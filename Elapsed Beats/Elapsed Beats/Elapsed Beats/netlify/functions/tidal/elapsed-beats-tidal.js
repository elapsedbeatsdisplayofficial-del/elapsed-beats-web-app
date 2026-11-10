// netlify/functions/elapsed-beats-tidal.js
//
// TIDAL catalog lookup for Elapsed Beats.
// Returns title, artist, album, BPM, key, duration, ISRC and cover art for a song.
//
// Credentials stay on the server. Set these in Netlify:
//   Site configuration -> Environment variables  (scope must include "Functions")
//     TIDAL_CLIENT_ID       your TIDAL app's Client ID
//     TIDAL_CLIENT_SECRET   your TIDAL app's Client Secret
//   Optional:
//     TIDAL_COUNTRY         two-letter catalog country, default US
//     ALLOWED_ORIGINS       comma-separated origins allowed to call this function
//                           (default: any origin)
// Redeploy after adding or changing variables.
//
// Calls (GET):
//   ?check=1                          setup diagnostics (never shows key values)
//   ?artist=The%20Fray&title=Cable%20Car   best match for a known artist + title
//   ?q=lifehouse%20aftermath          free-text search
//   ?isrc=USUM70000000                lookup by ISRC
//   ?id=48717877                      lookup by TIDAL track ID
//   &limit=5                          max results (1-20, default 5)
//   &country=GB                       override catalog country for one call

'use strict';

const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const API = 'https://openapi.tidal.com/v2';
const JSONAPI = 'application/vnd.api+json';

// Accept a few common spellings so a slightly different variable name still works.
const ID_NAMES = ['TIDAL_CLIENT_ID', 'TIDAL_API_CLIENT_ID', 'TIDAL_ID', 'TIDAL_CLIENT_KEY', 'TIDAL_KEY'];
const SECRET_NAMES = ['TIDAL_CLIENT_SECRET', 'TIDAL_API_CLIENT_SECRET', 'TIDAL_SECRET', 'TIDAL_SECRET_KEY'];

function clean(v) {
  return String(v == null ? '' : v).trim().replace(/^['"]+|['"]+$/g, '').trim();
}
function pickEnv(names) {
  for (const n of names) {
    const v = clean(process.env[n]);
    if (v) return { name: n, value: v };
  }
  return null;
}

// ---------- token (client credentials, cached while the function stays warm) ----------
let cachedToken = { token: null, exp: 0 };

async function getToken() {
  if (cachedToken.token && Date.now() < cachedToken.exp) return cachedToken.token;
  const id = pickEnv(ID_NAMES);
  const secret = pickEnv(SECRET_NAMES);
  if (!id || !secret) {
    const e = new Error('missing_credentials');
    e.code = 'setup';
    e.missing = [!id && 'TIDAL_CLIENT_ID', !secret && 'TIDAL_CLIENT_SECRET'].filter(Boolean);
    throw e;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(id.value + ':' + secret.value).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error('token_rejected');
    e.code = 'auth';
    e.status = res.status;
    throw e;
  }
  let j;
  try { j = JSON.parse(text); } catch (_) { j = {}; }
  if (!j.access_token) {
    const e = new Error('token_missing');
    e.code = 'auth';
    e.status = res.status;
    throw e;
  }
  const life = Math.max(60, (Number(j.expires_in) || 3600) - 60);
  cachedToken = { token: j.access_token, exp: Date.now() + life * 1000 };
  return cachedToken.token;
}

// ---------- API GET with one token refresh and short 429 back-off ----------
async function tidalGet(path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getToken();
    const res = await fetch(url.toString(), {
      headers: { Authorization: 'Bearer ' + token, Accept: JSONAPI },
    });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      cachedToken = { token: null, exp: 0 };
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 1;
      await new Promise((r) => setTimeout(r, Math.min(4000, ra * 1000)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const e = new Error('tidal_http_' + res.status);
      e.code = 'api';
      e.status = res.status;
      e.detail = text.slice(0, 300);
      throw e;
    }
    return text ? JSON.parse(text) : {};
  }
  const e = new Error('tidal_rate_limited');
  e.code = 'api';
  e.status = 429;
  throw e;
}

// ---------- JSON:API helpers ----------
function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function indexDoc(doc, idx) {
  idx = idx || new Map();
  for (const r of asArray(doc && doc.data).concat(asArray(doc && doc.included))) {
    if (r && r.type && r.id != null) {
      const key = r.type + ':' + r.id;
      const prev = idx.get(key);
      // Keep whichever copy carries relationship data (later calls add coverArt etc.).
      if (!prev) idx.set(key, r);
      else idx.set(key, mergeResource(prev, r));
    }
  }
  return idx;
}
function mergeResource(a, b) {
  const rel = Object.assign({}, a.relationships || {});
  for (const [k, v] of Object.entries(b.relationships || {})) {
    if (v && v.data !== undefined) rel[k] = v;
    else if (!rel[k]) rel[k] = v;
  }
  return Object.assign({}, a, b, {
    attributes: Object.assign({}, a.attributes || {}, b.attributes || {}),
    relationships: rel,
  });
}
function relRefs(res, name) {
  const d = res && res.relationships && res.relationships[name] && res.relationships[name].data;
  return asArray(d).filter((x) => x && x.id != null);
}

function isoDurationToSec(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(s || ''));
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function bestArtUrl(artwork, want) {
  const files = (artwork && artwork.attributes && artwork.attributes.files) || [];
  if (!files.length) return null;
  const sized = files
    .filter((f) => f && f.href)
    .map((f) => ({ href: f.href, w: (f.meta && f.meta.width) || 0 }))
    .sort((a, b) => a.w - b.w);
  if (!sized.length) return null;
  return (sized.find((f) => f.w >= (want || 640)) || sized[sized.length - 1]).href;
}

const KEY_NAMES = { CSharp: 'C#', FSharp: 'F#', DSharp: 'D#', GSharp: 'G#', ASharp: 'A#' };

function shapeTrack(t, idx) {
  const a = t.attributes || {};
  const artists = relRefs(t, 'artists')
    .map((r) => idx.get('artists:' + r.id))
    .map((x) => x && x.attributes && x.attributes.name)
    .filter(Boolean);
  const albumRef = relRefs(t, 'albums')[0];
  const album = albumRef ? idx.get('albums:' + albumRef.id) : null;
  const cover = album ? relRefs(album, 'coverArt')[0] : null;
  const art = cover ? bestArtUrl(idx.get('artworks:' + cover.id), 640) : null;
  const keyRaw = a.key && a.key !== 'UNKNOWN' ? (KEY_NAMES[a.key] || a.key) : null;
  const scale = a.keyScale && a.keyScale !== 'UNKNOWN' ? String(a.keyScale).toLowerCase() : null;
  const bpm = Number(a.bpm);
  return {
    id: String(t.id),
    title: a.title || '',
    version: a.version || null,
    artist: artists.join(', '),
    artists,
    album: (album && album.attributes && album.attributes.title) || null,
    albumId: albumRef ? String(albumRef.id) : null,
    year: ((album && album.attributes && album.attributes.releaseDate) || '').slice(0, 4) || null,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, // not every TIDAL track has BPM filled in
    key: keyRaw ? keyRaw + (scale ? ' ' + scale : '') : null,
    durationSec: isoDurationToSec(a.duration),
    isrc: a.isrc || null,
    explicit: !!a.explicit,
    artUrl: art,
    tidalUrl: 'https://tidal.com/track/' + t.id,
  };
}

// Fill in artists/albums for tracks that came back without them, then album cover art.
async function complete(ids, idx, country) {
  const needTracks = ids.filter((id) => {
    const t = idx.get('tracks:' + id);
    return !t || !relRefs(t, 'artists').length || !relRefs(t, 'albums').length;
  });
  if (needTracks.length) {
    indexDoc(await tidalGet('/tracks', {
      'filter[id]': needTracks.join(','), countryCode: country, include: 'albums,artists',
    }), idx);
  }
  const albumIds = [...new Set(ids
    .map((id) => relRefs(idx.get('tracks:' + id), 'albums')[0])
    .filter(Boolean)
    .map((r) => String(r.id)))]
    .filter((aid) => !relRefs(idx.get('albums:' + aid), 'coverArt').length);
  if (albumIds.length) {
    try {
      indexDoc(await tidalGet('/albums', {
        'filter[id]': albumIds.join(','), countryCode: country, include: 'coverArt',
      }), idx);
    } catch (_) { /* art is optional; keep the metadata */ }
  }
  return ids.map((id) => idx.get('tracks:' + id)).filter(Boolean).map((t) => shapeTrack(t, idx));
}

async function searchTracks(q, limit, country) {
  let doc;
  try {
    doc = await tidalGet('/searchResults', {
      'filter[query]': q, countryCode: country, include: 'tracks,tracks.artists,tracks.albums',
    });
  } catch (e) {
    if (e.status !== 400) throw e;
    doc = await tidalGet('/searchResults', { 'filter[query]': q, countryCode: country, include: 'tracks' });
  }
  const idx = indexDoc(doc);
  let ids = [];
  for (const root of asArray(doc.data)) {
    ids = ids.concat(relRefs(root, 'tracks').filter((r) => !r.type || r.type === 'tracks').map((r) => String(r.id)));
  }
  if (!ids.length) {
    ids = asArray(doc.included).filter((r) => r && r.type === 'tracks').map((r) => String(r.id));
  }
  ids = [...new Set(ids)].slice(0, limit);
  return ids.length ? complete(ids, idx, country) : [];
}

async function tracksBy(filterName, value, limit, country) {
  const doc = await tidalGet('/tracks', {
    ['filter[' + filterName + ']']: value, countryCode: country, include: 'albums,artists',
  });
  const idx = indexDoc(doc);
  const ids = [...new Set(asArray(doc.data).filter((r) => r && r.type === 'tracks').map((r) => String(r.id)))].slice(0, limit);
  return ids.length ? complete(ids, idx, country) : [];
}

// ---------- strict artist + title matching ----------
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function baseTitle(s) {
  // drop "(Remastered 2011)", "- Radio Edit", "[Live]" etc. for comparison only
  return norm(String(s || '').replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, ''));
}
function isMatch(track, artist, title) {
  const wantA = norm(artist);
  const wantT = baseTitle(title);
  if (!wantA || !wantT) return false;
  const artistOk = track.artists.some((n) => norm(n) === wantA) || norm(track.artist) === wantA;
  return artistOk && baseTitle(track.title) === wantT;
}

// ---------- HTTP ----------
function corsHeaders(origin) {
  const allowed = clean(process.env.ALLOWED_ORIGINS);
  let allow = '*';
  if (allowed) {
    const list = allowed.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
    allow = list.includes(origin) ? origin : list[0];
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}
function reply(status, body, headers) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}),
    body: JSON.stringify(body),
  };
}

async function diagnostics(country) {
  const id = pickEnv(ID_NAMES);
  const secret = pickEnv(SECRET_NAMES);
  const out = {
    status: 'check',
    clientIdVariable: id ? id.name : null,
    clientSecretVariable: secret ? secret.name : null,
    country,
    token: 'not tried',
    search: 'not tried',
  };
  if (!id || !secret) {
    out.token = 'missing ' + [!id && 'TIDAL_CLIENT_ID', !secret && 'TIDAL_CLIENT_SECRET'].filter(Boolean).join(' and ');
    return out;
  }
  try {
    cachedToken = { token: null, exp: 0 };
    await getToken();
    out.token = 'ok';
  } catch (e) {
    out.token = 'rejected by TIDAL (HTTP ' + (e.status || '?') + ') - check the Client ID/Secret pair';
    return out;
  }
  try {
    const r = await searchTracks('Avicii', 1, country);
    out.search = r.length ? 'ok' : 'no results';
    if (r[0]) out.sample = { title: r[0].title, artist: r[0].artist, bpm: r[0].bpm, key: r[0].key, hasArt: !!r[0].artUrl };
  } catch (e) {
    out.search = 'failed (HTTP ' + (e.status || '?') + ')';
    if (e.detail) out.detail = e.detail;
  }
  return out;
}

exports.handler = async (event) => {
  const h = (event && event.headers) || {};
  const cors = corsHeaders(clean(h.origin || h.Origin));
  const method = (event && event.httpMethod) || 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (method !== 'GET') return reply(405, { status: 'error', message: 'GET only' }, cors);

  const p = (event && event.queryStringParameters) || {};
  const country = (clean(p.country) || clean(process.env.TIDAL_COUNTRY) || 'US').toUpperCase().slice(0, 2);
  const limit = Math.max(1, Math.min(20, parseInt(p.limit, 10) || 5));

  try {
    if (p.check) {
      return reply(200, await diagnostics(country), Object.assign({ 'Cache-Control': 'no-store' }, cors));
    }

    const artist = clean(p.artist);
    const title = clean(p.title);
    let tracks;
    if (clean(p.id)) tracks = await tracksBy('id', clean(p.id), limit, country);
    else if (clean(p.isrc)) tracks = await tracksBy('isrc', clean(p.isrc).toUpperCase(), limit, country);
    else if (artist && title) tracks = await searchTracks(artist + ' ' + title, Math.max(limit, 10), country);
    else if (clean(p.q)) tracks = await searchTracks(clean(p.q), limit, country);
    else {
      return reply(400, { status: 'error', message: 'Pass artist+title, q, isrc or id (or check=1).' }, cors);
    }

    const body = { status: 'ok', provider: 'TIDAL', country };
    if (artist && title) {
      // Only call it a match when artist and title both line up; otherwise best is null
      // so the widget never shows another song's BPM or art.
      const best = tracks.find((t) => isMatch(t, artist, title)) || null;
      body.best = best;
      body.tracks = tracks.slice(0, limit);
    } else {
      body.tracks = tracks;
    }
    return reply(200, body, Object.assign({ 'Cache-Control': 'public, max-age=3600' }, cors));
  } catch (e) {
    if (e.code === 'setup') {
      return reply(503, {
        status: 'setup',
        missing: e.missing,
        message: 'Add ' + e.missing.join(' and ') + ' in Netlify environment variables (scope: Functions), then redeploy.',
      }, cors);
    }
    if (e.code === 'auth') {
      return reply(502, { status: 'auth', message: 'TIDAL did not accept the Client ID/Secret.', tidalStatus: e.status || null }, cors);
    }
    return reply(502, { status: 'error', message: e.message, tidalStatus: e.status || null }, cors);
  }
};

// exposed for local tests only
exports._test = { isoDurationToSec, shapeTrack, indexDoc, isMatch, baseTitle, norm };

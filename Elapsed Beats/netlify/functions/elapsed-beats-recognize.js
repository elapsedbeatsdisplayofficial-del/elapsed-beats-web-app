/* Elapsed Beats — proximity sensor song recognition.
 *
 * POST a short room recording (audio/wav, mono 16-bit, ~10 s) and get back
 * the song and the exact position in it where the recording began:
 *
 *   { status: 'ok', provider, title, artist, album, year, genre,
 *     durationSec, positionSec, score, isrc }
 *   { status: 'no_match' }
 *
 * isrc is the recording's ISRC when the provider sends one (else ''). The
 * widget uses it to look the exact recording up on TIDAL.
 *
 * Providers (set in Netlify → Site configuration → Environment variables,
 * then redeploy — functions only see variables from their own deploy):
 *   ACRCloud (preferred — millisecond offsets):
 *     ACR_HOST            e.g. identify-us-west-2.acrcloud.com
 *     ACR_ACCESS_KEY
 *     ACR_ACCESS_SECRET   (ACR_SECRET_KEY, ACR_SECRET and ACRCLOUD_* also work)
 *   AudD (fallback — offsets to the second):
 *     AUDD_API_TOKEN
 * Names are matched without regard to case, and pasted values are trimmed.
 * With neither provider set the function answers 501 and the widget falls
 * back to matching against the file loaded in the player.
 *
 * Setup check: open this function's address in a browser (GET). It lists
 * which variables it can see — names only, never values. Add ?check=1 to
 * also ask ACRCloud whether it accepts the host, key and secret.
 *
 * The recording is forwarded to the provider for identification only; this
 * function does not store it. Same-origin use only (no CORS headers).
 */
'use strict';

const crypto = require('crypto');

const MAX_BYTES = 3 * 1024 * 1024;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2)
});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const yearOf = (s) => { const m = String(s || '').match(/(19|20)\d{2}/); return m ? m[0] : ''; };
// First well-formed ISRC among the candidates (string or list), e.g. "GBBKS1500214"; else ''.
const isrcOf = (...vals) => {
  for (const v of vals.flat()) {
    const s = String(v == null ? '' : v).toUpperCase().replace(/[\s-]+/g, '');
    if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s)) return s;
  }
  return '';
};

/* ---------- settings ---------- */
// Accepted names for each value, first match wins. Compared after upper-casing
// and turning anything that isn't a letter or digit into "_".
const NAMES = {
  host:   ['ACR_HOST', 'ACRCLOUD_HOST', 'ACR_HOSTNAME', 'ACR_HOST_URL', 'ACRCLOUD_HOST_URL'],
  key:    ['ACR_ACCESS_KEY', 'ACRCLOUD_ACCESS_KEY', 'ACR_KEY', 'ACR_ACCESS_KEY_ID', 'ACRCLOUD_KEY'],
  secret: ['ACR_ACCESS_SECRET', 'ACR_SECRET_KEY', 'ACR_SECRET', 'ACR_ACCESS_SECRET_KEY', 'ACR_SK',
           'ACRCLOUD_ACCESS_SECRET', 'ACRCLOUD_SECRET_KEY', 'ACRCLOUD_SECRET'],
  audd:   ['AUDD_API_TOKEN', 'AUDD_TOKEN', 'AUDD_API_KEY']
};
const canon = (s) => String(s).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const clean = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();   // pasted quotes / spaces / line breaks

function settings() {
  const env = new Map();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || !clean(v)) continue;
    const c = canon(k);
    if (!env.has(c)) env.set(c, { name: k, value: clean(v) });
  }
  const find = (list) => { for (const n of list) { const hit = env.get(n); if (hit) return hit; } return null; };
  const host = find(NAMES.host), key = find(NAMES.key), secret = find(NAMES.secret), audd = find(NAMES.audd);
  const hostValue = host ? host.value.replace(/^[a-z]+:\/\//i, '').replace(/[\/?#].*$/, '').trim() : '';
  // Names (never values) of anything that looks like it was meant for this function.
  const related = [...env.values()].map(e => e.name).filter(n => /ACR|AUDD/i.test(n)).sort();
  return {
    acr: host && key && secret ? { host: hostValue, key: key.value, secret: secret.value } : null,
    audd: audd ? audd.value : '',
    found: { host: host && host.name, key: key && key.name, secret: secret && secret.name, audd: audd && audd.name },
    hostLooksRight: !host || /(^|\.)acrcloud\.(com|cn)$/i.test(hostValue),
    related
  };
}
function missingAcr(s) {
  const out = [];
  if (!s.found.host) out.push('ACR_HOST');
  if (!s.found.key) out.push('ACR_ACCESS_KEY');
  if (!s.found.secret) out.push('ACR_ACCESS_SECRET');
  return out;
}

// Length of the WAV sample in seconds (PCM header written by the widget).
function wavSeconds(buf) {
  try {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return NaN;
    let o = 12, rate = 0, block = 0;
    while (o + 8 <= buf.length) {
      const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
      if (id === 'fmt ') { rate = buf.readUInt32LE(o + 12); block = buf.readUInt16LE(o + 20); }
      if (id === 'data') return rate && block ? Math.min(size, buf.length - o - 8) / (rate * block) : NaN;
      o += 8 + size + (size & 1);
    }
  } catch (_) {}
  return NaN;
}

async function withTimeout(promise, ms) {
  let t;
  try { return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]); }
  finally { clearTimeout(t); }
}

// A provider failure the widget can name: 'credentials' or 'quota' (else generic).
class ProviderError extends Error {
  constructor(message, code) { super(message); this.code = code || 'unavailable'; }
}
const ACR_CODES = {
  3000: ['credentials', 'ACRCloud service error — check ACR_HOST matches the project host'],
  3001: ['credentials', 'ACRCloud rejected the access key (ACR_ACCESS_KEY)'],
  3002: ['unavailable', 'ACRCloud: invalid HTTP request'],
  3003: ['quota', 'ACRCloud request limit reached'],
  3006: ['credentials', 'ACRCloud: invalid arguments — check the project host and key belong together'],
  3014: ['credentials', 'ACRCloud rejected the signature — the access secret (ACR_ACCESS_SECRET) does not match the access key'],
  3015: ['quota', 'ACRCloud requests-per-second limit reached']
};

async function acrcloud(acr, audio, sampleSec) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const toSign = ['POST', '/v1/identify', acr.key, 'audio', '1', timestamp].join('\n');
  const signature = crypto.createHmac('sha1', acr.secret).update(toSign).digest('base64');

  const form = new FormData();
  form.append('sample', new Blob([audio], { type: 'audio/wav' }), 'sample.wav');
  form.append('sample_bytes', String(audio.length));
  form.append('access_key', acr.key);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', timestamp);

  let res;
  try { res = await withTimeout(fetch(`https://${acr.host}/v1/identify`, { method: 'POST', body: form }), 8000); }
  catch (err) {
    if (err && err.message === 'timeout') throw new ProviderError('ACRCloud did not answer in time', 'unavailable');
    throw new ProviderError(`ACRCloud host ${acr.host} could not be reached — check ACR_HOST (${err && err.cause && err.cause.code || err && err.message})`, 'credentials');
  }
  const data = await res.json().catch(() => null);
  const code = data && data.status ? Number(data.status.code) : -1;
  if (code === 1001) return { status: 'no_match' };                 // no result
  if (code === 2004) return { status: 'no_match' };                 // too quiet / no fingerprint
  if (code !== 0) {
    const known = ACR_CODES[code];
    throw new ProviderError(known ? `${known[1]} (code ${code})` : `ACRCloud ${code}: ${data && data.status && data.status.msg || 'HTTP ' + res.status}`, known ? known[0] : 'unavailable');
  }
  const list = (data.metadata && data.metadata.music) || [];
  const m = list.slice().sort((a, b) => num(b.score) - num(a.score))[0];
  if (!m || !m.title) return { status: 'no_match' };

  // Song position where the sample began. Prefer the matched-segment offsets
  // (db_begin − sample_begin); play_offset_ms is the position at the end of
  // the sample.
  const dbBegin = num(m.db_begin_time_offset_ms), sBegin = num(m.sample_begin_time_offset_ms);
  let positionMs = (Number.isFinite(dbBegin) && Number.isFinite(sBegin)) ? dbBegin - sBegin : NaN;
  if (!Number.isFinite(positionMs) && Number.isFinite(num(m.play_offset_ms)) && Number.isFinite(sampleSec)) {
    positionMs = num(m.play_offset_ms) - sampleSec * 1000;
  }
  if (!Number.isFinite(positionMs)) return { status: 'no_match' };

  const artists = (m.artists || []).map(a => a && a.name).filter(Boolean);
  return {
    status: 'ok', provider: 'ACRCloud',
    title: String(m.title),
    artist: artists.length > 2 ? artists.join(', ') : artists.join(' & '),
    album: m.album && m.album.name ? String(m.album.name) : '',
    year: yearOf(m.release_date),
    genre: (m.genres && m.genres[0] && m.genres[0].name) ? String(m.genres[0].name) : '',
    durationSec: num(m.duration_ms) > 0 ? num(m.duration_ms) / 1000 : null,
    positionSec: Math.max(0, positionMs / 1000),
    score: num(m.score),
    isrc: isrcOf(m.external_ids && m.external_ids.isrc)
  };
}

async function audd(token, audio) {
  const form = new FormData();
  form.append('api_token', token);
  form.append('return', 'apple_music,spotify');
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'sample.wav');
  const res = await withTimeout(fetch('https://api.audd.io/', { method: 'POST', body: form }), 8000);
  const data = await res.json();
  if (!data || data.status !== 'success') {
    const ec = data && data.error && Number(data.error.error_code);
    throw new ProviderError(`AudD: ${data && data.error && data.error.error_message}`, ec === 900 || ec === 901 ? 'credentials' : ec === 902 ? 'quota' : 'unavailable');
  }
  const r = data.result;
  if (!r || !r.title) return { status: 'no_match' };
  const tc = String(r.timecode || '').split(':').map(Number);          // "mm:ss" where the sample was found
  const positionSec = tc.length === 2 && tc.every(Number.isFinite) ? tc[0] * 60 + tc[1]
                    : tc.length === 3 && tc.every(Number.isFinite) ? tc[0] * 3600 + tc[1] * 60 + tc[2] : NaN;
  if (!Number.isFinite(positionSec)) return { status: 'no_match' };
  const durMs = num(r.spotify && r.spotify.duration_ms) || num(r.apple_music && r.apple_music.durationInMillis);
  const genre = r.apple_music && Array.isArray(r.apple_music.genreNames) ? r.apple_music.genreNames.find(g => g && g !== 'Music') || '' : '';
  return {
    status: 'ok', provider: 'AudD',
    title: String(r.title), artist: String(r.artist || ''), album: String(r.album || ''),
    year: yearOf(r.release_date), genre: String(genre),
    durationSec: durMs > 0 ? durMs / 1000 : null,
    positionSec: Math.max(0, positionSec),
    score: null,
    isrc: isrcOf(r.spotify && r.spotify.external_ids && r.spotify.external_ids.isrc, r.apple_music && r.apple_music.isrc)
  };
}

// Two seconds of faint noise: enough for ACRCloud to check the credentials.
function testWav() {
  const sr = 8000, n = sr * 2, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf.writeInt16LE(((x >> 8) % 600) - 300, 44 + i * 2); }
  return buf;
}

// GET: what this deployment can see (names only). The widget reads `status`.
async function setupReport(event) {
  const s = settings();
  const missing = missingAcr(s);
  const ready = !!(s.acr || s.audd);
  const report = {
    status: ready ? 'ready' : 'not_configured',
    providers: [s.acr && 'ACRCloud', s.audd && 'AudD'].filter(Boolean),
    acrcloud: {
      ACR_HOST: s.found.host ? `found (as ${s.found.host})` + (s.hostLooksRight ? '' : ' — but it does not look like an acrcloud.com host') : 'MISSING',
      ACR_ACCESS_KEY: s.found.key ? `found (as ${s.found.key})` : 'MISSING',
      ACR_ACCESS_SECRET: s.found.secret ? `found (as ${s.found.secret})` : 'MISSING'
    },
    audd: s.found.audd ? `found (as ${s.found.audd})` : 'not set (optional)',
    relatedVariablesSeen: s.related
  };
  if (!ready) {
    report.missing = missing;
    report.fix = 'Add the missing names in Netlify → Site configuration → Environment variables (scope must include Functions), then Deploys → Trigger deploy → Deploy site.';
  }
  const q = event.queryStringParameters || {};
  if (s.acr && (q.check === '1' || q.check === 'true')) {
    try {
      const r = await acrcloud(s.acr, testWav(), 2);
      report.acrcloudCheck = r.status === 'ok' || r.status === 'no_match' ? 'ACRCloud accepted the host, key and secret' : 'unexpected answer';
    } catch (err) {
      report.acrcloudCheck = 'FAILED — ' + (err && err.message || err);
      report.code = err && err.code;
    }
  } else if (s.acr) {
    report.acrcloudCheck = 'add ?check=1 to this address to test the credentials with ACRCloud';
  }
  return reply(200, report);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return setupReport(event);
  if (event.httpMethod !== 'POST') return reply(405, { status: 'error', error: 'POST a WAV sample' });

  const s = settings();
  if (!s.acr && !s.audd) return reply(501, { status: 'not_configured', missing: missingAcr(s) });

  let audio;
  try { audio = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'binary'); }
  catch (_) { return reply(400, { status: 'error', error: 'Unreadable body' }); }
  if (audio.length < 1000) return reply(400, { status: 'error', error: 'Sample too short' });
  if (audio.length > MAX_BYTES) return reply(413, { status: 'error', error: 'Sample too large' });
  const sampleSec = wavSeconds(audio);

  const errors = [];
  if (s.acr) {
    try { const r = await acrcloud(s.acr, audio, sampleSec); if (r.status === 'ok' || !s.audd) return reply(200, r); }
    catch (err) { errors.push(err); }
  }
  if (s.audd) {
    try { return reply(200, await audd(s.audd, audio)); }
    catch (err) { errors.push(err); }
  }
  console.error('[elapsed-beats-recognize]', errors.map(e => String(e && e.message || e)).join(' | '));
  const code = errors.some(e => e && e.code === 'quota') ? 'quota' : errors.every(e => e && e.code === 'credentials') ? 'credentials' : 'unavailable';
  return reply(502, { status: 'error', code, error: errors.map(e => String(e && e.message || e)).join(' | ') || 'Recognition service unavailable' });
};

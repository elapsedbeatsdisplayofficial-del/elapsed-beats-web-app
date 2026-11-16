import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const STORE_NAME = 'elapsed-beats-track-metrics-v1';
const MAX_BATCH = 25;
const CACHE_MS = 1000 * 60 * 60 * 24 * 90;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function norm(value) {
  return cleanText(value, 500)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function primaryArtist(value) {
  return cleanText(value).replace(/\s+(?:feat(?:uring)?|ft|with)\.?\s+.+$/i, '').trim();
}

function validBpm(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 40 && n <= 300;
}

function validDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function cacheKey(track) {
  const id = `${norm(primaryArtist(track.artist))}::${norm(track.title)}::${norm(track.remixer)}`;
  return `metric-${createHash('sha256').update(id).digest('hex')}`;
}

function scoreCandidate(item, track) {
  const title = norm(item && (item.title || item.title_short));
  const artist = norm(item && item.artist && item.artist.name);
  const targetTitle = norm(track.title);
  const targetArtist = norm(primaryArtist(track.artist));
  const remixer = norm(track.remixer);
  if (!title || !targetTitle) return -Infinity;

  let score = 0;
  if (title === targetTitle) score += 100;
  else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 70;
  else return -Infinity;

  if (targetArtist) {
    if (artist === targetArtist) score += 60;
    else if (artist && (artist.includes(targetArtist) || targetArtist.includes(artist))) score += 38;
    else score -= 30;
  }

  if (remixer) {
    if (title.includes(remixer)) score += 45;
    else if (/\b(remix|rmx|rework|bootleg|vip|mashup)\b/.test(title)) score += 10;
    else score -= 28;
  } else if (/\b(remix|rmx|rework|bootleg|vip|mashup)\b/.test(title)) {
    score -= 24;
  }
  return score;
}

async function fetchJson(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Elapsed-Beats/17' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupTrack(track) {
  const term = [track.artist, track.title, track.remixer ? `${track.remixer} remix` : '']
    .filter(Boolean).join(' ');
  if (!term) return null;

  const search = await fetchJson(`https://api.deezer.com/search/track?q=${encodeURIComponent(term)}&limit=8`);
  const candidates = (Array.isArray(search && search.data) ? search.data : [])
    .map(item => ({ item, score: scoreCandidate(item, track) }))
    .filter(x => Number.isFinite(x.score) && x.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  for (const { item, score } of candidates) {
    let detail = item;
    if (!validBpm(detail && detail.bpm) || !validDuration(detail && detail.duration)) {
      if (!item || !item.id) continue;
      try { detail = await fetchJson(`https://api.deezer.com/track/${encodeURIComponent(item.id)}`); }
      catch (_) { continue; }
    }
    const bpm = Number(detail && detail.bpm);
    const duration = Number(detail && detail.duration);
    if (!validBpm(bpm) || !validDuration(duration)) continue;
    return {
      bpm: Math.round(bpm * 100) / 100,
      duration: Math.round(duration * 1000) / 1000,
      provider: 'Deezer',
      matchScore: score,
      matchedTitle: cleanText(detail.title || item.title),
      matchedArtist: cleanText((detail.artist && detail.artist.name) || (item.artist && item.artist.name)),
      checkedAt: Date.now(),
    };
  }
  return null;
}

async function metricForTrack(store, track) {
  const key = cacheKey(track);
  try {
    const cached = await store.get(key, { type: 'json' });
    if (cached && Number(cached.checkedAt) > Date.now() - CACHE_MS && validBpm(cached.bpm) && validDuration(cached.duration)) {
      return cached;
    }
  } catch (_) {}

  let metric = null;
  try { metric = await lookupTrack(track); }
  catch (error) { console.warn('[Track Metrics] lookup failed', track.title, error); }
  if (metric) {
    try { await store.setJSON(key, metric); } catch (_) {}
  }
  return metric;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: jsonHeaders });
  if (req.method !== 'POST') return reply({ ok: false, error: 'Method not allowed.' }, 405);

  let body;
  try { body = await req.json(); }
  catch (_) { return reply({ ok: false, error: 'Invalid JSON.' }, 400); }

  const tracks = Array.isArray(body && body.tracks) ? body.tracks.slice(0, MAX_BATCH) : [];
  if (!tracks.length) return reply({ ok: true, metrics: [] });

  const cleanTracks = tracks.map(track => ({
    key: cleanText(track && track.key, 700),
    title: cleanText(track && track.title, 260),
    artist: cleanText(track && track.artist, 260),
    remixer: cleanText(track && track.remixer, 260),
  })).filter(track => track.key && track.title);

  const store = getStore({ name: STORE_NAME, consistency: 'eventual' });
  const metrics = [];

  // Small worker pool keeps the public catalogue requests polite while still
  // filling a phone-sized page quickly.
  let cursor = 0;
  async function worker() {
    while (cursor < cleanTracks.length) {
      const index = cursor++;
      const track = cleanTracks[index];
      const metric = await metricForTrack(store, track);
      if (metric) metrics.push({ key: track.key, ...metric });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, cleanTracks.length) }, () => worker()));
  return reply({ ok: true, metrics });
};

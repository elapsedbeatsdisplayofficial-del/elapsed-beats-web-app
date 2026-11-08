import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const STORE_NAME = 'elapsed-beats-bpm-corrections';
const MAX_TEXT = 300;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const bpm = Number(input.b);
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) return null;
  const title = cleanText(input.t, 240);
  if (!title) return null;
  const duration = Number(input.d);
  return {
    t: title,
    a: cleanText(input.a, 240),
    r: cleanText(input.r, 240),
    b: Math.round(bpm * 100) / 100,
    d: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
    ds: cleanText(input.ds, 40),
    album: cleanText(input.album, 240),
    mixAlbum: cleanText(input.mixAlbum, 240),
    variantLabel: cleanText(input.variantLabel, 240),
    rawTitle: cleanText(input.rawTitle || input.t, 300),
    src: 'learned',
    dbCorrected: true,
    at: Number(input.at) || Date.now(),
  };
}

function blobKeyFor(canonicalKey) {
  return `track-${createHash('sha256').update(canonicalKey).digest('hex')}`;
}

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  if (req.method === 'GET') {
    try {
      const { blobs } = await store.list({ prefix: 'track-' });
      const corrections = [];
      for (const entry of blobs) {
        const value = await store.get(entry.key, { type: 'json', consistency: 'strong' });
        if (!value || typeof value !== 'object' || !value.key || !value.record) continue;
        corrections.push(value);
      }
      corrections.sort((a, b) => (Number(b.cloudUpdatedAt) || 0) - (Number(a.cloudUpdatedAt) || 0));
      return reply({ ok: true, corrections });
    } catch (error) {
      console.error('[BPM Sync] GET failed', error);
      return reply({ ok: false, error: 'Cloud BPM store unavailable.' }, 503);
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const key = cleanText(body && body.key, 700);
      const record = cleanRecord(body && body.record);
      if (!key || !record) return reply({ ok: false, error: 'Invalid BPM correction.' }, 400);

      const cloudUpdatedAt = Date.now();
      const correction = { key, record, cloudUpdatedAt };
      await store.setJSON(blobKeyFor(key), correction);
      return reply({ ok: true, correction });
    } catch (error) {
      console.error('[BPM Sync] POST failed', error);
      return reply({ ok: false, error: 'Could not save BPM correction.' }, 503);
    }
  }

  return reply({ ok: false, error: 'Method not allowed.' }, 405);
};

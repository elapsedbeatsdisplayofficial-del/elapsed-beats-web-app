// Netlify Functions v2 (Node 18+). Do not put your AudD API token into HTML.
// Netlify environment variable: AUDD_API_TOKEN
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const limitBytes = 4 * 1024 * 1024;
const allowed = /^audio\/(webm|mp4|ogg|mpeg|wav|x-wav|aac|flac|aiff|x-aiff)/i;
export default async function handler(request) {
  if (request.method !== 'POST') return json({status:'error', error:'POST a short audio clip.'},405);
  const token = process.env.AUDD_API_TOKEN;
  if (!token) return json({status:'error', error:'Server recognition is not configured. Set AUDD_API_TOKEN in Netlify site environment variables.'},503);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > limitBytes + 8192) return json({status:'error', error:'Audio recording is too large.'},413);
  let form;
  try { form=await request.formData(); } catch { return json({status:'error', error:'Invalid recording upload.'},400); }
  const recording=form.get('file');
  if (!recording || typeof recording.arrayBuffer !== 'function' || !allowed.test(recording.type||'')) {
    return json({status:'error', error:'An audio recording in WebM, MP4, OGG or WAV format is required.'},400);
  }
  if (recording.size < 1000 || recording.size > limitBytes) return json({status:'error',error:'Recording has an invalid size.'},413);
  const upstream=new FormData();
  upstream.append('api_token',token);
  upstream.append('return','spotify,apple_music');
  upstream.append('file',recording,recording.name||'proximity.webm');
  let result;
  try {
    const res=await fetch('https://api.audd.io/',{method:'POST',body:upstream,signal:AbortSignal.timeout(13000)});
    if (!res.ok) return json({status:'error',error:'Music recognition provider is unavailable.'},502);
    result=await res.json();
  } catch {
    return json({status:'error',error:'Music recognition request failed or timed out.'},502);
  }
  if (result?.status!=='success') return json({status:'error',error:'Music recognition service rejected the request.'},502);
  const r=result.result;
  if (!r || !r.artist || !r.title) return json({status:'success',result:null});
  const spotify=r.spotify||{};
  const apple=r.apple_music||{};
  // Return only the fields the app needs. Never forward request/token/provider internals.
  return json({status:'success',result:{
    artist:String(r.artist).slice(0,200),title:String(r.title).slice(0,200),
    timecode:typeof r.timecode==='string'?r.timecode:null,
    duration:Number(spotify.duration_ms)>0?Number(spotify.duration_ms)/1000 : Number(apple.durationInMillis)>0?Number(apple.durationInMillis)/1000 : 0
  }});
}

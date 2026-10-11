const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');
const crypto = require('crypto');

const AUDIO_STORE = 'broadcastAudio';
// A real audio file easily runs several hundred KB to a few MB even for a short clip — kept well
// away from the main 'appdata' store (which holds the entire rest of the app's state as a small
// number of JSON documents) so one large recording can never slow down or bloat the read/write
// path every other screen in the app depends on.
// The frontend now records as uncompressed 16-bit PCM WAV, not a compressed codec (see the long
// comment above toggleBroadcastRecording in the main app for why) — a 3-minute mono recording at
// a typical 44.1kHz/48kHz mic sample rate runs 15-18MB, nowhere near fitting the old 8MB ceiling
// that made sense for a compressed format. Sized around the frontend's own 3-minute recording cap
// plus headroom, not picked independently of it.
const MAX_BYTES = 24 * 1024 * 1024; // 24MB

// Stores one recorded broadcast voice message, keyed by a long random id, and hands back a public
// URL (served by broadcast-audio.js) that Twilio's <Play> verb can fetch directly. Requires a
// real signed-in session to UPLOAD — the same session-auth pattern as transport-sms.js/
// transport-call.js — but the URL handed back is deliberately NOT behind auth once created,
// because Twilio has no way to send this app's session bearer token when it fetches it back.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
  const { audioBase64, mime } = body || {};
  if (!audioBase64) return json(400, { error: 'Expected { audioBase64, mime }' });
  if (!/^audio\//.test(mime || '')) return json(400, { error: 'Expected an audio mime type' });

  let buf;
  try { buf = Buffer.from(audioBase64, 'base64'); } catch (e) { return json(400, { error: 'audioBase64 is not valid base64' }); }
  if (buf.length === 0) return json(400, { error: 'That recording came through empty — try recording again.' });
  if (buf.length > MAX_BYTES) return json(400, { error: `Recording is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)}MB) — try a shorter message.` });

  // Random, not sequential/guessable — this id is the only thing standing between the audio and
  // anyone who requests it, since broadcast-audio.js intentionally serves it without auth.
  const id = crypto.randomBytes(24).toString('hex');
  const store = getStore(AUDIO_STORE);
  try {
    await store.set(id, JSON.stringify({ mime, dataBase64: audioBase64, createdAt: Date.now(), uploadedBy: payload.userId || payload.sub || null }));
  } catch (e) {
    return json(502, { error: 'Could not save the recording — please try again.' });
  }

  const url = `https://${event.headers.host}/.netlify/functions/broadcast-audio?id=${id}`;
  return json(200, { ok: true, id, url });
};

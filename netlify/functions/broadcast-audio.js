const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');

const AUDIO_STORE = 'broadcastAudio';
// Recordings only ever need to live long enough for Twilio to fetch them once during an active
// broadcast send — not indefinitely. Expiring them narrows how long the unauthenticated URL
// (see broadcast-audio-upload.js) is actually live for, and keeps this store from growing forever
// with one-off voice clips nobody will ever request again after their broadcast finishes sending.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Deliberately NOT behind session auth, unlike every other function in this app — Twilio fetches
// this URL directly from its own servers while placing the call, with no way to attach this app's
// session bearer token. The random, unguessable id (see broadcast-audio-upload.js) is what stands
// in for auth here, the same trust model as an unlisted sharing link.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  connectLambda(event);

  const id = (event.queryStringParameters || {}).id;
  if (!id || !/^[0-9a-f]{48}$/.test(id)) return { statusCode: 400, body: 'Missing or malformed id' };

  const store = getStore(AUDIO_STORE);
  let record;
  try {
    const raw = await store.get(id, { type: 'json' });
    record = raw;
  } catch (e) {
    return { statusCode: 502, body: 'Could not read the recording' };
  }
  if (!record) return { statusCode: 404, body: 'Not found — this recording may have already expired' };
  if (Date.now() - (record.createdAt || 0) > MAX_AGE_MS) {
    store.delete(id).catch(() => {}); // best-effort cleanup; the 404 below is what actually matters to the caller
    return { statusCode: 404, body: 'This recording has expired' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': record.mime || 'audio/webm', 'Cache-Control': 'private, max-age=3600' },
    body: record.dataBase64,
    isBase64Encoded: true,
  };
};

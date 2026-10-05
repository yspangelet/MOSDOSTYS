const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Sibling to transport-call.js, which reads a typed message aloud via Twilio's <Say> — this plays
// back a real recorded voice (see broadcast-audio-upload.js / broadcast-audio.js) via <Play>
// instead. Kept as its own function rather than a branch inside transport-call.js so the
// already-working, already-in-production transport alert path can't be affected by anything
// to do with this newer recording feature. Same session-auth + shared Twilio credentials
// (Transportation → Integrations) as every other outbound-call function in this app — the
// broadcast feature deliberately doesn't ask anyone to connect a second Twilio account.
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
  const { to, audioUrl } = body || {};
  if (!to || !audioUrl) return json(400, { error: 'Expected { to, audioUrl }' });

  // audioUrl must point back at THIS site's own broadcast-audio endpoint, not an arbitrary
  // address — otherwise an authenticated-but-compromised frontend could turn this into an open
  // relay that makes Twilio fetch-and-play any URL on the internet. Comparing against this
  // request's own host (same pattern transport-voice.js uses to build its own webhook URL) rather
  // than a hardcoded domain means this still works correctly across preview/staging deploys.
  let parsed;
  try { parsed = new URL(audioUrl); } catch (e) { return json(400, { error: 'audioUrl is not a valid URL' }); }
  if (parsed.host !== event.headers.host || parsed.pathname !== '/.netlify/functions/broadcast-audio') {
    return json(400, { error: 'audioUrl must point at this site\'s own broadcast-audio endpoint' });
  }

  const store = getStore(APP_STORE);
  const notif = await store.get(SK_PREFIX + 'transportNotifications', { type: 'json' });
  if (!notif || !notif.twilioAccountSid || !notif.twilioAuthToken || !notif.twilioPhoneNumber) {
    return json(400, { error: 'Twilio is not connected yet — add your Account SID, Auth Token, and phone number in Transportation → Integrations.' });
  }
  if (!notif.smsEnabled) {
    return json(400, { error: 'Parent Line & SMS is turned off — enable it in Transportation → Integrations.' });
  }

  // Same 2-second pre-roll pause as transport-call.js, and for the same reason: without it, the
  // first word or two of the recording gets clipped on phones that connect the audio path a beat
  // before the person actually has the phone up to their ear.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Play>${escXml(audioUrl)}</Play></Response>`;

  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${notif.twilioAccountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${notif.twilioAccountSid}:${notif.twilioAuthToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: notif.twilioPhoneNumber, Twiml: twiml }),
    });
    const data = await resp.json();
    if (!resp.ok) return json(resp.status, { error: (data && data.message) || 'Twilio rejected the call' });
    return json(200, { ok: true, sid: data.sid });
  } catch (e) {
    return json(502, { error: 'Could not reach Twilio — please try again.' });
  }
};

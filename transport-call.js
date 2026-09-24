const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Places one outbound voice call through Twilio, reading the given message aloud via inline
// TwiML — used by Transportation's broadcast feature ("call every parent on this route and read
// them this message"). Same session-auth pattern as transport-sms.js: this is called BY Ledger's
// own frontend (not by Twilio), so it needs a real signed-in session, not a Twilio signature.
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
  const { to, message } = body || {};
  if (!to || !message) return json(400, { error: 'Expected { to, message }' });

  const store = getStore(APP_STORE);
  const notif = await store.get(SK_PREFIX + 'transportNotifications', { type: 'json' });
  if (!notif || !notif.twilioAccountSid || !notif.twilioAuthToken || !notif.twilioPhoneNumber) {
    return json(400, { error: 'Twilio is not connected yet — add your Account SID, Auth Token, and phone number in Transportation → Integrations.' });
  }
  if (!notif.smsEnabled) {
    return json(400, { error: 'Parent Line & SMS is turned off — enable it in Transportation → Integrations.' });
  }

  // Twilio's Calls API accepts inline TwiML directly via the Twiml param (limited to ~4KB, which
  // a short broadcast message never approaches) — no separate webhook round-trip needed just to
  // read one message aloud, unlike transport-voice.js which needs a real webhook for its
  // multi-turn caller-ID lookup logic.
  // A short <Pause> before speaking gives the person a couple seconds to actually get the phone
  // to their ear after answering — without it, phones that connect the audio path a beat before
  // the person has the phone up (or ones that show/dismiss a "call connected" UI first) clip the
  // first word or two of the message every time.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Say voice="Polly.Joanna">${escXml(message)}</Say></Response>`;

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

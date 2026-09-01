const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

// Sends one SMS through Twilio — used by Driver View's "Text next stop's parents" button. Same
// session-auth pattern as ai.js: this is called BY Ledger's own frontend (not by Twilio, unlike
// transport-voice.js), so it needs a real signed-in session, not a Twilio signature.
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
    return json(400, { error: 'SMS alerts are turned off — enable them in Transportation → Integrations.' });
  }

  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${notif.twilioAccountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${notif.twilioAccountSid}:${notif.twilioAuthToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: notif.twilioPhoneNumber, Body: message }),
    });
    const data = await resp.json();
    if (!resp.ok) return json(resp.status, { error: (data && data.message) || 'Twilio rejected the message' });
    return json(200, { ok: true, sid: data.sid });
  } catch (e) {
    return json(502, { error: 'Could not reach Twilio — please try again.' });
  }
};

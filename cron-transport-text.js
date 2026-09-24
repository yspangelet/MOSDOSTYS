const { connectLambda } = require('@netlify/blobs');
const { runAutoText } = require('./_transport-text-helpers');

// The reliable backstop for scheduled-transport-text.js — same reasoning, and same shared-secret
// pattern, as cron-backup.js elsewhere in this project: Netlify's native Scheduled Functions have
// been observed to silently stop firing on some sites/periods, so this app's actually-depended-on
// path is a plain (non-scheduled) function triggered by an external, free cron service (e.g.
// cron-job.org, EasyCron) hitting this URL every 1-5 minutes — a mechanism outside Netlify's
// control entirely, so a Netlify-side scheduling bug can't silently take this feature down too.
//
// Protected by a shared secret (TRANSPORT_TEXT_CRON_KEY env var) in the query string, since this
// endpoint IS reachable by a plain URL and must not be triggerable (or guessable) by a stranger —
// each successful call sends real text messages to real parents. Until
// TRANSPORT_TEXT_CRON_KEY is set, this endpoint refuses every request — it does not fall back to
// being open. Set it in Netlify's environment variables to a long random value, then configure
// your external cron service to call:
//   https://YOUR-SITE.netlify.app/.netlify/functions/cron-transport-text?key=YOUR_SECRET
// every few minutes (recommended: every 2-5 minutes, comfortably shorter than your configured
// lead-time setting in Transportation → Integrations).
exports.handler = async (event) => {
  connectLambda(event);
  const requiredKey = process.env.TRANSPORT_TEXT_CRON_KEY;
  if (!requiredKey) {
    return { statusCode: 500, body: 'Not configured: set TRANSPORT_TEXT_CRON_KEY as an environment variable first, then redeploy.' };
  }
  const suppliedKey = (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (suppliedKey !== requiredKey) {
    return { statusCode: 401, body: 'Incorrect or missing key' };
  }
  try {
    const result = await runAutoText();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('cron transport auto-text failed', e);
    return { statusCode: 500, body: 'Auto-text run failed' };
  }
};

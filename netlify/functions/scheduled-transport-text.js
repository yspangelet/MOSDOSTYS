const { connectLambda } = require('@netlify/blobs');
const { runAutoText } = require('./_transport-text-helpers');

// Netlify Scheduled Function — intended to run automatically every 5 minutes, no manual trigger
// needed. Kept as a first-line attempt even though Netlify's own scheduler has been observed NOT
// firing silently on some sites/periods with zero error logs (a known, currently-active platform
// issue, not specific to this app — see scheduled-backup.js for the same caveat already
// documented elsewhere in this project) — see cron-transport-text.js for the reliable,
// externally-triggered backstop this feature actually depends on. If Netlify's own scheduler is
// working, this just means a stop's text fires from whichever path runs first each cycle — safe,
// since runAutoText() already only ever sends once per stop per day regardless of how many times
// or from how many paths it's called.
exports.handler = async (event) => {
  connectLambda(event);
  try {
    const result = await runAutoText();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('scheduled transport auto-text failed', e);
    return { statusCode: 500, body: 'Auto-text run failed' };
  }
};

// Runs every 5 minutes, IF Netlify's scheduler actually invokes it — see comment above. 5 minutes
// keeps this comfortably inside typical lead-time settings (10-15+ minutes) without over-calling
// Twilio; a school wanting a very short lead time (under ~5 minutes) should lower this interval.
exports.config = { schedule: '*/5 * * * *' };

const { connectLambda } = require('@netlify/blobs');
const { runBackup } = require('./_backup-helpers');

// Netlify Scheduled Function — intended to run automatically on the cron schedule below,
// no manual trigger needed. Kept as a first-line attempt even though it has been observed
// NOT firing silently on some sites/periods with zero error logs (a known, currently-active
// Netlify platform issue, not specific to this app) — see cron-backup.js for the reliable,
// externally-triggered backstop that this app's Settings → Backups screen actually depends
// on. If Netlify's own scheduler is working, this just means the backup happens twice (once
// from each path) on days both fire — harmless, since writing the same day's snapshot twice
// simply overwrites it with equivalent data.
exports.handler = async (event) => {
  connectLambda(event);
  try {
    const result = await runBackup();
    return { statusCode: 200, body: result.skipped ? result.reason : `Backed up as of ${result.date}` };
  } catch (e) {
    console.error('scheduled backup failed', e);
    return { statusCode: 500, body: 'Backup failed' };
  }
};

// Runs once a day, IF Netlify's scheduler actually invokes it — see comment above.
exports.config = { schedule: '@daily' };

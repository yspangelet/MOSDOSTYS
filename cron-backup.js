const { connectLambda } = require('@netlify/blobs');
const { runBackup } = require('./_backup-helpers');

// A backstop for scheduled-backup.js — Netlify's native Scheduled Functions have been
// observed to silently stop firing (deployed correctly, next-run time shown in the
// dashboard, but never actually invoked, with no error anywhere) on some sites/periods.
// This is a known, currently-active platform issue and not something fixable from inside
// this app's code. Rather than depend on that alone, this is a normal (non-scheduled)
// function that does the exact same backup, but is triggered by an external, free cron
// service (e.g. cron-job.org, EasyCron) hitting this URL once a day — a mechanism outside
// Netlify's control entirely, so a Netlify-side scheduling bug can't silently take the
// whole safety net down with it.
//
// Protected by a shared secret (BACKUP_CRON_KEY env var) in the query string, since this
// endpoint — unlike a true Scheduled Function — IS reachable by a plain URL, and a backup
// endpoint is exactly the kind of thing that must not be triggerable (or, worse, guessable)
// by a stranger. Set BACKUP_CRON_KEY to a long random value in Netlify's environment
// variables, then configure your external cron service to call:
//   https://YOUR-SITE.netlify.app/.netlify/functions/cron-backup?key=YOUR_SECRET
// once daily. Until BACKUP_CRON_KEY is set, this endpoint refuses every request — it does
// not fall back to being open.
exports.handler = async (event) => {
  connectLambda(event);
  const requiredKey = process.env.BACKUP_CRON_KEY;
  if (!requiredKey) {
    return { statusCode: 500, body: 'Not configured: set BACKUP_CRON_KEY as an environment variable first, then redeploy.' };
  }
  const suppliedKey = (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (suppliedKey !== requiredKey) {
    return { statusCode: 401, body: 'Incorrect or missing key' };
  }
  try {
    const result = await runBackup();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('cron-backup failed', e);
    return { statusCode: 500, body: 'Backup failed' };
  }
};

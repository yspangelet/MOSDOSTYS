const { getStore } = require('./_store-helpers');
const { loadFullState } = require('./_state-helpers');

const APP_STORE = 'appdata';
const BACKUP_STORE = 'backups';
const KEEP_DAYS = 30;

// Optional, fully automatic off-Netlify copy — emails the day's snapshot as a .json
// attachment using Resend (https://resend.com). Dormant until both RESEND_API_KEY and
// BACKUP_EMAIL_TO are set as environment variables; nothing changes for anyone who hasn't
// configured this. Sent weekly (Sundays) rather than daily, so it's a real safety margin
// without turning into inbox noise — change WEEKLY_DAY below (0=Sun..6=Sat) if you want a
// different day, or remove the day check entirely to send every day instead.
const WEEKLY_DAY = 0;
async function emailBackupOffsite(state, dateStr) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.BACKUP_EMAIL_TO;
  if (!apiKey || !to) return; // not configured — silently skip, this feature is opt-in
  const from = process.env.BACKUP_EMAIL_FROM || 'Ledger Backups <onboarding@resend.dev>';
  const json = JSON.stringify(state, null, 2);
  const attachmentBase64 = Buffer.from(json, 'utf8').toString('base64');
  const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: `Ledger backup — ${dateStr}`,
        text: `Automatic backup attached, dated ${dateStr}. This is a full copy of your school's data, sent automatically so a copy exists outside Netlify with no one needing to remember to download it. Keep this email somewhere safe (or forward it to your own long-term storage) and treat the attachment as containing sensitive student information.`,
        attachments: [{ filename: `ledger-backup-${dateStr}.json`, content: attachmentBase64 }],
      }),
    });
    if (!res.ok) console.error('backup email failed', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('backup email failed', e);
  }
}

// The actual snapshot-and-prune work, shared by both trigger paths (Netlify's native
// scheduler in scheduled-backup.js, and the external-cron-friendly endpoint in
// cron-backup.js) — one place to fix if the backup logic itself ever needs to change,
// instead of two copies quietly drifting apart.
async function runBackup() {
  const appStore = getStore(APP_STORE);
  const state = await loadFullState(appStore);
  if (!state || state.__bootstrapAdmin) return { ok: true, skipped: true, reason: 'No real state to back up yet' };

  const backupStore = getStore(BACKUP_STORE);
  const today = new Date().toISOString().slice(0, 10);
  await backupStore.setJSON(`backup:${today}`, { savedAt: new Date().toISOString(), state });

  const { blobs } = await backupStore.list({ prefix: 'backup:' });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  let pruned = 0;
  for (const b of blobs) {
    const dateStr = b.key.replace('backup:', '');
    if (dateStr < cutoff) { await backupStore.delete(b.key); pruned += 1; }
  }

  let emailed = false;
  if (new Date().getUTCDay() === WEEKLY_DAY) {
    await emailBackupOffsite(state, today);
    emailed = !!(process.env.RESEND_API_KEY && process.env.BACKUP_EMAIL_TO);
  }

  return { ok: true, date: today, pruned, emailed };
}

module.exports = { runBackup, KEEP_DAYS };

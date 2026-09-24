const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');
const { appendAudit } = require('./_audit-helpers');
const { loadFullState, saveChangedKeys } = require('./_state-helpers');

const APP_STORE = 'appdata';
const BACKUP_STORE = 'backups';

async function requireAdmin(event) {
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return { error: json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' }) };
  const payload = verifyToken(getBearerToken(event), secret);
  if (!payload) return { error: json(401, { error: 'Not signed in' }) };
  const appStore = getStore(APP_STORE);
  const state = await loadFullState(appStore);
  const me = state && state.staff && state.staff.find((s) => s.id === payload.staffId);
  if (!me || me.role !== 'Admin') return { error: json(403, { error: 'Only an Admin can manage backups' }) };
  return { payload, state };
}

exports.handler = async (event) => {
  connectLambda(event);
  const { error, payload, state } = await requireAdmin(event);
  if (error) return error;

  const backupStore = getStore(BACKUP_STORE);
  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    if (qs.date) {
      const backup = await backupStore.get(`backup:${qs.date}`, { type: 'json' });
      if (!backup) return json(404, { error: 'No backup found for that date' });
      return json(200, backup);
    }
    const { blobs } = await backupStore.list({ prefix: 'backup:' });
    const dates = blobs.map((b) => b.key.replace('backup:', '')).sort().reverse();
    return json(200, { dates });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
    if (body.action === 'restore') {
      const backup = await backupStore.get(`backup:${body.date}`, { type: 'json' });
      if (!backup) return json(404, { error: 'No backup found for that date' });
      const appStore = getStore(APP_STORE);
      await saveChangedKeys(appStore, backup.state);
      await appendAudit(event, { type: 'backup_restored', staffId: payload.staffId, detail: `restored ${body.date}` });
      return json(200, { ok: true });
    }
    if (body.action === 'sendTestEmail') {
      const apiKey = process.env.RESEND_API_KEY;
      const to = process.env.BACKUP_EMAIL_TO;
      if (!apiKey || !to) {
        return json(400, { error: 'Not configured yet — set RESEND_API_KEY and BACKUP_EMAIL_TO as environment variables, then redeploy, before testing.' });
      }
      const from = process.env.BACKUP_EMAIL_FROM || 'Ledger Backups <onboarding@resend.dev>';
      const today = new Date().toISOString().slice(0, 10);
      const json_ = JSON.stringify(state, null, 2);
      const attachmentBase64 = Buffer.from(json_, 'utf8').toString('base64');
      const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: recipients, subject: `Ledger TEST backup email — ${today}`,
          text: 'This is a manual test of the automatic backup email — no need to keep this one unless you want to. If this arrived, the weekly automatic version is configured correctly.',
          attachments: [{ filename: `ledger-backup-test-${today}.json`, content: attachmentBase64 }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return json(502, { error: `Resend rejected the request (${res.status}): ${detail.slice(0, 300)}` });
      }
      await appendAudit(event, { type: 'backup_test_email_sent', staffId: payload.staffId, detail: `to: ${recipients.join(', ')}` });
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  }

  return json(405, { error: 'Method not allowed' });
};

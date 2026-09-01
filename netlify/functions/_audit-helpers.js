// Append-only audit log, stored one Netlify Blob per UTC day.
// Never throws — a logging failure must never block or fail the real request.
const { getStore } = require('./_store-helpers');

const AUDIT_STORE = 'auditlog';
const MAX_PER_DAY = 3000; // safety cap so a runaway loop can't grow a blob unbounded

function dayKey(d) {
  d = d || new Date();
  return 'audit:' + d.toISOString().slice(0, 10);
}

// entry: { type, email, staffId, detail }  — ts and ip are added automatically.
async function appendAudit(event, entry) {
  try {
    const store = getStore(AUDIT_STORE);
    const key = dayKey();
    const existing = (await store.get(key, { type: 'json' })) || [];
    const ip = (event && event.headers &&
      (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'])) || 'unknown';
    existing.push({ ts: new Date().toISOString(), ip, ...entry });
    if (existing.length > MAX_PER_DAY) existing.splice(0, existing.length - MAX_PER_DAY);
    await store.setJSON(key, existing);
  } catch (e) {
    console.error('audit log write failed', e);
  }
}

// Reads the last `days` days of log entries, newest first.
async function readAuditRange(days) {
  const store = getStore(AUDIT_STORE);
  const n = Math.min(Math.max(Number(days) || 30, 1), 90);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const entries = await store.get(dayKey(d), { type: 'json' });
    if (entries && entries.length) out.push(...entries);
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out;
}

module.exports = { appendAudit, readAuditRange };

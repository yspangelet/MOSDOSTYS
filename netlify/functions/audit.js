const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');
const { appendAudit, readAuditRange } = require('./_audit-helpers');
const { loadFullState } = require('./_state-helpers');

const APP_STORE = 'appdata';

exports.handler = async (event) => {
  connectLambda(event);
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const payload = verifyToken(getBearerToken(event), secret);

  // POST: the browser reporting an unhandled JS error or promise rejection. Deliberately does
  // NOT require a valid session — a crash can happen before login too (e.g. on the sign-in
  // screen itself), and that's exactly the kind of thing worth still knowing about. Identity is
  // attached only when a valid token happens to be present. appendAudit's own per-day entry cap
  // is the abuse backstop; the client additionally self-limits to a handful of reports per page
  // load so one looping bug can't flood a day's log and crowd out real security-relevant entries.
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
    const message = String(body.message || '').slice(0, 500);
    if (!message) return json(400, { error: 'Missing message' });
    await appendAudit(event, {
      type: 'client_error',
      staffId: payload && payload.staffId,
      email: payload && payload.email,
      message,
      url: String(body.url || '').slice(0, 300),
      stack: String(body.stack || '').slice(0, 2000),
    });
    return json(200, { ok: true });
  }

  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!payload) return json(401, { error: 'Not signed in' });

  const appStore = getStore(APP_STORE);
  const state = await loadFullState(appStore);
  const me = state && state.staff && state.staff.find((s) => s.id === payload.staffId);
  if (!me || me.role !== 'Admin') return json(403, { error: 'Only an Admin can view the audit log' });

  const days = (event.queryStringParameters && event.queryStringParameters.days) || 30;
  const entries = await readAuditRange(days);
  return json(200, { entries });
};

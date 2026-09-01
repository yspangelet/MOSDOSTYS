const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { loadFullState } = require('./_state-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');
const { nowInSchoolTz, dateStrDaysAgo, fmtDateShort, sendOneReport } = require('./_weekly-compliance-helpers');

const APP_STORE = 'appdata';

// On-demand "send me a test report now," triggered from a button in Settings — a genuinely
// separate, ordinary function from weekly-compliance-report.js, because a scheduled function
// (one with exports.config = { schedule: ... }) can't be invoked directly via a normal request in
// production; Netlify only ever calls those internally, on their own schedule. This one has no
// schedule config, so it's reachable the same way every other action in this app is (transport-
// call.js, transport-sms.js, etc.) — a real POST with a real signed-in session.
//
// Always sends to the requester's OWN email only — there's no parameter to test-send someone
// else's report, so this can't be used to see into a colleague's numbers.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const authPayload = verifyToken(token, secret);
  if (!authPayload) return json(401, { error: 'Not signed in' });
  if (!process.env.RESEND_API_KEY) return json(400, { error: "RESEND_API_KEY isn't set on this site yet — add it in Netlify's environment variables first, then try again." });

  const store = getStore(APP_STORE);
  const state = await loadFullState(store);
  if (!state || state.__bootstrapAdmin) return json(400, { error: 'No real school data yet' });
  const staff = (state.staff || []).find((s) => s.id === authPayload.staffId);
  if (!staff) return json(400, { error: 'No staff record is linked to your account' });
  if (!staff.email) return json(400, { error: 'Add an email address to your own Staff record first (Staff → your card → Edit) — there is nowhere to send a test to otherwise.' });

  const tz = process.env.SCHOOL_TIMEZONE || 'America/New_York';
  const now = nowInSchoolTz(tz);
  const weekEnd = now.dateStr;
  const weekStart = dateStrDaysAgo(weekEnd, 6);
  const weekLabel = `Week of ${fmtDateShort(weekStart)}-${fmtDateShort(weekEnd)}, ${new Date(weekEnd + 'T00:00:00Z').getUTCFullYear()}`;
  const staffById = new Map((state.staff || []).map((s) => [s.id, s]));
  const result = await sendOneReport({ state, staff, weekStart, weekEnd, weekLabel, staffById, isTest: true });
  if (!result.sent) return json(502, { error: 'Resend rejected the send — double-check RESEND_API_KEY is correct, active, and not just a placeholder value.' });
  return json(200, { ok: true, toEmail: staff.email, ccEmails: result.ccEmails });
};

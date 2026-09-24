const { verifyToken, getBearerToken, json } = require('./_auth-helpers');

// A tiny proxy for hebcal.com's own public Gregorian<->Hebrew date converter API — the same
// authoritative source every other Hebrew-date value already in this app was manually verified
// against (see HEBREW_YEAR_DATA in public/index.html). That table is deliberately narrow (only
// the current couple of school years, each cross-checked one at a time against hebcal.com),
// which works fine for a wall calendar but can't cover an arbitrary student or staff member's
// birthdate from any past year. Rather than hand-writing a full Hebrew calendar algorithm (real
// molad/leap-year arithmetic — genuinely easy to get subtly wrong for some date with no way to
// notice), this calls hebcal's own converter directly for whichever date is actually needed, on
// demand, so the answer is authoritative for any date rather than only the few years anyone
// bothered to manually verify. Requires a real signed-in session, same as every other function
// here, so this can't be hammered anonymously even though hebcal.com itself is a free public API.
exports.handler = async (event) => {
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });
  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  const date = event.queryStringParameters && event.queryStringParameters.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Expected ?date=YYYY-MM-DD' });
  try {
    const res = await fetch(`https://www.hebcal.com/converter?cfg=json&date=${date}&g2h=1&strict=1`);
    if (!res.ok) return json(502, { error: 'hebcal.com did not respond as expected' });
    const data = await res.json();
    if (!data || !data.hy) return json(502, { error: 'Unexpected response from hebcal.com' });
    return json(200, { hy: data.hy, hm: data.hm, hd: data.hd, hebrew: data.hebrew || null });
  } catch (e) {
    return json(502, { error: 'Could not reach hebcal.com' });
  }
};

const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { loadFullState } = require('./_state-helpers');
const { nowInSchoolTz, dateStrDaysAgo, fmtDateShort, sendOneReport } = require('./_weekly-compliance-helpers');

const APP_STORE = 'appdata';
const REPORTS_STORE = 'weeklyReports';
const TARGET_WEEKDAY = 'Friday';
const TARGET_HOUR = 14; // 2:00 PM, in the school's local time (America/New_York — see nowInSchoolTz)

exports.handler = async (event) => {
  connectLambda(event);
  const tz = process.env.SCHOOL_TIMEZONE || 'America/New_York';
  const now = nowInSchoolTz(tz);

  const store = getStore(APP_STORE);
  // Cheap check first: read just the one small schedule key directly (not the full state, which
  // loadFullState below fetches as one separate blob read PER top-level field) — this runs once
  // an hour, every hour, all week, so doing the expensive full-state load before knowing whether
  // this is even the right hour would mean ~167 wasted full-state reads a week instead of 1.
  // Falls back to the original Friday/2:00 PM default if a school hasn't set this yet.
  const scheduleRaw = await store.get('sk:weeklyComplianceSchedule', { type: 'json' }).catch(() => null);
  const targetWeekday = (scheduleRaw && scheduleRaw.weekday) || TARGET_WEEKDAY;
  const targetHour = (scheduleRaw && (scheduleRaw.hour === 0 || scheduleRaw.hour)) ? scheduleRaw.hour : TARGET_HOUR;
  if (now.weekday !== targetWeekday || now.hour !== targetHour) {
    return { statusCode: 200, body: `Not the target time (it's ${now.weekday} ${now.hour}:00 in ${tz}; configured for ${targetWeekday} ${targetHour}:00) — skipping.` };
  }

  const reportsStore = getStore(REPORTS_STORE);
  const weekEnd = now.dateStr;
  const weekStart = dateStrDaysAgo(weekEnd, 6);

  // Idempotency — an hourly schedule could in principle fire more than once within the target
  // hour (or Netlify could retry), and nobody wants two copies of the same weekly report.
  const marker = `sent:${weekEnd}`;
  const already = await reportsStore.get(marker, { type: 'json' });
  if (already) return { statusCode: 200, body: `Already sent for week ending ${weekEnd}` };

  // Only load the full state once we know this is genuinely the target hour — everything past
  // this point runs at most once a week, so the cost of a full state load here is a non-issue.
  const state = await loadFullState(store);
  if (!state || state.__bootstrapAdmin) return { statusCode: 200, body: 'No real state yet' };

  const yearRange = (state.yearDateRanges || {})[state.currentYear];
  if (yearRange && yearRange.start && weekEnd < yearRange.start) {
    return { statusCode: 200, body: `Before the school year's first day (${yearRange.start}) — skipping.` };
  }
  if (yearRange && yearRange.end && weekStart > yearRange.end) {
    return { statusCode: 200, body: `After the school year's last day (${yearRange.end}) — skipping.` };
  }

  const weekLabel = `Week of ${fmtDateShort(weekStart)}-${fmtDateShort(weekEnd)}, ${new Date(weekEnd + 'T00:00:00Z').getUTCFullYear()}`;
  const staffById = new Map((state.staff || []).map((s) => [s.id, s]));

  let sentCount = 0, skippedCount = 0;
  for (const staff of state.staff || []) {
    if (staff.active === false || !staff.email) { skippedCount++; continue; }
    const result = await sendOneReport({ state, staff, weekStart, weekEnd, weekLabel, staffById, isTest: false });
    if (!result.items.length) { skippedCount++; continue; } // nothing applicable this week — per design, no email at all
    // Archive the underlying numbers, not the rendered PDF file — cheap to keep indefinitely,
    // and a past week's PDF can always be regenerated from this if anyone needs to see it again.
    await reportsStore.setJSON(`report:${staff.id}:${weekEnd}`, {
      staffId: staff.id, staffName: staff.name, role: staff.role, weekStart, weekEnd, items: result.items, emailed: result.sent, generatedAt: new Date().toISOString(),
    });
    if (result.sent) sentCount++;
  }

  await reportsStore.setJSON(marker, { at: new Date().toISOString(), sentCount, skippedCount });
  return { statusCode: 200, body: `Weekly reports: ${sentCount} sent, ${skippedCount} skipped (no applicable items or no email on file).` };
};

// Runs every hour; the handler itself only acts during the one target hour per week (see
// TARGET_WEEKDAY/TARGET_HOUR above). Requires RESEND_API_KEY to actually send anything — same
// environment variable the optional off-Netlify backup email already uses.
exports.config = { schedule: '0 * * * *' };

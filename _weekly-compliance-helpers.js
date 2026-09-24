// Shared by weekly-compliance-report.js (the real Friday-2pm scheduled run) and
// test-compliance-report.js (an on-demand "send me a test report now" button in Settings).
//
// This split exists because of a real Netlify constraint, not just code organization: a function
// with `exports.config = { schedule: ... }` (like weekly-compliance-report.js) cannot be invoked
// directly via a normal URL/fetch in production — Netlify only ever calls it internally, on its
// own schedule. So there was no way to bolt an on-demand test path onto that same file and
// actually reach it from the app. test-compliance-report.js is a completely ordinary function
// (no schedule config) that the frontend can call normally; both files pull from here so a test
// send is a genuine preview of the real thing, not a separate lookalike path that could quietly
// drift out of sync with it.
const buildSimplePdf = require('./_pdf-mini').buildSimplePdf;

const SHORTFALL_MINUTES = 5; // matches the threshold used elsewhere in the app for "ran short"
const LATE_CONFIRM_DEFAULT_MINUTES = 120; // matches the client default (Settings → Service Requirements → Calendar & Scheduling); a school can override via state.schedulingRules.lateConfirmationThresholdMinutes

// This runs hourly (see weekly-compliance-report.js's exports.config) and only actually does
// anything during the one hour a week that matches TARGET_WEEKDAY/TARGET_HOUR — the same "run
// often, check the real condition inside the handler" pattern already used by
// scheduled-backup.js's WEEKLY_DAY check. Computing local time via Intl instead of a hardcoded
// UTC offset means this stays correct through Daylight Saving changes without needing to be
// touched twice a year.
function nowInSchoolTz(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', hour: 'numeric', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get('weekday'), hour: parseInt(get('hour'), 10), dateStr: `${get('year')}-${get('month')}-${get('day')}` };
}

function dateStrDaysAgo(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// A real school day: one of the school's own weekly school days (defaults to Mon-Fri if that
// isn't set for some reason) AND not a specific calendar-date holiday/day-off entry. Mirrors the
// frontend's isHoliday()/schoolDays check exactly, so a Wednesday holiday is treated identically
// here as it is everywhere else in the app.
function isSchoolDay(state, dateStr) {
  const schoolDays = state.schoolDays && state.schoolDays.length ? state.schoolDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dayName = new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  if (!schoolDays.includes(dayName)) return false;
  if ((state.holidays || []).some((h) => h.date === dateStr)) return false;
  return true;
}

function computeWeeklyMetrics(state, staff, weekStart, weekEnd) {
  const year = state.currentYear;
  const items = []; // { good: bool, text }
  const staffId = staff.id;

  const allDates = [];
  for (let d = weekStart; d <= weekEnd; d = dateStrDaysAgo(d, -1)) allDates.push(d);
  const schoolDates = allDates.filter((d) => isSchoolDay(state, d));
  // A week that's entirely holidays/off days (a full week of winter break, a week straddling
  // Sukkos, etc.) has nothing real to hold anyone accountable for — treated exactly like "no
  // applicable activity this week" everywhere else in this function, which results in no email
  // being sent at all for that person that week, rather than a report full of false "missed"
  // flags for days school was never even open.
  if (!schoolDates.length) return items;

  // --- Session notes + duration shortfalls, for anyone with 1:1 sessions ---
  const mySessions = (state.sessions || []).filter((s) => s.staffIds && s.staffIds.includes(staffId) && s.type === '1:1');
  const lateConfirmThresholdMin = (state.schedulingRules && state.schedulingRules.lateConfirmationThresholdMinutes) || LATE_CONFIRM_DEFAULT_MINUTES;
  // Mirrors confirmationDelayMinutes in index.html exactly — the gap between a session's own
  // scheduled end (on its actual date) and the real moment it was confirmed. Independent of
  // shortfallMinutes: someone can confirm "ran as scheduled" (no duration flag at all, since it
  // assumes the full length happened) for a session they're only now confirming well after it
  // should have run, and this is what catches that specific accountability gap instead.
  function confirmationDelayMinutesServer(dateStr, scheduledEndTime, confirmedAtIso) {
    if (!confirmedAtIso) return null;
    const confirmedAt = new Date(confirmedAtIso);
    const [y, m, d] = dateStr.split('-').map(Number);
    const [eh, em] = scheduledEndTime.split(':').map(Number);
    const scheduledEndAt = new Date(y, m - 1, d, eh, em);
    const diffMin = Math.round((confirmedAt - scheduledEndAt) / 60000);
    return diffMin > 0 ? diffMin : 0;
  }
  if (mySessions.length) {
    let heldCount = 0, missingNoteCount = 0, shortfallCount = 0, skippedCount = 0, unconfirmedCount = 0, lateConfirmCount = 0;
    const confByYear = (state.sessionConfirmations || {})[year] || {};
    schoolDates.forEach((date) => {
      const byId = confByYear[date] || {};
      const dayName = new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
      // Only the sessions that actually recur on this date's weekday — a session doesn't need
      // (or get) a confirmation entry on a day it was never scheduled for in the first place.
      mySessions.filter((s) => s.day === dayName).forEach((s) => {
        const conf = byId[s.id];
        if (!conf) { unconfirmedCount++; return; }
        if (conf.status === 'skipped') { skippedCount++; return; }
        if (conf.status === 'held') {
          heldCount++;
          const hasNote = (state.notes || []).some((n) => n.sessionId === s.id && n.date === date)
            || (state.notes || []).some((n) => n.date === date && s.studentIds.includes(n.studentId) && n.staffId === staffId);
          if (!hasNote && !conf.noteWaived) missingNoteCount++;
          if (conf.shortfallMinutes >= SHORTFALL_MINUTES) shortfallCount++;
          if (!conf.auto && conf.confirmedAt) {
            const delayMin = confirmationDelayMinutesServer(date, s.end, conf.confirmedAt);
            if (delayMin != null && delayMin >= lateConfirmThresholdMin) lateConfirmCount++;
          }
        }
      });
    });
    if (heldCount > 0 || missingNoteCount > 0) {
      items.push({
        good: missingNoteCount === 0,
        text: missingNoteCount === 0
          ? `Session notes: 100% complete (${heldCount} of ${heldCount}) - Great job!`
          : `Session notes: missed ${missingNoteCount} of ${heldCount} held this week`,
      });
    }
    if (shortfallCount > 0) {
      items.push({ good: false, text: `${shortfallCount} session${shortfallCount === 1 ? '' : 's'} ran more than ${SHORTFALL_MINUTES} min short this week` });
    }
    if (lateConfirmCount > 0) {
      const thresholdLabel = lateConfirmThresholdMin >= 60 ? `${Math.round(lateConfirmThresholdMin / 60)} hr` : `${lateConfirmThresholdMin} min`;
      items.push({ good: false, text: `${lateConfirmCount} session${lateConfirmCount === 1 ? '' : 's'} confirmed more than ${thresholdLabel} after their scheduled end this week` });
    }
    if (unconfirmedCount > 0) {
      items.push({ good: false, text: `${unconfirmedCount} session${unconfirmedCount === 1 ? '' : 's'} never confirmed as Held or Skipped` });
    }
  }

  // --- Parent contact, only if this role's rule is actually weekly ---
  const contactRule = (state.contactRules || {})[staff.role];
  if (contactRule && contactRule.period === 'week' && contactRule.count > 0) {
    const myContacts = (state.contacts || []).filter((c) => c.staffId === staffId && c.date >= weekStart && c.date <= weekEnd);
    const met = myContacts.length >= contactRule.count;
    items.push({
      good: met,
      text: met
        ? `Parent contact: 100% complete (${myContacts.length} of ${contactRule.count} required) - Great job!`
        : `Parent contact: ${myContacts.length} of ${contactRule.count} required this week`,
    });
  }

  // --- Lesson plans, only if the school-wide rule is weekly and this looks like a teaching role ---
  const lpRule = state.lessonPlanRule || { count: 0, period: 'week' };
  const looksLikeTeacher = staff.role === 'Teacher' || (state.lessonPlans || []).some((p) => p.teacherId === staffId);
  if (lpRule.period === 'week' && lpRule.count > 0 && looksLikeTeacher) {
    const myPlans = (state.lessonPlans || []).filter((p) => p.teacherId === staffId && p.date >= weekStart && p.date <= weekEnd);
    if (myPlans.length >= lpRule.count) {
      const dueDay = lpRule.dueDayOfWeek;
      const late = dueDay && myPlans.every((p) => {
        const d = new Date((p.updatedAt || p.date) + 'T00:00:00Z');
        return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) !== dueDay
          && d > new Date(weekEnd + 'T23:59:59Z');
      });
      items.push({ good: !late, text: late ? 'Lesson plan submitted, but after the due day' : 'Lesson plan: submitted on time - Great job!' });
    } else {
      items.push({ good: false, text: 'Lesson plan: not submitted this week' });
    }
  }

  return items;
}

function buildEmailHtml({ schoolName, staffName, weekLabel, items }) {
  const rows = items.map((it) => `<tr><td style="padding:4px 0;color:${it.good ? '#1E7A4C' : '#B5720A'};font-weight:${it.good ? '400' : '600'};">${it.good ? 'GOOD' : 'NEEDS ATTENTION'} - ${it.text.replace(/ - Great job!$| this week$/, '')}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:520px;">
    <h2 style="color:#500F32;margin-bottom:2px;">${schoolName} - Weekly Compliance Report</h2>
    <div style="color:#655C6D;margin-bottom:14px;">${staffName} - ${weekLabel}</div>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    <div style="color:#999;font-size:12px;margin-top:16px;">Full PDF copy attached. Questions about anything here? Reach out to your administrator.</div>
  </div>`;
}

async function sendReportEmail({ toEmail, ccEmails, subject, html, pdfBuffer, pdfFilename }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !toEmail) return false;
  const from = process.env.BACKUP_EMAIL_FROM || 'Ledger Reports <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [toEmail], cc: ccEmails && ccEmails.length ? ccEmails : undefined,
        subject, html,
        attachments: [{ filename: pdfFilename, content: pdfBuffer.toString('base64') }],
      }),
    });
    if (!res.ok) { console.error('weekly report email failed', res.status, await res.text().catch(() => '')); return false; }
    return true;
  } catch (e) { console.error('weekly report email failed', e); return false; }
}

// Builds and sends one person's report. In test mode only, a week with nothing applicable still
// sends (with a note saying so) rather than silently doing nothing, since the whole point of a
// test is confirming the email pipeline itself works end-to-end (RESEND_API_KEY, etc.) — "nothing
// happened" can't do that on its own.
async function sendOneReport({ state, staff, weekStart, weekEnd, weekLabel, staffById, isTest }) {
  const items = computeWeeklyMetrics(state, staff, weekStart, weekEnd);
  if (!items.length && !isTest) return { sent: false, items };

  // CCs this specific person's own assigned Supervisor (Staff → their card → Edit → Supervisor),
  // not a blanket CC to every Director in the school — a provider's compliance report is only
  // really useful to whoever actually oversees THEM, and different providers can (and often do)
  // report to different people. No supervisor set on file simply means no CC at all for that
  // person's report, rather than falling back to anyone else by default.
  const supervisor = staff.supervisorId ? staffById.get(staff.supervisorId) : null;
  const ccEmails = (supervisor && supervisor.active !== false && supervisor.email) ? [supervisor.email] : [];
  const displayItems = items.length ? items : [{
    good: true,
    text: 'Nothing to report this week (no applicable sessions, notes, contacts, or lesson plans due) — a real Friday run would not send an email for a week like this.',
  }];

  const pdfItems = [
    { text: `${state.schoolName || 'School'} - Weekly Compliance Report${isTest ? ' (TEST SEND)' : ''}`, size: 16, bold: true, gapAfter: 4 },
    { text: `${staff.name} (${staff.role}) - ${weekLabel}`, size: 12, gapAfter: 14 },
    ...displayItems.map((it) => ({ text: (it.good ? 'GOOD: ' : 'NEEDS ATTENTION: ') + it.text, color: it.good ? [0.12, 0.48, 0.3] : [0.71, 0.45, 0.04] })),
  ];
  const pdfBuffer = buildSimplePdf({ items: pdfItems });
  const html = buildEmailHtml({ schoolName: state.schoolName || 'School', staffName: staff.name, weekLabel: isTest ? `${weekLabel} — TEST SEND` : weekLabel, items: displayItems });
  const ok = await sendReportEmail({
    toEmail: staff.email, ccEmails,
    subject: `${isTest ? '[TEST] ' : ''}Your weekly compliance report - ${weekLabel}`,
    html, pdfBuffer, pdfFilename: `weekly-report-${staff.name.replace(/\s+/g, '_')}-${weekEnd}.pdf`,
  });
  return { sent: ok, items, ccEmails };
}

module.exports = { nowInSchoolTz, dateStrDaysAgo, fmtDateShort, isSchoolDay, computeWeeklyMetrics, buildEmailHtml, sendReportEmail, sendOneReport };

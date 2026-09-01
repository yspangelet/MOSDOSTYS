const { getStore } = require('./_store-helpers');
const { loadFullState, saveChangedKeys } = require('./_state-helpers');

const APP_STORE = 'appdata';

// Sends one SMS through Twilio directly — this runs on a schedule with no signed-in user, so it
// can't go through transport-sms.js (which requires a real browser session token); same Twilio
// REST call, just made straight from here instead.
async function sendSms(notif, to, message) {
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${notif.twilioAccountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${notif.twilioAccountSid}:${notif.twilioAuthToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: notif.twilioPhoneNumber, Body: message }),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

function timeToMin(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function nowInSchoolTZ() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { dayAbbr: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
function todayISOInSchoolTZ() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
// Only phones whose contact has explicitly said yes to texting (the "Can text?" field on each
// parent/guardian in the student record — canText: true/false/null). This automated job fires
// unattended on a schedule with no staff review of who it's about to message, so unlike a
// person clicking a manual "text this parent" button, there is no human in the loop to catch a
// message going to someone who said no or was never asked — the consent flag has to actually be
// enforced here, not just recorded, for it to mean anything.
function studentPhones(student) {
  const nums = new Set();
  [student.mother, student.father].forEach((c) => { if (c && c.cell && c.canText === true) nums.add(c.cell); });
  if (student.parent && student.parent.phone && student.parent.canText === true) nums.add(student.parent.phone);
  return [...nums];
}
// Same shape/logic as the frontend's customTripActiveOn and transport-voice.js's
// customTripActiveOnServer — kept as its own small copy for the same reason noted there (plain
// Node function, no shared bundler with the frontend file).
function customTripActiveOnServer(t, dateISO) {
  if (!t.recurring || t.recurring.type === 'once') return !!(t.recurring && t.recurring.date === dateISO);
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(dateISO + 'T12:00:00Z'));
  if (!(t.recurring.days || []).includes(dow)) return false;
  if (t.recurring.startDate && dateISO < t.recurring.startDate) return false;
  if (t.recurring.endDate && dateISO > t.recurring.endDate) return false;
  return true;
}

// The core job: for every real, scheduled stop time today (regular routes, gated by the school
// calendar same as everywhere else in this module; Custom Routes, deliberately NOT gated, same
// rule as call-in/manual texting), fire one "the bus is about X minutes away" text the first time
// "now" falls inside the configured lead window before that stop's time — never before that
// window opens, never again once it's already fired once for that stop today. Designed to be
// safe to call as often as every 1-2 minutes: a stop already texted today is a no-op every
// subsequent run, and a stop whose window has already fully passed (e.g. this only started
// running hours after school began) is simply skipped rather than fired late.
async function runAutoText() {
  const store = getStore(APP_STORE);
  const state = await loadFullState(store);
  if (!state) return { skipped: true, reason: 'No data yet' };
  const notif = state.transportNotifications || {};
  if (!notif.smsEnabled) return { skipped: true, reason: 'SMS alerts are off' };
  if (!notif.autoTextEnabled) return { skipped: true, reason: 'Automatic lead-time texts are off' };
  if (!notif.twilioAccountSid || !notif.twilioAuthToken || !notif.twilioPhoneNumber) return { skipped: true, reason: 'Twilio not connected' };
  const leadMinutes = Number(notif.autoTextLeadMinutes) || 10;

  const { dayAbbr, minutes: nowMin } = nowInSchoolTZ();
  const dateISO = todayISOInSchoolTZ();

  const holiday = (state.holidays || []).find((h) => h.date === dateISO);
  const schoolDays = state.schoolDays && state.schoolDays.length ? state.schoolDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const yearRange = (state.yearDateRanges || {})[state.currentYear];
  const outsideYear = !!(yearRange && ((yearRange.start && dateISO < yearRange.start) || (yearRange.end && dateISO > yearRange.end)));
  const routesAllowedToday = !holiday && schoolDays.includes(dayAbbr) && !outsideYear;

  const sentLog = state.transportAutoTextSent || {};
  const sentToday = sentLog[dateISO] || {};
  const newlySent = {};
  let sentCount = 0;
  let failCount = 0;

  async function maybeSend(key, scheduledTime, phones, message) {
    if (!scheduledTime || !phones.length) return;
    const schedMin = timeToMin(scheduledTime);
    if (sentToday[key] || newlySent[key]) return;
    if (nowMin < schedMin - leadMinutes || nowMin >= schedMin) return;
    for (const to of phones) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await sendSms(notif, to, message);
      if (ok) sentCount++; else failCount++;
    }
    newlySent[key] = true;
  }

  if (routesAllowedToday) {
    for (const r of (state.transportRoutes || [])) {
      for (const dir of ['am', 'pm']) {
        for (const entry of (r[dir] || [])) {
          if (entry.oneOffDate && entry.oneOffDate !== dateISO) continue;
          const stop = (state.transportStops || []).find((s) => s.id === entry.stopId);
          const riders = (state.students || []).filter((s) => s.usesTransportation !== false && s.transportStopId === entry.stopId);
          const phones = new Set();
          riders.forEach((s) => studentPhones(s).forEach((p) => phones.add(p)));
          if (!phones.size) continue;
          const key = r.id + '_' + dir + '_' + entry.stopId;
          const message = `${state.schoolName || 'School'} transportation: the bus is expected at ${stop ? stop.label : 'your stop'} in about ${leadMinutes} minutes.`;
          // eslint-disable-next-line no-await-in-loop
          await maybeSend(key, entry.time, [...phones], message);
        }
      }
    }
  }

  for (const t of (state.transportCustomTrips || [])) {
    if (!customTripActiveOnServer(t, dateISO)) continue;
    const stops = t.stops && t.stops.length ? t.stops : (t.pickupAddress ? [{ id: 'legacy', riderName: t.riderName || '', riderPhone: t.riderPhone || '', time: t.time || '', studentId: t.studentId || null }] : []);
    for (const s of stops) {
      const phones = new Set();
      if (s.riderPhone) phones.add(s.riderPhone);
      if (s.studentId) {
        const student = (state.students || []).find((st) => st.id === s.studentId);
        if (student) studentPhones(student).forEach((p) => phones.add(p));
      }
      if (!phones.size) continue;
      const key = 'trip_' + t.id + '_' + s.id;
      const message = `${state.schoolName || 'School'} transportation: the vehicle is expected for ${s.riderName || 'your pickup'} in about ${leadMinutes} minutes.`;
      // eslint-disable-next-line no-await-in-loop
      await maybeSend(key, s.time, [...phones], message);
    }
  }

  if (Object.keys(newlySent).length) {
    const updatedSentLog = { ...sentLog, [dateISO]: { ...sentToday, ...newlySent } };
    // Trim anything older than 14 days so this doesn't grow forever — today's own entries are
    // always safe (just written above), only past days' bookkeeping gets dropped.
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    Object.keys(updatedSentLog).forEach((d) => { if (d < cutoff) delete updatedSentLog[d]; });
    await saveChangedKeys(store, { transportAutoTextSent: updatedSentLog });
  }

  return { ok: true, sent: sentCount, failed: failCount };
}

module.exports = { runAutoText };

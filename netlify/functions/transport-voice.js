const crypto = require('crypto');
const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');

const APP_STORE = 'appdata';
const SK_PREFIX = 'sk:';

function twiml(inner) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    // A short <Pause> before anything is spoken, on every single response this line generates
    // (first pickup, and every subsequent turn after a caller presses digits) — without it, the
    // opening word or two routinely gets clipped on calls where the audio path connects a beat
    // after the line picks up, or where the phone shows/dismisses a "call connected" UI first.
    // One change here covers every TwiML response in this file rather than needing it repeated
    // at each of the several places below that generate one.
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/>${inner}</Response>`,
  };
}

function parseFormBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

// Twilio signs every webhook request with the account's Auth Token so a spoofed POST from
// anyone who isn't actually Twilio gets rejected outright, rather than this endpoint trusting
// whatever hits the URL. Skipped only if no Auth Token is on file yet (nothing to verify against).
function validTwilioSignature(event, authToken, params) {
  const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  if (!signature || !authToken) return false;
  const url = `https://${event.headers.host}${event.path}`;
  let data = url;
  Object.keys(params).sort().forEach((k) => { data += k + params[k]; });
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  return expected === signature;
}

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}

async function loadTransportState(store) {
  const keys = [
    'students', 'transportRoutes', 'transportStops', 'transportNotifications',
    'transportLog', 'transportLiveLocations', 'transportSettings', 'schoolName', 'schoolPhone',
    'holidays', 'schoolDays', 'yearDateRanges', 'currentYear',
    // Added for Custom Routes support — same store, same keys the frontend already reads/writes.
    'transportCustomTrips', 'customTripLog',
    // Added so a completed run can say so outright, instead of describing individual stop
    // check-ins/live position as if the route were still in progress — same completion record
    // "✅ Mark route complete" writes in the app (see markLegCompleted/isLegCompleted).
    'transportRouteCompletions',
    // Added so the live-location supplementary sentence can reverse-geocode an actual street
    // location instead of naming a stop that only happens to be geographically nearest — see
    // reverseGeocodeServer below. Without this, the key was never loaded into `state` at all,
    // so it was silently unavailable no matter what the rest of this file tried to do with it.
    'googleMapsApiKey',
  ];
  const result = {};
  await Promise.all(keys.map(async (k) => { result[k] = await store.get(SK_PREFIX + k, { type: 'json' }); }));
  return result;
}

function findFamilyByPhone(students, callerDigits) {
  return (students || []).filter((s) => {
    const numbers = [s.homePhone, s.mother && s.mother.cell, s.father && s.father.cell, s.parent && s.parent.phone]
      .map(normalizePhone)
      .filter(Boolean);
    return numbers.includes(callerDigits);
  });
}

function studentCurrentRoute(state, student) {
  if (!student.transportStopId) return null;
  return (state.transportRoutes || []).find((r) =>
    (r.am || []).some((e) => e.stopId === student.transportStopId) ||
    (r.pm || []).some((e) => e.stopId === student.transportStopId)
  ) || null;
}

function timeToMin(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
// Server time is UTC by default on Netlify — converted here to America/New_York, since that's
// where this school is. If this school is ever in a different time zone, this is the one line
// to change.
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
function currentDirection(state, dayAbbr, nowMin) {
  const t = state.transportSettings || {};
  const ov = (t.dayOverrides && t.dayOverrides[dayAbbr]) || {};
  const amMin = timeToMin(ov.amArrival || t.amArrival || '8:00');
  const pmMin = timeToMin(ov.pmDismissal || t.pmDismissal || '15:30');
  return nowMin < (amMin + pmMin) / 2 ? 'am' : 'pm';
}
function fmtTime12(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
function fmtDateSpoken(iso) {
  if (!iso) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}
// Same derivation as the Live Map's hover tooltip and the History tab (see
// stopArrivalTimesForRoute in the frontend) — the earliest rider check-in recorded at a stop
// today. There's no continuous GPS trail kept, only live position pings and driver check-ins, so
// this is the most honest signal available for "what time was the bus actually there."
function stopArrivalTime(state, routeId, dir, dateISO, stopId) {
  const log = ((state.transportLog || {})[dateISO] || {})[routeId + '_' + dir] || {};
  const riderIds = (state.students || [])
    .filter((s) => s.usesTransportation !== false && s.transportStopId === stopId)
    .map((s) => s.id);
  const times = riderIds.map((id) => log[id]).filter(Boolean).map((e) => e.time).sort();
  return times[0] || null;
}
function findStopTime(route, dir, stopId) {
  const entry = (route[dir] || []).find((e) => e.stopId === stopId);
  return entry ? entry.time : null;
}
function haversineMilesServer(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Turns a live GPS point into something speakable — a real street location, not a guess at which
// stop is geographically closest. Naming "the nearest stop" was actively wrong whenever the
// straight-line-closest stop wasn't really where the bus is (a stop on a parallel street, or one
// the bus hasn't reached yet on a winding route) — this describes the GPS position itself
// instead, so it can never misattribute the bus's real location to the wrong stop's name. Same
// Google Maps key already used for forward geocoding elsewhere.
//
// Two earlier versions of this tried to name a nearby CROSS street — first by scanning for a
// result Google had already classified as an "intersection" (confirmed, in practice, to
// essentially never happen for a live GPS ping), then by sampling a few points a short distance
// around the location and checking for a different street name nearby. That second approach
// still failed for a location sitting right at the edge of a large park: several of the sampled
// directions land inside the park itself, where there's no road grid at all, so they never
// actually reach the real cross street just a short distance away along the road.
//
// This uses a genuinely more robust signal instead: Google's own street-NUMBER interpolation.
// RANGE_INTERPOLATED geocoding already reliably estimates a specific street number for
// essentially any point along a mapped road — including a stretch that runs beside a park with
// no buildings on that side — by interpolating between the nearest two known numbered addresses
// on that block, which is exactly the situation a plain street name or a cross-street guess both
// struggled with. A single call, no sampling, no assumption that a cross street happens to be
// reachable nearby.
async function reverseGeocodeServer(apiKey, lat, lng) {
  if (!apiKey || lat == null || lng == null) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || !data.results.length) return null;
    const top = data.results[0];
    const components = top.address_components || [];
    const streetNumber = components.find((c) => c.types.includes('street_number'));
    const route = components.find((c) => c.types.includes('route'));
    if (streetNumber && route) return `${streetNumber.long_name} ${route.long_name}`;
    if (route) return route.long_name;
    // No street-level component at all (rare — usually a very rural or very approximate fix) —
    // a short prefix of the full formatted address is still better than nothing, without
    // reading a caller the entire city/state/zip over the phone.
    return top.formatted_address ? top.formatted_address.split(',')[0] : null;
  } catch (e) {
    console.error('reverseGeocodeServer failed:', e);
    return null;
  }
}
// Where the bus actually is along an ordered stop list right now, for the phone line to describe
// in terms a caller can use ("the route is now after stop 3; your stop is number 5"). Deliberately
// based ONLY on actual rider check-ins logged today (ground truth — a check-in only happens once
// the driver is physically there and marks it) — NOT on live GPS proximity to a stop. A live
// position can be close to a LATER stop on the map for reasons that have nothing to do with
// having reached it yet (a detour, a road that loops near a stop before actually arriving there,
// one-way streets), and progress should only ever reflect what the driver has actually confirmed,
// never a guess from where the dot happens to be sitting on a map. Returns null if nothing has
// been checked in yet today.
function currentStopProgress(orderedStops, log, studentsByStopId) {
  let loggedIdx = -1;
  orderedStops.forEach((s, i) => {
    const ridersHere = studentsByStopId[s.id] || [];
    if (ridersHere.some((studentId) => log[studentId])) loggedIdx = i;
  });
  if (loggedIdx < 0) return null;
  return { idx: loggedIdx };
}
// Mirrors isLegCompleted in index.html exactly — true once a driver has actually pressed "✅ Mark
// route complete" (or a Custom Trip's equivalent) for this specific leg today, not just inferred
// from every rider happening to be checked off.
function isLegCompletedServer(state, dateISO, key) {
  return !!(((state.transportRouteCompletions || {})[dateISO] || {})[key]);
}
// Same calendar rule as Driver View, Reports, and Attendance History in the app itself: a
// holiday, a non-school weekday, or a date outside the school year's actual start/end range all
// mean "nothing is expected to run today" for a REGULAR ROUTE — a fact that has nothing to do
// with any particular route or stop, so it's checked once, up front. Deliberately NOT applied to
// Custom Routes below — those are explicitly for things outside the regular school calendar (an
// orientation pickup before the year starts, a summer program run), same rule Driver View and
// Reports already use for them.
function notASchoolDayReason(state, dayAbbr, dateISO) {
  const holiday = (state.holidays || []).find((h) => h.date === dateISO);
  if (holiday) return `${holiday.label || 'School is closed'} today.`;
  const schoolDays = state.schoolDays && state.schoolDays.length ? state.schoolDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (!schoolDays.includes(dayAbbr)) return 'Today is not a school day.';
  const yearRange = (state.yearDateRanges || {})[state.currentYear];
  if (yearRange && yearRange.start && dateISO < yearRange.start) return `The school year has not started yet — classes begin ${fmtDateSpoken(yearRange.start)}.`;
  if (yearRange && yearRange.end && dateISO > yearRange.end) return 'The school year has already ended.';
  return null;
}

// Reports the real, current status for a REGULAR ROUTE — a driver's actual boarded/absent mark
// for today if one's been recorded, otherwise the most recent stop check-in or live position
// update, and only falling back to the plain scheduled time if none of today's real activity is
// available yet (e.g. the driver hasn't started the route). Returns plain message TEXT (no <Say>
// wrapper, no <Hangup/>) so multiple results — a caller with more than one child, or a child on
// both a route and a Custom Route — can be composed together into one call instead of the old
// behavior of refusing outright the moment there was more than one match.
async function studentStatusText(student, state, dateISO, dayAbbr, minutes) {
  if (student.usesTransportation === false || !student.transportStopId) {
    return `${student.name} is not currently set up for school transportation.`;
  }
  const stop = (state.transportStops || []).find((s) => s.id === student.transportStopId);
  if (!stop) {
    return `We could not find a stop on file for ${student.name}.`;
  }
  const route = studentCurrentRoute(state, student);
  if (!route) {
    return `${student.name} does not have a bus route set up today.`;
  }
  const closedReason = notASchoolDayReason(state, dayAbbr, dateISO);
  if (closedReason) {
    return `${closedReason} No transportation is scheduled for ${student.name} today.`;
  }
  const dir = currentDirection(state, dayAbbr, minutes);
  const legLabel = dir === 'am' ? 'morning pickup' : 'afternoon drop-off';
  const key = route.id + '_' + dir;
  const log = ((state.transportLog || {})[dateISO] || {})[key] || {};
  const entry = log[student.id];

  // Computed once, up front, so every branch below — completed, already picked up/dropped off,
  // or still in progress — can include it, not just the "hasn't happened yet" case. A rider who
  // missed the bus (or a parent double-checking after their own child was already marked) needs
  // to know where the bus IS RIGHT NOW just as much as anyone still waiting on it — knowing
  // someone else already got picked up doesn't tell a family whether it's still worth trying to
  // catch up with the bus at its current spot.
  const live = (state.transportLiveLocations || {})[key];
  const liveAgeMin = live ? Math.round((Date.now() - live.updatedAt) / 60000) : null;
  const isLiveNow = live && liveAgeMin != null && liveAgeMin < 20;
  // Describes the actual GPS location by reverse-geocoding it to a real street name — never by
  // naming "the nearest stop," which risked naming a DIFFERENT stop than where the bus genuinely
  // is (a stop on a parallel street, or one on the route the bus hasn't actually reached yet, can
  // easily be the closest by straight-line distance without being anywhere close to accurate).
  // Still never touches the actual progress statement below (myStopNum/busStopNum) — that stays
  // 100% grounded in real check-ins, exactly as designed, specifically so a detour or a road that
  // loops near a later stop can never overstate progress. This only changes what the SEPARATE,
  // already explicitly "approximate" supplementary sentence describes.
  const nearStreet = isLiveNow ? await reverseGeocodeServer(state.googleMapsApiKey, live.lat, live.lng) : null;
  const liveNote = isLiveNow
    ? ` The driver is currently sharing their location, last updated ${liveAgeMin < 1 ? 'less than a minute ago' : liveAgeMin + ' minutes ago'}${nearStreet ? ', near ' + nearStreet : ''}.`
    : '';

  // "Completed" here means a driver actually pressed "✅ Mark route complete" (or the app's own
  // GPS-arrival prompt confirmed it for them — see maybePromptArrival in index.html) for TODAY's
  // run specifically. Checked FIRST and answered plainly — a caller whose child's leg is done
  // shouldn't hear "hasn't happened yet" just because that one rider never got an individual
  // check-in mark (a route can finish with someone left unmarked; that's a real gap worth
  // knowing about, not something to paper over with confusing not-yet-happened language).
  if (isLegCompletedServer(state, dateISO, key)) {
    if (entry) {
      if (entry.status === 'absent') return `${student.name} was marked absent today for the ${legLabel}${entry.time ? ' at ' + fmtTime12(entry.time) : ''}. This route has been completed.${liveNote}`;
      return `${student.name} was ${dir === 'am' ? 'picked up' : 'dropped off'} at ${stop.label} at ${fmtTime12(entry.time)}. This route has been completed.${liveNote}`;
    }
    return `This route has been completed. There is no record of ${student.name} being boarded or marked absent — please contact the school directly if you have questions.${liveNote}`;
  }

  if (entry) {
    if (entry.status === 'absent') {
      return `For ${student.name}'s ${legLabel}, the driver marked them absent today${entry.time ? ' at ' + fmtTime12(entry.time) : ''}.${liveNote}`;
    }
    return `${student.name} was ${dir === 'am' ? 'picked up' : 'dropped off'} at ${stop.label} at ${fmtTime12(entry.time)}.${liveNote}`;
  }

  // Not completed, and this specific student hasn't been checked in yet — describe overall route
  // progress purely from what's actually been MARKED so far (see currentStopProgress; never from
  // live GPS proximity alone, so a detour or an out-of-order stop can't make this claim more
  // progress than the driver has actually confirmed).
  const orderedStops = (route[dir] || []).map((e) => (state.transportStops || []).find((s) => s.id === e.stopId)).filter(Boolean);
  const myIdx = orderedStops.findIndex((s) => s.id === stop.id);
  const studentsByStopId = {};
  (state.students || []).forEach((s) => { if (s.transportStopId) (studentsByStopId[s.transportStopId] = studentsByStopId[s.transportStopId] || []).push(s.id); });
  const progress = currentStopProgress(orderedStops, log, studentsByStopId);

  if (myIdx < 0) {
    return `${student.name}'s ${legLabel} has not been recorded yet today.${liveNote}`;
  }
  const myStopNum = myIdx + 1;
  if (!progress) {
    return `The route is now before stop number 1. ${student.name}'s stop is number ${myStopNum}.${liveNote}`;
  }
  const busStopNum = progress.idx + 1;
  // "by stop number X" was meant as "progress has reached past X, now heading to X+1" but reads
  // as ambiguous in spoken English — easy to hear as "the bus is currently located at/near X,"
  // which is exactly backwards once the driver has actually already left that stop. "after stop
  // number X" says the same true thing (this is the last stop actually confirmed) without that
  // ambiguity. Left "at stop number X, which is [name]'s stop" (the one exception, below)
  // unchanged — that specifically means the caller's OWN stop was the one just handled, which
  // "at" describes accurately.
  if (myStopNum < busStopNum) {
    return `${student.name}'s stop, number ${myStopNum}, was already picked up. The route is now after stop number ${busStopNum}.${liveNote}`;
  }
  if (myStopNum === busStopNum) {
    return `The route is now at stop number ${busStopNum}, which is ${student.name}'s stop.${liveNote}`;
  }
  return `The route is now after stop number ${busStopNum}. ${student.name}'s stop is number ${myStopNum}.${liveNote}`;
}

// ---------- Custom Routes (one-time/repeating trips, not tied to the am/pm route model) ----------
// Mirrors the exact same shape/logic as the frontend's customTripStops/customTripTitle/
// customTripActiveOn (see public/index.html) — kept as small, separate copies here rather than a
// shared import, since this is a plain Node function with no bundler and the frontend file isn't
// requireable as-is. Any change to those three on the frontend should be mirrored here too.
function customTripStopsOf(t) {
  if (t.stops && t.stops.length) return t.stops;
  if (t.pickupAddress) return [{ id: 'legacy', riderName: t.riderName || '', riderPhone: t.riderPhone || '', address: t.pickupAddress, time: t.time || '', studentId: t.studentId || null }];
  return [];
}
function customTripTitleOf(t) {
  if (t.name && t.name.trim()) return t.name.trim();
  const stops = customTripStopsOf(t);
  if (!stops.length) return '(no riders yet)';
  if (stops.length === 1) return stops[0].riderName || '(unnamed rider)';
  return stops.map((s) => s.riderName || '?').join(', ');
}
function customTripActiveOnServer(t, dateISO) {
  if (!t.recurring || t.recurring.type === 'once') return !!(t.recurring && t.recurring.date === dateISO);
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(dateISO + 'T12:00:00Z'));
  if (!(t.recurring.days || []).includes(dow)) return false;
  if (t.recurring.startDate && dateISO < t.recurring.startDate) return false;
  if (t.recurring.endDate && dateISO > t.recurring.endDate) return false;
  return true;
}
// Deliberately NOT gated by notASchoolDayReason — Custom Routes exist specifically for things
// outside the regular school calendar (see the comment on that function above).
async function tripStopStatusText(trip, stop, state, dateISO) {
  const riderLabel = stop.riderName || '(unnamed rider)';
  const tripName = customTripTitleOf(trip);
  const log = ((state.customTripLog || {})[dateISO] || {})[trip.id] || {};
  const entry = log[stop.id];

  // Computed once, up front, so every branch below — completed, already picked up, or still in
  // progress — can include it, not just the "hasn't happened yet" case. See the identical
  // reasoning in studentStatusText above: someone who missed the ride needs to know where the
  // vehicle IS RIGHT NOW just as much as anyone still waiting on it.
  const live = (state.transportLiveLocations || {})['trip_' + trip.id];
  const liveAgeMin = live ? Math.round((Date.now() - live.updatedAt) / 60000) : null;
  const isLiveNow = liveAgeMin != null && liveAgeMin < 20;
  // Same fix as the regular-route version above (see the comment there for the full reasoning):
  // reverse-geocodes the actual GPS position to a real street name instead of naming "the
  // nearest stop" — which risked naming a DIFFERENT stop than where the bus genuinely is. The
  // actual progress statement below (myStopNum/busStopNum) is completely untouched — still 100%
  // grounded in real check-ins.
  const nearStreet = (isLiveNow && live) ? await reverseGeocodeServer(state.googleMapsApiKey, live.lat, live.lng) : null;
  const liveNote = isLiveNow
    ? ` The driver is currently sharing their location, last updated ${liveAgeMin < 1 ? 'less than a minute ago' : liveAgeMin + ' minutes ago'}${nearStreet ? ', near ' + nearStreet : ''}.`
    : '';

  // Same completed-first handling as the regular-route version — a caller shouldn't hear "hasn't
  // happened yet" for a trip that's actually done just because this one rider never got an
  // individual check-in mark.
  if (isLegCompletedServer(state, dateISO, 'trip_' + trip.id)) {
    if (entry) {
      if (entry.status === 'absent') return `${riderLabel} was marked absent today for the ${tripName} trip${entry.time ? ' at ' + fmtTime12(entry.time) : ''}. This route has been completed.${liveNote}`;
      return `${riderLabel} was picked up for the ${tripName} trip at ${fmtTime12(entry.time)}. This route has been completed.${liveNote}`;
    }
    return `This route has been completed. There is no record of ${riderLabel} being picked up or marked absent — please contact the school directly if you have questions.${liveNote}`;
  }

  if (entry) {
    if (entry.status === 'absent') {
      return `${riderLabel} was marked absent today for the ${tripName} trip${entry.time ? ' at ' + fmtTime12(entry.time) : ''}.${liveNote}`;
    }
    return `${riderLabel} was picked up for the ${tripName} trip at ${fmtTime12(entry.time)}.${liveNote}`;
  }

  // Not completed, and this rider hasn't been checked in yet — same log-only progress rule as
  // the regular-route version (see currentStopProgress): never inferred from live GPS proximity
  // alone, so a detour can't make this claim more progress than the driver has actually marked.
  const orderedStops = customTripStopsOf(trip);
  const myIdx = orderedStops.findIndex((s) => s.id === stop.id);
  const studentsByStopId = {};
  orderedStops.forEach((s) => { studentsByStopId[s.id] = [s.id]; });
  const pseudoLog = {};
  orderedStops.forEach((s) => { if (log[s.id]) pseudoLog[s.id] = log[s.id]; });
  const progress = currentStopProgress(orderedStops, pseudoLog, studentsByStopId);

  if (myIdx < 0) {
    return `${riderLabel}'s ${tripName} trip has not been recorded yet today.${liveNote}`;
  }
  const myStopNum = myIdx + 1;
  if (!progress) {
    return `The route is now before stop number 1. ${riderLabel}'s stop is number ${myStopNum}.${liveNote}`;
  }
  const busStopNum = progress.idx + 1;
  if (myStopNum < busStopNum) {
    return `${riderLabel}'s stop, number ${myStopNum}, was already picked up. The route is now after stop number ${busStopNum}.${liveNote}`;
  }
  if (myStopNum === busStopNum) {
    return `The route is now at stop number ${busStopNum}, which is ${riderLabel}'s stop.${liveNote}`;
  }
  return `The route is now after stop number ${busStopNum}. ${riderLabel}'s stop is number ${myStopNum}.${liveNote}`;
}

// One caller can legitimately match more than one thing: two enrolled children, a child who's on
// a regular route AND separately listed on a Custom Route today, or someone who isn't an
// enrolled student at all but is a named rider on a Custom Route stop (matched by that stop's own
// phone number instead). Every one of those gets its own status line rather than the old
// behavior, which flatly refused the moment there was more than one student match.
function findAllMatches(state, callerDigits, dateISO) {
  const results = [];
  const students = findFamilyByPhone(state.students, callerDigits);
  students.forEach((student) => results.push({ kind: 'route', student }));
  const matchedStudentIds = new Set(students.map((s) => s.id));
  (state.transportCustomTrips || []).forEach((trip) => {
    if (!customTripActiveOnServer(trip, dateISO)) return;
    customTripStopsOf(trip).forEach((stop) => {
      const linkedToMatchedStudent = stop.studentId && matchedStudentIds.has(stop.studentId);
      const directPhoneMatch = stop.riderPhone && normalizePhone(stop.riderPhone) === callerDigits;
      if (linkedToMatchedStudent || directPhoneMatch) results.push({ kind: 'trip', trip, stop });
    });
  });
  return results;
}

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function composeTwiml(matches, state) {
  const { dayAbbr, minutes } = nowInSchoolTZ();
  const dateISO = todayISOInSchoolTZ();
  const lines = await Promise.all(matches.map((m) => (
    m.kind === 'route'
      ? studentStatusText(m.student, state, dateISO, dayAbbr, minutes)
      : tripStopStatusText(m.trip, m.stop, state, dateISO)
  )));
  const intro = matches.length > 1 ? `Thank you for calling. We found ${matches.length} riders on this number. ` : 'Thank you for calling. ';
  return twiml(`<Say>${escXml(intro)}</Say>` + lines.map((l) => `<Say>${escXml(l)}</Say>`).join('') + `<Say>Goodbye.</Say>`);
}

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore(APP_STORE);
  const state = await loadTransportState(store);
  const notif = state.transportNotifications || {};
  const params = parseFormBody(event);

  if (notif.twilioAuthToken && !validTwilioSignature(event, notif.twilioAuthToken, params)) {
    return twiml('<Say>This call could not be verified. Goodbye.</Say><Hangup/>');
  }

  const callerDigits = normalizePhone(params.From);
  const dateISO = todayISOInSchoolTZ();
  const matches = findAllMatches(state, callerDigits, dateISO);

  if (matches.length) return await composeTwiml(matches, state);

  // Caller ID didn't match anyone on file — fall back to the numeric lookup code (see
  // generateTransportLookupCode in the frontend). This used to compare against the raw student
  // id, which looks like "stu_a1b2c3d" — letters included, so a phone keypad could never
  // actually produce a match. A student without a code generated yet simply can't be looked up
  // this way until the office generates one for them.
  if (params.Digits) {
    const digits = String(params.Digits).trim();
    const student = (state.students || []).find((s) => s.transportLookupCode && s.transportLookupCode === digits);
    if (student) {
      // Combine with any Custom Route stops already linked to this same student — same idea as
      // findAllMatches for caller-ID matching, so entering a student's own code reports
      // everything relevant to them, not just their regular route, if they're also a rider on a
      // one-time/repeating trip today.
      const matches = [{ kind: 'route', student }];
      (state.transportCustomTrips || []).forEach((trip) => {
        if (!customTripActiveOnServer(trip, dateISO)) return;
        customTripStopsOf(trip).forEach((stop) => { if (stop.studentId === student.id) matches.push({ kind: 'trip', trip, stop }); });
      });
      return await composeTwiml(matches, state);
    }
    // Not a student's code — check every active Custom Route stop's own lookup code instead, for
    // a rider who isn't an enrolled student at all (no student record to generate one on) — see
    // generateCtsLookupCode in the frontend, set per-stop in the trip's Edit modal.
    let stopMatch = null;
    (state.transportCustomTrips || []).forEach((trip) => {
      if (stopMatch || !customTripActiveOnServer(trip, dateISO)) return;
      const stop = customTripStopsOf(trip).find((s) => s.lookupCode && s.lookupCode === digits);
      if (stop) stopMatch = { trip, stop };
    });
    if (stopMatch) return await composeTwiml([{ kind: 'trip', trip: stopMatch.trip, stop: stopMatch.stop }], state);
    return twiml('<Say>We could not find a student with that code. Please contact the transportation office directly. Goodbye.</Say><Hangup/>');
  }
  return twiml(
    `<Gather numDigits="4" action="${event.path}" method="POST" timeout="8">` +
      `<Say>Thank you for calling. We could not match your number to a student on file. Please enter your child's four digit phone lookup code, then press pound.</Say>` +
    `</Gather><Say>We did not receive any input. Please contact the transportation office directly. Goodbye.</Say>`
  );
};

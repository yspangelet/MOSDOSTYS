const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { loadFullState } = require('./_state-helpers');

const APP_STORE = 'appdata';

// This is a public, auto-refreshing display with no one signed in to trigger a manual reload —
// every response must explicitly forbid caching, or the browser (or an intermediary CDN) can
// legitimately keep serving a stale snapshot instead of hitting this function on each refresh.
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    body: JSON.stringify(body),
  };
}

// Deliberately public, no auth — this is meant to be left open on a lobby TV/kiosk with nobody
// signed in. Returns only a small, computed summary (never the raw state, never anything not
// already meant for public display): today's absent students (first name + last initial, not
// full name, since this is visible to anyone walking by — parents, delivery people, visitors),
// today's absent staff (full name — not minors, lower sensitivity), and any active lobby
// announcements. Nothing here can be used to write anything; this function only ever reads.
function firstNameLastInitial(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || 'Student';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  try {
    const state = await loadFullState(getStore(APP_STORE));
    if (!state || state.__bootstrapAdmin) return json(200, { ready: false });

    // Attendance/absences are keyed by the browser's LOCAL calendar date (see dateToLocalISO in
    // the main app), not UTC — so this endpoint can't just compute "today" from the server's own
    // clock. A server has no reliable notion of "the school's timezone" on its own, but the
    // lobby screen itself does (it's physically sitting in the building), so it passes its own
    // local date along and this trusts that over a UTC guess. Falls back to UTC only if the
    // param is missing/malformed, e.g. an old cached page hitting a fresh deploy.
    const qsDate = (event.queryStringParameters || {}).date;
    const today = /^\d{4}-\d{2}-\d{2}$/.test(qsDate || '') ? qsDate : new Date().toISOString().slice(0, 10);
    const year = state.currentYear;

    const attendanceToday = (state.attendance && state.attendance[year] && state.attendance[year][today]) || {};
    const absentStudents = Object.entries(attendanceToday)
      .filter(([, rec]) => rec && rec.status === 'absent')
      .map(([studentId]) => (state.students || []).find((s) => s.id === studentId))
      .filter(Boolean)
      .map((s) => firstNameLastInitial(s.name));

    const staffAbsToday = (state.staffAbsences && state.staffAbsences[year] && state.staffAbsences[year][today]) || {};
    const absentStaff = Object.keys(staffAbsToday)
      .map((staffId) => (state.staff || []).find((s) => s.id === staffId))
      .filter(Boolean)
      .map((s) => s.name);

    const lobbyMessages = (state.messages || [])
      .filter((m) => (m.toIds || []).includes('LOBBY') && (!m.lobbyThrough || m.lobbyThrough >= today))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // School Calendar events flagged "Also show on the lobby screen" — same idea as lobby
    // messages above, but for calendar events (Picture Day, early dismissal, etc.) rather than
    // announcements. Only today's active ones show, same "today" date the rest of this endpoint
    // already uses (the school's own local date, passed in as a query param).
    const calendarToday = (state.calendarEvents || [])
      .filter((e) => e.showOnLobby && today >= e.date && today <= (e.endDate || e.date))
      .map((e) => e.title);

    // Photos live in their own blob (see data.js `messagePhoto` resource) rather than inline
    // in the message, so an announcement with a photo needs its own fetch here. This runs
    // server-side with store access the public kiosk itself never gets, so the lobby screen
    // can show the photo without ever needing an auth token of its own.
    const store = getStore(APP_STORE);
    const announcements = await Promise.all(
      lobbyMessages.map(async (m) => {
        let photo = null;
        if (m.hasPhoto) {
          photo = await store.get('msgPhoto:' + m.id, { type: 'text' }).catch(() => null);
        }
        return {
          text: m.subject ? `${m.subject}: ${m.body}` : m.body,
          photo: photo || null,
        };
      })
    );

    let schoolLogoDataUrl = await store.get('schoolLogo', { type: 'text' }).catch(() => null);
    if (!schoolLogoDataUrl && typeof state.schoolLogoDataUrl === 'string' && state.schoolLogoDataUrl.length > 500) {
      // Belt-and-suspenders: normally the logo lives only in its own blob (see data.js), but
      // if a save somehow left it sitting in the main state document instead (e.g. an old
      // client that predates that split), don't just show nothing — use it.
      schoolLogoDataUrl = state.schoolLogoDataUrl;
    }

    return json(200, {
      ready: true,
      schoolName: state.schoolName || '',
      schoolLogoDataUrl,
      date: today,
      absentStudents,
      absentStaff,
      announcements,
      calendarToday,
    });
  } catch (e) {
    console.error('lobby endpoint failed', e);
    return json(500, { error: 'Could not load lobby data' });
  }
};

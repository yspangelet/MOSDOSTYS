const crypto = require('crypto');
const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const { verifyToken, getBearerToken, json } = require('./_auth-helpers');
const { appendAudit } = require('./_audit-helpers');
const { loadFullState, saveChangedKeys, syncTestModeRole } = require('./_state-helpers');

const APP_STORE = 'appdata';

// Structural fields that stay strictly Admin-only, never delegable: creating/switching
// academic years is a significant data operation that has no assignable permission.
// roles/rolePermissions used to be hard-locked here too; they're now gated by the
// managePermissions permission instead (see the dedicated check below), so a role like
// "Director" can be granted control over that screen without editing this file again.
const STRICT_ADMIN_FIELDS = ['years', 'currentYear'];
// Other Settings fields, each gated by its own assignable permission (see PERMISSION_DEFS
// in the frontend) rather than being hard-locked to Admin.
const FIELD_PERMISSION_MAP = {
  schoolName: 'editSchoolInfo', schoolAddress: 'editSchoolInfo', schoolPhone: 'editSchoolInfo', schoolEIN: 'editSchoolInfo', schoolLogoDataUrl: 'editSchoolInfo',
  dayHours: 'editSchoolCalendar', schoolDays: 'editSchoolCalendar', holidays: 'editSchoolCalendar',
  contactRules: 'editContactRules',
  lessonPlanRule: 'editLessonPlanRule',
  emailjsConfig: 'manageEmailSettings',
  serviceDefaults: 'editServiceDefaults',
  defaultGroupActivities: 'editServiceDefaults',
  leadershipMeetings: 'accessLeadershipMeetings',
  leadershipMeetingTypes: 'accessLeadershipMeetings',
  adminMeetingGroups: 'manageAdminMeetingGroups',
  lobbyAnnouncements: 'manageLobbyDisplay',
  boardPresidentStaffId: 'manageHRIntake',
  onboardingDocChecklist: 'manageHRIntake',
  onboardingDocDismissals: 'manageHRIntake',
  transportSettings: 'manageTransportSetup',
  transportStops: 'manageTransportSetup',
  buses: 'manageTransportRoutes',
  transportRoutes: 'manageTransportRoutes',
  transportNotifications: 'manageTransportNotifications',
  googleMapsApiKey: 'manageTransportNotifications',
};
// These mirror the Setup tab, gated by the configurable "editSetup" permission.
const SETUP_FIELDS = ['staff', 'classes', 'students'];

function byId(arr) {
  const m = new Map();
  (arr || []).forEach((x) => x && x.id != null && m.set(x.id, x));
  return m;
}

function roleOf(state, staffId) {
  const s = (state.staff || []).find((x) => x.id === staffId);
  return s ? s.role : null;
}

// Returns every individual permission flag that flipped between oldState and newState,
// as { role, key, from, to }. Used both to enforce the managePermissions rules below and
// to write a specific, human-readable audit entry instead of a generic "state_saved".
function diffRolePermissionChanges(oldState, newState) {
  const changes = [];
  const oldRP = (oldState && oldState.rolePermissions) || {};
  const newRP = newState.rolePermissions || {};
  const roles = new Set([...Object.keys(oldRP), ...Object.keys(newRP)]);
  for (const role of roles) {
    const oldPerms = oldRP[role] || {};
    const newPerms = newRP[role] || {};
    const keys = new Set([...Object.keys(oldPerms), ...Object.keys(newPerms)]);
    for (const key of keys) {
      if (!!oldPerms[key] !== !!newPerms[key]) {
        changes.push({ role, key, from: !!oldPerms[key], to: !!newPerms[key] });
      }
    }
  }
  return changes;
}

function hasPerm(state, role, key) {
  if (role === 'Admin') return true;
  const perms = state.rolePermissions && state.rolePermissions[role];
  return !!(perms && perms[key]);
}

// Admin Meeting content lives in dynamically-named fields (adminMeetings_<groupId>) — one real,
// separate top-level field per group — specifically so a member of one group can never
// accidentally overwrite another group's data on save (see filterStateForRole for the read
// side of this same design). Since these field names aren't known in advance, they can't go in
// the static FIELD_PERMISSION_MAP above; this walks changedKeys for anything matching the
// pattern and checks real membership in that specific group instead.
const ADMIN_MEETINGS_KEY_RE = /^adminMeetings_(.+)$/;
function findAdminMeetingsViolations(oldState, newState, changedKeys, role, staffId) {
  const v = [];
  if (role === 'Admin') return v;
  const canManageAllGroups = hasPerm(newState, role, 'manageAdminMeetingGroups');
  if (canManageAllGroups) return v;
  for (const key of Object.keys(changedKeys)) {
    const match = key.match(ADMIN_MEETINGS_KEY_RE);
    if (!match) continue;
    if (JSON.stringify(oldState ? oldState[key] : undefined) === JSON.stringify(changedKeys[key])) continue;
    const groupId = match[1];
    const groups = newState.adminMeetingGroups || (oldState && oldState.adminMeetingGroups) || [];
    const group = groups.find((g) => g.id === groupId);
    const isMember = !!(group && (group.memberIds || []).includes(staffId));
    if (!isMember) v.push(`edit "${key}" — you're not a member of this Admin Meeting group — refused`);
  }
  return v;
}

// New hire applications now carry a two-stage signature (Administrator, then Board President)
// that's meant to stand as real proof an approval happened — so, mirroring
// findReportApprovalViolations below, only someone with the manageHRIntake permission (or
// Admin) may touch this collection at all. This is a blanket guard rather than field-by-field:
// the signature fields are exactly as sensitive as the rest of the record, and splitting hairs
// over which specific field changed would just be more surface area for a bypassed UI to slip
// through on.
function findHireApplicationViolations(oldState, newState, role) {
  const v = [];
  if (JSON.stringify(oldState.hireApplications) === JSON.stringify(newState.hireApplications)) return v;
  if (hasPerm(newState, role, 'manageHRIntake')) return v;
  v.push('edit "hireApplications" — editing new hire applications requires the manageHRIntake permission');
  return v;
}

// A hire application's status only ever moves forward through pending -> pending_board ->
// signed -> converted, driven exclusively by the dedicated hireAppSignature/conversion actions
// (which always write from a freshly-loaded, authoritative copy of state — never from whatever
// the browser happened to be holding). The one real risk is a DIFFERENT, ordinary edit to the
// application (or an unrelated field entirely) arriving from a client whose local copy of
// hireApplications predates someone else's signature — e.g. an Admin's browser tab that's been
// open since before the Board President signed, which still shows "pending_board" locally.
// That client's own next save resends its whole (now-stale) hireApplications array as
// "changed," and without this guard, a stale-but-permitted Admin save would silently revert a
// real signature back to unsigned — exactly the class of bug the CRITICAL_NONEMPTY_FIELDS check
// already guards against for whole-array emptying, just for a single item's forward-progress
// fields instead. This reconciles rather than blocks: it protects the signature timeline
// specifically while still allowing that same save through for any other legitimate field the
// client actually meant to change (name, phone, position, etc.) on that or any other application.
const HIRE_APP_STATUS_RANK = { pending: 0, pending_board: 1, signed: 2, converted: 3 };
const HIRE_APP_PROGRESS_FIELDS = [
  'status', 'adminSignedBy', 'adminSignedAt', 'adminSignatureName', 'adminSignatureDataUrl', 'adminConsent',
  'boardLinkCreatedAt', 'boardSignedBy', 'boardSignedAt', 'boardSignatureName', 'boardSignatureDataUrl', 'boardConsent',
  'hrNotifyPending', 'convertedStaffId',
];
function reconcileHireApplications(oldList, newList) {
  if (!Array.isArray(oldList) || !Array.isArray(newList)) return newList;
  const oldById = new Map(oldList.map((a) => [a.id, a]));
  return newList.map((incoming) => {
    const prior = oldById.get(incoming.id);
    if (!prior) return incoming; // a genuinely new application — nothing to reconcile against
    const oldRank = HIRE_APP_STATUS_RANK[prior.status] ?? -1;
    const newRank = HIRE_APP_STATUS_RANK[incoming.status] ?? -1;
    if (newRank >= oldRank) return incoming; // moving forward (or staying put) — trust it as-is
    // The incoming copy is behind where this application already is — keep every real signing/
    // progress field from the server's newer version, but still honor any other field the
    // client legitimately edited in this same save (name, phone, position, etc.).
    const reconciled = { ...incoming };
    for (const f of HIRE_APP_PROGRESS_FIELDS) reconciled[f] = prior[f];
    return reconciled;
  });
}

// Applies real server-side read filtering — not just UI hiding — to the specific pieces of
// state where it's safe to do without risking other features that assume full visibility
// (dropdowns, cross-student scheduling checks, substitute coverage, etc. all still need broad
// access to run correctly, which is why this is deliberately narrow rather than a blanket
// per-role state filter). Only qualifies for collections that are (a) all-or-nothing
// permission-gated in the UI already, so nothing legitimate ever needs partial access, and
// (b) never written back as a partial/filtered array by the same client — the client always
// resaves whatever collection it has locally in full, so filtering something a user might also
// write to (e.g. messages) would let their filtered view silently overwrite everyone else's
// data on their next save. That rules out anything with per-user partial visibility until a
// proper merge-on-write path exists for it — a separate, larger piece of work.
// Anything not covered here (students, notes, reports, attendance, messages, etc.) still relies
// on the client's own UI to scope visibility for now.
function filterStateForRole(state, role, staffId) {
  if (!state || role === 'Admin') return state; // Admin always sees everything, unfiltered
  const filtered = { ...state };
  if (!hasPerm(state, role, 'accessLeadershipMeetings')) {
    // Send an explicit empty array rather than omitting the key. The client always
    // re-initializes any *missing* field to [] immediately after load (see migrateState),
    // before the "what did we last save" snapshot is taken — omitting the key here would
    // make that fresh [] look like a real local change on the very next autosave, and get
    // rejected outright by the write-permission check below. Sending [] up front avoids the
    // mismatch entirely while still hiding every real leadership-meeting record and detail.
    filtered.leadershipMeetings = [];
  }
  // Admin Meeting groups: redact any group's meeting content the requester isn't a member of
  // (unless they manage groups generally). The group *definitions* (adminMeetingGroups — name,
  // membership list, recurrence) are deliberately NOT redacted here: they're low-sensitivity
  // (no meeting content), and redacting that array too would hit the exact same partial-array
  // overwrite risk described above, since it's a single shared collection every group's members
  // would otherwise be resaving a filtered copy of.
  if (!hasPerm(state, role, 'manageAdminMeetingGroups')) {
    const groups = state.adminMeetingGroups || [];
    for (const key of Object.keys(state)) {
      const match = key.match(ADMIN_MEETINGS_KEY_RE);
      if (!match) continue;
      const group = groups.find((g) => g.id === match[1]);
      const isMember = !!(group && (group.memberIds || []).includes(staffId));
      if (!isMember) filtered[key] = [];
    }
  }
  // Staff documents: for now, hidden entirely from anyone without manageHRIntake or Admin —
  // deliberately no exception even for someone's own documents, at the school's explicit
  // request (this is stricter than most permission checks elsewhere in the app). Hiding the
  // list in the UI alone isn't real protection here — the general state load is one plain
  // object every logged-in client receives, so an unredacted array would let anyone open
  // devtools and read every staff member's document names/types (TB test results, background
  // checks, etc.) regardless of what the rendered page shows.
  if (!hasPerm(state, role, 'manageHRIntake') && !hasPerm(state, role, 'approveOnboardingDocs')) {
    filtered.staffDocuments = [];
  }
  // Student documents: unlike staff documents, most of these are fine for anyone who already
  // has access to that student (progress notes, scanned prior records, etc.) — only documents
  // specifically marked privileged at upload time (SSN copies, sensitive legal/consent forms)
  // get held back from viewers without viewPrivilegedStudentDocs or Admin. Same reasoning as
  // every other per-role redaction here: this has to happen in the actual state payload, not
  // just the rendered page, or anyone could read the redacted entries via devtools.
  if (!hasPerm(state, role, 'viewPrivilegedStudentDocs')) {
    filtered.studentDocuments = (state.studentDocuments || []).filter((d) => !d.privileged);
  }
  return filtered;
}

// Summarizes what a save actually changed, for the generic "state_saved" audit entry — this
// used to log nothing beyond "a save happened," which made the audit log useless for answering
// "what data was saved" after the fact. For an array-shaped top-level key (reports, students,
// sessions, etc. — nearly everything in this app), diffs by item id against the previous state
// to report specific added/updated/removed counts rather than just naming the key; for anything
// else (an object or scalar, like serviceDefaults or schoolName), just names the key, since a
// meaningful diff isn't as well-defined there. Deliberately stays at counts, not full content —
// enough to know what happened without the audit log itself becoming a second copy of the data.
function summarizeChangedKeys(oldState, changedKeys) {
  const parts = [];
  Object.keys(changedKeys).forEach((k) => {
    const newVal = changedKeys[k];
    const oldVal = oldState ? oldState[k] : undefined;
    if (Array.isArray(newVal) && (oldVal === undefined || Array.isArray(oldVal))) {
      const oldById = new Map((oldVal || []).filter((x) => x && x.id).map((x) => [x.id, x]));
      const newById = new Map(newVal.filter((x) => x && x.id).map((x) => [x.id, x]));
      let added = 0, removed = 0, modified = 0;
      newById.forEach((v, id) => {
        if (!oldById.has(id)) added++;
        else if (JSON.stringify(oldById.get(id)) !== JSON.stringify(v)) modified++;
      });
      oldById.forEach((v, id) => { if (!newById.has(id)) removed++; });
      const bits = [];
      if (added) bits.push(`${added} added`);
      if (modified) bits.push(`${modified} updated`);
      if (removed) bits.push(`${removed} removed`);
      parts.push(bits.length ? `${k} (${bits.join(', ')})` : `${k} (no item changes)`);
    } else {
      parts.push(k);
    }
  });
  return parts.join('; ');
}

// Compares oldState -> newState and returns an array of human-readable violation
// strings for any change that the requester's role isn't allowed to make.
// This is deliberately conservative: on any ambiguity it lets the change through
// rather than risk locking staff out of legitimate work. It is a real backstop
// against a bypassed UI, not a full field-by-field ACL system.
function findViolations(oldState, newState, role, staffId) {
  const v = [];
  if (!oldState) return v; // first save ever (bootstrap) — nothing to compare against

  // 1) Structural fields: always Admin-only, not delegable via rolePermissions.
  for (const f of STRICT_ADMIN_FIELDS) {
    if (JSON.stringify(oldState[f]) !== JSON.stringify(newState[f]) && role !== 'Admin') {
      v.push(`edit "${f}" is restricted to Admin`);
    }
  }

  // 1b) Other Settings fields: each gated by its own assignable permission.
  for (const [f, permKey] of Object.entries(FIELD_PERMISSION_MAP)) {
    if (JSON.stringify(oldState[f]) !== JSON.stringify(newState[f]) && !hasPerm(newState, role, permKey)) {
      v.push(`edit "${f}" requires the ${permKey} permission`);
    }
  }

  // 1c) Setup fields: staff, classes, students — gated by the editSetup permission. "staff"
  // specifically also allows a second, narrower path: manageHRIntake alone may ADD a brand-new
  // staff record (never modify or remove an existing one) — this is exactly what converting a
  // signed New Hire Application into a staff profile does, and the client UI for that action is
  // deliberately gated on manageHRIntake alone, documented as sufficient for this one specific
  // action, not editSetup (the two are intentionally separable permissions elsewhere in this
  // app too). Without this, someone who legitimately holds only manageHRIntake could complete
  // the whole conversion flow in the UI — build the signed HAF PDF, upload every attachment —
  // only to have the actual staff record silently rejected at the very last step.
  for (const f of SETUP_FIELDS) {
    if (JSON.stringify(oldState[f]) === JSON.stringify(newState[f])) continue;
    if (hasPerm(newState, role, 'editSetup')) continue;
    if (f === 'staff' && hasPerm(newState, role, 'manageHRIntake')) {
      const oldById = byId(oldState.staff);
      const newById = byId(newState.staff);
      const isAdditionOnly = [...oldById.entries()].every(([id, rec]) => {
        const updated = newById.get(id);
        return updated && JSON.stringify(updated) === JSON.stringify(rec);
      });
      const newRecordsAreNonAdmin = [...newById.entries()]
        .filter(([id]) => !oldById.has(id))
        .every(([, rec]) => rec.role !== 'Admin');
      if (isAdditionOnly && newRecordsAreNonAdmin) continue; // allowed: pure addition, no Admin role granted
    }
    v.push(`edit "${f}" requires the editSetup permission`);
  }

  // 1d) Admin protection: having editSetup lets a role edit the staff list, but that alone must
  // never be enough to touch an existing Admin's own record, or to grant the Admin role to anyone
  // (including themselves) — otherwise any role with editSetup could quietly self-promote or lock
  // out the real admins. Only an actual Admin may do either of these.
  if (role !== 'Admin' && JSON.stringify(oldState.staff) !== JSON.stringify(newState.staff)) {
    const oldStaffById = byId(oldState.staff);
    const newStaffById = byId(newState.staff);
    for (const [id, oldStaff] of oldStaffById) {
      if (oldStaff.role === 'Admin') {
        const updated = newStaffById.get(id);
        if (!updated || JSON.stringify(updated) !== JSON.stringify(oldStaff)) {
          v.push("editing or removing an Admin's own staff record requires being an Admin");
          break;
        }
      }
    }
    for (const [id, newStaff] of newStaffById) {
      const prior = oldStaffById.get(id);
      if (newStaff.role === 'Admin' && (!prior || prior.role !== 'Admin')) {
        v.push('granting the Admin role requires being an Admin');
        break;
      }
    }
  }

  // 1e) Roles list (add/remove a role) and rolePermissions (the checkbox grid) are gated by
  // the managePermissions permission rather than hard-locked to Admin, so a role like
  // "Director" can be granted this screen. Two things stay Admin-only regardless, even for
  // someone who has managePermissions: editing Admin's own row, and flipping the
  // managePermissions flag itself — otherwise a delegated manager could mint more managers
  // (or quietly grant Admin-equivalent access) with nothing to stop them.
  const rolesChanged = JSON.stringify(oldState.roles) !== JSON.stringify(newState.roles);
  const rolePermsChanged = JSON.stringify(oldState.rolePermissions) !== JSON.stringify(newState.rolePermissions);
  if (role !== 'Admin' && (rolesChanged || rolePermsChanged)) {
    if (!hasPerm(newState, role, 'managePermissions')) {
      v.push('editing roles or permissions requires the managePermissions permission');
    } else {
      for (const c of diffRolePermissionChanges(oldState, newState)) {
        if (c.role === 'Admin') v.push("editing Admin's own permissions requires being an Admin");
        if (c.key === 'managePermissions') v.push('granting or revoking managePermissions itself requires being an Admin');
      }
    }
  }

  // 2) Sessions: structural edits need editSchedule; removing a session needs deleteSessions.
  const oldSessions = byId(oldState.sessions);
  const newSessions = byId(newState.sessions);
  if (oldSessions.size !== newSessions.size || JSON.stringify(oldState.sessions) !== JSON.stringify(newState.sessions)) {
    for (const id of oldSessions.keys()) {
      if (!newSessions.has(id) && !hasPerm(newState, role, 'deleteSessions')) {
        v.push('deleting a session requires the deleteSessions permission');
      }
    }
    const editedOrAdded = [...newSessions.entries()].some(([id, s]) => !oldSessions.has(id) || JSON.stringify(oldSessions.get(id)) !== JSON.stringify(s));
    if (editedOrAdded && !hasPerm(newState, role, 'editSchedule')) {
      v.push('adding/editing a session requires the editSchedule permission');
    }
  }

  // 2b) One-date-only reschedules/cancellations: full editSchedule can change any date's
  // override for any session. A more limited editOwnScheduleToday can only change *today's*
  // date, and only for sessions the requester is personally staffed on — lets a therapist
  // shift their own time or cancel for today without handing them the recurring-schedule
  // editSchedule permission. "Today" is judged by the server's own clock, not the client's.
  if (JSON.stringify(oldState.sessionOverrides) !== JSON.stringify(newState.sessionOverrides) && !hasPerm(newState, role, 'editSchedule')) {
    if (!hasPerm(newState, role, 'editOwnScheduleToday')) {
      v.push('changing a session for a specific date requires the editSchedule permission');
    } else {
      const todayStr = new Date().toISOString().slice(0, 10);
      const sessById = byId(newState.sessions);
      const oldYears = oldState.sessionOverrides || {};
      const newYears = newState.sessionOverrides || {};
      for (const year of new Set([...Object.keys(oldYears), ...Object.keys(newYears)])) {
        const oldOv = oldYears[year] || {};
        const newOv = newYears[year] || {};
        for (const date of new Set([...Object.keys(oldOv), ...Object.keys(newOv)])) {
          const oldDay = oldOv[date] || {};
          const newDay = newOv[date] || {};
          for (const sid of new Set([...Object.keys(oldDay), ...Object.keys(newDay)])) {
            if (JSON.stringify(oldDay[sid]) === JSON.stringify(newDay[sid])) continue;
            if (date !== todayStr) { v.push('changing a session override for a date other than today requires the editSchedule permission'); continue; }
            const sess = sessById.get(sid);
            if (!sess || !(sess.staffIds || []).includes(staffId)) v.push('editOwnScheduleToday only covers sessions you are personally staffed on');
          }
        }
      }
    }
  }

  // 2c) Same delegation pattern for a one-off lunch-break override: editSchedule can set
  // anyone's, any date; editOwnScheduleToday can only set their own, and only for today.
  if (JSON.stringify(oldState.staffLunchDateOverrides) !== JSON.stringify(newState.staffLunchDateOverrides) && !hasPerm(newState, role, 'editSchedule')) {
    if (!hasPerm(newState, role, 'editOwnScheduleToday')) {
      v.push('changing a lunch-break override requires the editSchedule permission');
    } else {
      const todayStr = new Date().toISOString().slice(0, 10);
      const oldYears = oldState.staffLunchDateOverrides || {};
      const newYears = newState.staffLunchDateOverrides || {};
      for (const year of new Set([...Object.keys(oldYears), ...Object.keys(newYears)])) {
        const oldOv = oldYears[year] || {};
        const newOv = newYears[year] || {};
        for (const date of new Set([...Object.keys(oldOv), ...Object.keys(newOv)])) {
          const oldDay = oldOv[date] || {};
          const newDay = newOv[date] || {};
          for (const sid of new Set([...Object.keys(oldDay), ...Object.keys(newDay)])) {
            if (JSON.stringify(oldDay[sid]) === JSON.stringify(newDay[sid])) continue;
            if (date !== todayStr) { v.push('changing a lunch-break override for a date other than today requires the editSchedule permission'); continue; }
            if (sid !== staffId) v.push('editOwnScheduleToday only covers your own lunch break');
          }
        }
      }
    }
  }

  // 3) Notes & contacts: deleting someone else's requires deleteNotes; deleting your own is always OK.
  for (const key of ['notes', 'contacts']) {
    const oldItems = byId(oldState[key]);
    const newItems = byId(newState[key]);
    for (const [id, item] of oldItems) {
      if (!newItems.has(id) && item.staffId !== staffId && !hasPerm(newState, role, 'deleteNotes')) {
        v.push(`deleting a ${key.slice(0, -1)} you don't own requires deleteNotes`);
      }
    }
  }

  // 4) Reports: deletions need deleteReports (own drafts may always be deleted by their author).
  const oldReports = byId(oldState.reports);
  const newReports = byId(newState.reports);
  for (const [id, r] of oldReports) {
    if (!newReports.has(id)) {
      const ownDraft = r.authorId === staffId && r.status === 'draft';
      if (!ownDraft && !hasPerm(newState, role, 'deleteReports')) {
        v.push('deleting a report requires the deleteReports permission');
      }
    }
  }

  // 5) Report templates (document types) need manageTemplates.
  if (JSON.stringify(oldState.reportTemplates) !== JSON.stringify(newState.reportTemplates) && !hasPerm(newState, role, 'manageTemplates')) {
    v.push('managing document types requires the manageTemplates permission');
  }

  // 6) Team meetings: deleting someone else's requires deleteNotes; deleting your own is always OK.
  const oldMeetings = byId(oldState.teamMeetings);
  const newMeetings = byId(newState.teamMeetings);
  for (const [id, meeting] of oldMeetings) {
    if (!newMeetings.has(id) && meeting.createdBy !== staffId && !hasPerm(newState, role, 'deleteNotes')) {
      v.push(`deleting a team meeting you don't own requires deleteNotes`);
    }
  }

  return v;
}

// Report status escalation (submit → approved/revision) is checked separately because it
// depends on the *report's own* approverId, not just a blanket permission.
function findReportApprovalViolations(oldState, newState, staffId, role) {
  const v = [];
  if (!oldState) return v;
  const oldReports = byId(oldState.reports);
  for (const r of (newState.reports || [])) {
    const old = oldReports.get(r.id);
    if (!old || old.status === r.status) continue;
    const isApprovalMove = (old.status === 'submitted') && (r.status === 'approved' || r.status === 'revision');
    if (!isApprovalMove) continue;
    const isDesignatedApprover = r.approverId ? r.approverId === staffId : false;
    const allowed = role === 'Admin' || isDesignatedApprover || hasPerm(newState, role, 'approveReports');
    if (!allowed) v.push(`edit "reports" — approving/returning report ${r.id} requires the approveReports permission or being its assigned approver`);
  }

  // A locked (approved) report can't have its content changed while still locked — it must
  // be explicitly unlocked first (which itself requires approveReports), closing off a path
  // to silently edit an approved report's content behind its already-attached signatures.
  for (const r of (newState.reports || [])) {
    const old = oldReports.get(r.id);
    if (!old || !old.locked || !r.locked) continue; // only relevant if it was locked and still is
    if (JSON.stringify(old.fields) !== JSON.stringify(r.fields) && !hasPerm(newState, role, 'approveReports')) {
      v.push(`edit "reports" — editing locked report ${r.id} requires unlocking it first (approveReports permission)`);
    }
  }
  return v;
}

// Same bug class as reconcileHireApplications above, applied where reports have the equivalent
// risk: a stale client (a browser tab that's been open since before a report was approved,
// still holding the pre-approval copy) later saving something unrelated resends its whole
// reports array as "changed" — and without this, that stale copy would silently un-approve /
// unlock the report, discarding both signatures and the approval history entry, with nothing
// in the existing checks to catch it (findReportApprovalViolations above only validates FORWARD
// approval moves and edits to an already-locked report — it never looks at a report going
// approved -> anything else). Unlike hire applications, reports have one legitimate reason to
// move backward — Admin/approveReports explicitly unlocking an approved report to fix a mistake
// — so this can't be a blanket "never regress" rule. Instead: only reconcile (restore the
// server's approved/locked copy wholesale) when the request COULDN'T have legitimately produced
// that regression, i.e. the requester lacks approveReports and isn't the report's own designated
// approver. A request that does hold that permission is trusted as a deliberate unlock.
function reconcileReports(oldList, newList, role, newState, staffId) {
  if (!Array.isArray(oldList) || !Array.isArray(newList)) return newList;
  const oldById = new Map(oldList.map((r) => [r.id, r]));
  return newList.map((incoming) => {
    const prior = oldById.get(incoming.id);
    if (!prior) return incoming; // a genuinely new report — nothing to reconcile against
    const wasApprovedLocked = prior.status === 'approved' && prior.locked === true;
    const stillApprovedLocked = incoming.status === 'approved' && incoming.locked === true;
    if (!wasApprovedLocked || stillApprovedLocked) return incoming; // no regression to check
    const isDesignatedApprover = prior.approverId ? prior.approverId === staffId : false;
    const allowedToUnlock = role === 'Admin' || isDesignatedApprover || hasPerm(newState, role, 'approveReports');
    if (allowedToUnlock) return incoming; // trusted as a deliberate unlock, not staleness
    return prior; // restore the server's real, still-approved copy wholesale
  });
}

// A message flagged to broadcast beyond its normal recipients — the public lobby screen
// ('LOBBY') and/or a Dashboard banner for its recipients ('DASHBOARD') — requires the
// manageLobbyDisplay permission. Checked as a diff (new message, or an edit that newly adds
// either flag to an existing one) rather than a whole-field gate, since Messages otherwise has
// no permission restrictions at all (anyone can message anyone).
const BROADCAST_MARKERS = ['LOBBY', 'DASHBOARD'];
function findLobbyMessageViolations(oldState, newState, role) {
  const v = [];
  if (!oldState || hasPerm(newState, role, 'manageLobbyDisplay')) return v;
  const oldById = new Map((oldState.messages || []).map((m) => [m.id, m]));
  for (const m of (newState.messages || [])) {
    const old = oldById.get(m.id);
    for (const marker of BROADCAST_MARKERS) {
      const was = !!(old && (old.toIds || []).includes(marker));
      const is = (m.toIds || []).includes(marker);
      if (is && !was) {
        v.push('edit "messages" — flagging a message to broadcast beyond its recipients requires the manageLobbyDisplay permission');
        break;
      }
    }
  }
  return v;
}

// Mirrors transportOverrideActiveOn/activeTransportOverrideForStudent/studentCurrentRoute from
// index.html — same reasoning as customTripActiveOnServer above (plain Node function, no
// shared import), kept in sync with those by hand.
function overrideActiveOnServer(o, dateISO) {
  if (!o.recurring || o.recurring.type === 'once') return !!(o.recurring && o.recurring.date === dateISO);
  if (o.recurring.type === 'range') return dateISO >= o.recurring.startDate && (!o.recurring.endDate || dateISO <= o.recurring.endDate);
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(dateISO + 'T12:00:00Z'));
  if (!(o.recurring.days || []).includes(dow)) return false;
  if (o.recurring.startDate && dateISO < o.recurring.startDate) return false;
  if (o.recurring.endDate && dateISO > o.recurring.endDate) return false;
  return true;
}
function studentNormalRouteIdServer(state, student) {
  if (!student.transportStopId) return null;
  const r = (state.transportRoutes || []).find((r) => (r.am || []).some((e) => e.stopId === student.transportStopId) || (r.pm || []).some((e) => e.stopId === student.transportStopId));
  return r ? r.id : null;
}
// Every student a given staff member is currently allowed to mark attendance for via
// Transportation specifically — a regular route's stops (using TODAY's driver, accounting for a
// same-day swap override, same rule as the UI's own effectiveRouteAssignment), a Custom Trip's
// stops, AND anyone riding via a temporary transport-address override today whose resolved route
// (the override's own routeId if set, otherwise their normal route) is one of this driver's
// routes — covering the case where a driver's rider list for today differs from students'
// permanent transportStopId assignment (a one-time/weekly-recurring temporary pickup added to
// their route, or someone else's regular rider borrowed onto it for a day). Mirrors the exact
// rider lists a driver's own Driver View shows them, so anything they can see and mark there is
// something this is guaranteed to allow.
function transportAuthorizedStudentIds(state, staffId) {
  const ids = new Set();
  const stopStudents = {};
  (state.students || []).forEach((s) => {
    if (s.usesTransportation !== false && s.transportStopId) {
      (stopStudents[s.transportStopId] = stopStudents[s.transportStopId] || []).push(s.id);
    }
  });
  const today = new Date().toISOString().slice(0, 10);
  const myRouteIds = new Set();
  (state.transportRoutes || []).forEach((r) => {
    const ov = r.todayOverride;
    const from = ov && (ov.fromDate || ov.date);
    const to = ov && (ov.toDate || ov.date);
    const overrideActive = ov && from && to && today >= from && today <= to ? ov : null;
    const effectiveDriverId = (overrideActive && overrideActive.driverId) || r.driverId;
    const isMyRoute = effectiveDriverId === staffId || (r.staffIds || []).includes(staffId);
    if (!isMyRoute) return;
    myRouteIds.add(r.id);
    ['am', 'pm'].forEach((dir) => {
      (r[dir] || []).forEach((entry) => {
        (stopStudents[entry.stopId] || []).forEach((id) => ids.add(id));
      });
    });
  });
  (state.students || []).forEach((s) => {
    if (s.usesTransportation === false) return;
    ['am', 'pm'].forEach((dir) => {
      const overrides = (s.transportOverrides || []).filter((o) => (o.direction === 'both' || o.direction === dir) && overrideActiveOnServer(o, today));
      const override = overrides.length ? overrides[overrides.length - 1] : null;
      if (!override) return;
      const resolvedRouteId = override.routeId || studentNormalRouteIdServer(state, s);
      if (resolvedRouteId && myRouteIds.has(resolvedRouteId)) ids.add(s.id);
    });
  });
  (state.transportCustomTrips || []).forEach((t) => {
    if (t.driverId !== staffId) return;
    (t.stops || []).forEach((s) => { if (s.studentId) ids.add(s.studentId); });
  });
  return ids;
}
// Attendance: allowed if the requester has markAttendance, is assigned staff on at least one
// session for that student in the relevant year (mirrors the UI's own rule), OR is the driver who
// legitimately marked them boarded/absent from Transportation's Driver View (see
// markStudentTransportStatus/setAttendanceFromTransport and markCustomTripStopStatus in
// index.html) — that flow deliberately writes to Attendance as its whole point, for drivers who
// realistically never have markAttendance and have no session of their own with this student, so
// without this exemption every single one of those legitimate writes was rejected outright.
function findAttendanceViolations(oldState, newState, staffId, role) {
  const v = [];
  if (!oldState || hasPerm(newState, role, 'markAttendance')) return v;
  if (JSON.stringify(oldState.attendance) === JSON.stringify(newState.attendance)) return v;

  const assignedStudentIds = new Set(
    (newState.sessions || []).filter((s) => (s.staffIds || []).includes(staffId)).flatMap((s) => s.studentIds || []),
  );
  const transportStudentIds = transportAuthorizedStudentIds(newState, staffId);

  for (const year of Object.keys(newState.attendance || {})) {
    const oldYear = (oldState.attendance || {})[year] || {};
    const newYear = newState.attendance[year] || {};
    for (const date of Object.keys(newYear)) {
      const oldDay = oldYear[date] || {};
      const newDay = newYear[date] || {};
      for (const studentId of Object.keys(newDay)) {
        if (JSON.stringify(oldDay[studentId]) !== JSON.stringify(newDay[studentId]) && !assignedStudentIds.has(studentId) && !transportStudentIds.has(studentId)) {
          v.push(`edit "attendance" — marking attendance for a student outside your assigned sessions or transportation route/trip requires markAttendance`);
        }
      }
    }
  }
  return v;
}

// Fields where a save that reduces them from non-empty to completely empty is almost certainly
// an accidental overwrite (a stale tab, a timing race on load) rather than something deliberate
// — deliberate clears (deleting the very last item, or the Danger Zone wipe tool) pass the field
// name in body.allowEmptyFields to get through. This is enforced here, not just client-side,
// since the client is exactly what might be buggy in the scenario this protects against.
const CRITICAL_NONEMPTY_FIELDS = ['staff', 'students', 'classes', 'reportTemplates', 'roles', 'notes', 'reports', 'sessions', 'attendance', 'hireApplications', 'buses', 'transportRoutes'];
function isEmptyValue(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
function findEmptyOverwriteViolations(oldState, changedKeys, allowEmptyFields) {
  const v = [];
  if (!oldState) return v;
  const allowed = new Set(Array.isArray(allowEmptyFields) ? allowEmptyFields : []);
  for (const f of CRITICAL_NONEMPTY_FIELDS) {
    if (allowed.has(f)) continue;
    if (changedKeys[f] === undefined || !isEmptyValue(changedKeys[f])) continue;
    if (oldState[f] !== undefined && oldState[f] !== null && !isEmptyValue(oldState[f])) {
      const prevSize = Array.isArray(oldState[f]) ? oldState[f].length : Object.keys(oldState[f]).length;
      v.push(`"${f}" had ${prevSize} item(s) and this save would empty it without going through its delete/wipe action — refused`);
    }
  }
  return v;
}

exports.handler = async (event) => {
  connectLambda(event);
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });

  const token = getBearerToken(event);
  const payload = verifyToken(token, secret);
  if (!payload) return json(401, { error: 'Not signed in' });

  const store = getStore(payload.testMode ? 'appdata_test' : APP_STORE);
  const resource = (event.queryStringParameters && event.queryStringParameters.resource) || 'state';

  // The letterhead logo is stored as its own blob, not embedded in the main state document —
  // it's stored as a big base64 string and would otherwise get re-sent on every single
  // autosave, which is exactly the kind of oversized-payload problem that causes mysterious
  // "Save failed" errors once a school has a few years of real data alongside it.
  // Read-only view into the archived weekly compliance report numbers (see
  // weekly-compliance-report.js) — never the rendered PDF itself, just the underlying figures,
  // which is all that's actually kept. Anyone can see their own history; seeing someone else's
  // requires the same Oversight access that already gates seeing others' compliance data
  // everywhere else in the app.
  // Snapshots the real school's operational data into the separate Test Mode store, so staff
  // can practice on genuinely realistic data (real students, classes, schedules, history)
  // instead of a small, static set of fake demo records — while Test Mode's own architecture
  // (a completely separate blob store, appdata_test, never the real one — see the `store`
  // selection above) already guarantees nothing done there can ever write back to real data,
  // regardless of this endpoint. Always reads/writes both stores directly rather than the
  // request's own `store` (which follows payload.testMode) — this only ever makes sense
  // triggered from a real session copying INTO test, never the reverse.
  //
  // Three things are deliberately left out of the copy:
  // 1) Live integration credentials (transportNotifications' Twilio SID/token/phone,
  //    googleMapsApiKey, emailjsConfig) — copying these would mean a training exercise like
  //    "send a transportation alert" could text a REAL parent's phone, or a geocoding/email
  //    call could hit the real paid account, entirely defeating the point of practicing
  //    somewhere safe. Test Mode's existing values for these (usually blank) are left as-is.
  // 2) Document-metadata arrays (staffDocuments, studentDocuments, generalDocuments,
  //    masterDocuments) — the actual uploaded FILES live in separate blobs (e.g.
  //    'staffDoc:<id>') that this snapshot does not copy, so carrying the metadata across
  //    would leave entries that look real but 404 the moment someone tries to open one.
  //    Better to show a clean "no documents yet" than a broken link.
  // 3) hireApplications keeps every field except each entry's own attached `documents` array,
  //    for the identical reason as #2.
  if (resource === 'copyToTestMode') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    if (payload.testMode) return json(400, { error: 'Sign in with your real account (not Test Mode) to copy data into Test Mode' });
    const realStore = getStore(APP_STORE);
    const realState = await loadFullState(realStore);
    if (!realState || realState.__bootstrapAdmin) return json(400, { error: 'No real data to copy yet' });
    const role = roleOf(realState, payload.staffId);
    if (role !== 'Admin') return json(403, { error: 'Only an Admin can copy real data into Test Mode' });

    const EXCLUDED_KEYS = new Set(['transportNotifications', 'googleMapsApiKey', 'emailjsConfig',
      'staffDocuments', 'studentDocuments', 'generalDocuments', 'masterDocuments']);
    const snapshot = {};
    for (const [key, value] of Object.entries(realState)) {
      if (EXCLUDED_KEYS.has(key)) continue;
      snapshot[key] = key === 'hireApplications' && Array.isArray(value)
        ? value.map((app) => ({ ...app, documents: [] }))
        : value;
    }

    const testStore = getStore('appdata_test');
    await saveChangedKeys(testStore, snapshot);
    await appendAudit(event, {
      type: 'test_mode_data_copied', staffId: payload.staffId, email: payload.email,
      detail: `Copied real data into Test Mode (${Object.keys(snapshot).length} fields).`,
    });
    return json(200, { ok: true, fieldsCopied: Object.keys(snapshot).length });
  }

  if (resource === 'weeklyComplianceReports') {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
    const state = await loadFullState(store);
    const role = roleOf(state, payload.staffId);
    const targetStaffId = (event.queryStringParameters && event.queryStringParameters.staffId) || payload.staffId;
    if (targetStaffId !== payload.staffId && role !== 'Admin' && !hasPerm(state, role, 'viewOversight')) {
      return json(403, { error: 'You do not have permission to view this' });
    }
    const reportsStore = getStore('weeklyReports');
    const { blobs } = await reportsStore.list({ prefix: `report:${targetStaffId}:` });
    const reports = await Promise.all(blobs.map((b) => reportsStore.get(b.key, { type: 'json' })));
    reports.sort((a, b) => (b.weekEnd || '').localeCompare(a.weekEnd || ''));
    return json(200, { reports: reports.slice(0, 26) }); // roughly a school half-year of history at a glance
  }

  // Optional ?year=... lets this same endpoint store a separate logo per academic year, used
  // for historical branding on printed documents from a year before the school's current name/
  // logo — see letterheadHtml on the frontend. No year param = the current/default logo,
  // exactly as before this was added, so nothing about the existing behavior changes.
  if (resource === 'logo') {
    const year = event.queryStringParameters && event.queryStringParameters.year;
    const storeKey = year ? `schoolLogo:${year}` : 'schoolLogo';
    if (event.httpMethod === 'GET') {
      const logo = await store.get(storeKey, { type: 'text' });
      return json(200, { logo: logo || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      const role = state ? roleOf(state, payload.staffId) : null;
      if (state && !state.__bootstrapAdmin && role && !hasPerm(state, role, 'editSchoolInfo')) {
        return json(403, { error: 'You do not have permission to change the letterhead logo' });
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (typeof body.logo !== 'string' && body.logo !== null) return json(400, { error: 'Expected { logo: "data:..." }' });
      if (body.logo && body.logo.length > 2_000_000) return json(413, { error: 'That image is too large — please use a smaller file.' });
      if (body.logo) await store.set(storeKey, body.logo); else await store.delete(storeKey);
      await appendAudit(event, { type: year ? 'year_logo_changed' : 'logo_changed', staffId: payload.staffId, email: payload.email, detail: year || undefined });
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // Message photo attachments — same reasoning as the letterhead logo above: a base64 image
  // embedded directly in a message object would get re-sent as part of the whole messages
  // array on every single autosave, for every message that ever had a photo. Each one gets its
  // own blob instead, keyed by message id; the message object itself just carries a `hasPhoto`
  // flag. Only the message's own sender, or an Admin, may attach/replace/remove one.
  if (resource === 'messagePhoto') {
    const messageId = event.queryStringParameters && event.queryStringParameters.id;
    if (!messageId) return json(400, { error: 'Missing message id' });
    if (event.httpMethod === 'GET') {
      const photo = await store.get('msgPhoto:' + messageId, { type: 'text' });
      return json(200, { photo: photo || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        const message = (state.messages || []).find((m) => m.id === messageId);
        const isOwner = !!(message && message.fromId === payload.staffId);
        if (!isOwner && role !== 'Admin') {
          return json(403, { error: 'You do not have permission to attach a photo to this message' });
        }
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (typeof body.photo !== 'string' && body.photo !== null) return json(400, { error: 'Expected { photo: "data:..." }' });
      if (body.photo && body.photo.length > 4_000_000) return json(413, { error: 'That photo is too large — please use a smaller image.' });
      if (body.photo) await store.set('msgPhoto:' + messageId, body.photo); else await store.delete('msgPhoto:' + messageId);
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      // Best-effort cleanup when a message itself gets deleted client-side — never blocks the
      // message deletion if this fails, so no permission check here beyond just being signed in.
      await store.delete('msgPhoto:' + messageId).catch(() => {});
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // A student's photo — stored as its own blob per student, same reasoning as message photos
  // and the letterhead logo above: embedded directly in the main state, a photo per student
  // (potentially the whole school) would mean every single autosave re-sending every photo,
  // forever. Used on the student's own profile and on printed bus tags.
  if (resource === 'studentPhoto') {
    const studentId = event.queryStringParameters && event.queryStringParameters.id;
    if (!studentId) return json(400, { error: 'Missing student id' });
    if (event.httpMethod === 'GET') {
      const photo = await store.get('studentPhoto:' + studentId, { type: 'text' });
      return json(200, { photo: photo || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        if (role !== 'Admin' && !hasPerm(state, role, 'editSetup')) {
          return json(403, { error: 'You do not have permission to upload a student photo' });
        }
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (typeof body.photo !== 'string' && body.photo !== null) return json(400, { error: 'Expected { photo: "data:..." }' });
      if (body.photo && body.photo.length > 4_000_000) return json(413, { error: 'That photo is too large — please use a smaller image.' });
      if (body.photo) await store.set('studentPhoto:' + studentId, body.photo); else await store.delete('studentPhoto:' + studentId);
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      // Best-effort cleanup when a student themselves gets deleted client-side — never blocks
      // that deletion if this fails, so no permission check here beyond just being signed in.
      await store.delete('studentPhoto:' + studentId).catch(() => {});
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // A school-wide document library not tied to any one student or staff member — e.g. a batch
  // of filled permission slips generated for a whole grade at once, kept as one reference copy
  // rather than duplicated onto every single student's own folder. Deliberately much simpler
  // than studentDocument above: no privileged flag, no per-person ownership to check against.
  if (resource === 'generalDocument') {
    const docId = event.queryStringParameters && event.queryStringParameters.id;
    if (!docId) return json(400, { error: 'Missing document id' });
    if (event.httpMethod === 'GET') {
      const data = await store.get('generalDoc:' + docId, { type: 'text' });
      return json(200, { data: data || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      let uploaderRole = null;
      if (state && !state.__bootstrapAdmin) {
        uploaderRole = roleOf(state, payload.staffId);
        if (uploaderRole !== 'Admin' && !hasPerm(state, uploaderRole, 'editSetup')) {
          return json(403, { error: 'You do not have permission to save a document here' });
        }
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (body.rename) {
        if (typeof body.name !== 'string' || !body.name.trim()) return json(400, { error: 'Missing new name' });
        const updated = (state.generalDocuments || []).map((d) => d.id === docId ? { ...d, name: String(body.name).trim().slice(0, 300) } : d);
        await saveChangedKeys(store, { generalDocuments: updated });
        return json(200, { ok: true });
      }
      if (typeof body.data !== 'string') return json(400, { error: 'Expected { data: "data:...", meta: {...} }' });
      if (body.data.length > 12_000_000) return json(413, { error: 'That file is too large.' });
      const meta = body.meta || {};
      if (typeof meta.name !== 'string') return json(400, { error: 'Missing document metadata (name)' });
      await store.set('generalDoc:' + docId, body.data);
      const entry = { id: docId, name: String(meta.name).slice(0, 300), uploadedBy: payload.staffId, uploadedAt: new Date().toISOString() };
      if (state) {
        const updated = [...(state.generalDocuments || []), entry];
        await saveChangedKeys(store, { generalDocuments: updated });
      }
      return json(200, { ok: true, entry });
    }
    if (event.httpMethod === 'DELETE') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        if (role !== 'Admin' && !hasPerm(state, role, 'editSetup')) return json(403, { error: 'You do not have permission to delete this document' });
      }
      await store.delete('generalDoc:' + docId);
      if (state) {
        const updated = (state.generalDocuments || []).filter((d) => d.id !== docId);
        await saveChangedKeys(store, { generalDocuments: updated });
      }
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // Uploaded prior-year records (PDFs, scanned reports, etc.) attached to a student — stored as
  // their own blob per document, same reasoning as the letterhead logo and message photos
  // above: an uploaded PDF embedded directly in the main state document would make every
  // autosave re-send it, for every document ever uploaded, forever.
  // Rewritten to own the array append/remove server-side (like staffDocument below), instead of
  // trusting the client to resave the whole studentDocuments array — required now that a
  // privileged document can be redacted per-role in filterStateForRole, since a viewer who can't
  // see certain entries must never be the one whose save determines what the shared array
  // contains (see the staffDocument comment below for the full reasoning — same bug class).
  if (resource === 'studentDocument') {
    const docId = event.queryStringParameters && event.queryStringParameters.id;
    if (!docId) return json(400, { error: 'Missing document id' });
    if (event.httpMethod === 'GET') {
      const data = await store.get('studentDoc:' + docId, { type: 'text' });
      return json(200, { data: data || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      let uploaderRole = null;
      if (state && !state.__bootstrapAdmin) {
        uploaderRole = roleOf(state, payload.staffId);
        if (uploaderRole !== 'Admin' && !hasPerm(state, uploaderRole, 'editSetup')) {
          return json(403, { error: 'You do not have permission to upload a document here' });
        }
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      // Rename: no file bytes involved, just updating the stored name on the existing entry —
      // kept in this same POST handler (rather than a new resource) since it needs the exact
      // same server-owns-the-array treatment as upload/delete above, for the exact same reason.
      if (body.rename) {
        if (typeof body.name !== 'string' || !body.name.trim()) return json(400, { error: 'Missing new name' });
        const doc = state && (state.studentDocuments || []).find((d) => d.id === docId);
        if (!doc) return json(404, { error: 'Document not found' });
        if (state && !state.__bootstrapAdmin) {
          const isUploader = doc.uploadedBy === payload.staffId;
          if (uploaderRole !== 'Admin' && !hasPerm(state, uploaderRole, 'editSetup') && !isUploader) {
            return json(403, { error: 'You do not have permission to rename this document' });
          }
        }
        const updated = (state.studentDocuments || []).map((d) => d.id === docId ? { ...d, name: String(body.name).trim().slice(0, 300) } : d);
        await saveChangedKeys(store, { studentDocuments: updated });
        return json(200, { ok: true });
      }
      if (typeof body.data !== 'string') return json(400, { error: 'Expected { data: "data:...", meta: {...} }' });
      if (body.data.length > 6_000_000) return json(413, { error: 'That file is too large — please use one under about 4MB.' });
      const meta = body.meta || {};
      if (!meta.studentId || typeof meta.name !== 'string') return json(400, { error: 'Missing document metadata (studentId, name)' });
      const wantsPrivileged = !!meta.privileged;
      if (wantsPrivileged && state && !state.__bootstrapAdmin && uploaderRole !== 'Admin' && !hasPerm(state, uploaderRole, 'viewPrivilegedStudentDocs')) {
        return json(403, { error: 'You do not have permission to mark a document as privileged' });
      }
      await store.set('studentDoc:' + docId, body.data);
      const entry = {
        id: docId,
        studentId: meta.studentId,
        name: String(meta.name).slice(0, 300),
        year: typeof meta.year === 'string' ? meta.year : undefined,
        privileged: wantsPrivileged,
        uploadedBy: payload.staffId,
        uploadedAt: new Date().toISOString(),
      };
      if (state) {
        const updated = [...(state.studentDocuments || []), entry];
        await saveChangedKeys(store, { studentDocuments: updated });
      }
      return json(200, { ok: true, entry });
    }
    if (event.httpMethod === 'DELETE') {
      const state = await loadFullState(store);
      const doc = state && (state.studentDocuments || []).find((d) => d.id === docId);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        const isUploader = !!(doc && doc.uploadedBy === payload.staffId);
        if (role !== 'Admin' && !hasPerm(state, role, 'editSetup') && !isUploader) {
          return json(403, { error: 'You do not have permission to delete this document' });
        }
        if (doc && doc.privileged && role !== 'Admin' && !hasPerm(state, role, 'viewPrivilegedStudentDocs')) {
          return json(403, { error: 'You do not have permission to delete a privileged document' });
        }
      }
      await store.delete('studentDoc:' + docId).catch(() => {});
      if (state) {
        const updated = (state.studentDocuments || []).filter((d) => d.id !== docId);
        await saveChangedKeys(store, { studentDocuments: updated });
      }
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // Same walled-off-per-file pattern as studentDocument above, scoped to a staff member's own
  // profile instead — this is where a signed, printed onboarding packet (or offer letter, ID
  // scan, certification, annual/yearly renewal, etc.) ends up once uploaded, so it lives
  // permanently with the rest of that employee's record instead of on whichever computer
  // printed/signed it. Gated by manageHRIntake (the same permission that governs the rest of
  // personnel/HR paperwork) rather than editSetup — editSetup is a much more commonly granted,
  // general "add/edit classes, students & staff" permission that doesn't imply HR should trust
  // that role with personnel documents. A staff member may still upload to (or delete from)
  // their own profile even without manageHRIntake, matching the frontend's own check.
  //
  // Unlike studentDocument, the metadata list (state.staffDocuments) IS redacted per-role in
  // filterStateForRole — someone without manageHRIntake only ever sees their own documents in
  // the general state load. That makes it unsafe to let clients write this array back wholesale
  // via the generic changedKeys save the way studentDocuments does: a non-HR client's local copy
  // only ever contains their own entries, so resaving "the whole array" from their side would
  // silently erase every other employee's documents. Instead, POST/DELETE here read-modify-write
  // state.staffDocuments directly, server-side, off the real unredacted array every time —
  // never trusting whatever partial copy the requesting client happened to have.
  // Master documents: an uploaded blank form (PDF or DOCX) with fields an Admin/editSetup user
  // has clicked to place on top of it, later filled in and batch-printed for chosen students or
  // staff (see MASTER_DOC_FIELD_SOURCES and the frontend's master-document editor/print flow).
  // Not sensitive personnel data the way staff documents are, so — like studentDocuments —
  // metadata isn't redacted per-role, and clients are trusted to resave the whole
  // masterDocuments array on edit, same as reportTemplates/goalBank elsewhere in this file.
  if (resource === 'masterDocument') {
    const docId = event.queryStringParameters && event.queryStringParameters.id;
    if (!docId) return json(400, { error: 'Missing document id' });
    if (event.httpMethod === 'GET') {
      const data = await store.get('masterDoc:' + docId, { type: 'text' });
      return json(200, { data: data || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        if (role !== 'Admin' && !hasPerm(state, role, 'editSetup')) {
          return json(403, { error: 'You do not have permission to upload a master document' });
        }
      }
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (typeof body.data !== 'string') return json(400, { error: 'Expected { data: "data:..." }' });
      if (body.data.length > 12_000_000) return json(413, { error: 'That file is too large — please use one under about 8MB.' });
      await store.set('masterDoc:' + docId, body.data);
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        if (role !== 'Admin' && !hasPerm(state, role, 'editSetup')) {
          return json(403, { error: 'You do not have permission to delete this master document' });
        }
      }
      await store.delete('masterDoc:' + docId).catch(() => {});
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  if (resource === 'staffDocument') {
    const docId = event.queryStringParameters && event.queryStringParameters.id;
    if (!docId) return json(400, { error: 'Missing document id' });
    if (event.httpMethod === 'GET') {
      const data = await store.get('staffDoc:' + docId, { type: 'text' });
      return json(200, { data: data || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      // Rename: no file bytes involved, just updating the stored name — same strict rule as
      // upload/delete above (only Admin or manageHRIntake, no exceptions), and the same
      // server-owns-the-array treatment, for the same reason.
      if (body.rename) {
        if (typeof body.name !== 'string' || !body.name.trim()) return json(400, { error: 'Missing new name' });
        const state = await loadFullState(store);
        const doc = state && (state.staffDocuments || []).find((d) => d.id === docId);
        if (!doc) return json(404, { error: 'Document not found' });
        if (state && !state.__bootstrapAdmin) {
          const role = roleOf(state, payload.staffId);
          if (role !== 'Admin' && !hasPerm(state, role, 'manageHRIntake')) {
            return json(403, { error: 'You do not have permission to rename this document' });
          }
        }
        const updated = (state.staffDocuments || []).map((d) => d.id === docId ? { ...d, name: String(body.name).trim().slice(0, 300) } : d);
        await saveChangedKeys(store, { staffDocuments: updated });
        return json(200, { ok: true });
      }
      // Approve/reject a split-out onboarding document — deliberately gated by
      // approveOnboardingDocs specifically, NOT manageHRIntake. Someone with only manageHRIntake
      // (e.g. a General Secretary who uploads and splits packets) can still preview every
      // document via the normal GET above, but this is the one action reserved for whoever holds
      // the narrower Office-Manager-style permission — matching what the frontend's review queue
      // itself shows/hides (see renderOnboardingDocReview).
      if (body.setReviewStatus) {
        const status = body.setReviewStatus.status;
        if (!['approved', 'rejected', 'pending'].includes(status)) return json(400, { error: 'Invalid review status' });
        const state = await loadFullState(store);
        const doc = state && (state.staffDocuments || []).find((d) => d.id === docId);
        if (!doc) return json(404, { error: 'Document not found' });
        if (state && !state.__bootstrapAdmin) {
          const role = roleOf(state, payload.staffId);
          if (role !== 'Admin' && !hasPerm(state, role, 'approveOnboardingDocs')) {
            return json(403, { error: 'You do not have permission to approve or reject onboarding documents' });
          }
        }
        const updated = (state.staffDocuments || []).map((d) => d.id === docId ? {
          ...d,
          reviewStatus: status,
          reviewNote: typeof body.setReviewStatus.note === 'string' ? body.setReviewStatus.note.slice(0, 500) : (status === 'rejected' ? (d.reviewNote || '') : ''),
          reviewedBy: payload.staffId,
          reviewedAt: new Date().toISOString(),
        } : d);
        await saveChangedKeys(store, { staffDocuments: updated });
        return json(200, { ok: true });
      }
      if (typeof body.data !== 'string') return json(400, { error: 'Expected { data: "data:...", meta: {...} }' });
      if (body.data.length > 6_000_000) return json(413, { error: 'That file is too large — please use one under about 4MB.' });
      const meta = body.meta || {};
      if (!meta.staffId || typeof meta.name !== 'string') return json(400, { error: 'Missing document metadata (staffId, name)' });
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        // No self-upload exception for now, even to one's own profile — this is deliberately
        // stricter than most permission checks in this app, at the school's explicit request:
        // only Admin or manageHRIntake can touch staff documents at all, full stop.
        if (role !== 'Admin' && !hasPerm(state, role, 'manageHRIntake')) {
          return json(403, { error: 'You do not have permission to upload a document to this profile' });
        }
      }
      await store.set('staffDoc:' + docId, body.data);
      const entry = {
        id: docId,
        staffId: meta.staffId,
        name: String(meta.name).slice(0, 300),
        docType: typeof meta.docType === 'string' ? meta.docType.slice(0, 100) : 'Other',
        docLabel: typeof meta.docLabel === 'string' ? meta.docLabel.slice(0, 150) : '',
        uploadedBy: payload.staffId,
        uploadedAt: new Date().toISOString(),
        // Present only for a document that came out of the AI packet-splitter (see
        // aiSplitOnboardingPacket in index.html) — reviewStatus starts a 3-state approval flow
        // ('pending'|'approved'|'rejected'), splitFromDocId points back at the original merged
        // upload it was extracted from, and checklistLabel is whichever onboardingDocChecklist
        // entry AI matched it to (or blank if AI couldn't match one — still split out, just
        // unmatched, so a reviewer sees it rather than it silently vanishing). A manually
        // uploaded document (the normal, non-split path) simply omits all three, same as today.
        ...(typeof meta.reviewStatus === 'string' ? { reviewStatus: meta.reviewStatus.slice(0, 20) } : {}),
        ...(typeof meta.splitFromDocId === 'string' ? { splitFromDocId: meta.splitFromDocId.slice(0, 100) } : {}),
        ...(typeof meta.checklistLabel === 'string' ? { checklistLabel: meta.checklistLabel.slice(0, 150) } : {}),
      };
      if (state) {
        const updated = [...(state.staffDocuments || []), entry];
        await saveChangedKeys(store, { staffDocuments: updated });
      }
      return json(200, { ok: true, entry });
    }
    if (event.httpMethod === 'DELETE') {
      const state = await loadFullState(store);
      if (state && !state.__bootstrapAdmin) {
        const role = roleOf(state, payload.staffId);
        // No uploader-can-delete-their-own exception either, for the same reason as upload
        // above — deliberately stricter than the studentDocument pattern this was based on.
        if (role !== 'Admin' && !hasPerm(state, role, 'manageHRIntake')) {
          return json(403, { error: 'You do not have permission to delete this document' });
        }
      }
      await store.delete('staffDoc:' + docId).catch(() => {});
      if (state) {
        const updated = (state.staffDocuments || []).filter((d) => d.id !== docId);
        await saveChangedKeys(store, { staffDocuments: updated });
      }
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // The sensitive half of a hire application — SSN and every pay-related figure — kept in its
  // own walled-off blob per application, never included in the general state fetch every
  // logged-in user's browser receives. Only the dedicated HR/Staff-Intake permission (or Admin)
  // can read or write it; the non-sensitive fields (name, position, department, etc.) live in
  // the normal state.hireApplications array since they're no more sensitive than anything else
  // already in there.
  if (resource === 'hireApplicationSensitive') {
    const appId = event.queryStringParameters && event.queryStringParameters.id;
    if (!appId) return json(400, { error: 'Missing application id' });
    const state = await loadFullState(store);
    let role = null;
    if (state && !state.__bootstrapAdmin) {
      role = roleOf(state, payload.staffId);
      const isHR = role === 'Admin' || hasPerm(state, role, 'manageHRIntake');
      // A Board President reviewing an application actually needs the full picture, SSN and pay
      // included, to make an informed signing decision — but view-only: editing or deleting this
      // data still requires manageHRIntake specifically, same as before.
      const canViewOnly = hasPerm(state, role, 'signBoardApprovals');
      if (!isHR && !(canViewOnly && event.httpMethod === 'GET')) {
        return json(403, { error: 'You do not have permission to view or edit this' });
      }
    }
    if (event.httpMethod === 'GET') {
      const data = await store.get('hireAppSensitive:' + appId, { type: 'json' });
      return json(200, { data: data || null });
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      await store.setJSON('hireAppSensitive:' + appId, body || {});
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      await store.delete('hireAppSensitive:' + appId).catch(() => {});
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  // Signature on a hire application — either the Administrator's (first) or, now that a Board
  // President can hold a real narrowly-scoped account instead of only the no-login emailed
  // link, the Board President's (second) too. Same reasoning as everywhere else this pattern is
  // used: a real drawn signature (reusable once saved to the signer's own staff record), an
  // explicit consent acknowledgment, and a server-verified timestamp/IP via the audit log — the
  // legal weight is in the consent + identity + audit trail, not in re-drawing the ink every
  // time. The no-login board-sign.js link still exists as a fallback for a board member who
  // genuinely doesn't want an account; this is the path for one who does.
  if (resource === 'hireAppSignature') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const appId = event.queryStringParameters && event.queryStringParameters.id;
    if (!appId) return json(400, { error: 'Missing application id' });
    const state = await loadFullState(store);
    if (!state) return json(404, { error: 'Not set up yet.' });
    const role = roleOf(state, payload.staffId);
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
    const signerRole = body.signerRole === 'board' ? 'board' : 'admin';
    if (signerRole === 'admin') {
      if (!state.__bootstrapAdmin && role !== 'Admin' && !hasPerm(state, role, 'manageHRIntake')) {
        return json(403, { error: 'You do not have permission to sign this' });
      }
    } else {
      if (role !== 'Admin' && !hasPerm(state, role, 'signBoardApprovals')) {
        return json(403, { error: 'You do not have permission to sign as Board President' });
      }
    }
    const name = String(body.signatureName || '').trim();
    if (!name) return json(400, { error: 'A typed name is required' });
    if (body.consent !== true) return json(400, { error: 'Consent to sign electronically is required' });

    const apps = state.hireApplications || [];
    const idx = apps.findIndex((a) => a.id === appId);
    if (idx === -1) return json(404, { error: 'Application not found' });
    if (signerRole === 'admin' && apps[idx].status !== 'pending') {
      return json(409, { error: 'This application is not currently waiting on an Administrator signature.' });
    }
    if (signerRole === 'board' && apps[idx].status !== 'pending_board') {
      return json(409, { error: 'This application is not currently waiting on a Board President signature.' });
    }

    const staffList = state.staff || [];
    const staffIdx = staffList.findIndex((s) => s.id === payload.staffId);
    let signatureDataUrl = body.signatureDataUrl || null;
    const changed = {};

    if (body.useSaved) {
      const saved = staffIdx !== -1 && staffList[staffIdx].savedSignature;
      if (!saved || !saved.dataUrl) return json(400, { error: 'No saved signature on file — draw one first.' });
      signatureDataUrl = saved.dataUrl;
    } else if (signatureDataUrl && staffIdx !== -1) {
      // Drawing a fresh one updates their saved signature for next time, unless they explicitly
      // decline to save it.
      if (body.saveForNextTime !== false) {
        const newStaff = staffList.slice();
        newStaff[staffIdx] = { ...newStaff[staffIdx], savedSignature: { dataUrl: signatureDataUrl, updatedAt: new Date().toISOString() } };
        changed.staff = newStaff;
      }
    }
    if (!signatureDataUrl) return json(400, { error: 'A signature (drawn or saved) is required' });

    const updated = apps.slice();
    if (signerRole === 'admin') {
      updated[idx] = {
        ...updated[idx], status: 'pending_board',
        adminSignedBy: payload.staffId, adminSignedAt: new Date().toISOString(),
        adminSignatureName: name, adminSignatureDataUrl: signatureDataUrl, adminConsent: true,
        boardLinkCreatedAt: new Date().toISOString(),
      };
    } else {
      updated[idx] = {
        ...updated[idx], status: 'signed',
        boardSignedBy: payload.staffId, boardSignedAt: new Date().toISOString(),
        boardSignatureName: name, boardSignatureDataUrl: signatureDataUrl, boardConsent: true,
        // No board-sign.js involved on this path, so nothing else needs to set this flag —
        // set it here directly so the HR notification still fires the same way either way.
        hrNotifyPending: true,
      };
    }
    changed.hireApplications = updated;
    await saveChangedKeys(store, changed);
    await appendAudit(event, {
      type: signerRole === 'admin' ? 'admin_signature_added' : 'board_signature_added',
      staffId: payload.staffId, email: payload.email,
      detail: `application ${appId} signed by "${name}"`,
    });
    return json(200, { ok: true, adminSignatureDataUrl: signatureDataUrl, signatureDataUrl, status: updated[idx].status });
  }

  // Report signatures — author submitting, or approver approving. Same reasoning and pattern as
  // hireAppSignature above: a real drawn signature (reusable once saved), explicit consent, and
  // a server-verified timestamp/IP via the audit log — arguably even more warranted here, since
  // these are official records about a child's disability services, signed far more often than
  // the handful of hire applications a year. The full status transition and version-history
  // snapshot happen here too, so "what was actually signed" is frozen server-side at the moment
  // of signing, not assembled from a separate client-side save afterward.
  if (resource === 'reportSignature') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const reportId = event.queryStringParameters && event.queryStringParameters.id;
    if (!reportId) return json(400, { error: 'Missing report id' });
    const state = await loadFullState(store);
    if (!state) return json(404, { error: 'Not set up yet.' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
    const role = body.role === 'approver' ? 'approver' : 'author';
    const name = String(body.signatureName || '').trim();
    if (!name) return json(400, { error: 'A typed name is required' });
    if (body.consent !== true) return json(400, { error: 'Consent to sign electronically is required' });

    const reports = state.reports || [];
    const idx = reports.findIndex((r) => r.id === reportId);
    if (idx === -1) return json(404, { error: 'Report not found' });
    const report = reports[idx];
    const staffRole = roleOf(state, payload.staffId);

    if (role === 'author') {
      if (report.authorId !== payload.staffId) return json(403, { error: "Only the report's author can sign this" });
      if (report.status !== 'draft' && report.status !== 'revision') {
        return json(409, { error: "This report is not currently waiting on the author's signature." });
      }
    } else {
      const canApprove = staffRole === 'Admin' || (report.approverId ? report.approverId === payload.staffId : hasPerm(state, staffRole, 'approveReports'));
      if (!canApprove) return json(403, { error: 'You do not have permission to approve this report' });
      if (report.status !== 'submitted') return json(409, { error: 'This report is not currently waiting on approval.' });
    }

    const staffList = state.staff || [];
    const staffIdx = staffList.findIndex((s) => s.id === payload.staffId);
    let signatureDataUrl = body.signatureDataUrl || null;
    const changed = {};

    if (body.useSaved) {
      const saved = staffIdx !== -1 && staffList[staffIdx].savedSignature;
      if (!saved || !saved.dataUrl) return json(400, { error: 'No saved signature on file — draw one first.' });
      signatureDataUrl = saved.dataUrl;
    } else if (signatureDataUrl && staffIdx !== -1 && body.saveForNextTime !== false) {
      const newStaff = staffList.slice();
      newStaff[staffIdx] = { ...newStaff[staffIdx], savedSignature: { dataUrl: signatureDataUrl, updatedAt: new Date().toISOString() } };
      changed.staff = newStaff;
    }
    if (!signatureDataUrl) return json(400, { error: 'A signature (drawn or saved) is required' });

    const nowIso = new Date().toISOString();
    const signatureRecord = role === 'author'
      ? { dataUrl: signatureDataUrl, name, signedBy: payload.staffId, consent: true, signedAt: nowIso }
      : { dataUrl: signatureDataUrl, name, signedBy: payload.staffId, consent: true, date: nowIso.slice(0, 10), signedAt: nowIso };

    const updatedReport = { ...report, history: report.history ? report.history.slice() : [] };
    if (role === 'author') {
      updatedReport.history.push({
        fields: { ...updatedReport.fields }, status: updatedReport.status, label: 'Submitted', by: payload.staffId, at: nowIso,
        authorSignature: signatureRecord, approverSignature: updatedReport.approverSignature ? { ...updatedReport.approverSignature } : null,
      });
      updatedReport.authorSignature = signatureRecord;
      updatedReport.status = 'submitted';
    } else {
      updatedReport.history.push({
        fields: { ...updatedReport.fields }, status: updatedReport.status, label: 'Approved', by: payload.staffId, at: nowIso,
        authorSignature: updatedReport.authorSignature ? { ...updatedReport.authorSignature } : null, approverSignature: signatureRecord,
      });
      updatedReport.approverSignature = signatureRecord;
      updatedReport.status = 'approved';
      updatedReport.locked = true;
    }
    updatedReport.updatedAt = nowIso;
    const updatedReports = reports.slice();
    updatedReports[idx] = updatedReport;
    changed.reports = updatedReports;

    await saveChangedKeys(store, changed);
    await appendAudit(event, {
      type: role === 'author' ? 'report_author_signature_added' : 'report_approver_signature_added',
      staffId: payload.staffId, email: payload.email, detail: `report ${reportId} signed by "${name}"`,
    });
    return json(200, { ok: true, signatureDataUrl, status: updatedReport.status });
  }

  // Supporting documents for a hire application (offer letter, license/certification scans,
  // ID copies, etc.) — same walled-off-per-file pattern as studentDocument above, so uploads
  // don't bloat the main autosave payload. Non-sensitive (no SSN/pay), gated the same way as
  // the rest of the application: manageHRIntake or Admin.
  if (resource === 'hireApplicationDocument') {
    const docId = event.queryStringParameters && event.queryStringParameters.id;
    if (!docId) return json(400, { error: 'Missing document id' });
    if (event.httpMethod === 'GET') {
      const data = await store.get('hireAppDoc:' + docId, { type: 'text' });
      return json(200, { data: data || null });
    }
    const state = await loadFullState(store);
    if (state && !state.__bootstrapAdmin) {
      const role = roleOf(state, payload.staffId);
      if (role !== 'Admin' && !hasPerm(state, role, 'manageHRIntake')) {
        return json(403, { error: 'You do not have permission to do this' });
      }
    }
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
      if (typeof body.data !== 'string') return json(400, { error: 'Expected { data: "data:..." }' });
      if (body.data.length > 8_000_000) return json(413, { error: 'That file is too large — please use one under about 6MB.' });
      await store.set('hireAppDoc:' + docId, body.data);
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      await store.delete('hireAppDoc:' + docId).catch(() => {});
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  if (event.httpMethod === 'GET') {
    const state = await loadFullState(store);
    // In Test Mode, self-heal this person's role/permissions against the real account on every
    // load — not just at login — so a stale role never lingers just because someone kept an old
    // session open instead of fully signing out and back in.
    if (payload.testMode && state && !state.__bootstrapAdmin) {
      const realState = await loadFullState(getStore(APP_STORE)).catch(() => null);
      const changes = syncTestModeRole(state, realState, payload.staffId, payload.name, payload.email);
      if (changes) {
        await saveChangedKeys(store, changes);
        Object.assign(state, changes);
      }
    }
    if (!state || state.__bootstrapAdmin) return json(200, { state: state || null });
    const role = roleOf(state, payload.staffId);
    return json(200, { state: role ? filterStateForRole(state, role, payload.staffId) : state });
  }

  if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }
    // Accepts either the current partial format { changedKeys: {...} } — only the fields that
    // actually changed — or, for safety, a full { state: {...} } payload from an older client,
    // in which case every key in it is treated as "changed".
    const changedKeys = body.changedKeys || body.state;
    if (!changedKeys || typeof changedKeys !== 'object') return json(400, { error: 'Expected { changedKeys: {...} }' });

    // Belt-and-suspenders: never let a stray large logo string sneak back into the main
    // document even if an older client version still sends one.
    if (typeof changedKeys.schoolLogoDataUrl === 'string' && changedKeys.schoolLogoDataUrl.length > 500) {
      delete changedKeys.schoolLogoDataUrl;
    }

    const oldState = await loadFullState(store);

    // Guard against a stale client silently reverting a hire application's signature status —
    // see reconcileHireApplications above. Applied before oldState/changedKeys are merged into
    // newState, so every downstream check (permissions, violations, the saved copy itself)
    // sees the corrected version, not the stale one the client actually sent.
    if (oldState && Array.isArray(changedKeys.hireApplications)) {
      changedKeys.hireApplications = reconcileHireApplications(oldState.hireApplications, changedKeys.hireApplications);
    }
    // Same protection for reports — see reconcileReports above. Role is resolved fresh here
    // (rather than reusing the `role` computed a few lines down) since reconciliation has to
    // run before newState exists yet, and role only depends on oldState anyway.
    if (oldState && !oldState.__bootstrapAdmin && Array.isArray(changedKeys.reports)) {
      const earlyRole = roleOf(oldState, payload.staffId);
      const stateForPermCheck = { ...oldState, ...changedKeys };
      changedKeys.reports = reconcileReports(oldState.reports, changedKeys.reports, earlyRole, stateForPermCheck, payload.staffId);
    }

    const newState = oldState ? { ...oldState, ...changedKeys } : changedKeys;
    const role = oldState ? roleOf(oldState, payload.staffId) : null;

    // Data-integrity guard, independent of role/permissions: refuse to let any save silently
    // empty out a critical field that had real data — this protects against the client itself
    // being wrong (a stale tab, a load-timing race), which permission checks can't catch since
    // the request looks perfectly legitimate from that angle.
    const emptyOverwriteViolations = findEmptyOverwriteViolations(oldState, changedKeys, body.allowEmptyFields);
    if (emptyOverwriteViolations.length) {
      await appendAudit(event, {
        type: 'write_blocked', staffId: payload.staffId, email: payload.email,
        detail: emptyOverwriteViolations.join('; '),
      });
      return json(409, { error: emptyOverwriteViolations[0] });
    }

    // The bulk data-wipe tool is Admin-only by explicit design, not just "happens to have the
    // right permissions" — a role with editSetup/deleteSessions/deleteNotes/deleteReports could
    // otherwise trigger it even though the UI itself is hardcoded to Admin only. Enforced here
    // too so that hardcoding can't be bypassed by calling the API directly.
    if (body.wipeSummary && role !== 'Admin') {
      await appendAudit(event, {
        type: 'write_blocked', staffId: payload.staffId, email: payload.email,
        detail: 'Attempted a data wipe without being an Admin',
      });
      return json(403, { error: 'Only an Admin can wipe data' });
    }

    // Only enforce once the app is past its one-time bootstrap marker, and only if we
    // could resolve the requester's current role from the last-saved state.
    if (oldState && !oldState.__bootstrapAdmin && role) {
      const violations = [
        ...findViolations(oldState, newState, role, payload.staffId),
        ...findReportApprovalViolations(oldState, newState, payload.staffId, role),
        ...findAttendanceViolations(oldState, newState, payload.staffId, role),
        ...findAdminMeetingsViolations(oldState, newState, changedKeys, role, payload.staffId),
        ...findLobbyMessageViolations(oldState, newState, role),
        ...findHireApplicationViolations(oldState, newState, role),
      ];
      if (violations.length) {
        await appendAudit(event, {
          type: 'write_blocked', staffId: payload.staffId, email: payload.email,
          detail: violations.slice(0, 5).join('; '),
        });
        // Tell the client exactly which top-level field(s) triggered this, so it can revert
        // just those fields locally (back to the last value it successfully synced) instead of
        // leaving them permanently "dirty." Without this, a single rejected change to a field the
        // user isn't allowed to touch (e.g. an unrelated stale edit to staff/students) would keep
        // getting re-included in every future autosave forever — silently blocking completely
        // unrelated, otherwise-legitimate edits (like a transportation change) with this same
        // confusing error, until the page happens to get reloaded.
        const blockedFields = Array.from(new Set(
          violations.map((msg) => { const m = msg.match(/edit "([^"]+)"/); return m ? m[1] : null; }).filter(Boolean)
        ));
        return json(403, { error: 'Blocked by server-side permission check: ' + violations[0], blockedFields });
      }
    }

    await saveChangedKeys(store, changedKeys);
    if (body.wipeSummary) {
      await appendAudit(event, {
        type: 'year_data_wiped', staffId: payload.staffId, email: payload.email,
        detail: String(body.wipeSummary).slice(0, 500),
      });
    }
    if (changedKeys.emailjsConfig !== undefined && !payload.testMode) {
      // Mirrored copy, readable pre-login (see auth.js action:"getEmailConfig") so the
      // sign-in screen can send MFA codes before a session exists. Contains no secrets —
      // EmailJS's public key/service ID/template ID are meant to be used client-side.
      // Only ever written from a REAL session — a Test Mode "Admin" changing email
      // settings in their sandbox must never affect real email delivery.
      await store.setJSON('emailjsPublic', changedKeys.emailjsConfig);
    }
    if (oldState && changedKeys.rolePermissions !== undefined) {
      const changes = diffRolePermissionChanges(oldState, newState);
      if (changes.length) {
        await appendAudit(event, {
          type: 'role_permissions_changed', staffId: payload.staffId, email: payload.email,
          detail: changes.map((c) => `${c.role}.${c.key}: ${c.from}\u2192${c.to}`).slice(0, 20).join('; '),
        });
      }
    }
    if (oldState && changedKeys.roles !== undefined && JSON.stringify(oldState.roles) !== JSON.stringify(newState.roles)) {
      const oldRoles = new Set(oldState.roles || []);
      const newRoles = new Set(newState.roles || []);
      const added = [...newRoles].filter((r) => !oldRoles.has(r));
      const removed = [...oldRoles].filter((r) => !newRoles.has(r));
      await appendAudit(event, {
        type: 'roles_list_changed', staffId: payload.staffId, email: payload.email,
        detail: [added.length ? `added: ${added.join(', ')}` : '', removed.length ? `removed: ${removed.join(', ')}` : ''].filter(Boolean).join('; '),
      });
    }
    await appendAudit(event, {
      type: 'state_saved', staffId: payload.staffId, email: payload.email, testMode: !!payload.testMode,
      detail: summarizeChangedKeys(oldState, changedKeys).slice(0, 500),
    });
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
};

// Shared by data.js, auth.js, and audit.js — every place that needs to read or write the
// app's data must go through these, not touch the 'appdata' store's blobs directly, or
// they'll silently break once data is split into per-field blobs instead of one document.
const SK_PREFIX = 'sk:';
const LEGACY_STATE_KEY = 'state';

// Reconstructs the full state object from per-field blobs. On a site that hasn't been
// touched since before the storage was split into per-field blobs, this transparently
// migrates the old single-blob format the first time it's read — no action needed by anyone.
async function loadFullState(store) {
  const { blobs } = await store.list({ prefix: SK_PREFIX });
  if (blobs.length > 0) {
    const result = {};
    await Promise.all(blobs.map(async (b) => {
      const key = b.key.slice(SK_PREFIX.length);
      result[key] = await store.get(b.key, { type: 'json' });
    }));
    return result;
  }
  const legacy = await store.get(LEGACY_STATE_KEY, { type: 'json' });
  if (!legacy) return null;
  if (legacy.__bootstrapAdmin) return legacy; // one-time setup marker, not real data yet — leave as-is
  await Promise.all(Object.entries(legacy).map(([k, v]) => store.setJSON(SK_PREFIX + k, v)));
  await store.delete(LEGACY_STATE_KEY).catch(() => {});
  return legacy;
}

// Writes only the given top-level fields — never the whole document.
async function saveChangedKeys(store, changedKeys) {
  await Promise.all(Object.entries(changedKeys).map(([k, v]) => store.setJSON(SK_PREFIX + k, v)));
  await store.delete(LEGACY_STATE_KEY).catch(() => {});
}

// Used only by the one-time setup bootstrap, which writes a tiny marker before any real
// state exists yet — kept as the old single-blob format on purpose, since loadFullState()
// already knows how to recognize and hand back a bootstrap marker as-is.
async function writeBootstrapMarker(store, marker) {
  await store.setJSON(LEGACY_STATE_KEY, marker);
}

// Test Mode support: keeps every test-mode staff member's role, and the whole role/permission
// structure, in sync with the real account — called both at login and on every subsequent
// test-mode state load (by anyone, not just the person whose role changed), so a stale role
// never lingers just because the specific person it belongs to hasn't logged back in themselves.
// Never touches any other real staff record's name/email, or any real student data — only the
// role field of people already present in the test roster, plus the abstract role/permission rules.
function syncTestModeRole(testState, realState, staffId, name, email) {
  if (!testState || testState.__bootstrapAdmin || !testState.staff) return null; // not seeded yet

  const realById = new Map();
  const realByEmail = new Map();
  if (realState && realState.staff) {
    for (const s of realState.staff) {
      realById.set(s.id, s);
      if (s.email) realByEmail.set(String(s.email).toLowerCase(), s);
    }
  }
  const realRolePerms = (realState && realState.roles && realState.rolePermissions)
    ? { roles: realState.roles, rolePermissions: realState.rolePermissions } : null;

  // Resolve the current requester's own real role first, since they might not be in the test
  // roster at all yet (first time they've ever shown up here).
  const requesterReal = realById.get(staffId) || (email ? realByEmail.get(String(email).toLowerCase()) : null);
  const requesterRole = (requesterReal && requesterReal.role) || 'Admin';

  let staffChanged = false;
  let newStaff = testState.staff.map((testStaffMember) => {
    // Match this test-roster entry back to a real person, by id first, then by email — the same
    // person can end up with a different id here if their login was linked/re-linked since.
    const real = realById.get(testStaffMember.id) ||
      (testStaffMember.email ? realByEmail.get(String(testStaffMember.email).toLowerCase()) : null);
    if (!real) return testStaffMember; // no matching real person (e.g. a demo-only staff member) — leave alone
    if (testStaffMember.role === real.role) return testStaffMember; // already correct
    staffChanged = true;
    return { ...testStaffMember, role: real.role, access: { type: 'all', studentIds: [] } };
  });

  const byIdMatch = newStaff.find((s) => s.id === staffId);
  const byEmailMatch = !byIdMatch && email
    ? newStaff.find((s) => s.email && String(s.email).toLowerCase() === String(email).toLowerCase())
    : null;
  if (byEmailMatch) {
    // The current requester exists under a different id than their current login carries (e.g.
    // their account was linked/re-linked to a different staff record) — fold into that one id
    // rather than leaving two entries for the same person.
    staffChanged = true;
    newStaff = newStaff.map((s) => s === byEmailMatch ? { id: staffId, name: name || byEmailMatch.name, email, role: requesterRole, access: { type: 'all', studentIds: [] } } : s);
  } else if (!byIdMatch && name) {
    // The current requester has never shown up in this test roster before, and we have a name
    // for them (only true at login) — add them now.
    staffChanged = true;
    newStaff = [...newStaff, { id: staffId, name, email, role: requesterRole, access: { type: 'all', studentIds: [] } }];
  }

  const changes = {};
  if (staffChanged) changes.staff = newStaff;
  if (realRolePerms &&
      (JSON.stringify(testState.roles) !== JSON.stringify(realRolePerms.roles) ||
       JSON.stringify(testState.rolePermissions) !== JSON.stringify(realRolePerms.rolePermissions))) {
    changes.roles = realRolePerms.roles;
    changes.rolePermissions = realRolePerms.rolePermissions;
  }
  return Object.keys(changes).length ? changes : null;
}

module.exports = { loadFullState, saveChangedKeys, writeBootstrapMarker, syncTestModeRole };

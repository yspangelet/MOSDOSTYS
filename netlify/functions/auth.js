const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('./_store-helpers');
const {
  hashPassword, verifyPassword, signToken, verifyToken, getBearerToken, generateOtp, json,
} = require('./_auth-helpers');
const { appendAudit } = require('./_audit-helpers');
const { loadFullState, saveChangedKeys, writeBootstrapMarker, syncTestModeRole } = require('./_state-helpers');

const CRED_STORE = 'credentials';
const APP_STORE = 'appdata';
const TEST_APP_STORE = 'appdata_test'; // completely separate storage — real data never touches this
const MFA_STORE = 'mfa_pending';
const CRED_KEY = 'all'; // one JSON blob mapping lowercase-email -> credential record

function roleOf(state, staffId) {
  const s = (state && state.staff || []).find((x) => x.id === staffId);
  return s ? s.role : null;
}
function hasTestModeAccess(state, role) {
  if (!state) return false;
  if (role === 'Admin') return true;
  const perms = state.rolePermissions && state.rolePermissions[role];
  return !!(perms && perms.accessTestMode);
}
// Account management (invite, remove, list, reset someone else's password) is delegable via
// the manageAccounts permission — but an Admin's own account can never be touched by anyone
// but another Admin, regardless of that permission, so a delegated manager can't lock out or
// hijack the real admins. targetRole may be null (e.g. inviting a brand-new staff record that
// hasn't been given a role yet) — treated as manageable, since it can't be Admin if it's new.
function canManageAccount(state, requestorStaffId, targetRole) {
  const requestorRole = roleOf(state, requestorStaffId);
  if (requestorRole === 'Admin') return true;
  if (targetRole === 'Admin') return false;
  const perms = state && state.rolePermissions && state.rolePermissions[requestorRole];
  return !!(perms && perms.manageAccounts);
}
// The first time anyone opens Test Mode, the sandbox has no data at all — seed it with the
// same bootstrap-marker approach real first-time setup uses, so the existing frontend logic
// (which already knows how to turn a bootstrap marker into a full seeded demo dataset with
// this person as Admin) just works, with zero special-casing needed on the client. Everyone
// with Test Mode access shares this one sandbox — if it already exists, just make sure this
// particular tester has a staff record in it too (as Admin, for full run-of-the-place access),
// rather than only ever bootstrapping the very first person who tried it.
async function ensureTestBootstrap(staffId, name, email) {
  const testStore = getStore(TEST_APP_STORE);
  const existing = await loadFullState(testStore);

  const realState = await loadFullState(getStore(APP_STORE)).catch(() => null);

  if (!existing) {
    // Very first-ever test-mode login on this site: hand the client what it needs to seed demo
    // data and immediately apply the real role/permission structure on top of it.
    const realStaff = realState && realState.staff ? realState.staff.find((s) => s.id === staffId) : null;
    const realRolePerms = realState && realState.roles && realState.rolePermissions
      ? { roles: realState.roles, rolePermissions: realState.rolePermissions } : null;
    await writeBootstrapMarker(testStore, {
      __bootstrapAdmin: { staffId, name, email, role: (realStaff && realStaff.role) || 'Admin' },
      __rolesToCopy: realRolePerms,
    });
    return;
  }

  const changes = syncTestModeRole(existing, realState, staffId, name, email);
  if (changes) await saveChangedKeys(testStore, changes);
}

const OTP_TTL_MS = 10 * 60 * 1000;       // codes are valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;              // wrong-code attempts before the challenge is void
const LOGIN_MAX_FAILURES = 5;            // wrong-password attempts before a temporary lockout
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // lockout duration
// Session length: override with env var SESSION_TTL_HOURS if you want it shorter/longer.
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 12) * 3600 * 1000;

async function loadCreds(store) {
  const data = await store.get(CRED_KEY, { type: 'json' });
  return data || {};
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON body' }); }

  const action = body.action;

  // ---- Public (unauthenticated) read of the EmailJS config, needed by the login screen
  // itself to send MFA codes before the user has a session. EmailJS's public key, service
  // ID, and template ID are all designed to be exposed client-side — nothing secret here.
  if (action === 'getEmailConfig') {
    const appStore = getStore(APP_STORE);
    const cfg = await appStore.get('emailjsPublic', { type: 'json' });
    return json(200, { config: cfg || null });
  }

  const credStore = getStore(CRED_STORE);
  const secret = process.env.SESSION_SECRET || process.env.SESSION_SECRET_2;
  if (!secret) return json(500, { error: 'Server misconfigured: SESSION_SECRET is not set' });

  // ---- Public: is first-time setup already done? Lets the sign-in screen hide that tab
  // once it's no longer relevant, instead of showing it to every visitor forever.
  if (action === 'setupStatus') {
    const creds = await loadCreds(credStore);
    return json(200, { completed: Object.keys(creds).length > 0 });
  }

  // ---- Bootstrap the very first Admin account ----
  if (action === 'setup') {
    const setupKey = process.env.SETUP_KEY || process.env.SETUP_KEY_2;
    if (!setupKey) return json(500, { error: 'Server misconfigured: SETUP_KEY is not set' });
    if (body.setupKey !== setupKey) return json(403, { error: 'Incorrect setup key' });

    const creds = await loadCreds(credStore);
    if (Object.keys(creds).length > 0) return json(409, { error: 'Setup already completed — use Login instead' });

    const { name, email, password } = body;
    if (!name || !email || !password) return json(400, { error: 'Name, email, and password are all required' });

    const staffId = 'st_' + Math.random().toString(36).slice(2, 10);
    const { salt, hash } = hashPassword(password);
    creds[email.toLowerCase()] = { staffId, name, salt, hash };
    await credStore.setJSON(CRED_KEY, creds);

    // Seed the app data store with this person as the first Admin, if no app data exists yet.
    const appStore = getStore(APP_STORE);
    const existingState = await loadFullState(appStore);
    if (!existingState) {
      // A minimal marker — the frontend's own seedState()/migrateState() fills in the rest
      // and this Admin staff record on first save.
      await writeBootstrapMarker(appStore, { __bootstrapAdmin: { staffId, name, email: email.toLowerCase() } });
    }

    const token = signToken({ staffId, email: email.toLowerCase() }, secret, SESSION_TTL_MS);
    await appendAudit(event, { type: 'setup_admin_created', email: email.toLowerCase(), staffId });
    return json(200, { token, staffId, name });
  }

  // ---- Admin or a manageAccounts-permitted role creates/resets a login by emailing a
  // temporary password the user must change ----
  if (action === 'sendInvite') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Not signed in' });

    const { targetEmail, targetStaffId, targetName } = body;
    if (!targetEmail || !targetStaffId) return json(400, { error: 'targetEmail and targetStaffId are required' });

    const appStore = getStore(APP_STORE);
    const state = await loadFullState(appStore);
    const targetRole = state ? roleOf(state, targetStaffId) : null;
    if (!canManageAccount(state, payload.staffId, targetRole)) {
      return json(403, { error: 'You do not have permission to invite this staff member' });
    }

    const tempPassword = generateOtp() + generateOtp().slice(0, 4); // 10-digit temp password
    const { salt, hash } = hashPassword(tempPassword);
    const creds = await loadCreds(credStore);
    creds[String(targetEmail).toLowerCase()] = {
      staffId: targetStaffId, name: targetName || '', salt, hash, mustChangePassword: true,
    };
    await credStore.setJSON(CRED_KEY, creds);
    await appendAudit(event, {
      type: 'invite_sent', email: String(targetEmail).toLowerCase(), staffId: payload.staffId,
      detail: `invited staffId ${targetStaffId}`,
    });
    // Plaintext temp password returned once, so the admin's browser can email it via EmailJS —
    // same pattern/limitation as the MFA code (see the login action below).
    return json(200, { tempPassword });
  }

  // ---- Self-service: change your own password (used for the forced first-login change) ----
  if (action === 'changePassword') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Not signed in' });
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword) return json(400, { error: 'currentPassword and newPassword are required' });
    if (newPassword.length < 8) return json(400, { error: 'New password must be at least 8 characters' });

    const creds = await loadCreds(credStore);
    const rec = creds[payload.email];
    if (!rec || !verifyPassword(currentPassword, rec.salt, rec.hash)) {
      return json(401, { error: 'Current password is incorrect' });
    }
    const { salt, hash } = hashPassword(newPassword);
    creds[payload.email] = { ...rec, salt, hash, mustChangePassword: false };
    await credStore.setJSON(CRED_KEY, creds);
    await appendAudit(event, { type: 'password_changed_self', email: payload.email, staffId: payload.staffId });
    return json(200, { ok: true });
  }

  // ---- Recovery: force a given email's staff record to Admin, gated by the setup key.
  // Exists for exactly this situation — someone is locked out of Admin-only screens (like
  // Settings) because their staff record's role got mixed up, and normal in-app fixes
  // require Admin access in the first place. Anyone with the setup key can use this at any
  // time (not just once), since it's meant as a standing recovery tool, not a one-time step.
  if (action === 'promoteToAdmin') {
    const setupKey = process.env.SETUP_KEY || process.env.SETUP_KEY_2;
    if (!setupKey) return json(500, { error: 'Server misconfigured: SETUP_KEY is not set' });
    if (body.setupKey !== setupKey) return json(403, { error: 'Incorrect setup key' });

    const emailKey = String(body.email || '').toLowerCase();
    const creds = await loadCreds(credStore);
    const rec = creds[emailKey];
    if (!rec) return json(404, { error: 'No account found with that email' });

    const appStore = getStore(APP_STORE);
    const state = await loadFullState(appStore);
    if (!state || !state.staff) return json(500, { error: 'No app data found yet — sign in and load the app at least once first' });

    const staffMember = state.staff.find((s) => s.id === rec.staffId);
    if (staffMember) {
      staffMember.role = 'Admin';
      staffMember.access = { type: 'all', studentIds: [] };
    } else {
      // No staff record matches this login at all — rather than fail, create one. This is
      // exactly the scenario this tool exists for: a login and the staff list have drifted
      // apart (e.g. across renamed/re-deployed sites), and someone needs a guaranteed way in.
      state.staff.push({
        id: rec.staffId, name: rec.name || emailKey, email: emailKey, role: 'Admin',
        access: { type: 'all', studentIds: [] },
      });
    }
    await saveChangedKeys(appStore, { staff: state.staff });
    await appendAudit(event, { type: 'promoted_to_admin', email: emailKey, staffId: rec.staffId });
    return json(200, { ok: true });
  }

  // ---- Login, step 1: password check → issues an MFA challenge, not a session ----
  if (action === 'login') {
    const { email, password, testMode } = body;
    if (!email || !password) return json(400, { error: 'Email and password are required' });
    const emailKey = String(email).toLowerCase();
    const creds = await loadCreds(credStore);
    const rec = creds[emailKey];

    if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
      const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      await appendAudit(event, { type: 'login_locked_out', email: emailKey });
      return json(423, { error: `Too many failed attempts. Try again in ${mins} minute(s).` });
    }

    if (!rec || !verifyPassword(password, rec.salt, rec.hash)) {
      if (rec) {
        rec.failedAttempts = (rec.failedAttempts || 0) + 1;
        if (rec.failedAttempts >= LOGIN_MAX_FAILURES) {
          rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
          rec.failedAttempts = 0;
        }
        creds[emailKey] = rec;
        await credStore.setJSON(CRED_KEY, creds);
      }
      await appendAudit(event, { type: 'login_failed_password', email: emailKey });
      return json(401, { error: 'Incorrect email or password' });
    }

    if (rec.failedAttempts || rec.lockedUntil) {
      rec.failedAttempts = 0;
      delete rec.lockedUntil;
      creds[emailKey] = rec;
      await credStore.setJSON(CRED_KEY, creds);
    }

    // Test Mode: the person's real account must have the accessTestMode permission (checked
    // against the REAL production data — test mode is a real-role privilege, not a separate
    // credential). If granted, everything from here on is scoped to a completely separate
    // Blobs store, isolated from real school data.
    const realState = await loadFullState(getStore(APP_STORE));
    const role = roleOf(realState, rec.staffId);
    if (testMode) {
      if (!hasTestModeAccess(realState, role)) {
        await appendAudit(event, { type: 'test_mode_denied', email: emailKey, staffId: rec.staffId });
        return json(403, { error: 'Your account does not have access to Test Mode. Ask an Admin to grant it in Settings → Roles & permissions.' });
      }
    }

    // MFA is required for every role by default. A role can be explicitly exempted (Settings →
    // Roles & Permissions → "Skip MFA for this role") — meant for something like a Driver
    // account with a narrow, low-privilege scope where a school has judged the friction of a
    // login code isn't worth it for that job. This is an opt-OUT an Admin has to consciously
    // set per role; it's false (MFA required) for every role unless changed, including Admin
    // itself, which can never be exempted regardless of this setting — see the check below.
    const mfaExempt = role !== 'Admin' && !!(realState.rolePermissions && realState.rolePermissions[role] && realState.rolePermissions[role].mfaExempt);
    if (mfaExempt) {
      const token = signToken({ staffId: rec.staffId, email: emailKey, testMode: !!testMode }, secret, SESSION_TTL_MS);
      await appendAudit(event, { type: testMode ? 'login_success_test_mode' : 'login_success_mfa_exempt', email: emailKey, staffId: rec.staffId });
      if (testMode) await ensureTestBootstrap(rec.staffId, rec.name, emailKey);
      return json(200, { token, staffId: rec.staffId, name: rec.name, mustChangePassword: !!rec.mustChangePassword, testMode: !!testMode });
    }

    // Password is correct. Issue a one-time code the client must email to itself via
    // EmailJS and then submit back with action:"verifyMfa" to actually get a session.
    const mfaStore = getStore(MFA_STORE);
    const pendingId = require('crypto').randomBytes(24).toString('hex');
    const code = generateOtp();
    const { salt, hash } = hashPassword(code); // scrypt-hash the code the same way as passwords
    await mfaStore.setJSON(pendingId, {
      staffId: rec.staffId, email: emailKey, name: rec.name,
      salt, hash, attempts: 0, expires: Date.now() + OTP_TTL_MS, mustChangePassword: !!rec.mustChangePassword,
      testMode: !!testMode,
    });
    await appendAudit(event, { type: 'login_password_ok_awaiting_mfa', email: emailKey, staffId: rec.staffId });

    // NOTE ON DESIGN: this app sends email client-side via EmailJS (no server-side email
    // credentials exist). That means the plaintext code must be returned here so the browser
    // can hand it to EmailJS. Anyone who could read this specific HTTPS response already has
    // the user's password, so this is a real second factor against stolen/reused passwords and
    // remote credential-stuffing — but it is weaker than a server-sent code. If you later add
    // a transactional email provider (Postmark/Resend/SES) with a server-side API key, move the
    // emailjs.send() call from the browser into this function and stop returning `code` at all.
    return json(200, {
      mfaRequired: true, pendingId, email: emailKey, name: rec.name, code,
    });
  }

  // ---- Login, step 2: verify the emailed code, then issue the real session token ----
  if (action === 'verifyMfa') {
    const { pendingId, code } = body;
    if (!pendingId || !code) return json(400, { error: 'pendingId and code are required' });
    const mfaStore = getStore(MFA_STORE);
    const entry = await mfaStore.get(pendingId, { type: 'json' });
    if (!entry) return json(401, { error: 'Code expired or invalid — please sign in again' });
    if (Date.now() > entry.expires) {
      await mfaStore.delete(pendingId);
      return json(401, { error: 'Code expired — please sign in again' });
    }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) {
      await mfaStore.delete(pendingId);
      await appendAudit(event, { type: 'mfa_locked_out', email: entry.email, staffId: entry.staffId });
      return json(401, { error: 'Too many incorrect attempts — please sign in again' });
    }
    if (!verifyPassword(String(code).trim(), entry.salt, entry.hash)) {
      entry.attempts += 1;
      await mfaStore.setJSON(pendingId, entry);
      await appendAudit(event, { type: 'mfa_failed', email: entry.email, staffId: entry.staffId });
      return json(401, { error: 'Incorrect code' });
    }
    await mfaStore.delete(pendingId);
    const token = signToken({ staffId: entry.staffId, email: entry.email, testMode: !!entry.testMode }, secret, SESSION_TTL_MS);
    await appendAudit(event, { type: entry.testMode ? 'login_success_test_mode' : 'login_success', email: entry.email, staffId: entry.staffId });
    if (entry.testMode) await ensureTestBootstrap(entry.staffId, entry.name, entry.email);
    return json(200, { token, staffId: entry.staffId, name: entry.name, mustChangePassword: !!entry.mustChangePassword, testMode: !!entry.testMode });
  }

  // ---- Resend a fresh code for an in-progress MFA challenge ----
  if (action === 'resendMfa') {
    const { pendingId } = body;
    if (!pendingId) return json(400, { error: 'pendingId is required' });
    const mfaStore = getStore(MFA_STORE);
    const entry = await mfaStore.get(pendingId, { type: 'json' });
    if (!entry) return json(401, { error: 'Session expired — please sign in again' });
    const code = generateOtp();
    const { salt, hash } = hashPassword(code);
    entry.salt = salt; entry.hash = hash; entry.attempts = 0; entry.expires = Date.now() + OTP_TTL_MS;
    await mfaStore.setJSON(pendingId, entry);
    return json(200, { pendingId, email: entry.email, name: entry.name, code });
  }

  // ---- List which staff currently have login accounts (no password data exposed) — Admin,
  // or anyone with manageAccounts, though the latter never sees Admin accounts in the list ----
  if (action === 'listAccounts') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Not signed in' });
    const state = await loadFullState(getStore(APP_STORE));
    const requestorIsAdmin = roleOf(state, payload.staffId) === 'Admin';
    if (!requestorIsAdmin && !canManageAccount(state, payload.staffId, null)) {
      return json(403, { error: 'You do not have permission to view accounts' });
    }
    const creds = await loadCreds(credStore);
    const accounts = Object.entries(creds)
      .filter(([, rec]) => requestorIsAdmin || roleOf(state, rec.staffId) !== 'Admin')
      .map(([email, rec]) => ({
        email, staffId: rec.staffId, mustChangePassword: !!rec.mustChangePassword, locked: !!(rec.lockedUntil && Date.now() < rec.lockedUntil),
      }));
    return json(200, { accounts });
  }

  // ---- Revoke a login entirely (the person can no longer sign in at all) — Admin, or
  // manageAccounts, but never targeting an Admin's own account ----
  if (action === 'removeAccount') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Not signed in' });
    const { targetEmail } = body;
    if (!targetEmail) return json(400, { error: 'targetEmail is required' });
    const state = await loadFullState(getStore(APP_STORE));
    const creds = await loadCreds(credStore);
    const emailKey = String(targetEmail).toLowerCase();
    if (!creds[emailKey]) return json(404, { error: 'No account found with that email' });
    const targetRole = roleOf(state, creds[emailKey].staffId);
    if (!canManageAccount(state, payload.staffId, targetRole)) {
      return json(403, { error: 'You do not have permission to remove this account' });
    }
    delete creds[emailKey];
    await credStore.setJSON(CRED_KEY, creds);
    await appendAudit(event, { type: 'account_removed', email: emailKey, staffId: payload.staffId });
    return json(200, { ok: true });
  }

  // ---- Set/reset a password, and/or update the staff link & display name — self always
  // allowed; changing someone else's requires Admin or manageAccounts, and never targets an
  // Admin's own account unless the requester is an Admin themselves ----
  if (action === 'setPassword') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Not signed in' });

    const { targetEmail, targetStaffId, newPassword, targetName } = body;
    if (!targetEmail) return json(400, { error: 'targetEmail is required' });

    const creds = await loadCreds(credStore);
    const emailKey = String(targetEmail).toLowerCase();
    const existing = creds[emailKey];
    if (!newPassword && !existing) return json(400, { error: 'newPassword is required to create a new account' });

    const isSelf = existing && existing.staffId === payload.staffId;
    if (!isSelf) {
      const state = await loadFullState(getStore(APP_STORE));
      const currentRole = roleOf(state, existing && existing.staffId);
      const newRole = roleOf(state, targetStaffId);
      if (!canManageAccount(state, payload.staffId, currentRole) || !canManageAccount(state, payload.staffId, newRole)) {
        return json(403, { error: 'You do not have permission to change this account' });
      }
    }

    let salt, hash;
    if (newPassword) { ({ salt, hash } = hashPassword(newPassword)); }
    else { salt = existing.salt; hash = existing.hash; }

    creds[emailKey] = {
      staffId: targetStaffId || (existing && existing.staffId) || payload.staffId,
      name: targetName || (existing && existing.name) || '',
      salt, hash,
    };
    await credStore.setJSON(CRED_KEY, creds);
    await appendAudit(event, {
      type: newPassword ? 'password_set' : 'account_updated', email: emailKey, staffId: payload.staffId,
      detail: isSelf ? 'self' : 'by_admin',
    });
    return json(200, { ok: true });
  }

  // ---- Verify a session is still valid (used on app load) ----
  if (action === 'verify') {
    const token = getBearerToken(event);
    const payload = verifyToken(token, secret);
    if (!payload) return json(401, { error: 'Session expired — please sign in again' });
    return json(200, { staffId: payload.staffId, email: payload.email, testMode: !!payload.testMode });
  }

  return json(400, { error: 'Unknown action' });
};

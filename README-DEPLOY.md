# Deploying Ledger with a real backend (Netlify + EmailJS)

This package turns the single-file Ledger app into a real multi-user system: login
with a password **and an emailed 6-digit code (MFA)**, data stored centrally (not in
one browser), an audit log, and server-side permission checks — not just checks in the
browser.

If you already have this deployed from before, this is an **upgrade** — same site,
same data, same environment variables. See "Upgrading an existing deployment" below.

## What's in this folder

```
netlify.toml                        — site config + security headers
package.json                        — the one dependency the functions need
public/index.html                   — the app itself (identical to the artifact you've been using)
netlify/functions/auth.js           — login, MFA, first-time setup, password resets
netlify/functions/data.js           — reads/writes the school's data, enforces role permissions
netlify/functions/audit.js          — Admin-only: fetch the audit log
netlify/functions/_auth-helpers.js  — password/OTP hashing + session tokens (no external deps)
netlify/functions/_audit-helpers.js — appends/reads the audit log blobs
```

## 1. Create the site on Netlify

**Easiest path — drag and drop:**
1. Zip this whole folder (or just drag the folder) into [app.netlify.com/drop](https://app.netlify.com/drop).
2. Netlify will publish `public/` as your site and auto-detect `netlify/functions/`.

**Or, if you prefer Git:** push this folder to a GitHub repo and "Import an existing
project" in Netlify, pointing the publish directory to `public` and functions directory
to `netlify/functions` (already set in `netlify.toml`, so the defaults just work).

## 2. Netlify Blobs

Enabled by default on all Netlify sites — nothing to sign up for or configure.

## 3. Set environment variables

In your Netlify site: **Site configuration → Environment variables → Add a variable**

| Key | Required? | Value |
|---|---|---|
| `SESSION_SECRET` | Yes | Any long random string (40+ characters, e.g. from [random.org/strings](https://www.random.org/strings/)). Signs login sessions. Keep it secret. |
| `SETUP_KEY` | Yes | A password only you know, used once to create the first Admin account. |
| `SESSION_TTL_HOURS` | No | How many hours a signed-in session lasts before requiring password + code again. Defaults to `12` if not set. |
| `ANTHROPIC_API_KEY` | Only if you want AI features | Powers "✨ Suggest," Smart Import, AI-drafted reports/lesson plans, and the handwriting/calendar readers. Get one at [console.anthropic.com](https://console.anthropic.com) → API Keys. Without this, those buttons show a clear "AI features aren't set up yet" message instead of failing silently — everything else in the app works fine without it. |
| `RESEND_API_KEY` | Only if you want the automated off-Netlify backup email or the weekly staff compliance report emails | Free account at [resend.com](https://resend.com). Used server-side for sending real emails with attachments from a scheduled job — EmailJS (used for regular in-app notifications) is a browser-only SDK and can't run on a schedule with nobody's browser open. |
| `BACKUP_EMAIL_TO` / `BACKUP_EMAIL_FROM` | Only for the backup email | Where the weekly full-data backup email goes, and what "from" address it's sent as. |
| `SCHOOL_TIMEZONE` | No | IANA timezone name (e.g. `America/New_York`, `America/Chicago`). Controls when "Friday 2:00 PM" actually is for the weekly staff compliance reports. Defaults to `America/New_York` if not set. |

After adding these, **redeploy the site** (Deploys → Trigger deploy) so the functions
pick them up.

## 4. Create the first Admin account

1. Visit your new Netlify site URL.
2. Click **"First-time setup"**.
3. Enter your `SETUP_KEY`, your name, your email, and a password.
4. You're now signed in as Admin. Setup can only run once — after this, everyone signs
   in with **"Sign in"**. (The very first setup skips the emailed code, since EmailJS
   isn't configured yet at that point — set it up next.)

## 5. Turn on email notifications AND sign-in codes (EmailJS)

This one EmailJS setup now powers two things: report/message notifications, and the
6-digit codes used for MFA at login. Do this before other staff start signing in.

1. Create a free account at [emailjs.com](https://www.emailjs.com).
2. Add an **Email Service** (e.g. connect your Gmail/Outlook) — note the **Service ID**.
3. Create an **Email Template** with these variable placeholders in the body:
   `{{to_name}}`, `{{subject}}`, `{{message}}`, `{{school_name}}` — and set the "To
   email" field to `{{to_email}}`. Note the **Template ID**. (The MFA code is sent
   through the `{{message}}` variable along with everything else — no second template
   needed.)
4. In EmailJS, go to Account → General and copy your **Public Key**.
5. In Ledger, go to **Settings → Email notifications**, paste in all three, check
   **Enabled**, and click **Save**, then **"Send test email to myself"** to confirm it
   works.
6. Sign out and sign back in once to confirm you receive the 6-digit code by email.

**Known limitation, on purpose:** because emails are sent from the browser (no
server-side email account exists), the server hands the code to the browser so it can
hand it to EmailJS — it doesn't email it from the server directly. That's still a real
second factor against a stolen or guessed password, but it's not as strong as a
server-sent code. If you want that upgrade later, it means adding a transactional
email provider (Postmark, Resend, SES, etc.) with a server-side API key — ask and we
can build that next.

## 6. Add your staff

From the Staff tab, add each person as usual. For anyone who should be able to log in
themselves, open their record and click **"🔑 Set/reset login password"** (you'll need
their email filled in first) — give them that password to sign in with. They'll get an
emailed code every time they sign in, in addition to the password.

## What's real now

- **Passwords**: hashed with scrypt, never stored in plain text.
- **MFA**: password + a 6-digit code emailed on every sign-in, with a 10-minute
  expiry and a 5-attempt limit before it's void.
- **Account lockout**: 5 wrong passwords locks the account for 15 minutes.
- **Sessions**: cryptographically signed, expire after `SESSION_TTL_HOURS` (default 12).
- **Idle timeout**: the app itself signs a user out after 20 minutes of no mouse/keyboard
  activity, with a warning toast beforehand.
- **Audit log**: every sign-in (success/failure), MFA attempt, password change, data
  save, and any write the server blocked is recorded server-side. Visible to Admins
  under the new **Audit Log** tab. Staff cannot edit or delete these entries.
- **Server-side permission checks**: `data.js` now compares the incoming save against
  what's currently stored and rejects it (HTTP 403, logged to the audit log) if the
  signed-in staff member's role doesn't have the right permission for what changed —
  editing setup/staff/students/classes, editing or deleting sessions, deleting others'
  notes/reports, approving/returning reports, or managing document templates. This
  closes the gap where someone could bypass the interface and call the API directly.
- **Security headers**: `netlify.toml` now sends HSTS, X-Frame-Options,
  X-Content-Type-Options, and a conservative Permissions-Policy on every response.

## What's still not real (the honest list)

These are the remaining items before this should hold real student health/education
records long-term — see the separate HIPAA readiness document for the non-technical
half of this (risk assessment, backup/disaster recovery, breach notification, and
tracking the Business Associate Agreements you'd still need):

- **No Business Associate Agreement (BAA)** with Netlify or EmailJS. This is the big
  one and it's contractual, not something code can fix.
- **The AI features** (voice-to-text suggestions, "smart import," AI-written report
  text) call Anthropic's public API directly from the browser with no BAA either.
  Treat those as off-limits for real PHI until that's addressed too — same category of
  problem as EmailJS.
- **MFA code delivery** goes through the browser, as noted above — a real second
  factor, but not the strongest possible design.
- Permission enforcement in `data.js` is deliberately conservative (it favors letting
  an ambiguous change through over locking staff out of real work) — it's a backstop,
  not a full field-by-field access-control system.
- No encryption beyond what Netlify provides by default (TLS in transit; Netlify
  Blobs' own at-rest handling).

## Upgrading an existing deployment

If you deployed the previous version of this package already:

1. Replace the whole folder's contents with this version (or just the changed files
   listed above) and redeploy — same Netlify site, same env vars.
2. Nothing to migrate in your data — the audit log and MFA are new, independent blob
   stores that start empty.
3. The first time each staff member signs in after the upgrade, they'll be asked for
   an emailed code in addition to their password — that's expected.
4. If `SESSION_TTL_HOURS` isn't set, sessions now default to 12 hours instead of the
   old 7 days — everyone will need to sign in again once after deploying.

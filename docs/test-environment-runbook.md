# Closed test environment runbook

Baseline commit: `3d81ee8041f7a46f39eb84d53154f932bda5313f` (`3d81ee8`).
Prepared: 2026-08-05. Scope: release plan stage 1 only — prepare and verify a
closed test environment. No pilot, no production, no real customer data.

Read this together with [`docs/test-environment-status.md`](test-environment-status.md)
(what is and is not verified) and
[`docs/test-environment-smoke-test.md`](test-environment-smoke-test.md)
(the step-by-step acceptance run).

---

## 1. Architecture of the test environment

```text
Frontend      Static single-page application (no framework, no bundler).
              One tracked index.html + 12 classic scripts in src/ + vendor/supabase.js.
              Navigation is in-page tab switching. There are no client-side routes
              and no deep links, so no SPA rewrite/fallback rule is required.
Build tool    node scripts/build-pages-artifact.cjs (npm run build:pages).
              Fixed 17-file allowlist, deterministic bytes, self-validating.
Backend       Supabase (PostgreSQL 17 + PostgREST + GoTrue + Edge Functions).
Database      All business writes go through SECURITY DEFINER RPCs. No table has
              an INSERT/UPDATE/DELETE policy; browsers hold SELECT only.
Auth          Supabase Auth, email + password. No signup UI, no OAuth, no magic
              link, no email confirmation. Accounts are created by an administrator.
Storage       NOT CONFIGURED. No bucket, no storage policy, no upload path. See blocker B1.
Hosting       NOT CONFIGURED. See section 8 and blocker B4.
```

### Data flow

| Operation | Path |
| --- | --- |
| Sign in | `supabase.auth.signInWithPassword` → `profiles` row → role |
| Load leads | `SELECT` on the `public.players_secure` view (masked contacts only) |
| CSV import | `prepareCsvImport` in the browser → `create_players_atomic` RPC |
| Assignment | `assign_players_atomic` RPC (admin only) |
| Status change | `change_player_status_atomic` RPC |
| Contact reveal | `reveal_player_contacts` RPC — the single audited contact egress |
| Comments / follow-up | `add_player_comment_atomic`, `set_player_follow_up_atomic` |
| Team management | `team-management` Edge Function (verify_jwt = true) |

---

## 2. Requirements

- Node.js >= 22 (verified on 22.23.1), npm 10.
- Docker Desktop (local runtime only; not needed for a cloud test project).
- Supabase CLI — installed per project by `npm ci` (verified 2.110.0).
- A Supabase project dedicated to testing. **Never a production project.**
- Static HTTPS hosting for the built artifact.

---

## 3. Configuration contract

This project deliberately does **not** use `.env` files, and no `.env.example`
exists on purpose. There are exactly two configuration surfaces:

**A. Local development** — two Git-ignored files under `config/`:

| File | Copy from | Contents |
| --- | --- | --- |
| `config/supabase-config.local.js` | `config/supabase-config.example.js` | `projectUrl`, `publishableKey` |
| `config/data-config.local.js` | `config/data-config.example.js` | `mode: 'supabase'` or `'local'` |

**B. Deployment build** — process environment variables read by `build:pages`:

| Variable | Used by | Required | Public/Secret | Test value source |
| --- | --- | ---: | --- | --- |
| `DASHBOARD_SUPABASE_PROJECT_URL` | `scripts/build-pages-artifact.cjs`, `verify:release` | Yes | Public (browser) | Test project → Settings → API → Project URL |
| `DASHBOARD_SUPABASE_PUBLISHABLE_KEY` | `scripts/build-pages-artifact.cjs`, `verify:release` | Yes | Public (browser) | Test project → Settings → API keys → publishable |
| `DASHBOARD_PORT` | `npm run dev:local`, `npm run doctor` | No (default 3100) | n/a | local only |
| `SMOKE_TEST_*` | runtime smoke scripts under `scripts/` | Only for smoke runs | Secret (passwords, service key) | session shell only, never a file |

Validation enforced by the builder — a wrong value fails the build, it does not
ship:

- `DASHBOARD_SUPABASE_PROJECT_URL` must be `https://<project-ref>.supabase.co`
  with no port, path, query, fragment, or credentials.
- `DASHBOARD_SUPABASE_PUBLISHABLE_KEY` must be of the `sb_publishable_` class.
  JWTs, `sb_secret_`, and service-role values are rejected.

**A service-role key must never appear in any of the above.** It belongs only to
Supabase Edge Function secrets, where the platform injects it server-side.

---

## 4. Provision the test Supabase project

> Every step below targets a project that is **not** production. Confirm the
> project reference before each command.

1. Create (or nominate) a Supabase project used only for testing. Record its
   reference as `<test-ref>`.
2. Authorize the CLI once, in an interactive terminal:

```bash
npx supabase login
```

3. Link the repository to the test project (this writes `supabase/.temp/project-ref`,
   which is Git-ignored):

```bash
npx supabase link --project-ref <test-ref>
```

4. **Review before applying.** List what would change, and confirm the target:

```bash
npx supabase migration list --linked
```

5. Apply the migrations. All eight are additive; none drops a table or column.

```bash
npx supabase db push --linked
```

Expected migration set, in order:

| Version | File | Purpose |
| --- | --- | --- |
| 20260729000100 | `dashboard_foundation.sql` | tables, enums, indexes, RLS, SELECT policies |
| 20260729000200 | `atomic_writes.sql` | atomic business RPCs |
| 20260729000300 | `smoke_test_harness.sql` | **test-only** provisioning + scoped cleanup helpers |
| 20260729000400 | `team_management.sql` | admin audit, team RPCs |
| 20260801000100 | `secure_contact_projection.sql` | `players_secure` masked view |
| 20260801000200 | `revoke_raw_contacts.sql` | revokes raw contact columns from browser roles |
| 20260802000100 | `contact_reveal_audit.sql` | immutable reveal audit + rate limits |
| 20260802000200 | `contact_reveal_rpc.sql` | `reveal_player_contacts`, the single egress |

`20260729000300` is explicitly marked *SMOKE-TEST ONLY*. It is appropriate for a
test project and must be rolled back (`supabase/rollback/`) or excluded before any
production deployment.

6. Deploy the Edge Function used for team management:

```bash
npx supabase functions deploy team-management
```

7. In the test project's dashboard, confirm Auth settings:
   - Email provider enabled, **email confirmations off** (the app has no confirm flow).
   - **Signups disabled.** Accounts are administrator-created only.
   - Site URL set to the test frontend URL (used only for email templates; the app
     uses password sign-in and no redirect callback).

### Rollback

Each contact-boundary migration ships a matching script in `supabase/rollback/`.
Apply them in reverse order through the SQL editor of the test project:

```text
20260802000200_contact_reveal_rpc_rollback.sql
20260802000100_contact_reveal_audit_rollback.sql
20260801000200_revoke_raw_contacts_rollback.sql
20260801000100_secure_contact_projection_rollback.sql
```

The four foundation migrations have no rollback script (documented legacy
exemption). For a **test** project the supported rollback is to recreate the
project and re-run section 4. Never run `db reset` against a shared project.

---

## 5. Create the test accounts

There is no self-registration and **no working admin UI for creating cashiers in
Supabase mode** (blocker B2). Create accounts one of two ways.

**Option 1 — Supabase dashboard (recommended for the first admin).**

1. Authentication → Users → Add user → email + password, "Auto Confirm User" on.
2. Copy the new user's UUID.
3. SQL editor, one statement per account:

```sql
insert into public.profiles (id, username, name, role, lang, is_active)
values ('<uuid>', 'test_admin', 'Test Admin', 'admin', 'es', true);
```

Use role `agent` for cashiers. A profile row is mandatory: without it sign-in
fails with `profile_missing`.

**Option 2 — team-management Edge Function (for additional cashiers).**
Signed in as an existing admin, with that admin's access token:

```bash
curl -X POST "https://<test-ref>.supabase.co/functions/v1/team-management" \
  -H "authorization: Bearer <admin-access-token>" \
  -H "content-type: application/json" \
  -d '{"action":"invite-member","email":"cashier1@example.com","username":"cashier1","name":"Cashier One","role":"agent","requestId":"<uuid>"}'
```

Supported actions: `list-members`, `invite-member`, `update-member-role`,
`set-member-active`, `reassign-players`. Every action is admin-only, idempotent
by `requestId`, and audited. Deactivating an agent that still holds leads is
refused with `REASSIGNMENT_REQUIRED` unless `reassignTo` is supplied.

Minimum test roster: 1 admin, 2 agents.

---

## 6. Seed synthetic test data

Use only the fixtures in `docs/test-environment/`. They contain invented names,
`example.com` / `example.org` addresses, and non-routable numbers.

| File | Delimiter | Contents |
| --- | --- | --- |
| `synthetic-leads.csv` | `,` | 10 valid leads, 1 duplicate row, 1 invalid email, 1 blank row |
| `synthetic-leads-duplicates.csv` | `;` | 1 cross-file duplicate, phone-only row, email-only row, 2 valid |

Import them through the running application (Import → Choose file), not through
SQL. That is the path under test.

Recognised CSV headers (case-insensitive; a header row is optional, and without
one the columns are read positionally as phone, email, contact):

```text
phone     | телефон
email     | почта
contact   | контакт | telegram | whatsapp | messenger
```

Limits: 5 MB, 10000 data rows, `.csv` only (`.xlsx` is rejected explicitly).
Duplicates are detected on normalised phone, then email, then contact.

**Do not load real customer data into this environment.** Blocker B1 means the
proof/attachment side of the workflow is not implemented, and the environment has
not been reviewed for real personal data.

---

## 7. Build the frontend

```powershell
$env:DASHBOARD_SUPABASE_PROJECT_URL = 'https://<test-ref>.supabase.co'
$env:DASHBOARD_SUPABASE_PUBLISHABLE_KEY = '<test publishable key>'
npm ci
npm run build:vendor
npm run build:pages
```

Output: `artifacts/pages-site/` — exactly 17 files plus `deployment-manifest.json`.
The command prints a manifest SHA-256 that identifies the artifact. It builds a
local directory only; it publishes nothing.

Verify the artifact independently at any time:

```powershell
npm run build:pages -- --validate-only
```

The ignored `config/*.local.js` files are never read by the builder, so local
development configuration cannot leak into a deployed artifact.

---

## 8. Deploy the frontend

**No hosting provider is configured in this repository** (blocker B4). There is no
`vercel.json`, `netlify.toml`, `render.yaml`, `fly.toml`, `wrangler.toml`,
Dockerfile, or Pages deployment workflow. `.github/workflows/release.yml`
explicitly states it deploys nothing.

The artifact is provider-neutral static hosting: plain files, relative paths, one
entry point, no server-side rendering, no rewrite rules, no server runtime. The
only external origin it contacts besides the Supabase project is
`fonts.googleapis.com`.

Two compatible options, in the order the repository's own evidence favours:

1. **GitHub Pages.** The builder already emits `.nojekyll` and the docs are
   written around a Pages artifact. Requires an owner decision, because Pages on
   a public repository serves a publicly reachable URL. The application itself is
   auth-gated and holds no data without a Supabase session, but the URL would be
   public.
2. **Any static host with private/preview access** (Cloudflare Pages, Netlify,
   Vercel static). Preferable if the test URL must not be publicly reachable.

Both require an account and an owner decision, so neither was created here.
Whichever is chosen, upload the contents of `artifacts/pages-site/` as the site
root and serve `index.html`.

After deployment, add the resulting origin to the test Supabase project's
allowed origins if you later enable any redirect-based flow. Password sign-in
needs no redirect configuration.

---

## 9. Verify

Run the full acceptance pass in
[`docs/test-environment-smoke-test.md`](test-environment-smoke-test.md).

For a local runtime verification instead:

```powershell
npm run doctor          # read-only diagnosis, must end READY or READY WITH WARNINGS
npm run dev:local       # serves http://127.0.0.1:3100 and provisions local smoke users
npm run dev:local -- --stop
```

The five runtime security suites under `scripts/` (`secure-contact-boundary-smoke`,
`contact-reveal-smoke`, `contact-reveal-ui-smoke`, `runtime-smoke`,
`team-management-smoke`) run against a loopback stack only and refuse a
non-loopback URL.

---

## 10. Known blockers

| ID | Severity | Summary |
| --- | --- | --- |
| B1 | P1 | Proof upload does not exist: no Storage bucket, no proof column, no upload UI, no proof-required close constraint. |
| B2 | P1 | Admin cannot create or manage cashiers from the UI in Supabase mode; the Access screen still writes through the local-storage path. |
| B3 | P1 (external) | No cloud test Supabase project and no authorized CLI session. |
| B4 | P1 (external) | No frontend hosting provider configured; nothing publishes the artifact. |
| B5 | P2 | The Access screen reports success for role changes that silently fail in Supabase mode. |
| B6 | P2 | An admin cannot reveal contacts at all, which diverges from the approved business rule on admin contact export. |
| B7 | P3 | `supabase/config.toml` Site URL and redirects point at port 3000 while the dev server runs on 3100. |

Full detail, evidence, and required actions are in
[`docs/test-environment-status.md`](test-environment-status.md).

---

## 11. Data-handling rule

Until the Product Owner records a security approval covering blocker B1 and the
storage/proof design, this environment is **synthetic data only**. No real
customer name, phone number, email address, messenger handle, or document may be
imported, uploaded, or pasted into it.

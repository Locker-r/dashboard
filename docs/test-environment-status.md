# Closed test environment status

Date: 2026-08-05
Baseline commit: `3d81ee8041f7a46f39eb84d53154f932bda5313f` (`3d81ee8`)
Branch: `chore/test-environment-readiness` (local only — not pushed, not merged)
Scope: release plan stage 1 — prepare and verify a closed test environment.

## Verdict

```text
DEPLOYMENT-READY — EXTERNAL ACCESS REQUIRED
```

The application, database schema, and security boundary are verified against a
live Supabase runtime and are ready to be deployed to a test environment. No
test environment exists yet, because creating one requires a Supabase account
and a hosting account that this session has no access to. Two functional gaps
(B1, B2) additionally mean the workflow the Product Owner asked to test cannot
be exercised end to end even once hosting exists.

## What was verified

Everything below was executed against a live local Supabase stack
(`dashboard-runtime-smoke`, Postgres 17, API `http://127.0.0.1:54321`) with the
frontend served at `http://127.0.0.1:3100` in Supabase data mode.

**The historical WinNAT blocker is gone.** `netsh int ipv4 show excludedportrange
protocol=tcp` now reports only `50000–50059`. Ports 54321–54329 are free, the
full Supabase stack starts, and local runtime verification is possible again.

### Static and unit gates

| Check | Result |
| --- | --- |
| `npm test` | exit 0 — 764 tests, 760 passed, 0 failed, 4 skipped |
| `npm run check:js` | exit 0 — 61 files |
| `npm run check:secrets` | exit 0 — 131 tracked files |
| `npm run check:migrations` | exit 0 — 8 migrations, 4 with rollback scripts |
| `npm run build:pages` | exit 0 — 17 files, manifest `f249093222550447…` |
| `npm run doctor` | READY WITH WARNINGS — 0 blockers, 1 warning (untracked Studio snippets) |

There is no `lint` or `typecheck` script in this repository; `check:js` is the
equivalent syntax gate. This is a plain-JavaScript project with no TypeScript
configuration outside the Edge Function.

### Migrations

`npx supabase db diff --local` created a fresh shadow database, applied all eight
migrations in order, and reported **`No schema changes found`**. That proves the
migration set applies cleanly to an empty database and that the running database
matches it exactly with zero drift. This is the strongest available evidence
that `supabase db push` against a fresh test project will succeed.

### Runtime security suites

All five suites passed against the live stack:

| Suite | Checks | Result |
| --- | ---: | --- |
| `scripts/secure-contact-boundary-smoke.cjs` | 35 | exit 0 |
| `scripts/contact-reveal-smoke.cjs` | 43 | exit 0 |
| `scripts/contact-reveal-ui-smoke.cjs` | 49 | exit 0 |
| `scripts/runtime-smoke.cjs` | — | exit 0 |
| `scripts/team-management-smoke.cjs` | — | exit 0 |

### Browser end-to-end pass

Driven through the real application at `http://127.0.0.1:3100`:

| Step | Result |
| --- | --- |
| Admin sign-in | Passed. No registration path is offered. |
| CSV import of the synthetic fixture | Passed. 12 rows → 10 valid, 1 invalid email, 1 duplicate; 10 created through `create_players_atomic`. |
| Round-robin distribution to 2 agents | Passed. 5 + 5, 0 unassigned. |
| Agent A scope | Passed. Sees exactly its own 5 leads; only Dashboard and Player list are reachable. |
| Contact masking before `in_work` | Passed. `🔒*******0101`, `a***@example.com`, `@a***`. |
| `assigned → in_work` transition | Passed, with a status-history row naming the agent. |
| Contacts still masked at `in_work` | Passed. An explicit "Show contacts" action is required. |
| Audited reveal | Passed. Full contacts returned, audit notice shown, ~5-minute TTL. |
| Re-masking after leaving `in_work` | Passed. |
| Agent B isolation | Passed. Sees only its own 5 leads; none of Agent A's, including the closed one. |
| Admin after closure | Passed. Sees status `Success`, the assigned agent, and both history transitions. Admin contacts stay masked. |

### Direct API attack attempts

Executed from a real browser session holding a genuine agent token:

| Attempt | Result |
| --- | --- |
| `SELECT phone,email,messenger FROM players` as agent | `DENIED 42501 permission denied for table players` |
| Same as admin | Denied (raw contact columns are revoked from every browser role) |
| Read another agent's rows from `players_secure` | Returns only the caller's own rows |
| `UPDATE players SET agent_id = me` (steal a lead) | `DENIED 42501` |
| `assign_players_atomic` as agent | `DENIED ADMIN_REQUIRED` |
| `UPDATE profiles SET role='admin'` (self-promotion) | `DENIED 42501` |
| Anonymous read of `players`, `players_secure`, `profiles` | `DENIED 42501` on all three |
| Anonymous `reveal_player_contacts`, `create_players_atomic` | `permission denied for function` |
| Inactive agent, app sign-in | Refused: "Employee profile is disabled." |
| Inactive agent holding a valid auth token | 0 rows from `players_secure`; RPCs return `ACTIVE_PROFILE_REQUIRED` |

### Database posture

- RLS enabled on all six data tables. `contact_reveal_limits` has no RLS but also
  no grant to `anon` or `authenticated`, so it is unreachable from a browser.
- Only `SELECT` policies exist. No table has an INSERT, UPDATE, or DELETE policy,
  so every write must pass through an admin/owner-checked SECURITY DEFINER RPC.
- `anon` holds no table grant and no function EXECUTE grant anywhere.
- All 20 SECURITY DEFINER functions pin `search_path` to `pg_catalog, public`.
- `players_secure` is a `security_barrier` view.
- No `SELECT` grant on `public.players` reaches the browser roles at all.

### Secrets

No tracked `.env` file exists. A working-tree scan for `sb_secret_`, JWT,
`ghp_`, and `sbp_` shapes returned zero key values — every hit was the literal
identifier `service_role` / `SERVICE_ROLE_KEY` in SQL grants and code. The built
Pages artifact contains only the two browser-public values and reaches no origin
other than the configured Supabase project and Google Fonts. The service-role key
is used only inside the `team-management` Edge Function, where Supabase injects it
server-side.

## What was NOT verified

| Area | Reason |
| --- | --- |
| Cloud test Supabase project | None exists; the CLI is not authorized and is not linked to any project. |
| Deployed frontend URL | No hosting provider is configured anywhere in the repository. |
| Proof upload, proof access control, proof-gated closing | The feature does not exist (B1). |
| Admin creating a cashier through the UI | The UI path is not wired to the backend (B2). |
| Storage buckets and storage policies | None are defined. `storage.buckets` is empty. |
| Behaviour under real production-scale data | Out of scope for this stage. |

## Release blockers

| ID | Severity | Problem | Evidence | Required action |
| --- | --- | --- | --- | --- |
| B1 | P1 | Proof upload does not exist. No Storage bucket (`storage.buckets` is empty), no storage policy, no proof column, no upload control in the UI, and no backend constraint requiring proof before a terminal status. A lead closes to `Success` immediately. | Browser pass: clicking "Success" closed the lead with no prompt; the only `input[type=file]` elements on the page are `fileImportInput` (CSV) and `migrationMapInput`. `docs/business-rules.md` does not mention proof at all. | Product Owner decision: proof is a new feature, not a fix. Needs a design (bucket, path scheme, RLS on `storage.objects`, signed URLs, a `proof_object_path` column, and a proof-required check inside `change_player_status_atomic`), then implementation as its own change. |
| B2 | P1 | An admin cannot create or manage cashiers from the UI in Supabase mode. The Access screen mutates the in-memory `users` array and calls `saveUsers()`, which resolves to `SupabaseDataService.saveUsers()` and throws `RPC_REQUIRED`. There is no "add user" control at all. The working `team-management` Edge Function has no UI. | `index.html:1916-1947` calls `saveUsers()` with no `dataMode === 'supabase'` branch, unlike every other write path. `src/data/supabase-data-service.js:136-138`. | For the test environment, provision accounts via the Supabase dashboard or the Edge Function (runbook section 5). Wiring the Access screen to the Edge Function is a separate change. |
| B3 | P1 (external) | No cloud test Supabase project, and the Supabase CLI holds no session. `~/.supabase/access-token` is absent, `SUPABASE_ACCESS_TOKEN` is unset, and `supabase/.temp/` contains no `project-ref`. | Filesystem and environment checks. | Product Owner: create or nominate a test-only Supabase project, run `npx supabase login` interactively, and supply the project reference. |
| B4 | P1 (external) | No frontend hosting provider is configured. No `vercel.json`, `netlify.toml`, `render.yaml`, `fly.toml`, `wrangler.toml`, Dockerfile, or Pages deployment workflow exists. `release.yml` states in its own header comment that it deploys nothing. | Repository inventory; `.github/workflows/release.yml:3-4`. | Product Owner: choose a static host (runbook section 8 lists two options) and decide whether the test URL may be publicly reachable. |
| B5 | P2 | The Access screen shows "role updated" while the write silently fails in Supabase mode, because the optimistic toast fires before the rejected save is caught into a generic error toast. | `index.html:1921-1922` and `index.html:803-805`. | Fix together with B2. |
| B6 | P2 | An admin cannot reveal contacts at all — `reveal_player_contacts` denies admins by design and the UI sends no RPC for them. `docs/business-rules.md` states that full-contact export is an admin capability. | `contact-reveal-smoke` section 5 asserts "admin denied"; `contact-reveal-ui-smoke` section 5 asserts the admin flow sends no RPC. | Product Owner: confirm which rule is authoritative and update either the rule or the RPC. |
| B7 | P3 | `supabase/config.toml` sets `site_url` and `additional_redirect_urls` to port 3000 while `npm run dev:local` serves port 3100. Harmless for password sign-in, which uses no redirect. | `supabase/config.toml` `[auth]`; `scripts/dev/dev-local.cjs` default port 3100. | Align when a redirect-based flow is introduced. |
| B8 | P3 | `supabase/snippets/` holds three untracked Supabase Studio files, one of which is a `DELETE FROM public.profiles` statement. Already recorded in `docs/tech-debt.md`. | `npm run doctor` → `SNIPPETS_MUTATING`. | Owner decision to ignore the directory or delete the files. Not done automatically. |

No P0 findings. Every P0-class attack path tested at runtime was refused.

## Verification matrix

| Area | Status | Evidence | Next action |
| --- | --- | --- | --- |
| Git state | VERIFIED | Clean tree at `3d81ee8`; work on `chore/test-environment-readiness`; no push, no merge | Review the branch |
| Dependencies | VERIFIED | `node_modules` present, `npm test` runs from the committed lock; Node 22.23.1, npm 10.9.8 | — |
| Lint | NOT APPLICABLE | No lint script exists | — |
| Typecheck | NOT APPLICABLE | No TypeScript configuration outside the Edge Function | — |
| Unit tests | VERIFIED | 764 tests, 760 passed, 0 failed, 4 skipped, exit 0 | — |
| Build | VERIFIED | `build:pages` exit 0, 17 files, manifest `f249093222…` | Rebuild with real test values |
| Local Supabase | VERIFIED | Full stack healthy; WinNAT exclusion no longer covers 54321–54329 | — |
| Migrations | VERIFIED | `db diff --local` applied all 8 to a fresh shadow DB: `No schema changes found` | `db push` to the test project |
| Cloud test Supabase | BLOCKED | No linked project, no CLI session (B3) | Product Owner action 1–2 |
| Environment variables | VERIFIED | Two browser-public build inputs, format-validated; no `.env`; no secret can reach the bundle | — |
| Auth | VERIFIED | Admin and both agents sign in; inactive profile refused at app and DB layers; no admin fallback | — |
| Roles | VERIFIED | Agent navigation limited to Dashboard and Player list; `ADMIN_REQUIRED` on admin RPCs | — |
| RLS | VERIFIED | Cross-agent reads return zero rows; anon denied on every table and function | — |
| Contact masking | VERIFIED | Masked before `in_work`; audited RPC is the only egress; raw columns revoked from all browser roles | — |
| Storage | FAILED | No bucket, no storage policy (B1) | Product Owner decision on proof |
| Proof | FAILED | Feature absent end to end (B1) | Product Owner decision on proof |
| CSV import | VERIFIED | 12 rows → 10 valid, 1 invalid, 1 duplicate, imported through the real UI into Supabase | — |
| Assignment | VERIFIED | Round-robin 5+5; agents cannot self-assign or reassign | — |
| Frontend deployment | BLOCKED | Artifact builds and validates; nothing publishes it (B4) | Product Owner action 3–4 |
| Test data | READY | Two synthetic CSV fixtures in `docs/test-environment/` | — |
| Smoke test | READY | `docs/test-environment-smoke-test.md` | Run after deployment |
| Secrets | VERIFIED | No tracked `.env`; no key value in the working tree; artifact clean | — |
| Rollback | PARTIAL | Four contact-boundary migrations have rollback scripts; the four foundation migrations do not | Recreate the test project if a foundation rollback is ever needed |

## Local environment left behind

The local Supabase stack is running and holds synthetic data only: 3 smoke
accounts, 2 leftover invited agent profiles from earlier smoke runs, and 10
synthetic leads (9 `assigned`, 1 `success`). No real personal data was created at
any point. The `npm run dev:local` static server was stopped.

## Exact next actions for the Product Owner

1. Create or nominate a **test-only** Supabase project and run `npx supabase login`
   in an interactive terminal, then supply the project reference.
2. Decide on blocker B1 (proof upload). It is a new feature and the requested test
   workflow cannot be completed without it — say whether stage 1 proceeds without
   proof or waits for it.
3. Choose a static host for the frontend and state whether the test URL may be
   publicly reachable (runbook section 8 lists two compatible options).
4. Once 1 and 3 are answered, run runbook sections 4–8: `supabase db push`,
   `supabase functions deploy team-management`, create the test accounts, build
   with the test values, and upload `artifacts/pages-site/`.
5. Run `docs/test-environment-smoke-test.md` end to end and record the result of
   the `[BLOCKED]` steps B11, B12, C7 and F3.

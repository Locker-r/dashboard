# Technical debt

Audit snapshot: 2026-07-31, commit `89acc74ed11386fa5e663e3e23157934ddd6175c` (`89acc74`). Every future audit update must record its date and audited commit SHA. Closed items remain with their verification date and commit so the decision history is preserved.

## P0: contact disclosure must be enforced at the DB/API boundary

Status: Closed 2026-08-01, verified at the head of `feat/contact-reveal-frontend` (PR C).

Closure evidence. PR A (`f0e70bd`) moved every contact behind `public.players_secure` and revoked the raw
columns; PR B (`92431fd`) added `reveal_player_contacts` as the single audited egress; PR C connects the
browser to it. All three runtime suites were executed against a local Supabase on 2026-08-01 and passed:
`scripts/secure-contact-boundary-smoke.cjs` (35 checks), `scripts/contact-reveal-smoke.cjs` (43 checks) and
`scripts/contact-reveal-ui-smoke.cjs` (49 checks). The frontend suite proves that raw values enter only the
transient store, that `JSON.stringify(players[])` contains no contact value, that CSV export, worklist search
and analytics labels stay masked while a reveal is live, and that an admin is refused without any RPC being
sent. A manual browser pass over `index.html` additionally confirmed no raw contact in `localStorage`,
`sessionStorage`, IndexedDB, DOM attributes or console output, before or after logout.

Two caveats are recorded rather than implied away. The browser pass had to stub the data-service transport,
because `normalizeConfig` in `src/supabase-auth-service.js` accepts only an `https://<ref>.supabase.co`
project root and refuses a loopback URL; the live RPC path is covered by the automated suites instead. And
the local database's migration ledger listed `20260802000100`/`20260802000200` as applied while the objects
were absent (consistent with PR B's rollback scripts having been run locally); the two migrations were
re-applied by hand before verification. Neither affects shipped code, but the ledger drift is worth a look
before the next environment is provisioned.

Superseded record of the original gap:

Approved business rule: an assigned agent receives the full `phone`, `email`, and `messenger` values only after the lead enters `in_work`. Before `in_work`, every contact channel must be protected at the database/API boundary. UI masking is presentation only and is not a security control.

Current gap: the existing player SELECT policy controls rows, but each permitted row still contains the complete contact columns. Target solution: a secure status- and role-aware projection returning redacted values before `in_work`, plus a narrowly scoped, audited reveal/transition workflow. Add integration tests querying as admin, assigned agent, and unrelated agent before and after transition.

Known gaps and open questions that are deliberately deferred rather than blocking a shipped change. Each item names the current mitigation and the follow-up work, and is owned by the Product Owner for prioritization.

## REASSIGNMENT_COUNT_MISMATCH has no deterministic test of the real race branch

Current coverage: a behavioral unit test exercises the error-mapping logic against a synthetic error object, and a live check against the real local stack confirmed `PLAYER_ASSIGNMENT_MISMATCH` returns a real HTTP 409 (not a masked 500) — it goes through the exact same `safeCodes.has(code) ? 409 : 500` code path as `REASSIGNMENT_COUNT_MISMATCH`, so it stands in as a proxy. The race branch itself, inside `team_reassign_players` (a concurrent insert of a player with the same `agent_id` landing in the narrow window between row locking and the `UPDATE`), has not been reproduced deterministically — it cannot be reliably triggered from outside over HTTP.

Proposed follow-up: a focused SQL/PL-pgSQL-level test that calls `team_reassign_players` directly with an emulated expected/actual count mismatch, without depending on a real thread race.

Baseline update (2026-07-31, `89acc74`): still Open and not runtime-verified. Unit/static checks cover safe HTTP 409 mapping, expected-versus-actual validation, and check-before-audit ordering. `supabase start` timed out twice and containers remained stopped. Recommended test: two controlled DB sessions with synchronization barriers that deterministically produce the mismatch, then assert transaction rollback and absence of an audit row.

## supabase_edge_runtime exits after ~16h of uptime

The `supabase_edge_runtime_dashboard-runtime-smoke` container exited (`Exited 255`) after roughly 16 hours of uptime, tied to the edge runtime's internal wall-clock limit on long-lived isolates (a runtime characteristic, not a project bug). `npx supabase start` does not restart it automatically once it has exited — it had to be brought back with a direct `docker start`.

Open question: whether a restart policy / health check is needed for this container in the docker-compose configuration used for staging or production, so an unattended exit does not turn into silent downtime.

Baseline update (2026-07-31, `89acc74`): still Open. The container was `Exited (137) 22 hours ago`; this run did not reproduce the earlier exit code or verify automatic recovery. Staging/production should use an orchestrator restart policy, readiness/liveness checks, alerting, and an external endpoint probe rather than depending on a developer CLI invocation.

## Unused reactivation-desk-mvp-postgres-1 container

A separate `docker-compose.yml` one directory above `dashboard/` (`C:\Projects\reactivation-desk-mvp\docker-compose.yml`) starts a bare `postgres:17-alpine` container on port `5433` with database `reactivation_desk`. A search across `dashboard/` (docs, config, `.env` files, scripts) found no reference to this stack or port — it looks like a leftover from before the project moved to the Supabase-based architecture.

Baseline update (2026-07-31, `89acc74`): necessity remains unconfirmed. The container existed as `Exited (0) 22 hours ago`; no active port conflict was present. Do not delete the Compose file, container, or volume until the owner is identified, dependent applications are checked, volume data and backup requirements are reviewed, and Product Owner approval is recorded.

## Local development cannot authenticate against local Supabase

Status: Open, recorded 2026-08-03 while adding `npm run doctor` and `npm run dev:local`.

`normalizeConfig` in `src/supabase-auth-service.js` accepts only an
`https://<ref>.supabase.co` project root, so a loopback project URL is rejected with
`config_invalid`. With `config/data-config.local.js` set to `mode: 'supabase'` and
`config/supabase-config.local.js` set to the required local origin
`http://127.0.0.1:54321`, browser sign-in therefore cannot succeed locally. The same
constraint already forced the PR C browser pass to stub the data-service transport
(see the P0 closure caveat above).

Current mitigation: `npm run doctor` reports it as `FRONTEND_LOOPBACK_AUTH_UNSUPPORTED`
with two supported paths — data mode `local` for UI work, and the runtime smoke harness
for local backend verification. The launcher deliberately does not work around it,
because changing that validation is frontend business logic and a security-relevant
decision.

Proposed follow-up: decide explicitly whether the auth service should accept a loopback
origin under a narrowly scoped local-only condition, or whether local browser
verification stays permanently out of scope. Either outcome should be recorded here.

## `supabase/snippets` is untracked and not ignored

Status: Open, low severity, recorded 2026-08-03.

Supabase Studio writes ad-hoc query files into `supabase/snippets`, which
`supabase/.gitignore` does not cover, so they permanently appear as untracked
paths and dirty every status listing. The three present files
(`Untitled query 173/693/952.sql`) are read-only `SELECT`s against
`public.profiles`. `npm run doctor` classifies each file as read-only or mutating
and never deletes anything.

Proposed follow-up: an owner decision to either ignore the directory in
`supabase/.gitignore` or remove the files. Not done automatically here, because
deleting unknown local files is outside the safe boundary of this tooling.

## Runtime Supabase baseline is not verified

Status: Open release risk.

Static and unit gates pass, but Auth, RLS, atomic RPC, team-management, concurrency, last-active-admin, role/deactivation, reassignment, idempotent request ID, `PLAYER_ASSIGNMENT_MISMATCH`, and `REASSIGNMENT_COUNT_MISMATCH` were not exercised against a live database on 2026-07-31. `supabase start` and `supabase start --debug` timed out after approximately 120 and 300 seconds. The provided local wrapper was not run because it executes the prohibited `supabase db reset --local`.

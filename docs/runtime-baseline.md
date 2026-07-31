# Runtime baseline

- Date: 2026-07-31
- Audited commit SHA: `89acc74ed11386fa5e663e3e23157934ddd6175c` (`89acc74`)
- Source branch: `main`
- Documentation branch: `chore/runtime-baseline-and-tech-debt`

## Docker status

Docker Desktop 4.82.0 and Docker Engine 29.6.1 were reachable. No containers were running. Existing stopped containers were the `dashboard-runtime-smoke` database, Edge Runtime, REST, Inbucket, Auth, and Kong containers, plus `reactivation-desk-mvp-postgres-1`.

The separate parent PostgreSQL service reserves host port 5433; dashboard Supabase uses DB port 54322 and API port 54321. No active conflict was observed because both stacks were stopped. The need for the port-5433 service is unconfirmed. No container or volume was stopped, deleted, or modified.

## Supabase status

`npx.cmd supabase status` failed with `LegacyStatusDbNotRunningError` because `supabase_db_dashboard-runtime-smoke` was exited.

- `npx.cmd supabase start` timed out after approximately 120 seconds without diagnostic output.
- `npx.cmd supabase start --debug` timed out after approximately 300 seconds without diagnostic output.
- Containers remained stopped after both attempts.

No database reset, manual migration, volume deletion, secret change, or remote Supabase operation was performed.

## Test results

| Check | Result |
| --- | --- |
| `npm.cmd test` | Passed: 126 tests, 0 failed, 0 skipped |
| `npm.cmd run check:js` | Passed: 33 JavaScript files |
| `npm.cmd run check:secrets` | Passed: 75 tracked files |
| `scripts/check-atomic-writes.ps1` | Passed |
| `scripts/check-runtime-smoke-harness.ps1` | Passed |
| `scripts/check-team-management.ps1` | Passed |
| `git diff --check` before documentation edits | Passed |

`build:vendor` was not run because it rewrites a generated file. No `lint` or `typecheck` npm script exists.

## Runtime smoke results

Not executed against a live Supabase runtime because the stack could not be started. Therefore Auth, RLS, atomic RPC, team-management, concurrency, last-active-admin, role/deactivation, reassignment, idempotent request ID, `PLAYER_ASSIGNMENT_MISMATCH`, and `REASSIGNMENT_COUNT_MISMATCH` remain unverified at runtime.

`scripts/Invoke-LocalRuntimeSmokeTest.ps1` was skipped because it invokes `supabase db reset --local --no-seed`, which was prohibited. `scripts/Invoke-LocalTeamManagementSmokeTest.ps1` depends on that base wrapper and was also skipped.

## Failed/skipped checks

- Failed: `supabase status`; local DB container was exited.
- Failed by timeout: `supabase start` and `supabase start --debug`.
- Skipped: both local runtime wrappers because they require the prohibited reset and a running stack.

## Known limitations

- Passing unit and source-structure checks do not prove live RLS, transactions, locks, Edge Runtime, or HTTP behavior.
- The concrete `REASSIGNMENT_COUNT_MISMATCH` race branch lacks deterministic integration coverage.
- Automatic Edge Runtime recovery after prolonged uptime is not verified.
- Ownership and data requirements for the separate port-5433 PostgreSQL stack are unknown.
- Approved P0 policy is not yet enforced at the DB/API boundary: full phone, email, and messenger must be withheld from an assigned agent until `in_work`; UI masking is insufficient.

## Release recommendation

Do not treat this snapshot as runtime release approval. Documentation and static/unit baselines are acceptable, but production/security sign-off remains blocked until the Supabase runtime suites pass on an audited commit and the P0 contact-disclosure boundary is implemented and integration-tested.

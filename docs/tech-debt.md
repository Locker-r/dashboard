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
because `normalizeConfig` in `src/supabase-auth-service.js` accepted only an `https://<ref>.supabase.co`
project root at the time and refused a loopback URL (lifted in Automation PR 1.1, recorded below); the
live RPC path is covered by the automated suites instead. And
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

Status: Closed 2026-08-03 (Automation PR 1.1), recorded 2026-08-03 while adding
`npm run doctor` and `npm run dev:local`.

`normalizeConfig` in `src/supabase-auth-service.js` accepted only an
`https://<ref>.supabase.co` project root, so a loopback project URL was rejected with
`config_invalid` and browser sign-in could not succeed locally. The same constraint
forced the PR C browser pass to stub the data-service transport (see the P0 closure
caveat above).

Resolution: the deferred decision recorded here — whether the auth service should
accept a loopback origin under a narrowly scoped local-only condition — was taken in
favour of accepting it. `normalizeConfig` now accepts a hosted project root **or** an
`http` origin whose hostname is a literal loopback host (`127.0.0.1`, `localhost`,
`[::1]`), with no path, query, fragment, or embedded credentials in either form. The
rule cannot send credentials off the machine, and it matches `classifyProjectUrl` in
`scripts/dev/doctor.cjs` so the diagnostic and the browser agree on what "local" means.
Production is unaffected: `scripts/build-pages-artifact.cjs` independently pins the
published artifact to `https://<ref>.supabase.co` with an `sb_publishable_` key.

`npm run doctor` now reports `FRONTEND_LOCAL_AUTH_SUPPORTED` in every data mode. The
previous `FRONTEND_LOOPBACK_AUTH_UNSUPPORTED` warning was emitted only under data mode
`supabase` and advised switching to `local`, so following its advice suppressed the
warning without changing the behaviour it described.

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

## Accepted Automation PR 2-A1 review follow-ups

Status: Closed 2026-08-04. Items 1, 2, and 6 were closed by the project-status
validator hotfix; items 3, 4, and 5 are closed by Automation PR 2-A2. Accepted
by the Product Owner on 2026-08-04 at merge of PR #24
(squash commit `c6e119ddbdaf23b714b91649520baade4e333d2f`). Recorded from the
independent adversarial review of PR #24; none of these blocked the merge.

1. Bind or remove the detached two-parent main-SHA fallback.
   `resolveMainSha` in `scripts/dev/check-project-status.cjs` returns the first
   parent of a detached two-parent merge commit when neither `refs/heads/main`
   nor `refs/remotes/origin/main` resolves, without verifying that the parent is
   main. A fixture whose first parent was a feature commit was certified as
   current main. This is the active path for pull-request CI runs, so
   correctness currently depends on GitHub building the pull-request merge ref
   base-first. Preferred fix: fetch `origin/main` in CI and drop the fallback,
   or bind the fallback to explicit CI provenance.

2. Add tests for the parent-count restriction. Disabling
   `parents.length === 2` produced no test failure, so the restriction the
   existing test is named for is not actually exercised. Cover the one-parent
   and octopus-merge rejections.

3. Add tests for `OUTPUT_EXISTS`. Disabling the overwrite refusal in
   `ensureSafeOutputDirectories` produced no test failure.

4. Add tests for `OUTPUT_NOT_IGNORED`. Disabling the ignore verification in
   `verifyOutputIsIgnored` produced no test failure. The unused `outputIgnored`
   and `symlinkPath` fixture overrides in `tests/prompt-generator.test.cjs`
   already provide the hooks.

5. Include branch-vs-base diff in review prompt context.
   `collectRepositoryContext` reports only the uncommitted working-tree diff, so
   an `adversarial-review` prompt renders "Tracked changed files: none" for a
   clean checkout of a pull request that changes many files. Either add the
   base-relative diff or relabel the existing fields.

6. Correct the shallow-checkout wording. `docs/developer-toolchain.md` describes
   the fallback as supporting a shallow detached CI merge checkout. In a genuine
   shallow clone the merge commit's parents are grafted away and the fallback
   fails closed; it applies to a full-history detached merge checkout.

Lower-severity observations from the same review, not scheduled: locale-sensitive
`localeCompare` ordering of tracked files feeding the context fingerprint;
fingerprint excludes supplied task, issue, and findings inputs; Unicode bidi
controls pass through prompt quoting unescaped; Windows reserved device names and
NTFS alternate data streams are accepted as output filenames within the ignored
prompt directory.

### Closure record 2026-08-04: project-status validator hotfix

Trigger: `main` CI was red from `c6e119d` (PR #24) onward. `docs/project-status.md`
recorded the pre-merge main SHA while the validator required exact equality with
the main tip, and the commit that updates the field becomes the new tip, so the
value it records is stale the moment it lands. Exact equality was therefore
unsatisfiable on a main tip that contains its own status update. Pull-request CI
did not show this, because it resolved main through the merge-ref first parent,
which equals the base SHA the document correctly recorded.

Closed by this hotfix:

1. **Detached two-parent main-SHA fallback — closed.** The fallback now runs only
   when the runner's own event payload declares a pull-request base SHA and that
   SHA is proven to be the first parent of the exact two-parent merge commit
   checked out. Commit messages, branch names, and pull-request titles are not
   evidence. `quality-gates.yml` additionally fetches `origin/main`, so
   validation normally runs on verified refs and never reaches the fallback.
   Every unverifiable detached case fails closed with `MAIN_REF_UNAVAILABLE`.

2. **Parent-count restriction tests — closed.** Real Git fixtures now cover
   ordinary detached commits, octopus merges, truncated shallow history, a
   payload base that does not match the first parent, a non pull-request event,
   a non-main base ref, and an unreadable payload.

6. **Shallow-checkout wording — closed.** `docs/developer-toolchain.md` no longer
   describes the fallback as supporting a shallow checkout. In a genuine shallow
   clone the merge parents are grafted away and resolution fails closed; the
   fallback applies to a full-history detached merge checkout.

### Closure record 2026-08-04: Automation PR 2-A2 prompt follow-ups

Closed by Automation PR 2-A2:

3. **`OUTPUT_EXISTS` behavioral coverage — closed.** The prompt-generator test
   executes the same guarded output twice, proves the second call fails with
   `OUTPUT_EXISTS`, and proves the original bytes, write count, and clipboard
   state remain unchanged.
4. **`OUTPUT_NOT_IGNORED` behavioral coverage — closed.** The test makes Git's
   literal `check-ignore` decision fail, proves `OUTPUT_NOT_IGNORED` is returned,
   and proves no file or clipboard write occurs.
5. **Exact review diff context — closed.** `adversarial-review` now uses the full
   live GitHub base and head SHAs for an exact `base...head` Git diff, renders its
   sorted changed files and statistics separately from uncommitted working-tree
   changes, treats filenames as redacted untrusted data, and fingerprints the
   result. Missing live state or Git objects are reported as unavailable rather
   than replaced with a guessed diff.

Rule adopted by PR #26, now superseded: Main SHA was valid only when it equaled
the resolved main tip or that tip's direct first parent. A baseline more than
one main commit behind failed as stale.

### Supersession record 2026-08-04: final project-status ancestry policy

PR #27 demonstrated that the direct-parent allowance survived only one
additional merge: the next ordinary merge moved the recorded baseline two
commits behind main and made main CI red again. Requiring a documentation update
after every technical merge would recreate the same self-referential cycle.

The final policy treats Main SHA as a verified milestone baseline. A full SHA
that resolves to a commit and is an ancestor of resolved main is valid at any
depth; the validator reports commitsBehindMain as informational context. Exact
equality remains fully current. Missing commits block as MAIN_SHA_UNREACHABLE,
and reachable unrelated or descendant commits block as
MAIN_SHA_NOT_ANCESTOR. Milestone completion refreshes the baseline; technical
hotfix and documentation merges do not require status-only follow-ups.

PR #26's secure main-resolution work is retained unchanged: synchronized main
refs are preferred, CI fetches origin/main, and the detached pull-request
fallback remains provenance-gated and fails closed when its evidence is absent.

## Accepted Automation PR 2-A2 (PR #29) review follow-ups

Status: Partially closed 2026-08-04 by Automation PR 2-B1. Items 2, 3, 4, 5, 6,
7, and 8 are closed. Item 1 remains Open and is scoped to Automation PR 2-B2.
Recorded from the independent adversarial review of PR #29; none of these
blocked that merge.

Closed by Automation PR 2-B1:

2. **Duplicate release migration governance — closed.** `verify:release` ran
   `npm run check:migrations` twice under two stage ids. The redundant
   `release-migration-governance` stage was removed, and the release happy-path
   test now asserts that no command is executed twice on the tier.
3. **Weakened smoke opt-in refusal test — closed.** The single test that
   accepted exit 1 or 2 and any non-passing status was replaced by two tests
   that prove the configuration blocker (exit 2, `Skipped`) and the no-opt-in
   refusal (exit 1, `Failed`, mentioning `-AllowDatabaseReset`) separately,
   each against the real wrapper with a stubbed `npx.cmd` on PATH.
4. **Overstated destructive-wait documentation — closed.** The toolchain
   document now states that the destructive wait is unbounded and that Windows
   delivers Ctrl+C to the whole console group, so the verifier cannot guarantee
   an interrupt never reaches the child.
5. **`NPM_EXECUTABLE_UNAVAILABLE` coverage — closed.** Five behavioral cases
   prove the Windows runner never spawns an untrusted npm CLI, plus one case
   proving the tier result is a blocked exit 2 with later stages skipped.
6. **Source-regex assertions — closed.** The PowerShell timeout-policy
   assertions that matched wrapper source text were removed; the behaviour is
   covered by the real-process tests in `tests/developer-toolchain.test.cjs`.
7. **Release workspace ownership revalidation — closed.** `compare`,
   `validate`, and `scan` now revalidate workspace ownership before reading,
   closing the window between build and scan.
8. **Changelog — closed.** The smoke exit-code reclassification and the
   verification changes above are recorded in CHANGELOG.md.

Still Open, deferred to Automation PR 2-B2:

1. Run the JavaScript test suite on `windows-latest` in CI. `npm test` runs only
   on `ubuntu-latest`, so the Windows-only guard tests in
   `tests/developer-toolchain.test.cjs` and `tests/agent-worktree.test.cjs` are
   skipped in CI and are currently proven only by local Windows runs.

## Accepted Automation PR 2-B1 limitations

Status: Open, accepted 2026-08-04 as documented scope, not defects.

- Review worktrees are read-only by convention only. Git will not move a branch
  in a detached worktree, but no filesystem permission prevents edits.
- The shared runtime lock is defined and inspected, not yet acquired. The
  primitive, its exclusivity, and its staleness rules ship here, and
  `agent:worktree` reports a held lock and refuses removal while one is live,
  but no destructive runtime command takes it. `verify:runtime`, the smoke
  wrappers, and provisioning acquire nothing today, so concurrent database
  resets are still possible; wiring acquisition into those call sites is
  Automation PR 2-B2 work. The lock is advisory even then and cannot constrain a
  process that ignores it.
- The ownership marker is an accident guard, not an authenticator. It lives
  inside the directory it describes and holds no secret, so a well-formed marker
  written by hand can make automation treat a foreign worktree as its own. See
  ADR-011 for the guards that keep such a removal recoverable.
- Worktree removal has no force mode by design. Legitimate manual edits inside a
  worktree require manual cleanup.
- Process start identity for PID-reuse defence is resolved through PowerShell
  and is therefore Windows-only; on other platforms a live PID is trusted.

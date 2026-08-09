# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
interpreted in [`docs/release-governance.md`](docs/release-governance.md).

A version tag marks a reviewed, gated snapshot of `main`. It does **not** mean the
snapshot has been deployed: pushing a tag triggers the production Pages
deployment workflow, but that workflow still waits on a human environment
approval before Cloudflare is touched.

## [Unreleased]

### Added

- `.github/workflows/staging-demo-prep.yml` and `scripts/staging-demo-{cleanup,seed,flow-verify,shared}.cjs`:
  a manually dispatched, staging-only workflow that prepares the environment
  for a management demo. Deactivates leftover disposable `smoke_test_`
  cashiers and removes leftover `SMOKE_TEST_*` leads through existing,
  reviewed paths (never touching anything ambiguous or demo-owned);
  idempotently reconciles a small, fake, obviously `demo_`-prefixed dataset
  (two cashiers, eight leads spread across every status, no real PII); and
  proves the full management-demo path end to end (admin login, cashier
  visibility, assignment, cashier login, isolation, in_work, the audited
  contact reveal, close with proof, admin final-result/analytics visibility)
  through one disposable, self-cleaning `SMOKE_TEST_`-prefixed identity. No
  service-role key is used anywhere; every write goes through the same
  product-supported RPCs and Edge Function actions the real UI uses. See
  `docs/decisions.md` ADR-017.

### Changed

- Product Owner decision, 2026-08-09 (ADR-019): the three untracked
  `supabase/snippets/` files are to be deleted, not gitignored — one
  (`Untitled query 952.sql`) is a live `delete from public.profiles`
  statement, not merely a stray read. Deleting local untracked files is a
  filesystem action this repository's own tooling guard refuses to an agent
  without separate, explicit per-run operator authorization, so the
  deletion itself remains an operator step (B8).

### Fixed

- `docs/business-rules.md` stated full contact export was an admin
  capability, contradicting the deployed `reveal_player_contacts` RPC
  (agent-only, admin explicitly denied — ADR-002) and
  `docs/test-environment-smoke-test.md` step F5, which already expected
  that. Product Owner decision, 2026-08-09 (ADR-018): the RPC is correct;
  the document is corrected to match. No RPC or database change (B6).

- `scripts/staging-demo-flow-verify.cjs` checked `reveal_player_contacts`'s
  outcome against `'granted'`, but the RPC's successful path returns
  `outcome := 'revealed'`
  (`supabase/migrations/20260802000200_contact_reveal_rpc.sql`); `'granted'`
  is only the internal `contact_reveal_events` audit `event_type` for that
  same path, never a value the RPC returns to its caller. The fifth real
  dispatch (GitHub Actions run 31311284116) failed flow verification with
  `CONTACT_REVEAL_NOT_GRANTED:revealed`. Fixed the check to accept
  `'revealed'`.

- `scripts/staging-demo-seed.cjs`'s reconciliation only attached a proof
  step when a lead's target status was `success`, but
  `change_player_status_atomic` requires an active proof to close a lead as
  EITHER `success` or `failed`
  (`supabase/migrations/20260805000100_lead_proof.sql`). The fourth real
  dispatch (GitHub Actions run 31310524648) failed seeding `demo_lead_08`
  (targets `failed`) with `PROOF_REQUIRED`. Fixed: `withProof` is now
  derived from the target status itself (closing to `success` or `failed`),
  not hand-set per lead, and the proof-insertion check in
  `planLeadReconciliation` matches both closing statuses.

- `scripts/staging-demo-cleanup.cjs`'s deactivation filter matched any
  `smoke_test_`-prefixed username with zero owned players — but
  `runtime-smoke.cjs`'s own `readConfig()` already requires
  `SMOKE_TEST_ADMIN_EMAIL` (the same value as `STAGING_SMOKE_ADMIN_EMAIL`,
  which `staging-demo-prep.yml` reuses) to start with `smoke_test`, so the
  real staging admin account this tooling authenticates as is itself
  `smoke_test_`-shaped. The third real dispatch (GitHub Actions run
  31308149570) failed at `list-members` with `403 ADMIN_REQUIRED`, because a
  prior run's cleanup had deactivated its own calling admin account before
  crashing on the run 31307722394 bug. Fixed: `planCleanup` now takes the
  signed-in actor's own id and excludes it from deactivation candidates
  unconditionally, before the username pattern is even checked.

- `scripts/staging-demo-cleanup.cjs` aliased `report.membersSkipped`/
  `report.playersSkipped` directly to `planCleanup`'s `Object.freeze()`d
  return arrays, then pushed onto them when a deactivation call failed.
  The second real dispatch of `staging-demo-prep.yml` (GitHub Actions run
  31307722394, on top of the run 31307205728 fix) hit exactly this and
  crashed with `Cannot add property 0, object is not extensible` instead of
  recording the failed deactivation. Fixed by copying into fresh,
  extensible arrays.

- `scripts/staging-demo-cleanup.cjs` selected `messenger` from `players`,
  but that column (along with `phone`/`email`) has been revoked from
  `authenticated` for every session, admin included
  (`supabase/migrations/20260801000200_revoke_raw_contacts.sql`). The first
  real dispatch of `staging-demo-prep.yml` (GitHub Actions run 31307205728)
  failed at the cleanup step with "permission denied for table players".
  Fixed to select only `id`; the messenger-marker match this used to
  pre-check client-side is re-derived authoritatively inside
  `cleanup_smoke_test_run_atomic` itself (`security definer`), so an id that
  only coincidentally looks like smoke debris simply deletes zero rows,
  never an error.

- `scripts/staging-smoke-deprovision-cashiers.cjs` matched leftover smoke
  cashiers by `email`, but `team_list_members()`
  (`supabase/migrations/20260805000200_agent_management.sql`) has never
  returned an `email` field — every real deprovision call silently matched
  nothing, so every staging smoke run's disposable cashiers stayed active
  indefinitely despite the workflow reporting success. Fixed to match by
  `username`, which the RPC does return.

- `scripts/verify-production-deployment.cjs` (`npm run verify:production-deployment -- --tag vX.Y.Z`):
  read-only, credential-free verification that a tagged release is actually
  live at `dashboard-latam.pages.dev` — a successful `production-pages-deploy.yml`
  run for that exact tag, a live manifest matching what the tagged commit
  would produce, and every listed file serving matching bytes. Fails closed
  with `NO_PRODUCTION_DEPLOYMENT_YET` when no production deployment has ever
  occurred, rather than passing vacuously.
- `scripts/release/rollback-rehearsal.cjs` (`npm run rollback:rehearse -- --target vX.Y.Z`):
  proves a candidate rollback target is usable (annotated tag, ancestor of
  `main`, has its own successful production deploy, rebuilds to the expected
  bytes) and prints the human roll-forward rollback sequence — it invokes no
  Wrangler command, calls no Cloudflare API, and creates, moves, or pushes no
  tag (M-D2C, docs/decisions.md ADR-016).
- `.github/workflows/production-pages-deploy.yml`: tag-triggered publication
  of the Pages artifact to production Cloudflare Pages (`dashboard-latam`) by
  Direct Upload via Wrangler. Triggers only on an annotated `vMAJOR.MINOR.PATCH`
  tag reachable from `main`; re-verifies the tag, rebuilds the artifact from
  that exact commit with the existing builder, and runs under the `production`
  GitHub environment. Requires (but never creates) production Supabase
  configuration variables, and fails closed before any build or deploy step if
  a precondition is unmet. No tag has been pushed and no deployment has
  occurred (M-D2B, docs/decisions.md ADR-015).
- Canonical AI project status and an append-only architecture decision log,
  with a dependency-free validator that detects malformed or unsafe ancestry
  context.
- A dependency-free repository-aware prompt generator with seven role
  templates, shared safety rules, offline operation, redaction, deterministic
  fingerprints, guarded file output, and safe Windows clipboard handling.
- Four dependency-free verification tiers for focused feedback, complete PR
  gates, guarded local runtime checks, and deterministic non-publishing release
  readiness, with human and JSON output and explicit failure/skip semantics.
- `npm run agent:worktree`: safe Git worktree management for AI agents, with
  create, list, inspect, remove, and prune commands. Worktrees are created
  beside the repository, implementation roles require a feature/fix/docs
  branch, review worktrees use a detached HEAD at an exact SHA, and every
  destructive operation must revalidate an exclusive ownership marker. It never
  launches an AI client, never force-removes, never deletes a branch, and never
  deletes untracked, ignored, or foreign files. The ownership marker is an
  accident guard rather than an authentication mechanism: it lives inside the
  directory it describes and holds no secret, so removal safety rests on the
  Git-registration, cleanliness, branch-reachability, and non-force guards
  around it.
- An advisory shared-runtime lock primitive for the `database-reset`,
  `runtime-smoke`, and `smoke-provisioning` operation names, with exclusive
  acquisition, stale and PID-reuse detection, and no automatic stealing of a
  live lock. This milestone defines and inspects it: `agent:worktree` reports a
  held lock and refuses worktree removal while one is live.
- `verify:runtime`'s `runtime-smoke-reset` stage now acquires the
  `database-reset` lock immediately before it invokes the sanctioned
  `scripts/dev/smoke.ps1 -AllowDatabaseReset` wrapper, and releases it on
  success, failure, or interruption. The family root is always resolved from
  the primary repository (via `git rev-parse --git-common-dir`), so the lock
  is visible to `agent:worktree` regardless of which worktree
  `verify:runtime` runs from. Collision is a hard refusal
  (`RUNTIME_LOCK_HELD`, exit 2): never stolen, never waited on, never
  retried; a stale or malformed claim is preserved for a human to clear.
  See ADR-012.
- `npm run smoke -- -AllowDatabaseReset` now acquires the same
  `database-reset` lock too, through a small CLI bridge
  (`scripts/dev/runtime-lock.cjs`) around the identical, unchanged
  `acquireRuntimeLock`/`releaseRuntimeLock` primitives. It skips acquisition
  when `verify:runtime` has already acquired the lock for the same process
  (`RUNTIME_LOCK_ALREADY_HELD=1`), so the two entry points never nest.
- `scripts/dev/pr-lifecycle.cjs` and `scripts/dev/branch-cleanup.cjs`:
  read-only CI observation (`gh pr checks`), a merge-readiness observation
  that never itself decides to merge, a squash-only merge
  (`gh pr merge <n> --squash`, never `--admin`/`--force`/`--merge`/`--rebase`),
  post-merge verification that `origin/main` equals the PR's own
  `mergeCommit.oid`, safe `agent:worktree` removal, and a fail-closed local
  `git branch -d` (never `-D`) that refuses on a protected or non-allowlisted
  name, the current branch, a branch checked out in any worktree, a locked
  index or in-progress Git operation, an unreachable-from-`origin/main`
  branch, or an ambiguous/missing `origin` remote — stopping at the first
  refusal and reporting exactly what completed. Remote branch deletion is
  never automated under any flag.
- Documentation of the Automation PR 2-A1/2-A2 split. Verification tiers are
  delivered in PR 2-A2; agent worktrees in PR 2-B1; runtime-lock wiring in PR
  2-B2a; PR lifecycle and cleanup automation in PR 2-B2b.
- `npm run doctor`: read-only local environment diagnostic covering Git state,
  toolchain, Docker, Supabase, port ownership, local configuration, key class,
  Auth health, smoke-user linkage, and competing processes. It finishes with
  exactly one of `READY`, `READY WITH WARNINGS`, or `BLOCKED`, prints a code and
  a remediation for every warning and blocker, redacts credential-shaped values,
  and supports `--json`.
- `npm run dev:local`: safe local launcher that gates on the diagnostic, starts
  or reuses local Supabase without ever resetting the database, serves the
  dashboard on port 3100 from a verified repository root, refuses a port held by
  another project, provisions smoke users only through the existing sanctioned
  local-only path, and stops only the process it started.
- Deterministic fixed-allowlist Pages artifact construction with generated
  runtime configuration, an exact transformed entrypoint, minimal integrity
  manifest, and LF/CRLF-safe regression coverage. Publishing and deployment
  remain out of scope.
- Release governance: `CODEOWNERS` ownership routing, tag-triggered release
  workflow, changelog process, and branching/review/merge documentation.
- `npm run check:migrations`: static migration naming, ordering, transaction
  boundary, and rollback coverage check.
- CI dependency review on pull requests and a production-dependency
  `npm audit` gate at severity `high`.
- `docs/github-settings.md`: one-time repository settings guide covering branch
  protection, Dependabot alerts, merge strategy, and GitHub Pages governance.

### Changed

- `.github/workflows/production-pages-deploy.yml`'s deployed-host check now
  accepts both the `dashboard-latam.pages.dev` apex domain and a
  `<hash>.dashboard-latam.pages.dev` deployment alias (Wrangler's normal
  output shape for a Direct Upload), instead of only the exact apex string —
  the prior check would very likely have failed the job on the first real
  deploy despite the upload itself succeeding. Still refuses every other
  `*.pages.dev` host (M-D2C).
- `verify:release` no longer runs `npm run check:migrations` twice. Migration
  governance runs once as a PR-gate stage; the duplicate release stage was
  removed.
- Release artifact comparison, validation, and secret-shape scanning now
  revalidate workspace ownership before reading, closing the window between
  build and scan.
- `npm run smoke` reports a stopped local Supabase as a configuration blocker
  (exit 2) with the destructive checks `Skipped`, instead of reporting them as
  required failures (exit 1). Without `-AllowDatabaseReset` but with Supabase
  reachable, it still refuses with exit 1.
- Documentation now states that the destructive reset wait is unbounded and
  that Windows delivers Ctrl+C to the whole console process group, so the
  verifier cannot guarantee an interrupt never reaches the child.
- `agent:worktree` now derives the shared runtime-lock directory from the
  resolved worktree parent in `create`, `list`, and `remove` alike. Previously
  `remove` looked only under the default `<repository-parent>\.worktrees\`, so a
  live lock held for a custom `--parent` was invisible to it and a worktree
  could be removed while a destructive runtime operation was running.
- Documentation no longer describes the worktree ownership marker as proof of
  ownership. It is an accident guard: a well-formed marker written by hand can
  make automation treat a foreign worktree as its own, and the guards that keep
  that recoverable are documented explicitly in ADR-011 and
  `docs/developer-toolchain.md`.

- Project-status Main SHA validation now accepts any reachable ancestor of
  verified main, reports commitsBehindMain, and blocks unreachable or
  non-ancestor SHAs. Prompt context reports the same relationship, while exact
  branch, HEAD, and PR-head stale-context guards remain unchanged.
- Adversarial-review prompts now render the exact live pull-request base-to-head
  diff separately from uncommitted working-tree changes. Guarded prompt output
  refusals now have behavioral coverage for existing and non-ignored targets.
- Destructive local smoke timeouts now wait for the sanctioned owned process
  tree to finish, preventing an outer-wrapper kill from orphaning reset work.
- `package.json` declares a supported Node.js range.

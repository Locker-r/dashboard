# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
interpreted in [`docs/release-governance.md`](docs/release-governance.md).

A version tag marks a reviewed, gated snapshot of `main`. It does **not** mean the
snapshot has been deployed: no production deployment pipeline exists yet.

## [Unreleased]

### Added

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

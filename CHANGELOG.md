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
  deletes untracked, ignored, or foreign files.
- An advisory shared-runtime lock coordinating database reset, runtime smoke,
  and smoke provisioning across worktrees, with exclusive acquisition, stale and
  PID-reuse detection, and no automatic stealing of a live lock.
- Documentation of the Automation PR 2-A1/2-A2 split. Verification tiers are
  delivered in PR 2-A2; agent worktrees in PR 2-B1; PR lifecycle automation remains PR 2-B2.
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

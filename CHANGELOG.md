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
  with a dependency-free validator that detects malformed or stale context.
- A dependency-free repository-aware prompt generator with seven role
  templates, shared safety rules, offline operation, redaction, deterministic
  fingerprints, guarded file output, and safe Windows clipboard handling.
- Documentation of the Automation PR 2-A1/2-A2 split. Verification tiers are
  deferred to PR 2-A2; worktree and PR lifecycle automation remain PR 2-B.
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

- `package.json` declares a supported Node.js range.

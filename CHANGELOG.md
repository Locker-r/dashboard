# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
interpreted in [`docs/release-governance.md`](docs/release-governance.md).

A version tag marks a reviewed, gated snapshot of `main`. It does **not** mean the
snapshot has been deployed: no production deployment pipeline exists yet.

## [Unreleased]

### Added

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

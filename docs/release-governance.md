# Release governance

How work reaches `main`, how a version is cut, and what may be assumed about a
tag. Read this before your first pull request.

For local commands (preflight, review, PR creation) see
[`docs/developer-toolchain.md`](developer-toolchain.md). For the automated
checks themselves see [`docs/quality-gates.md`](quality-gates.md). For the
one-time repository settings an administrator must apply see
[`docs/github-settings.md`](github-settings.md).

## Branching model

Trunk-based. `main` is the only long-lived branch and is always releasable.

- Branch from the current `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`,
  `docs/<topic>`.
- Keep a branch scoped to one reviewable change. Prefer several small pull
  requests over one broad one.
- Never commit directly to `main`, never force-push a shared branch, never
  merge your own work without the required checks passing.
- Rebase or merge `main` into your branch to resolve conflicts; do not rewrite
  history that another person has pulled.

## Review flow

1. `npm run preflight` before starting and before finishing.
2. `npm run review` to produce `artifacts/review.md` and get a
   `READY FOR REVIEW` / `REVIEW WITH WARNINGS` / `BLOCKED` verdict.
3. Open a non-draft pull request, dry-run first via `scripts/dev/pr.ps1`.
4. Describe what changed, how it was validated, and how to roll it back.
5. Resolve every review comment explicitly. Do not resolve your own blocking
   comment silently.

`.github/CODEOWNERS` records ownership and auto-requests review, but it is
**advisory**: approval is not mechanically required, because a single
maintainer cannot approve their own pull request. When a second maintainer
joins, enable *Require review from Code Owners* and delete this paragraph.

## Merge policy

- Merging is gated on the required status checks, not on a human approval.
  This is a recorded, deliberate exception for a single-maintainer repository,
  not a statement that review is optional.
- Squash merge. One pull request becomes one commit on `main`.
- Delete the branch after merge.
- A red required check is never merged around. Fix the cause, not the check.
- Never merge a change to `supabase/` without reading the SQL end to end and
  confirming a rollback path exists.

## Versioning

Semantic Versioning, interpreted for an internal application rather than a
published library:

| Bump | Meaning |
| --- | --- |
| MAJOR | A breaking database or API contract change, or a migration requiring a coordinated rollout or an operator action |
| MINOR | A backwards-compatible feature, including an additive migration |
| PATCH | A backwards-compatible fix, documentation, tooling, or governance change |

The version in `package.json` is not bumped per pull request. It is set when a
release is cut, in the same commit as the changelog entry.

## Changelog process

`CHANGELOG.md` follows Keep a Changelog and is maintained by hand — no
generator, no new dependency.

- Every user-visible or operationally relevant change adds a bullet under
  `## [Unreleased]`, in the same pull request that makes the change.
- Purely internal refactors that change no behaviour and no process may be
  omitted.
- Cutting a release renames `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and
  opens a fresh empty `## [Unreleased]`.

The release workflow reads the section matching the tag. A tag with no
changelog section fails the release.

## Release flow

1. Confirm `main` is green and contains everything intended for the release.
2. Open a release pull request: bump `version` in `package.json` and close the
   `## [Unreleased]` section in `CHANGELOG.md`.
3. Merge it once the required checks pass.
4. Tag the merge commit with an **annotated** tag and push it:

```bash
git tag -a v1.1.0 -m "v1.1.0" && git push origin v1.1.0
```

5. `.github/workflows/release.yml` verifies the tag is an ancestor of `main`,
   re-runs the Ubuntu gates, extracts the changelog section, and publishes a
   GitHub release.

### What a tag means

A tag means: reviewed, gated, and reproducible. **It does not mean deployed.**
No production deployment pipeline exists — that is D2 and later.

GitHub Pages currently publishes the root of `main` to
`https://locker-r.github.io/dashboard/` automatically on every push, outside
this release process. It serves an inert page today because the runtime
configuration files are untracked, so the application cannot start. That
channel is retained by decision, and moving it onto tag-based publishing is
planned work — see [`docs/github-settings.md`](github-settings.md). Until then,
**never assume a merge to `main` is unpublished.**

## Rollback expectations

Rollback is planned before a change merges, not improvised after it breaks.

- **Application code.** Revert the squash commit and merge the revert through
  the normal flow. There is no deployment step to undo.
- **Database migrations.** Every new migration ships with a matching
  `supabase/rollback/<name>_rollback.sql` in the same pull request.
  `npm run check:migrations` enforces this. Four migrations predating the rule
  are exempted in `scripts/check-migration-governance.cjs`; writing their
  rollback scripts is D3 work and the exemption list may only shrink.
- **A rollback script is not a restore.** It reverses schema objects. It does
  not recover data destroyed by the forward migration, and it has not been
  rehearsed against a database with real data. Backup and restore are D6.
- **Tags and releases** are never deleted or moved. A bad release is superseded
  by a higher version, so history stays truthful.

## Required status checks

These job names must pass before a merge. Keep this list and the repository
ruleset in sync:

- `Tests, syntax, diff, and secrets`
- `SQL and server PowerShell checks`
- `Dependency review`

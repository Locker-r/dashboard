# Reactivation Desk Dashboard

## AI project context

Every implementation and review session starts by reading
docs/project-status.md and docs/decisions.md. Validate the canonical status
against the local main ref with:

    npm run check:project-status

Generate a repository-aware prompt with:

    npm run prompt -- implementation --task "Automation PR 2-A2"
    npm run prompt -- adversarial-review --pr 24
    npm run prompt -- validation --offline

Prompts default to stdout. File output is confined to the already ignored
artifacts/prompts directory. Offline mode performs no GitHub query and marks
mergeability and CI as unverified. Windows clipboard output uses prompt bytes through standard input rather than shell interpolation. Adversarial-review prompts
report the exact live pull-request base-to-head diff separately from uncommitted working-tree changes; unavailable live context is reported rather than guessed.

## Verification tiers

Use the smallest tier that truthfully covers the task:

```powershell
npm.cmd run verify:fast
npm.cmd run verify:pr
npm.cmd run verify:runtime
npm.cmd run verify:release
```

- `verify:fast` reports repository state, checks JavaScript and whitespace,
  validates project status, and runs the focused automation tests. It is for
  implementation feedback and is not sufficient for a pull request or merge.
- `verify:pr` runs the complete local PR gate: the full tests, JavaScript and
  secret checks, migration and project-status validation, preflight, and
  `git diff --check`.
- `verify:runtime` checks the local Docker, Supabase, Auth, smoke-user, and
  runtime-harness state without resetting or starting services. Its destructive
  smoke stage is skipped unless `--allow-reset` is supplied explicitly.
- `verify:release` includes the PR gate and production dependency audit, then
  builds two isolated Pages artifacts, compares their bytes, validates their
  content and governance contracts, scans them for elevated credential shapes,
  and cleans only its identity-verified workspace. It never tags, publishes,
  creates a Release, or deploys.

`--json` emits the versioned machine result. `verify:release` requires explicit `DASHBOARD_SUPABASE_PROJECT_URL` and
`DASHBOARD_SUPABASE_PUBLISHABLE_KEY` browser-public values; it accepts only a hosted HTTPS Supabase project root and the `sb_publishable_` key class, never
fabricates production values, and blocks rather than skipping its dependency audit in `--offline` mode. Full stage, option, output, exit-code, reset, and
artifact-cleanup contracts are documented in
[`docs/developer-toolchain.md`](docs/developer-toolchain.md).

## Agent worktrees

Give each AI agent its own Git worktree instead of sharing one checkout:

```powershell
npm.cmd run agent:worktree -- create --name claude --branch feature/example --create-branch
npm.cmd run agent:worktree -- create --name codex --branch feature/example-review --create-branch
npm.cmd run agent:worktree -- create --name review --ref <sha> --read-only
npm.cmd run agent:worktree -- list
npm.cmd run agent:worktree -- inspect --name claude --json
npm.cmd run agent:worktree -- remove --name claude
```

Worktrees are created beside the repository, never inside it, at
`..\.worktrees\dashboard\<name>`. Implementation worktrees require a
`feature/`, `fix/`, or `docs/` branch; `main` and `master` are refused. Review
worktrees check out a detached SHA so no branch can move underneath a review.

`--read-only` is a documented convention, not a filesystem permission: Git will
not update a branch in a detached review worktree, but nothing stops a local
edit there.

Removal refuses anything the tool cannot prove it owns and created, and anything
dirty, untracked, ignored-by-an-unknown-process, or ahead of `main`. It never
force-removes and never deletes a branch — branch deletion stays a separate,
explicit operation. All worktrees of this repository share one local Docker,
Supabase, and port runtime; the commands report an advisory shared-runtime lock
so two agents do not reset the same database at once.

PR preparation, review packages, merge-readiness, post-merge validation, and
branch cleanup remain deferred to Automation PR 2-B2.

## Local development

Diagnose the environment, then start the dashboard:

```powershell
npm run doctor
npm run dev:local
```

`npm run doctor` is read-only and finishes with `READY`, `READY WITH WARNINGS`,
or `BLOCKED`, printing a remediation for every warning and blocker.
`npm run dev:local` serves the dashboard at:

```text
http://127.0.0.1:3100
```

Both commands are documented in
[`docs/developer-toolchain.md`](docs/developer-toolchain.md).

The historical canonical address was `http://localhost:3000`. Port 3100 is used
now because 3000 is commonly held by an unrelated project; the diagnostic warns
when that is the case. Every distinct origin — `http://localhost:3000`,
`http://127.0.0.1:3000`, `http://127.0.0.1:3100`, and a published domain — has
its own `localStorage`, so local-storage-mode data does not carry across them.
Starting and stopping the HTTP server at one address does not clear its browser
users.

## Supabase Auth configuration

The dashboard is a static application, so it reads Supabase settings from a local runtime configuration file rather than `.env`.

1. Copy `config/supabase-config.example.js` to `config/supabase-config.local.js`.
2. Set `projectUrl` to the Supabase Project URL.
3. Set `publishableKey` to the Supabase Publishable key. Never use a secret or `service_role` key.
4. Run `npm install` and `npm run build:vendor` after cloning or updating dependencies.

`config/supabase-config.local.js` and `node_modules` are ignored by Git. The generated `vendor/supabase.js` bundle is served locally, so the dashboard does not depend on a CDN.

## Pages artifact construction

`npm run build:pages` constructs and validates a deterministic, fixed-allowlist
static directory at `artifacts/pages-site`. It takes explicit browser-public
Supabase configuration from the current process environment, generates
`config/runtime-config.js`, and transforms only the artifact copy of
`index.html`. The ignored local configuration files are never read or copied.

This command builds a local directory only. It does not publish an artifact,
create a Release, configure GitHub Pages, or deploy anything. Its inputs,
output contract, validation, and safe replacement behavior are documented in
[`docs/pages-artifact.md`](docs/pages-artifact.md).

Supabase storage setup is documented in `docs/supabase-storage-foundation.md`. The optional atomic write RPC migration and its manual verification workflow are documented in `docs/supabase-atomic-writes.md`; repository scripts never apply SQL to a remote project.

The isolated local/staging Auth, RPC, and RLS smoke-test harness is documented in `docs/runtime-smoke-tests.md`. It is intentionally excluded from credential-free CI runtime execution.

Safe local preflight, runtime smoke orchestration, branch review, and dry-run-first PR automation are documented in [`docs/developer-toolchain.md`](docs/developer-toolchain.md).

The branching model, review flow, merge policy, versioning, changelog process, and rollback expectations are documented in [`docs/release-governance.md`](docs/release-governance.md). Read it before your first pull request. The one-time repository settings an administrator must apply are listed in [`docs/github-settings.md`](docs/github-settings.md).

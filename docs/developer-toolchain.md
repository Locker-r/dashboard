# Developer toolchain

## Purpose

The scripts in `scripts/dev` provide repeatable readiness checks, guarded runtime smoke orchestration, diff-aware review reports, and dry-run-first pull request creation without new dependencies.

## Safety model

- Read-only behavior is the default; required failures are never reported as success.
- Output and reports redact credential-shaped values and remain inside the repository.
- No force push, automatic merge, container/volume deletion, or production targeting.
- Database reset requires explicit `-AllowDatabaseReset`.
- PR commits use an explicit `-Paths` allowlist.

## Commands

Diagnose the local environment before spending time on it:

```powershell
npm run doctor
```

Start the dashboard locally:

```powershell
npm run dev:local
```

Standard daily workflow and the check before starting a task:

```powershell
npm run preflight
```

## Doctor

`npm run doctor` is a read-only diagnostic. It reports the repository root,
branch and HEAD, local `main` against `origin/main` as of the last fetch, the
tracked and untracked state, Node and npm versions, Docker CLI and daemon
status, the Supabase CLI, local Supabase status, the expected Supabase ports and
which process owns each relevant port, whether port 3000 serves another project,
the selected dashboard port, the data mode, the configured Supabase project URL
and whether it is local, hosted, or malformed, the class of the configured key
without printing it, Auth health, the presence and profile linkage of the
expected smoke users, running smoke/reset/provisioning processes, agent
processes scoped to this repository, unexpected recovery artifacts, and the
classification of every file in `supabase/snippets`.

```powershell
npm run doctor
npm run doctor -- --json
npm run doctor -- --port 4200
```

Output always ends with exactly one status line: `READY`,
`READY WITH WARNINGS`, or `BLOCKED`. Every warning and blocker carries a code, a
concise explanation, and an exact remediation command or next action.

The diagnostic never writes, never deletes, never resets a database, never
creates a user, never starts Docker, never terminates a process, and never
prints a key value. A probe is issued only against a loopback address, so a
hosted project is never contacted.

### Doctor exit codes

- `0`: `READY`.
- `1`: `READY WITH WARNINGS`.
- `2`: `BLOCKED`.
- `64`: invalid usage; nothing was inspected.

These differ from the PowerShell tools deliberately: warnings are a distinct,
non-blocking state rather than a silent success.

## Local launcher

`npm run dev:local` runs the diagnostic first and refuses to start on any
blocker. It then verifies that `config/supabase-config.local.js` points only to
`http://127.0.0.1:54321` and that the configured key is a browser-public
publishable class, starts local Supabase if it is not already running, claims
port 3100, verifies over the identity endpoint that the served root is exactly
this repository, provisions the local smoke users through
`scripts/Initialize-LocalSmokeUsers.ps1`, and prints the local addresses.

```powershell
npm run dev:local
npm run dev:local -- --open
npm run dev:local -- --no-provision
npm run dev:local -- --stop
npm run dev:local -- --port 4200
```

Port 3100 is used rather than the 3000 documented in the README because 3000 is
commonly held by another project. Note that a different port is a different
browser origin, so local-storage-mode data does not carry over from
`http://localhost:3000`.

The launcher never runs `supabase db reset`; runtime verification that needs a
pristine database still goes through `smoke.ps1 -AllowDatabaseReset`. It never
edits an ignored local configuration file: a missing or wrong value produces a
safe template and an instruction, never a generated credential. Provisioning is
skipped rather than forced when `SMOKE_TEST_*` passwords are absent, and refused
outright when the diagnostic found duplicate or mismatched smoke profile rows,
because provisioning into them would corrupt usernames.

Cleanup is ownership-bound. The launcher records the static server's pid, port,
and a random token in `artifacts/dev-local.state.json`; `--stop` terminates that
process only after the identity endpoint returns the matching token and
repository root, and refuses otherwise. Docker containers, local Supabase, and
every process the launcher did not start are always left running.

### Launcher exit codes

- `0`: started, reused, or stopped.
- `1`: startup failure.
- `2`: refused (diagnostic blocker, foreign port, or unsafe configuration).
- `64`: invalid usage.

Before a PR:

```powershell
npm run review
```

## Preflight

Preflight checks Git, tools, project files, unit/static gates, Docker, and Supabase status. Optional unavailable services are warnings by default.

```powershell
pwsh -File scripts/dev/preflight.ps1
pwsh -File scripts/dev/preflight.ps1 -StartSupabase
pwsh -File scripts/dev/preflight.ps1 -StartSupabase -IncludeRuntime
pwsh -File scripts/dev/preflight.ps1 -Json
pwsh -File scripts/dev/preflight.ps1 -ReportPath artifacts/preflight.json -Json
```

`-StartSupabase` may start local containers but never resets the database. `-IncludeRuntime` delegates to smoke.

Because preflight never resets the database, it cannot satisfy the reset-dependent runtime wrappers. With `-IncludeRuntime`, preflight therefore does not execute runtime smoke at all: it reports the stage as `Skipped` and prints an explicit closing notice.

```
Runtime smoke: SKIPPED (database reset required).
Runtime verification has NOT been executed.
To run runtime verification execute:
  powershell -File scripts/dev/smoke.ps1 -AllowDatabaseReset
```

A green `preflight:runtime` therefore means exactly three things: the non-destructive gates passed, runtime smoke was **not** executed, and runtime verification still requires the explicit opt-in below. Runtime smoke remains a required, hard failure inside `smoke.ps1` itself, where that opt-in is made.

## Runtime smoke

Default smoke prints a plan and refuses reset-dependent wrappers. An explicit destructive-local run is:

```powershell
powershell -File scripts/dev/smoke.ps1 -AllowDatabaseReset
```

This is allowed only for a disposable local Supabase DB and forbidden for staging/production. The script accepts no connection string.

## Review

Review compares the actual diff and working tree with the base merge point. It detects migration/destructive SQL, RLS, grants, `SECURITY DEFINER`, auth/error mapping, status rules, tests, docs, and risk markers. It writes `artifacts/review.md` by default and returns `READY FOR REVIEW`, `REVIEW WITH WARNINGS`, or `BLOCKED`.

## Pull request creation

Always start with dry-run:

```powershell
powershell -File scripts/dev/pr.ps1 `
  -CommitMessage "..." `
  -PrTitle "..." `
  -Paths @("file1", "file2") `
  -RunPreflight `
  -RunReview
```

Real execution:

```powershell
powershell -File scripts/dev/pr.ps1 `
  -CommitMessage "..." `
  -PrTitle "..." `
  -Paths @("file1", "file2") `
  -RunPreflight `
  -RunReview `
  -Execute
```

It is forbidden on `main`/`master`, stages only `-Paths`, shows the staged diff, refuses empty commits/conflicts, never force-pushes or merges, and reuses an open PR. `-Yes` is permitted only for a controlled CI/non-interactive flow.

## Exit codes (PowerShell tools)

- `0`: required checks passed or dry-run completed.
- `1`: a required check or workflow step failed.
- `2`: configuration, unsafe invocation, or confirmation error.

`doctor` and `dev:local` use their own scales, documented above.

## Reports

`-Json` emits structured JSON. `-ReportPath` must stay inside the repository. Generated `artifacts/` are ignored and report content is redacted.

## Examples

```powershell
npm run preflight
npm run review
powershell -File scripts/dev/smoke.ps1 -Json -ReportPath artifacts/smoke.json
```

## Recovery scenarios

- Fix the named required preflight failure and rerun.
- On Supabase timeout, inspect Docker without deleting containers/volumes.
- If commit succeeds but push fails, fix connectivity and push the branch manually.
- If push succeeds but PR creation fails, run `gh pr create`; the commit is not rolled back.
- Existing PRs are reported rather than duplicated.

## Known limitations

- Diff classification requires human interpretation.
- Static checks do not prove live runtime behavior.
- Existing local runtime wrappers require database reset; this tool makes that decision explicit.
- PowerShell 5.1 argument passing is less expressive than PowerShell 7, but no shell evaluation is used.
- `src/supabase-auth-service.js` accepts only an `https://<ref>.supabase.co`
  project root, so with data mode `supabase` and a loopback URL the dashboard
  sign-in fails with `config_invalid`. The launcher serves the application and
  reports the limitation as `FRONTEND_LOOPBACK_AUTH_UNSUPPORTED`; it does not
  change frontend behaviour. Use data mode `local` for UI work, or the runtime
  smoke harness for local backend verification. Tracked in
  [`docs/tech-debt.md`](tech-debt.md).
- `supabase/.gitignore` does not cover `supabase/snippets`, so Supabase Studio
  snippets keep appearing as untracked. The diagnostic classifies them and never
  removes them.

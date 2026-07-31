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

Standard daily workflow and the check before starting a task:

```powershell
npm run preflight
```

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

## Exit codes

- `0`: required checks passed or dry-run completed.
- `1`: a required check or workflow step failed.
- `2`: configuration, unsafe invocation, or confirmation error.

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

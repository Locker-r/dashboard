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

## Durable project context

Every implementation and review agent reads docs/project-status.md and
docs/decisions.md before beginning. Project status is a concise, parseable
snapshot; decisions are append-only records. Both change through ordinary code
review.

Run the dependency-free validator with:

    npm run check:project-status

Success prints PROJECT STATUS VALID plus the Main SHA relation and
commitsBehindMain distance. Failure prints PROJECT STATUS INVALID plus specific
error codes. The validator accepts LF, CRLF, and a UTF-8 BOM, rejects
missing, duplicate, unknown, empty, malformed, placeholder, and secret-shaped
fields, and compares Main SHA with the synchronized local main and origin/main
refs rather than the current feature-branch HEAD. Divergent main refs fail with
MAIN_REFS_DIVERGED instead of choosing one silently.

Main SHA is a verified milestone baseline. It must be a full SHA that resolves
to a commit and is an ancestor of resolved main. Exact equality is reported as
exact with commitsBehindMain 0. Any older ancestor remains valid, with the
shortest parent-edge distance through the Git graph reported as informational
context; a direct parent is therefore 1 even at a merge. There is no blocking
maximum depth. A missing commit fails with MAIN_SHA_UNREACHABLE,
and a reachable unrelated or descendant commit fails with
MAIN_SHA_NOT_ANCESTOR. This allows technical merges after a milestone without
creating an endless chain of status-only pull requests.

Main resolution uses refs/heads/main or refs/remotes/origin/main whenever either
is present. Continuous integration fetches origin/main explicitly so validation
stays on verified refs. A detached checkout with no main ref falls back to the
merge parent only when the runner's own event payload declares a pull-request
base SHA and that SHA is proven to be the first parent of the exact two-parent
merge commit that is checked out. Commit messages, branch names, and
pull-request titles are never treated as proof. Every other detached case —
ordinary commits, octopus merges, truncated shallow history, a mismatched
payload, or a non pull-request event — fails closed with MAIN_REF_UNAVAILABLE.

Milestone status uses exactly: planned, in-progress, blocked, or complete.
Last merged PR and Current open PR use either none or a positive number prefixed
with #; both are milestone-scoped rather than a log of technical hotfix,
documentation-only, or dependency-update pull requests. Refresh project status
when a milestone completes. Valid ancestor lag is informational; unreachable or
non-ancestor SHAs, unsafe main resolution, or materially incorrect milestone
state require stopping with the named error instead of an automatic update.

## Prompt generator

The dependency-free generator supports these templates:

- implementation
- adversarial-review
- fix-blockers
- validation
- runtime-investigation
- merge
- post-merge

Examples:

    npm run prompt -- implementation --task "Automation PR 2-A1"
    npm run prompt -- adversarial-review --pr 24
    npm run prompt -- fix-blockers --pr 24 --findings docs/reviews/pr-24.md
    npm run prompt -- validation
    npm run prompt -- runtime-investigation --issue "local login"
    npm run prompt -- merge --pr 24
    npm run prompt -- post-merge --pr 24

Common options are --out, --clipboard, --timestamp, --offline, and --help.
Default output is stdout. A relative --out value is resolved under
artifacts/prompts; output outside that owned directory, traversal, linked
targets, and tracked targets are refused. The artifacts directory is already
ignored, so generated prompts are never committed by the command.

The generator reads only fixed repository context files and explicit tracked,
non-ignored, ordinary findings files outside Git internals; linked paths are
refused. A --findings path must already exist and be tracked. The generator
never reads environment files or ignored credential files.
Git, GitHub, task, issue, findings, branch, commit, filename, and PR-title text
is redacted and placed in an explicit untrusted-data section, never in the
mandatory rules. Output includes exact HEAD, timestamp, a context fingerprint,
the recorded status SHA, resolved main SHA, commitsBehindMain, and whether the
baseline relation is exact or ancestor-based. A valid ancestor is never labeled
stale-blocking. The STALE PROMPT guard remains exact: branch, HEAD, relevant PR
head, and other execution context must still match the generated prompt.

Offline mode never invokes GitHub and emits:

    GitHub state unavailable.
    PR mergeability and CI status are unverified.

Merge and post-merge prompts require verified live GitHub state because they
authorize state-changing work. Other templates degrade safely when GitHub is
unavailable.

On Windows, --clipboard starts the fixed clip.exe program with shell execution
disabled and sends the prompt through standard input. Unsupported or failed
clipboard output is reported without removing stdout or a successfully written
file.

## Verification tiers

The verify:fast, verify:pr, verify:runtime, and verify:release commands are
deferred intact to Automation PR 2-A2. This PR does not claim they exist.
Current preflight, doctor, smoke, review, and release checks keep their existing
contracts until that focused follow-up.

Automation PR 2-B remains responsible for AI worktrees, PR preparation, merge,
and post-merge automation. No worktree or AI client is launched by the prompt
generator.

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
outright when the launcher's pre-provisioning live inspection detects duplicate
or mismatched smoke profile rows, because provisioning into them would corrupt
usernames.

That inspection reads the local database after Supabase is running and
immediately before provisioning, not from the earlier diagnostic run: when
Supabase was stopped at diagnostic time, the diagnostic has no user state to
report. If the inspection cannot run at all, provisioning is refused rather than
attempted blind.

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
- `src/supabase-auth-service.js` accepts a hosted `https://<ref>.supabase.co`
  project root and an `http` loopback project root, so dashboard sign-in,
  session restore, and sign-out work against local Supabase in either data mode.
  The diagnostic reports this as `FRONTEND_LOCAL_AUTH_SUPPORTED`. The published
  Pages artifact stays pinned to the hosted form by
  `scripts/build-pages-artifact.cjs`.
- `supabase/.gitignore` does not cover `supabase/snippets`, so Supabase Studio
  snippets keep appearing as untracked. The diagnostic classifies them and never
  removes them.

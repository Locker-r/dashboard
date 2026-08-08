# Developer toolchain

## Purpose

The scripts in `scripts/dev` provide repeatable verification tiers, readiness checks, guarded runtime smoke orchestration, diff-aware review reports, and dry-run-first pull request creation without new dependencies.

## Safety model

- Read-only behavior is the default; required failures are never reported as success.
- Output and reports redact credential-shaped values and remain inside the repository.
- No force push, automatic merge, container/volume deletion, or production targeting.
- Database reset requires explicit `--allow-reset`, which delegates only to the
  existing `-AllowDatabaseReset` smoke path.
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

For `adversarial-review`, verified live GitHub base and head SHAs define an exact base-to-head Git diff. Its sorted changed-file list and short statistics are
rendered separately from uncommitted working-tree changes, remain quoted untrusted data, and participate in the context fingerprint. If live PR state or either
Git diff query is unavailable, the prompt reports the missing context and does not substitute a guessed branch or working-tree diff.

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

The dependency-free verifier provides one interface over the existing checks:

```powershell
npm.cmd run verify:fast
npm.cmd run verify:pr
npm.cmd run verify:runtime
npm.cmd run verify:release
```

Every tier reports the selected tier, repository root, branch, full HEAD, start and completion time, total duration, destructive intent, each stage's duration
and result, skip reasons, and the first failure. Stages use fixed executable and argument arrays with shell execution disabled. The first failed, blocked, or
interrupted required stage remains primary; later stages are explicitly `skipped`. Release cleanup still runs when it is safe, and a cleanup failure is reported
without replacing an earlier failure.

The final human line is exactly `VERIFY <TIER> PASSED` or
`VERIFY <TIER> FAILED`. Supported options are:

- `--json`: emit only the versioned JSON result.
- `--offline`: record offline intent. For `verify:release` this blocks at the
  required dependency audit instead of skipping it and returning a false pass;
  it does not rewrite the commands used by other tiers.
- `--allow-reset`: authorize the sanctioned destructive stage in
  `verify:runtime` only. Other tiers reject it as invalid usage.
- `--help` or `-h`: print usage without running stages.

JSON schema version 1 contains `schemaVersion`, `tier`, `repository`, `branch`, `head`, `status`, `destructive`, `offline`, `stages`, `startedAt`, `completedAt`,
`durationMs`, `failureCode`, and `failureStage`. Each stage records its id, label, required and destructive flags, status, fixed display command when applicable,
duration, redacted details, and failure metadata.
Credential-shaped output is redacted in both formats.

Verifier exit codes are:

- `0`: every required stage passed; an intentionally skipped default runtime
  reset does not make the non-destructive tier fail.
- `1`: a validation stage failed or execution was interrupted.
- `2`: an environment or precondition blocker prevented truthful validation.
- `64`: invalid tier, option, or option combination.
- `70`: internal orchestration or unmasked cleanup failure.

On Windows, invoke a tier through its npm script so the verifier can resolve the
installed npm CLI without running a `.cmd` file through a shell. Durations are
environment-dependent: fast is normally seconds to a few minutes; PR and
release are several-minute gates; runtime depends on local services, and an
explicit reset suite can take substantially longer.

### `verify:fast`

Fast feedback runs exactly:

1. repository identity and Git-state reporting;
2. JavaScript syntax validation;
3. `git diff --check`;
4. project-status validation;
5. `tests/project-status.test.cjs`, `tests/prompt-generator.test.cjs`, and
   `tests/verification-tiers.test.cjs`.

Tracked and untracked changes are reported rather than rejected, including the
allowlisted `supabase/snippets` path, which is never modified. This tier invokes
no Docker, Supabase, dependency audit, release artifact, GitHub, or network
stage. It is useful while implementing but is not sufficient for PR creation or
merge.

### `verify:pr`

The complete local PR gate runs these mandatory stages in order:

1. `npm test`;
2. `npm run check:js`;
3. `npm run check:secrets`;
4. `npm run check:migrations`;
5. `npm run check:project-status`;
6. `npm run preflight`;
7. `git diff --check`.

It stops after the first meaningful failure and marks every later stage skipped.
It never resets a database, pushes, or requires GitHub state. Preflight retains
its own documented optional environment and connectivity warnings.

### `verify:runtime`

Runtime verification runs:

1. the read-only doctor;
2. Docker CLI availability;
3. Docker daemon availability;
4. local Supabase status at the canonical loopback URL;
5. canonical local Dashboard configuration and browser-public key checks;
6. local Auth health;
7. smoke-user linkage;
8. competing-process and runtime-ownership checks;
9. the existing runtime harness dry-run;
10. the sanctioned local reset smoke suite, skipped by default.

The default never starts Docker or Supabase, resets a database, provisions a
user, or terminates a process. Stopped services, hosted or malformed targets,
secret or unknown key classes, unhealthy Auth, unsafe smoke-user state, and
ambiguous process ownership block with an exact remediation.

`npm.cmd run verify:runtime -- --allow-reset` is destructive. Before invoking
`scripts/dev/smoke.ps1 -AllowDatabaseReset`, the verifier requires the three
local smoke passwords, reruns doctor, rechecks every loopback, service, Auth,
user, and ownership precondition, and prints a destructive warning. The wrapper
is the only reset path; it rechecks that canonical local Supabase is already
running and never starts it for this verifier. Hosted Supabase is always refused. Supplying the flag
expresses authorization but does not bypass a failed safety check.
During this destructive tree the verifier's own timeout does not kill the owned
wrapper: it waits for the process tree to finish rather than orphaning a
half-completed database reset. Two consequences must be understood before use.

First, the wait is unbounded. Once the sanctioned reset wrapper starts, neither
the verifier's 35-minute stage timeout nor the wrapper's own 900-second timeouts
will terminate it; they only change how the result is reported. A hung
`supabase db reset` will block until it exits or you intervene at the operating
system level.

Second, the verifier cannot guarantee that an interrupt never reaches the child.
Its SIGINT and SIGTERM handlers decline to forward a signal to a destructive
child, but on Windows Ctrl+C is delivered by the console to every process in the
group, including the child PowerShell process. Automation policy cannot override
that. Do not use Ctrl+C to stop a running reset; let it finish.

### `verify:release`

Release readiness is a local proof only. It runs all seven `verify:pr` stages,
then:

1. `npm audit --omit=dev --audit-level=high`;
2. validation of explicit browser-public artifact configuration and creation of
   a unique run-owned ignored workspace;
3. deterministic Pages artifact build A;
4. deterministic Pages artifact build B;
5. exact comparison of all artifact paths, bytes, and the combined digest;
6. independent validation of both artifacts;
7. release-governance structural tests;
8. workflow structural tests;
9. the fixed artifact-content contract;
10. an elevated credential-shape scan across both artifacts;
11. identity- and token-verified cleanup of only this run's workspace.

Migration governance is not repeated here. It runs once, as PR-gate stage 4.
Artifact comparison, validation, and the credential-shape scan each revalidate
workspace ownership before reading, so a directory substituted mid-run is
refused rather than trusted.

The caller must set `DASHBOARD_SUPABASE_PROJECT_URL` to an exact hosted HTTPS
Supabase project root and `DASHBOARD_SUPABASE_PUBLISHABLE_KEY` to an approved
`sb_publishable_` value. Synthetic format-valid public fixture values are
acceptable for local proof when explicitly supplied. Missing, placeholder,
loopback, malformed, JWT, secret, service-role, or unknown values block; the
verifier never invents or prints configuration.

Both artifacts are built under `artifacts/verify-release-*`, which is ignored by
Git. The verifier compares every byte, independently validates the fixed
17-file Pages contract, and removes the workspace only while its path, identity,
ownership token, and exact entries remain trustworthy. On ambiguous ownership
or recovery material it fails closed and preserves the reported workspace for
inspection. Dependency-audit registry failure is an environment blocker.

This tier never invokes the publishing release workflow, creates a tag or
GitHub Release, uploads an artifact, pushes, publishes, or deploys Pages.

Use `verify:fast` during implementation and `verify:pr` before handing off a
pull request. AI agents should run runtime or release only when the task actually
requires those environment-specific proofs and must never use `--allow-reset`
without explicit destructive-local authorization.

Automation PR 2-B remains responsible for AI worktrees, PR preparation, merge,
and post-merge automation. The verifier launches no worktree or AI client and
performs no PR lifecycle action.

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

## Agent worktrees

`npm run agent:worktree` gives each AI agent an isolated checkout so two agents
never fight over one working tree. It is dependency-free and shares the
verification tiers' execution, redaction, and exit-code conventions.

```powershell
npm.cmd run agent:worktree -- create --name claude --branch feature/example --create-branch
npm.cmd run agent:worktree -- create --name codex  --branch feature/example-review --create-branch
npm.cmd run agent:worktree -- create --name review --ref <sha-or-branch> --read-only
npm.cmd run agent:worktree -- list [--json]
npm.cmd run agent:worktree -- inspect --name claude [--json]
npm.cmd run agent:worktree -- remove --name claude
npm.cmd run agent:worktree -- prune
```

### Roles and location

Three logical roles are supported: `claude`, `codex`, and `review`. A custom
name is allowed only with an explicit `--role`. Names must match
`^[a-z0-9][a-z0-9_-]{0,39}$`.

Worktrees live at `<repository-parent>\.worktrees\<repository-name>\<name>` —
outside the primary working tree, so they never appear as untracked content.
A parent inside the repository is refused, as are traversal segments, control
and bidirectional characters, UNC paths, drive-relative paths, and any path with
a symbolic-link or junction ancestor.

`claude` and `codex` are implementation roles: they require an existing
`feature/`, `fix/`, or `docs/` branch, or `--create-branch` to create one from
HEAD. `main`, `master`, and any name Git could read as an option or revision
(leading `-`, `..`, `@{`, whitespace, `.lock`) are refused. A branch already
checked out in another worktree is refused.

`review` uses a detached HEAD at an exact resolved commit, so no branch can move
underneath a review and the implementation branch is never silently checked out.

### What read-only does and does not mean

`--read-only` records a convention in the ownership marker and is reported by
`list` and `inspect`. **Git does not enforce it and neither does the
filesystem.** A detached worktree will not advance a branch, but any process —
including an AI agent — can still edit files there. Treat it as a signal to
reviewers, not a permission boundary.

### Ownership

Every created worktree receives `.automation-owner.json` containing a random
correlation token, the repository identity, the logical name and role, the path,
the branch or ref, and the creation time. Creation uses exclusive write and never
adopts an existing directory: a pre-existing path is refused and preserved.

**The marker is an accident guard, not an authentication mechanism.** It lives
inside the directory it describes, so anything that can write to that directory
can also write the marker, and every field it holds is public or derivable: the
repository identity is a hash of the package name and the root commit, and the
path and name are visible on disk. The token is a correlation value, not a
secret — nothing verifies it against a value stored outside the guarded
directory, so a marker whose token is replaced with another well-formed value
still validates. Read the marker as "automation believes it created this",
never as "automation proved it created this". A hand-written marker can make
automation treat a foreign worktree as its own.

What actually bounds the damage is everything else `remove` requires, and none
of it can be satisfied by writing a file. Git must already register the path as
a worktree of this repository; the tree must be clean, with no untracked path
other than the marker and no ignored file from an unknown process; the branch
must be reachable from `main`; no shared runtime lock may be live; and the
removal itself is always a non-forced `git worktree remove`, which independently
refuses anything that became dirty since the check. A worktree that passes all
of those is fully recoverable from Git, which is why a forged marker is a
correctness problem rather than a data-loss one.

`remove` therefore refuses a missing, malformed, or tampered marker; a
repository or path mismatch; a dirty tracked tree; any untracked path other than
the marker; ignored files created by an unknown process; a locked worktree; an
in-progress Git operation; a live shared runtime lock; and a branch with commits
not reachable from `main`. It never uses `--force`, never deletes untracked
files, and never deletes a branch. Branch deletion is deliberately a separate,
explicit, manual operation in this milestone.

The marker is deleted immediately before `git worktree remove`, because Git
refuses to remove a worktree that still contains untracked files. If the Git
removal then fails, the worktree is left in place without a marker and
automation can no longer remove it — this is deliberate fail-closed behaviour.
The reported recovery path tells you which directory to inspect and remove
manually.

`prune` touches Git metadata only. It never deletes a filesystem path, shows the
Git prune plan first, and refuses to prune automatically when a prunable entry
lies under the managed worktree parent, because that usually means an owned
directory disappeared unexpectedly and deserves inspection.

### Shared local runtime

Every worktree of this repository shares one Docker daemon, one local Supabase
instance, and the same ports. This milestone **defines and inspects** an
advisory lock under `<repository-parent>\.worktrees\.automation-locks\` for
three destructive operation names — `database-reset`, `runtime-smoke`, and
`smoke-provisioning`. A lock file records the operation, owning worktree, PID,
process start identity where available, timestamp, and a token, and contains no
secrets.

**One destructive runtime command acquires the lock.** `verify:runtime`'s
`runtime-smoke-reset` stage acquires the `database-reset` operation immediately
before it invokes the sanctioned `scripts/dev/smoke.ps1 -AllowDatabaseReset`
wrapper, and releases it in every case — success, failure, or interruption —
once that invocation returns. The family root it acquires at is always the
primary repository's, resolved via `git rev-parse --git-common-dir` so the
lock is visible to `agent:worktree` regardless of which worktree
`verify:runtime` is run from. Collision is a hard, immediate refusal
(`RUNTIME_LOCK_HELD`, exit 2): it never steals, never waits, and never
retries, and a stale or malformed claim is preserved for a human to clear
rather than cleared automatically.

The `runtime-smoke` and `smoke-provisioning` operation names, and the
PowerShell entry points that would need to acquire them
(`scripts/dev/smoke.ps1` itself, `Invoke-LocalRuntimeSmokeTest.ps1`,
`provision-local-smoke-users.cjs`), remain unwired — deferred to Automation
PR 2-B2b. Until those are wired, the lock does not protect you from two
concurrent database resets started outside `verify:runtime --allow-reset`; it
only lets a worktree removal notice a reset that some other tool has already
announced.

The lock directory is always derived from the resolved worktree parent, so
`create`, `list`, and `remove` agree on one location for a given `--parent`.
With the default parent that is `<repository-parent>\.worktrees\`; with an
explicit `--parent <path>` it is the parent of that path. Pass the same
`--parent` to every command, or a lock held for one location will simply not be
visible from another.

Acquisition is exclusive. A second owner is refused rather than queued.
Automation never steals a live lock and never deletes a lock it does not hold;
a dead PID is reported stale for a human to clear. A live PID whose recorded
start identity no longer matches is treated as PID reuse and reported stale
rather than live.

**The lock is advisory.** It only coordinates commands that choose to consult
it and cannot stop a local process that ignores it — including
`scripts/dev/smoke.ps1` run directly, outside `verify:runtime`. Never run two
database resets concurrently on the strength of the lock alone.

### Exit codes and output

`0` success, `1` validation failure, `2` environment or precondition blocker,
`64` invalid usage, `70` internal orchestration failure. Status lines are
`WORKTREE CREATED`, `WORKTREE LIST OK`, `WORKTREE OWNED`, `WORKTREE NOT OWNED`,
`WORKTREE REMOVED`, `WORKTREE METADATA PRUNED`, `WORKTREE PRUNE SKIPPED`, and
`WORKTREE BLOCKED`. `--json` emits the versioned machine result only. Untrusted
branch names, paths, and Git output are redacted and quoted as JSON strings, so
they cannot inject headings or newlines into output.

### What this milestone does not do

Automation never launches Claude, Codex, or any other AI client — `create`
prints the `cd` command for you to run yourself. PR preparation, review-package
generation, merge-readiness verification, post-merge validation, and branch
cleanup are deferred to Automation PR 2-B2b and are not available yet.
Runtime-lock acquisition is wired for `verify:runtime`'s destructive stage
only (Automation PR 2-B2a); the smoke wrappers and provisioning remain
unwired, also deferred to 2-B2b.

## Known limitations

- Diff classification requires human interpretation.
- Review worktrees are read-only by convention only; nothing enforces it.
- The ownership marker guards against accidents, not against a local adversary.
  It cannot authenticate anything, because it lives inside the directory it
  describes and holds no value that is secret from whoever can write there.
- The shared runtime lock is acquired by `verify:runtime`'s destructive stage
  only; wiring it into the smoke wrappers and provisioning is Automation PR
  2-B2b work. It is advisory in any case and cannot constrain a process that
  ignores it.
- Worktree removal deliberately refuses more often than strictly necessary; the
  documented remediation is manual inspection, not a force flag.
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

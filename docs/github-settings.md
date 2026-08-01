# GitHub repository settings

Settings that cannot live in the repository and must be applied once by a user
with admin rights on `Locker-r/dashboard`. Nothing here is applied
automatically; the process these settings enforce is described in
[`docs/release-governance.md`](release-governance.md).

State recorded 2026-08-01 at commit `254bf2f`, read from the GitHub API.

## 1. Branch protection for `main` — MISSING

`GET /repos/Locker-r/dashboard/branches/main/protection` returns
`404 Branch not protected`, and `GET /repos/Locker-r/dashboard/rulesets`
returns `[]`. Direct pushes to `main` are currently possible and no check is
required before merge.

Apply as a **ruleset** (Settings → Rules → Rulesets → New branch ruleset):

- Name: `main protection`, Enforcement: **Active**, Target: **Default branch**
- **Restrict deletions**
- **Block force pushes**
- **Require a pull request before merging**
  - Required approvals: **0** — deliberate. A single maintainer cannot approve
    their own pull request, so any higher number deadlocks every merge.
  - **Dismiss stale approvals when new commits are pushed**: on
  - Require review from Code Owners: **off** until a second maintainer exists
- **Require status checks to pass**, with **Require branches to be up to date**:
  - `Tests, syntax, diff, and secrets`
  - `SQL and server PowerShell checks`
  - `Dependency review`
- **Require linear history**

Do not add a bypass list. An admin can still merge; recording an explicit
bypass only makes the exception invisible.

Status check names must match the workflow job names exactly. If a job is
renamed in `.github/workflows/quality-gates.yml`, the ruleset silently stops
requiring it — update both together.

## 2. Dependabot alerts — DISABLED

`GET /repos/Locker-r/dashboard/vulnerability-alerts` returns
`404 Vulnerability alerts are disabled`, and `dependabot_security_updates` is
`disabled`. Version-update pull requests are configured in
`.github/dependabot.yml`, but nobody is being told about known
vulnerabilities.

Settings → Code security:

- **Dependabot alerts**: enable
- **Dependabot security updates**: enable

Already enabled and to be left on: **secret scanning** and **push protection**.

Two Dependabot pull requests are open and unmerged (#4 `actions/checkout`,
#5 `actions/setup-node`). Review and merge or close them explicitly.

## 3. Merge strategy — INCONSISTENT

Currently all three merge methods are enabled, `delete_branch_on_merge` is
`false`, and four stale local branches already exist.

Settings → General → Pull Requests:

- **Allow squash merging**: on, with *Default to pull request title*
- **Allow merge commits**: off
- **Allow rebase merging**: off
- **Automatically delete head branches**: on

## 4. GitHub Pages — LIVE AND UNGATED

Not a defect to fix today, but it must not be forgotten.

`GET /repos/Locker-r/dashboard/pages` reports a legacy build publishing the
root of `main` to `https://locker-r.github.io/dashboard/`, with 24 deployments
since 2026-07-14. Every push to `main` republishes automatically, with no tag,
no approval, and no rollback path.

Today it serves an inert page: `config/supabase-config.local.js` and
`config/data-config.local.js` are untracked, so both return 404, the boot path
in `index.html` throws `config_missing`, and the application stops at an error
on the login screen. No data and no credential is exposed.

The risk is future, not present. When D2 introduces configuration injection,
this same channel would publish a **working** application on every push to
`main`.

Product Owner decision (2026-08-01): keep Pages enabled. Before D2 ships,
move publishing onto a release-driven channel:

- Replace the legacy branch build with a GitHub Actions Pages workflow
  triggered by `v*` tags rather than by pushes to `main`.
- Publish a build artifact directory, not the repository root, so untracked
  runtime configuration cannot be served by accident.
- Gate the deployment on a `github-pages` environment so a release requires an
  explicit approval.

This is D2 work and deliberately not implemented here.

## Verification

After applying sections 1–3, these should hold:

```bash
gh api repos/:owner/:repo/rulesets --jq 'length'
gh api repos/:owner/:repo/vulnerability-alerts
gh api repos/:owner/:repo --jq '{allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
```

Expected: at least `1`; HTTP `204`; and `false`, `false`, `true`.

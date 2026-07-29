# Quality gates

GitHub Actions runs on every pull request and every push to `main`. The Ubuntu job installs the locked dependency tree with Node.js 24 LTS, runs all Node tests, validates tracked JavaScript syntax, checks changed-line whitespace, and scans tracked files for local configuration paths and credential-shaped content. A small Windows job runs the atomic SQL and runtime smoke-harness structural PowerShell checks in their native environment.

The workflow has read-only repository permissions. It has no Supabase credentials, never connects to Supabase, and cannot modify application data.

## Run locally

From PowerShell in the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-all.ps1
```

This runs the tests, JavaScript syntax scan, tracked-file secret scan, atomic SQL safety check, smoke-harness migration/scope checks, and `git diff --check`. Run `npm ci` separately after cloning or whenever the lockfile changes.

## Manual production-release gates

Automation does not replace review of database migrations or live authorization behavior. Before production release, manually review and apply SQL to the intended project, run the read-only verification SQL, and complete the deferred two-account runtime smoke test documented in `docs/supabase-atomic-writes.md`. That test must confirm admin assignment, audit history, comments, follow-up, invalid-transition rejection, and cross-agent ownership rejection using dedicated non-production accounts.

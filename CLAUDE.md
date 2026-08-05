# CLAUDE.md

Project instructions for Claude Code in `dashboard/`. The tool-agnostic rules
are in [`AGENTS.md`](AGENTS.md) and apply here in full. This file adds only
what is specific to running Claude Code against this repository.

## Project

Dashboard Latam: a single-page lead reactivation dashboard backed by Supabase.
Plain JavaScript, no build framework, no TypeScript outside the Edge Function.
`index.html` is the application. `src/` holds the data and auth services.
`supabase/` holds migrations, rollbacks, and the `team-management` Edge
Function.

Canonical context, in reading order:

1. [`docs/project-status.md`](docs/project-status.md) — milestone, next task, blockers.
2. [`docs/decisions.md`](docs/decisions.md) — accepted ADRs, append-only.
3. [`docs/release-harness.md`](docs/release-harness.md) — how a release run works.
4. [`docs/release-governance.md`](docs/release-governance.md) — branching, merge, versioning.

## Commands

```bash
npm test
```

Other read-only checks: `npm run check:js`, `npm run check:secrets`,
`npm run check:migrations`, `npm run check:project-status`, `npm run doctor`,
`npm run verify:fast`, `npm run verify:pr`.

Local-write checks an operator runs, not Claude: `npm run verify:release`
(writes into `artifacts/`), `npm run verify:runtime` (needs Docker and a
started local Supabase stack).

Release harness:

```bash
node scripts/release/release.cjs simulate
```

The PowerShell orchestrator wraps the same run and writes a report:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release/Invoke-ReleaseOrchestrator.ps1
```

## Conventions to match

- CommonJS `.cjs` for tooling, `'use strict'`, `Object.freeze` on exported
  shapes, dependency injection through a `createDeps`/`overrides` parameter.
- Fixed exit codes: `0` ok, `1` validation, `2` blocked, `3` halted at the
  production gate, `64` usage, `70` internal.
- Versioned JSON envelopes with `schemaVersion`, and a `--json` flag beside a
  readable default rendering.
- Redact before printing. Reuse the existing redactors rather than writing a
  new one.
- Tests are `node:test` files under `tests/*.test.cjs`, run by `npm test`.

## What Claude does not do here

- No production action, ever. See `AGENTS.md` section 1. `git tag`, `gh
  release`, `supabase db push`, `supabase functions deploy`, `supabase link`,
  `supabase login`, `npm publish`, and any hosting CLI are refused
  unconditionally by `.claude/settings.json` and by
  `.claude/hooks/release-guard.cjs`. `git push` and `gh pr` are narrower: an
  explicit push of one ordinary branch to `origin`, `gh pr create`, and `gh pr
  merge --squash` (no `--admin`/`--force`/`--merge`/`--rebase`) are allowed —
  everything else (`main`/`master`, force, delete, tags, `--all`/`--mirror`, an
  ambiguous target, an admin bypass) is still refused. See
  [`docs/release-gates.md`](docs/release-gates.md) "What push and PR automation
  are actually allowed."
- No writes to `release/approvals/` under any circumstances. Writes to
  `release/verification/` are expected — that is where acceptance evidence goes.
- No change that turns off row-level security, makes a storage bucket public, or
  puts an elevated key into browser-delivered code. The guard refuses these as
  file content, not only as commands.
- No product-code edits while a release run is active
  (`RELEASE_HARNESS_MODE` set). Outside a release run, ordinary feature work on
  product code is normal and allowed.
- No `npm run smoke`, `supabase db reset`, or `verify:runtime --allow-reset`
  without explicit per-run authorization from the operator: these reset the
  local database.
- No edits to `docs/project-status.md` as a side effect. Status changes are
  reviewed like code.

## Hooks in this project

`.claude/settings.json` wires two hooks, both plain Node so they behave the
same in every shell:

- `SessionStart` → `.claude/hooks/release-context.cjs` injects the current
  branch, HEAD, selected next task, and the production-gate rule.
- `PreToolUse` → `.claude/hooks/release-guard.cjs` denies production and
  destructive commands, denies writes to `release/approvals/`, and denies
  product-code and harness self-modification while a release run is active.

Both fail closed: if a hook cannot evaluate a request, it denies it.

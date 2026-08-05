---
name: release-run
description: Run the autonomous release harness end to end read-only — select the next backlog task, walk the gate ladder, and halt at the production gate with an operator handoff. Use when asked to run a release, prepare a release, check release readiness, or find the next release task in the dashboard project.
---

# Release run

A release run answers *what is next* and *is it verified*, then stops. It never
answers *ship it*.

Read [`AGENTS.md`](../../../AGENTS.md) section 1 before starting. The single
rule: no agent performs a production action.

## Steps

### 1. Simulate

```bash
node scripts/release/release.cjs simulate
```

Exit `3` with `HALTED_AT_PRODUCTION_GATE` is the healthy outcome. Read the
result before doing anything else:

- **Exit 2, `BACKLOG_*`** — the backlog is unusable. Report it. Do not repair it.
- **Exit 2, `GOVERNANCE_DOCUMENT_MISSING`** — a required document is missing.
  Report which. The harness will not plan against an incomplete rulebook.
- **Exit 2, `NO_ELIGIBLE_TASK`** — every task is excluded. Report the exclusion
  codes; the answer is usually a pending decision or an external dependency.
- **Exit 2, `TASK_STATE_STALE`** — a task records implementation commits that
  exist here but is still marked `open`. Reconcile `release/backlog.json` before
  going further, or the run will schedule work that already landed.
- **Exit 2, `ACCEPTANCE_EVIDENCE_ABSENT` or `ACCEPTANCE_CRITERIA_UNPROVEN`** —
  the selected task is implemented and unproven. The next operation is
  verification. Continue with step 3; this is the normal path, not an error.
- **Exit 70** — the harness refused to execute a non read-only command. This is
  a harness defect and outranks everything else in your report.

### 2. Confirm the selection against evidence

Open the documents the selected task cites and check they say what the backlog
claims. A selection nobody verified is a claim, not a decision. Report any
citation that does not support its task.

Read the **next operation** the plan reports. `verify` means the implementation
already exists at the recorded commits: prove the acceptance criteria, and do
not write the feature a second time.

### 3. Verify (G3)

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release/Invoke-ReleaseOrchestrator.ps1 -Mode Verify
```

The orchestrator re-classifies every command immediately before running it and
executes only read-only ones. It writes a report under `artifacts/release/`.

Running the same checks directly is equivalent: `npm test`,
`npm run check:js`, `npm run check:secrets`, `npm run check:migrations`,
`npm run check:project-status`. Stop at the first real failure and preserve it.

Do not run `npm run verify:release` (writes into `artifacts/`) or
`npm run verify:runtime` (needs Docker and a started local stack) unless the
operator asks for them in this session. Report both as `planned`.

### 4. Record acceptance evidence

Run the selected task's acceptance criteria and write
`release/verification/<taskId>.evidence.json` per
`release/verification/README.md`. Record only criteria that actually ran; a
criterion you skipped is `blocked`, never `passed`. Gate G5b re-reads the file
and rejects it if it names a different HEAD than the one being verified.

### 5. Hand off

Use the `release-production-handoff` skill. Do not improvise the production
steps.

## Never, during a release run

- Edit product code — `index.html`, `src/`, `supabase/`, `config/`, `vendor/`,
  or the packaging files. A run verifies what it is releasing; it does not
  change it.
- Edit the harness itself — `.claude/`, `scripts/release/`,
  `release/backlog.json`. A run may not rewrite the rules it is judged by.
- Write anything under `release/approvals/`. Human-only, unconditionally.
- Run `git push`, `git tag`, `gh release`, `supabase db push`,
  `supabase functions deploy`, `npm publish`, or any hosting CLI.
- Update `docs/project-status.md` as a side effect. Status changes are reviewed
  like code.

## When unsure whether a command is allowed

```bash
node scripts/release/release.cjs classify --command "<the command>"
```

Exit `0` means read-only. Anything else means you do not run it — including
`unknown`, which fails closed on purpose.

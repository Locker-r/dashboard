# Release backlog

The backlog the harness selects from, the rules it selects by, and why the
current selection is what it is.

`release/backlog.json` is canonical. This document explains it. When they
disagree, the JSON is right and this file is stale.

```bash
node scripts/release/release.cjs plan
```

## Where the entries come from

Every task is derived from an existing repository document and cites it:

- `docs/test-environment-status.md` — the release blocker table B1–B8.
- `docs/test-environment-runbook.md` — operator sections and the same blockers.
- `docs/project-status.md` — the canonical milestone, next task, deferred work.
- `docs/tech-debt.md` — accepted limitations.

The backlog adds no findings of its own. A task with no evidence reference
fails validation with `BACKLOG_TASK_EVIDENCE_MISSING`.

## Task fields

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, uppercase. |
| `rank` | Explicit tiebreak order. Unique across the backlog. |
| `severity` | `P0`–`P3`, taken from the source document. |
| `status` | `open` (not implemented), `in-review` (implemented, unproven), `done` (implemented and proven). |
| `implementation` | The commits that implement the task, the branch, and whether they are merged. Checked against the repository at G1. |
| `acceptanceCriteria` | What must be proven before the task can be called done, each with the command that proves it. Required for `in-review`. |
| `decision` | `approved`, `pending`, `rejected`. An agent may only start `approved` work. |
| `actionability` | `internal` (the repository contains everything needed) or `external` (needs an account, credential, or human approval no agent can obtain). |
| `workaround` | A documented way to proceed without the task, or `null`. |
| `dependsOn` | Task ids that must be `done` first. Cycles fail validation. |
| `evidence` | Source references. At least one is required. |
| `productionActions` | What the task will eventually require an operator to do. Recorded, never executed. |

## Ordering rules

Applied in order, on the eligible set only:

1. Severity ascending — `P0` before `P1` before `P2` before `P3`.
2. Tasks with **no** documented workaround before tasks that have one.
3. Explicit `rank` ascending.
4. Task id ascending.

Rules 3 and 4 guarantee a total order, so the selection cannot depend on the
order the file happens to list tasks in. `tests/release-harness.test.cjs`
asserts this by shuffling the task array and re-selecting.

## Eligibility

A task is excluded, with a recorded code, when any of these holds:

| Code | Condition |
| --- | --- |
| `ALREADY_DONE` | `status` is `done`. |
| `DECISION_REJECTED` | `decision` is `rejected`. |
| `DECISION_PENDING` | `decision` is not `approved`. |
| `EXTERNAL_DEPENDENCY` | `actionability` is `external`. |
| `DEPENDENCY_NOT_DONE` | Some `dependsOn` task is not `done`. |

Exclusions are printed with the selection. A selection whose alternatives are
not visible is not auditable.

## Status drives the operation, not just the ordering

The selector reports a **next operation** derived from the selected task's
status. This is the difference between useful automation and an expensive way
to write the same feature twice:

| Status | Operation | Meaning |
| --- | --- | --- |
| `open`, no implementation commits | `implement` | The work does not exist. |
| `in-review` | `verify` | The work exists and is unproven. Do not re-implement it; prove the acceptance criteria. |
| `open`, with implementation commits | `reconcile-state` | A contradiction. G1 blocks the run with `TASK_STATE_STALE`. |
| `done` | — | Excluded from selection. |

G1 checks every recorded implementation commit against the repository with
`git rev-parse --verify`. A task claiming to be unstarted while its commits are
reachable stops the run rather than scheduling a duplicate implementation. A
task claiming review status whose commits are not reachable stops it too
(`TASK_IMPLEMENTATION_MISSING`).

## What is not a task

`nonTasks` records paths that exist in the working tree and are explicitly not
release work — currently `supabase/snippets/` (untracked Supabase Studio scratch
files, whose disposition is blocker B8) and `artifacts/` (ignored output).

An untracked directory is never itself a release task and is never committed as
part of a release change. Recording this is what stops an autonomous run from
inventing work out of whatever `git status` happens to print.

## Current selection: B1

At the recorded backlog state the eligible order is **B1 > B2 > B7 > M-2B2**,
the harness selects **B1 — proof upload end to end**, and the next operation is
**verify**, not implement.

Why B1 rather than each of the others:

| Task | Outcome | Reason |
| --- | --- | --- |
| **B1** | **selected** | P1, internal, approved, no dependencies, and no documented workaround. |
| B2 | eligible, second | Also P1 and internal, but `docs/test-environment-runbook.md` section 5 documents a workaround (provision accounts through the Supabase dashboard or the Edge Function), so rule 2 orders it after B1. |
| B3 | excluded | `EXTERNAL_DEPENDENCY`. Needs a Supabase account and an interactive `supabase login`. |
| B4 | excluded | `EXTERNAL_DEPENDENCY`. Needs a hosting account. |
| B5 | excluded | `DEPENDENCY_NOT_DONE`. Its source document says to fix it together with B2. |
| B6 | excluded | `DECISION_PENDING`. The Product Owner has not said which rule is authoritative. |
| B7 | eligible, third | P3. |
| B8 | excluded | `DECISION_PENDING`. Owner decision on the Studio snippets is not recorded. |
| M-2B2 | eligible, fourth | P3 milestone work. |
| M-D2B | excluded | `DEPENDENCY_NOT_DONE`. Depends on B4. |
| M-D2C | excluded | `DEPENDENCY_NOT_DONE`. Depends on M-D2B. |

B1 also gates four steps of the closed-environment smoke test — B11, B12, C7,
and F3 in `docs/test-environment-smoke-test.md` — which is why its severity and
its lack of a workaround agree.

The proof feature is implemented on `feat/proof-and-agent-management` by commits
`6f9c7b6`, `3f7543b`, and `aa236c0`, and is **not merged**. B2 is implemented by
`28b0bcf`, `3f7543b`, and `aa236c0`. Both are therefore recorded as
`in-review`, not `open`: the code exists and the acceptance claim does not.

Their acceptance criteria, each with the command that proves it:

| Task | Criterion | Command |
| --- | --- | --- |
| B1 | `proof-migration-governed` | `npm run check:migrations` |
| B1 | `proof-unit-tests` | `node --test tests/lead-proof.test.cjs` |
| B1 | `proof-runtime-suite` | `node scripts/lead-proof-smoke.cjs` |
| B1 | `proof-no-browser-secret` | `npm run check:secrets` |
| B2 | `cashier-migration-governed` | `npm run check:migrations` |
| B2 | `cashier-unit-tests` | `node --test tests/team-admin.test.cjs tests/team-management.test.cjs` |
| B2 | `cashier-structure` | `scripts/check-team-management.ps1` |
| B2 | `cashier-runtime-suite` | `node scripts/agent-management-smoke.cjs` |

The two runtime suites are the substantive ones: between them they exercise
proof-required closing, the private bucket, cross-agent proof isolation, admin
proof access, deactivated-agent access loss, cashier creation, duplicate email
and username handling, deactivate/reactivate on a live token, and a scan for a
service-role key in frontend files. They need a running local Supabase stack,
which is why they are classified `local-write` and run by the verifier rather
than by the planner.

## Maintaining the backlog

- Treat a backlog change as reviewed code, like `docs/project-status.md`.
- Move a task to `done` only when its source document agrees.
- Do not add a task an agent cannot verify from repository evidence.
- Keep `rank` unique. Duplicate ranks fail validation with
  `BACKLOG_RANK_DUPLICATE` rather than silently tie.

# Autonomous release harness

What the harness is, what it may do on its own, and where it stops.

For the gate definitions see [`release-gates.md`](release-gates.md). For the
backlog and its ordering see [`release-backlog.md`](release-backlog.md). For
the stage-by-stage release itself see [`release-plan.md`](release-plan.md). For
branching, merging, and versioning see
[`release-governance.md`](release-governance.md), which the harness does not
replace.

## The claim

The harness answers one question autonomously — *what is the next release task,
and why that one* — and refuses to answer a second one — *should this ship*.

It is built so the refusal is structural rather than behavioural. There is no
code path in `scripts/release/` that performs a production action, no flag that
enables one, and no configuration file that unlocks one. Production steps exist
in the harness only as classified, printable text.

## Components

| Path | Role |
| --- | --- |
| `release/backlog.json` | The canonical machine-readable backlog. Every task carries severity, decision state, dependencies, and evidence. |
| `release/approvals/` | Where a human writes a production approval record. Agents are denied write access here in every mode. |
| `release/verification/` | Where the verifier records acceptance evidence: which commands proved which criteria, against which commit. Agent-writable, because it is falsifiable. |
| `scripts/release/release-core.cjs` | The engine: backlog validation, task selection, command classification, the gate ladder, the execution ledger. |
| `scripts/release/release.cjs` | The CLI: `simulate`, `plan`, `gates`, `classify`. |
| `scripts/release/Invoke-ReleaseOrchestrator.ps1` | The Windows orchestrator. Runs the planner, optionally the read-only gates, writes a report, and stops at the production gate. |
| `.claude/hooks/release-guard.cjs` | Tool-level enforcement of the same rules for an interactive agent session. |
| `.claude/agents/`, `.claude/skills/` | The four narrow agent roles and the two release workflows. |
| `tests/release-harness.test.cjs` | The proofs: deterministic selection, refusal of production actions, hook denials. |

## How a run works

```bash
node scripts/release/release.cjs simulate
```

1. **G0** reads repository identity, branch, HEAD, and working-tree state.
2. **G1** validates `release/backlog.json`, checks recorded implementation
   commits against the repository, and selects exactly one next task with a
   **next operation** — `verify` or `implement` — recording an exclusion code
   for every task it did not select.
3. **G2** refuses to continue if any required governance document is missing.
4. **G3–G5** name the delegated verification commands and their classification.
   The planner executes none of them.
5. **G5b** reads the acceptance evidence and refuses to call the selected task
   verified unless every stated criterion passed against this exact HEAD.
6. **G6** reads — never writes — the approval record for the selected task.
7. **G7** halts. It lists the production actions it did not perform.

A run against unproven work ends at G5b with `ACCEPTANCE_EVIDENCE_ABSENT` and
exit code `2`: the next operation is verification, and the harness says so. Once
the evidence is recorded, the run ends with `HALTED_AT_PRODUCTION_GATE` and exit
code `3`. That is the healthy outcome, not a failure.

## Verifying is not implementing

The most likely way for a harness like this to cause damage is not a rogue
deployment — it is scheduling a second implementation of work that already
landed, because nobody updated the backlog when the commits arrived.

G1 defends against exactly that. Every task records its implementation commits;
G1 resolves each one with `git rev-parse --verify` and refuses to proceed when a
task claims to be unstarted while its implementation is reachable
(`TASK_STATE_STALE`). A task whose code exists and whose claims do not is
`in-review`, and the operation reported for it is `verify`.

## Why the halt is trustworthy

Three independent mechanisms, each testable on its own:

**The execution ledger.** Every command the planner runs is classified *before*
it runs and recorded *after*. A non read-only classification throws
`PRODUCTION_ACTION_ATTEMPTED` and exits `70`. The report prints the ledger, so
"no production action was executed" is a checked claim about observed commands
rather than a promise about intent.

**The classifier.** `classifyCommand` unwraps `powershell -Command "…"`,
`cmd /c "…"`, `bash -c "…"`, `npx`, `sudo`, and environment-variable prefixes,
splits pipelines, and takes the least safe classification found. A production
command hidden inside a wrapper still classifies as production.

**The approval reader.** `readApproval` only reads. The absence of an approval
record is the normal steady state and produces a blocked G6 — but G7 halts
whether or not an approval exists, because executing an approval is an operator
action performed outside this harness.

## Modes

| Mode | Meaning |
| --- | --- |
| `simulate` (default) | Report only. No delegated command is executed by anyone. |
| `verify` | The same ladder, plus an `executionPlan` listing the read-only delegated commands the PowerShell orchestrator is authorized to execute. The planner still executes none of them. |

Neither mode can reach a production action. There is no third mode.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The subcommand succeeded (`plan`, `gates`, `classify` on a read-only command). |
| 1 | Validation failure. |
| 2 | Blocked: an unusable backlog, stale task state, no eligible task, a missing document, unproven acceptance criteria, a non read-only command passed to `classify`. |
| 3 | Halted at the production gate. Expected. |
| 64 | Usage error. |
| 70 | Internal error, including a refused attempt to execute a non read-only command. |

## Relationship to the existing tooling

The harness owns no verification logic. `verify:fast`, `verify:pr`,
`verify:release`, `verify:runtime`, `doctor`, and the `check:*` scripts remain
the single implementations, and the gate ladder cites them by name. If a gate
and a script ever disagree, the script is right and the ladder is stale.

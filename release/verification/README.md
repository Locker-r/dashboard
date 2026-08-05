# Acceptance evidence

One file per task: `<taskId>.evidence.json`, recording what actually ran to
prove that task's acceptance criteria.

Evidence is not approval. The two are deliberately different in kind:

| | Evidence (`release/verification/`) | Approval (`release/approvals/`) |
| --- | --- | --- |
| Answers | Did the stated checks pass? | May this ship? |
| Written by | The verifier, from real command output | A person |
| Falsifiable | Yes — re-run the commands on the same commit | No — it is a judgement |
| Agent may write | Yes | **Never** |

An agent may write evidence precisely because evidence claims nothing that
cannot be re-checked: it names a commit, the commands, and their exit codes.
Gate G5b re-reads it and refuses it when it is stale, partial, malformed, or
recorded against a different HEAD.

## Format

```json
{
  "schemaVersion": 1,
  "taskId": "B1",
  "headSha": "<the exact 40-character commit the checks ran against>",
  "recordedAt": "<ISO-8601>",
  "criteria": [
    {
      "id": "<must match an acceptanceCriteria id in release/backlog.json>",
      "status": "passed",
      "exitCode": 0,
      "command": "<the command that ran>",
      "detail": "<short, redacted summary of the observed result>"
    }
  ]
}
```

Every criterion listed in the backlog must appear with `status: "passed"`,
`exitCode: 0`, the criterion's own `command`, and a non-empty `detail`. A
criterion that is missing, failed, or recorded without naming what proved it
produces `ACCEPTANCE_CRITERIA_UNPROVEN`, and the run stops before the production
gate is even discussed.

Evidence stops applying when the code it attests to changes. It survives its own
commit — otherwise the record could never be stored — but only while every path
changed since the recorded commit is under `release/verification/`. Any other
committed change makes it `ACCEPTANCE_EVIDENCE_STALE`, and any uncommitted
tracked change outside this directory makes it `ACCEPTANCE_WORKTREE_DIRTY`.

**What this file cannot do.** Nothing here re-runs a criterion. B1's decisive
criterion needs a live Supabase stack, which the gate cannot start or observe.
Recording a criterion you did not run is therefore possible, and it is a
deliberate falsehood rather than an oversight — the format exists to make it
one. Only re-running the commands proves anything.

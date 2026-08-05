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

Every criterion listed in the backlog must appear with `status: "passed"` and
`exitCode: 0`. A missing or failed criterion produces
`ACCEPTANCE_CRITERIA_UNPROVEN`, and the run stops before the production gate is
even discussed.

Evidence stops applying the moment HEAD moves. That is intentional: a commit
that was not tested has not been tested, however recently its predecessor was.

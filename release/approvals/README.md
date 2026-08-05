# Production approvals

One file per approved task: `<taskId>.approval.json`, copied from
`../approval.example.json` and filled in by a person.

**No agent may create, edit, or delete anything in this directory.** The denial
is unconditional — every mode, every flag — and is enforced in two independent
places: the `deny` rules in `.claude/settings.json` and the `PreToolUse` guard
in `.claude/hooks/release-guard.cjs`. The release harness only ever reads.

An approval names an exact `headSha`. It stops applying the moment the branch
moves; the harness reports `APPROVAL_HEAD_MISMATCH` rather than accepting a
record written for a different commit.

An approval authorizes a **human** to perform the production steps in
`docs/release-plan.md` section R7. It never converts the harness into an
executor: gate G7 halts whether or not a valid approval exists.

See [`docs/release-gates.md`](../../docs/release-gates.md) for the required
fields and the refusal codes.

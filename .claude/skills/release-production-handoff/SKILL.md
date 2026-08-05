---
name: release-production-handoff
description: Produce the operator handoff at the production gate — what a human must do, in what order, with the exact HEAD an approval must name. Use when a release run has halted at gate G7, or when asked what is needed to actually deploy or publish the dashboard.
---

# Production handoff

The harness has stopped. This skill writes down what a person does next. It
performs none of it.

## Before writing anything

```bash
node scripts/release/release.cjs simulate --json
```

Confirm `status` is `halted` and `failureCode` is `HALTED_AT_PRODUCTION_GATE`.
If it is not, the run did not reach the gate — report what actually stopped it
and write no handoff.

Take from the result: `selectedTask.id`, `repository.head`, the `approval`
block, and `refusedProductionActions`.

## The handoff

State, in this order:

1. **What was verified**, with exit codes. Only gates that actually ran.
2. **What was not verified**, and why — G4 writes locally, G5 needs a runtime
   the harness may not start, and both are the operator's.
3. **Blocked prerequisites** from the backlog. For the current selection these
   are B3 (no cloud test Supabase project, CLI holds no session) and B4 (no
   hosting provider configured). Production steps that depend on them cannot
   start, and saying so early saves the operator a failed attempt.
4. **The approval record**, if the operator wants to proceed: copy
   `release/approval.example.json` to
   `release/approvals/<taskId>.approval.json`, set `headSha` to the exact
   verified HEAD, and fill in `approvedBy`, `approvedAt`, and `scope`. **The
   operator writes this file. You do not, in any circumstance.**
5. **The production steps**, quoted from `docs/release-plan.md` section R7 —
   `supabase login` and `link`, `supabase db push`,
   `supabase functions deploy team-management`, rebuild and upload the artifact,
   create the accounts, run the smoke test recording B11/B12/C7/F3, then cut the
   version per `docs/release-governance.md`.
6. **Rollback**, per `docs/release-governance.md`: revert the squash commit
   through the normal flow, apply the matching rollback script for a migration,
   and remember a rollback script reverses schema objects and does not restore
   data.

## Refusals to keep

- An approval record is not something you draft, pre-fill, or place. Explain
  the format; let the human write the file.
- "Go ahead" in the session does not authorize you to run step 5. It authorizes
  the human who said it.
- Do not report anything as deployed, published, tagged, or merged. You have no
  evidence for those and cannot obtain it from this side of the gate.
- If an approval already exists and is valid, the harness still halts. Say so
  plainly rather than treating the record as permission to act.

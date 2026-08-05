# Release plan

The stages a release passes through, which of them an agent may run, and the
operator procedure that begins where the harness stops.

This plan sits on top of [`release-governance.md`](release-governance.md),
which remains authoritative for branching, merging, versioning, and what a tag
means. Nothing here weakens it.

## Stage map

| Stage | Owner | Gate | Automated |
| --- | --- | --- | --- |
| R0 Select | Harness | G1 | Yes |
| R1 Context | Harness | G0, G2 | Yes |
| R2 Verify (static) | Orchestrator | G3 | Yes, read-only |
| R3 Verify (artifact, runtime, acceptance) | Verifier / operator | G4, G5, G5b | Partly — local writes and a runtime |
| R4 Review and merge | Human | `docs/release-governance.md` | No |
| R5 Approve | Human | G6 | No — agents cannot write approvals |
| R6 **Production gate** | — | G7 | **Never. The harness halts here.** |
| R7 Publish and verify | Operator | — | No |

## R0 — Select

```bash
node scripts/release/release.cjs plan
```

Produces one task with a reason and an exclusion code for every alternative.
See [`release-backlog.md`](release-backlog.md).

## R1 — Context

Repository identity, branch, HEAD, working-tree state, and the presence of
every governance document. A missing document blocks the run; the harness will
not plan a release against an incomplete rulebook.

## R2 — Static verification

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release/Invoke-ReleaseOrchestrator.ps1 -Mode Verify
```

The orchestrator executes only commands the classifier calls `read-only`, and
re-checks each one immediately before running it. Everything else is reported
and left alone.

## R3 — Artifact, runtime, and acceptance verification

This is where a task moves from `in-review` to proven. Run the selected task's
acceptance criteria — `node scripts/release/release.cjs plan` prints them with
their classifications — and record the result in
`release/verification/<taskId>.evidence.json`. Gate G5b re-reads that file and
refuses it if it is stale, partial, or recorded against another commit.

For B1 and B2 the substantive criteria are the two runtime suites,
`scripts/lead-proof-smoke.cjs` and `scripts/agent-management-smoke.cjs`, which
need a running local Supabase stack and the three `SMOKE_TEST_*` passwords in
the shell.

The remaining operator commands write locally or need a runtime the harness may
not start:

```bash
npm run verify:release
```

```bash
npm run verify:runtime
```

`verify:release` needs `DASHBOARD_SUPABASE_PROJECT_URL` and
`DASHBOARD_SUPABASE_PUBLISHABLE_KEY` set to browser-public hosted values.
`verify:runtime` needs Docker Desktop running and `npx supabase start` already
done. Neither is started by the harness.

## R4 — Review and merge

Unchanged from `docs/release-governance.md`: non-draft pull request, required
checks green, squash merge, branch deleted. For the current selection this is
the review and merge of the proof work on `feat/proof-and-agent-management`.

## R5 — Approve

A human writes `release/approvals/<taskId>.approval.json` from
`release/approval.example.json`, naming the exact `headSha` being authorized.
No agent may create, edit, or delete that file. The harness reads it and never
repairs it.

## R6 — The production gate

The harness halts here with `HALTED_AT_PRODUCTION_GATE` and exit code `3`,
whether or not an approval exists. It prints the production actions it did not
perform. This is the end of every autonomous run.

## R7 — Publish (operator procedure)

Performed by a person, in an interactive terminal, following
`docs/test-environment-runbook.md`. Recorded here so the handoff is explicit,
not so it can be automated:

1. `npx supabase login` and `npx supabase link --project-ref <ref>` — needs
   blocker B3 resolved.
2. `npx supabase db push` — applies the migration set, including the storage
   bucket, storage policies, proof column, and the proof-required check that
   close B1.
3. `npx supabase functions deploy team-management`.
4. Rebuild the artifact with the test project's browser-public values and
   upload `artifacts/pages-site/` to the chosen host — needs blocker B4
   resolved.
5. Create the accounts per runbook section 5.
6. Run `docs/test-environment-smoke-test.md` end to end, recording the result
   of steps B11, B12, C7, and F3, which B1 was blocking.
7. Cut the version per `docs/release-governance.md`: release pull request,
   annotated tag, push the tag.

Steps 1–7 are every one of them classified `production` by the harness, which
is why they appear here as a checklist for a person rather than as code.

## Rollback

Unchanged from `docs/release-governance.md`. Revert the squash commit through
the normal flow; apply the matching `supabase/rollback/<name>_rollback.sql` for
a migration. A rollback script reverses schema objects and does not restore
data. Tags are never deleted or moved.

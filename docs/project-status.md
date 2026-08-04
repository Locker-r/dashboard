# Project status

Every implementation or review agent must read this file and docs/decisions.md
before beginning work. This is the canonical concise project context; it is not
a roadmap or a command log.

## Canonical status

Project: Dashboard Latam
Current milestone: Developer Automation PR 2-B1
Milestone status: in-progress
Main SHA: 0efe42f82edc520a5bb1293a5996407811fba77d
Last merged PR: #29
Current open PR: none
Active blockers: none
Approved decisions: ADR-001 through ADR-011 in docs/decisions.md
Next task: Review and merge Automation PR 2-B1, then implement Automation PR 2-B2
Deferred work: Automation PR 2-B2 review packages, PR preparation, merge-readiness, post-merge validation, branch cleanup, and Windows CI for the JavaScript suite; D2-B; D2-C; anonymous boot error
Technical debt references: docs/tech-debt.md
Last updated: 2026-08-04T17:45:00.0000000+05:00

## Update contract

- Update this file when a milestone is completed. Main SHA records the verified
  milestone baseline at that point; technical hotfix, dependency, and
  documentation merges do not require a self-referential status update.
- Main SHA must be a full, reachable Git commit that is an ancestor of resolved
  main. Exact equality is fully current. An older ancestor remains valid, and
  the validator reports its informational commitsBehindMain distance without
  imposing an arbitrary maximum.
- A missing or unreachable Main SHA is blocking. A reachable SHA outside main's
  ancestry is blocking with MAIN_SHA_NOT_ANCESTOR. Divergent or unresolvable
  main refs also fail closed. Ancestor lag by itself is not stale project status.
- Report STALE PROJECT STATUS before working when ancestry, milestone-scoped
  pull-request state, or another material field disagrees with verified state.
- Treat every status change as reviewed code. Never update it automatically.
- Keep values concise and verifiable. Do not add secrets, credentials, volatile
  command output, or a copy of the full roadmap.
- Last merged PR and Current open PR are milestone-scoped. Technical hotfixes,
  documentation-only changes, and unrelated automated dependency updates are
  outside these status fields.

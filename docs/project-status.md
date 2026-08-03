# Project status

Every implementation or review agent must read this file and docs/decisions.md
before beginning work. This is the canonical concise project context; it is not
a roadmap or a command log.

## Canonical status

Project: Dashboard Latam
Current milestone: Developer Automation PR 2-A1
Milestone status: complete
Main SHA: ebf0c265daa5677b3afbe049122c43bd5221046a
Last merged PR: #25
Current open PR: none
Active blockers: none
Approved decisions: ADR-001 through ADR-010 in docs/decisions.md
Next task: Automation PR 2-A2 verification tiers, authorized but not yet started
Deferred work: Automation PR 2-A2 verification tiers; Automation PR 2-B worktrees, PR preparation, and post-merge automation; accepted PR 2-A1 review follow-ups in docs/tech-debt.md; D2-B; D2-C; anonymous boot error
Technical debt references: docs/tech-debt.md
Last updated: 2026-08-04T00:58:11.402+05:00

## Update contract

- Update this file after every milestone merge.
- Main SHA must be the main tip or its direct first parent. Record the SHA that
  is main when the change is written; the commit carrying that change becomes
  the new tip, which keeps main valid without a further update. One more main
  commit without an update makes this status stale.
- Report STALE PROJECT STATUS before working when Main SHA, pull-request state,
  or another material field disagrees with verified repository state.
- Treat every status change as reviewed code. Never update it automatically.
- Keep values concise and verifiable. Do not add secrets, credentials, volatile
  command output, or a copy of the full roadmap.
- Current open PR identifies this milestone's pull request; unrelated automated
  dependency updates are outside this status field.

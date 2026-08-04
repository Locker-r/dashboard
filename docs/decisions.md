# Architecture decisions

Read this append-only log with docs/project-status.md before implementation or
review. Add a new record when a decision changes; do not rewrite an accepted
record to conceal the earlier state. Spelling and link corrections still
receive normal code review.

## ADR-001 — Protect contacts at the DB/API boundary

Decision ID: ADR-001
Date: 2026-08-01
Status: accepted
Context: UI masking alone left raw contact columns available to permitted rows.
Decision: Enforce contact protection in the database projection and API boundary.
Rejected alternatives: UI-only masking; returning raw contacts and relying on callers.
Consequences: Browser reads stay masked and authorization is enforced before data leaves the database.
Related milestone: Secure Contact Boundary PR A
Evidence: docs/tech-debt.md and commit f0e70bdf54daf343f1b807a9485f75e2f647e332

## ADR-002 — Reveal contacts through one audited operation

Decision ID: ADR-002
Date: 2026-08-01
Status: accepted
Context: Eligible agents need temporary contact access without reopening broad reads.
Decision: Use the narrowly scoped reveal_player_contacts operation with immutable audit events.
Rejected alternatives: Persistent unmasking; unaudited direct column reads.
Consequences: Each controlled reveal decision is attributable and raw values remain transient in the browser.
Related milestone: Audited Contact Reveal PR B and frontend PR C
Evidence: docs/contact-reveal-frontend.md and commits 92431fd536acb447216050529ffe5da33aa267aa and 254bf2f9336798c20f4e360f2fe284eaad5a8939

## ADR-003 — Retain GitHub Pages

Decision ID: ADR-003
Date: 2026-08-01
Status: accepted
Context: Legacy Pages publishes main but is currently inert without runtime configuration.
Decision: Keep Pages enabled while replacing its publication model in later D2 work.
Rejected alternatives: Disable Pages immediately; treat the legacy channel as production-ready.
Consequences: Every main push may still publish, and release-driven deployment remains mandatory before a configured application is shipped.
Related milestone: D2 deployment
Evidence: docs/github-settings.md section 4

## ADR-004 — Build a deterministic Pages artifact

Decision ID: ADR-004
Date: 2026-08-03
Status: accepted
Context: Deployment needs a fixed, independently validated artifact rather than the repository root.
Decision: Construct a dependency-free fixed-allowlist Pages directory with canonical bytes and an integrity manifest.
Rejected alternatives: Recursive workspace copies; HTML-discovered inputs; direct publication of the checkout.
Consequences: Identical approved inputs produce identical artifact bytes and deployment remains a separate step.
Related milestone: D2-A
Evidence: docs/pages-artifact.md and commit 95681e919a38f8920022a80740241f3b309569b0

## ADR-005 — Defer release-driven deployment

Decision ID: ADR-005
Date: 2026-08-03
Status: accepted
Context: Artifact construction is complete but workflow publication, approval, and deployment are not.
Decision: Keep release-driven publication and deployment in D2-B and D2-C.
Rejected alternatives: Add deployment to developer automation; publish on every main push.
Consequences: Tags remain reviewed snapshots rather than proof of deployment.
Related milestone: D2-B and D2-C

## ADR-006 — Separate AI implementation and independent review

Decision ID: ADR-006
Date: 2026-08-03
Status: accepted
Context: Claude and Codex may both contribute, but an implementer cannot supply independent review of its own change.
Decision: Keep implementation and independent adversarial review as separate AI roles when both agents are used.
Rejected alternatives: Treat self-review as independent approval; allow two agents to edit the same scope without ownership boundaries.
Consequences: Handoffs must include exact branch, SHA, scope, validation, and unresolved findings.
Related milestone: Developer Automation

## ADR-007 — Use local Dashboard port 3100

Decision ID: ADR-007
Date: 2026-08-03
Status: accepted
Context: Port 3000 is commonly occupied by unrelated local projects.
Decision: Use port 3100 as the default verified local Dashboard port.
Rejected alternatives: Continue assuming port 3000; terminate the process that owns a conflicting port.
Consequences: The launcher refuses foreign ownership and never stops unrelated processes.
Related milestone: Automation PR 1
Evidence: docs/developer-toolchain.md and commit 56aa4a546c99168b7d616932dc3da5a11e1c1a23

## ADR-008 — Allow only literal local Supabase origins

Decision ID: ADR-008
Date: 2026-08-03
Status: accepted
Context: Local browser authentication needs HTTP loopback while URL canonicalization can disguise non-literal input.
Decision: Allow only exact 127.0.0.1, localhost, or [::1] HTTP origins with an optional canonical decimal port.
Rejected alternatives: Hosted-only local development; trusting a hostname only after URL canonicalization.
Consequences: Local authentication works without accepting alternate IP spellings, separators, paths, credentials, queries, or fragments.
Related milestone: Automation PR 1.1
Evidence: docs/tech-debt.md and merge commit 23985ce92807b5bc82b2eca625c840547c2c6317

## ADR-009 — Keep production configuration hosted-only

Decision ID: ADR-009
Date: 2026-08-03
Status: accepted
Context: Local authentication support must not weaken published artifact inputs.
Decision: Require a hosted HTTPS Supabase project root and approved publishable key class for the Pages artifact.
Rejected alternatives: Permit loopback or arbitrary HTTPS origins in production artifacts.
Consequences: Local and production configuration policies remain intentionally independent.
Related milestone: D2-A and Automation PR 1.1
Evidence: docs/pages-artifact.md and merge commit 23985ce92807b5bc82b2eca625c840547c2c6317

## ADR-010 — Split developer automation into reviewable pull requests

Decision ID: ADR-010
Date: 2026-08-03
Status: accepted
Context: Durable context, prompt safety, verification tiers, worktrees, and PR lifecycle automation exceed one safe review unit.
Decision: Deliver status, decisions, validation, and prompts in PR 2-A1; verification tiers in PR 2-A2; worktrees and PR/post-merge automation in PR 2-B.
Rejected alternatives: One automation monolith; removing required safety controls to meet a line target.
Consequences: Later automation remains explicitly deferred and no unimplemented command is documented as available.
Related milestone: Developer Automation PR 2-A and PR 2-B

## ADR-011 — Prove worktree ownership with a marker, never by path convention

Decision ID: ADR-011
Date: 2026-08-04
Status: accepted
Context: Automation that deletes worktrees must distinguish directories it created from operator directories that merely share a name or location.
Decision: Record an exclusive `.automation-owner.json` marker holding a random token, repository identity, name, role, path, and ref; refuse every destructive worktree operation that cannot revalidate it, and never adopt or force-remove a path.
Rejected alternatives: Trust the managed parent path; trust the directory name; offer a `--force` removal mode.
Consequences: Automation refuses more often, including after legitimate manual edits, and the documented remedy is human inspection rather than a bypass flag.
Related milestone: Developer Automation PR 2-B1
Evidence: scripts/dev/automation-core.cjs, tests/agent-worktree.test.cjs

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

## ADR-011 — Mark automation-created worktrees, and treat the marker as an accident guard

Decision ID: ADR-011
Date: 2026-08-04
Status: accepted
Context: Automation that deletes worktrees must distinguish directories it created from operator directories that merely share a name or location. The marker file necessarily lives inside the directory it describes, and every field it can hold is either public or derivable, so it can record an intent but cannot authenticate one.
Decision: Record an exclusive `.automation-owner.json` marker holding a random correlation token, repository identity, name, role, path, and ref; refuse every destructive worktree operation that cannot revalidate it, and never adopt or force-remove a path. Treat the marker as a guard against acting on a directory automation did not create, not as proof of authorship: the guards that actually bound the blast radius are that Git must already register the path as a worktree of this repository, that the tree must be clean with no untracked or unknown ignored files, that the branch must be reachable from main, and that removal is always delegated to a non-forced `git worktree remove`.
Rejected alternatives: Trust the managed parent path; trust the directory name; offer a `--force` removal mode; present the token as an authentication secret when nothing verifies it against a value held outside the guarded directory.
Consequences: A hand-written marker can make automation treat a foreign worktree as its own, so the marker is never the last line of defence and must not be described as one; the cleanliness, reachability, and non-force guards are what keep such a removal recoverable. Automation also refuses more often, including after legitimate manual edits, and the documented remedy is human inspection rather than a bypass flag.
Related milestone: Developer Automation PR 2-B1
Evidence: scripts/dev/automation-core.cjs, tests/agent-worktree.test.cjs

## ADR-012 — Wire the shared runtime lock at the destructive boundary only; never automate remote branch deletion

Decision ID: ADR-012
Date: 2026-08-08
Status: accepted
Context: Automation PR 2-B2 covers two destructive surfaces at once — acquiring the shared advisory runtime lock ADR (and Automation PR 2-B1) defined but left unwired, and new local/remote branch cleanup following PR merge — each needing its own safety design, so it is split into 2-B2a (this decision's lock-wiring half, implemented) and 2-B2b (PR preparation, merge readiness, post-merge validation, branch cleanup, not yet implemented).
Decision: Acquire the existing advisory runtime lock at the destructive child-process boundary only — inside `verify:runtime`'s `runtime-smoke-reset` stage, immediately before it spawns the sanctioned `scripts/dev/smoke.ps1 -AllowDatabaseReset` wrapper, never at CLI entry — and release it in every case (success, failure, interruption) once that invocation returns. A stale lock claim is never auto-cleared; only a human clears one, after inspecting it. When 2-B2b implements branch cleanup, it will delete a local branch only with `git branch -d` (never `-D`) and will never delete a remote branch under any flag.
Rejected alternatives: Acquiring the lock at CLI entry (holds it across long read-only stages that do not need it); auto-clearing a stale lock (defeats the fail-closed posture ADR-011 already established for worktree removal); waiting or queuing on collision (hides that a concurrent reset is running instead of refusing loudly); `git branch -D` for local cleanup (bypasses Git's own unmerged-branch protection); `git push origin --delete`/`git push origin :branch` for remote cleanup, or any force flag for either (remote branch deletion already classifies as a production action refused unconditionally by the release guard; a force flag was already rejected for worktree removal in ADR-011 for the same reason).
Consequences: `verify:runtime --allow-reset` is now the only reset path this lock protects; `scripts/dev/smoke.ps1`, `Invoke-LocalRuntimeSmokeTest.ps1`, and `provision-local-smoke-users.cjs` remain unwired and undocumented as protected until 2-B2b gives them a way to reach the primitive. Remote branch deletion stays out of automation's reach entirely, by policy and by the existing guard, not only by omission.
Related milestone: Automation PR 2-B2a (this change) and 2-B2b (deferred)
Evidence: scripts/dev/verify.cjs (resolveRuntimeLockFamilyRoot, the runtime-smoke-reset stage), tests/runtime-lock-wiring.test.cjs, tests/verification-tiers.test.cjs

## ADR-013 — Approve Cloudflare Pages as the production frontend host

Decision ID: ADR-013
Date: 2026-08-08
Status: accepted
Context: ADR-003's GitHub Pages channel is retained for staging/pilot only (Product Owner decision, 2026-08-07; docs/release-gates.md "Frontend hosting: GitHub Pages, staging/pilot only"); production hosting was explicitly left undecided (blocker B4). This decision names the production host. It does not authorize creating the Cloudflare account or project, configuring DNS or a custom domain, choosing a deployment mechanism (Wrangler CLI, Cloudflare's GitHub integration, or a GitHub Actions workflow calling the Cloudflare API), or performing any deployment — all of that still needs a human with Cloudflare account access and, for any repository-side automation, a scoped API token recorded as a GitHub Actions secret. No agent can obtain either.
Decision: Cloudflare Pages is the approved production frontend host for Dashboard Latam, chosen by the Product Owner on 2026-08-08.
Rejected alternatives: Leaving production hosting undecided indefinitely; GitHub Pages for both staging and production (ADR-003/the 2026-08-07 decision already scoped GitHub Pages to staging/pilot only and did not extend it); deciding a specific deployment mechanism now, ahead of the account/project existing to deploy to.
Consequences: Blocker B4's "choose" half is resolved; the "configure" half (Cloudflare account/project creation, DNS, a deployment mechanism, and the workflow that exercises it) remains external and unresolved, the same posture ADR-005 already established for GitHub Pages publication (a separate, later, reviewed change) and the same shape B3 followed for the Supabase staging project — a human performs the account-level action first, and only then does a scoped, reviewed automation change follow it, mirroring "The scoped exception: staging Auth URL configuration" and "The one scoped exception: staging project provisioning" in docs/release-gates.md. B4 stays `actionability: external` and `status: open` until that happens.
Related milestone: B4; D2-B and D2-C (deployment mechanism and workflow, not yet designed)
Evidence: release/backlog.json B4; docs/release-gates.md "Frontend hosting: production (Cloudflare Pages), account and deployment mechanism not yet configured"

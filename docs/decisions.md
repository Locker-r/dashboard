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

## ADR-014 — Cloudflare account/project provisioned; Direct Upload via GitHub Actions + Wrangler is the approved deployment mechanism

Decision ID: ADR-014
Date: 2026-08-08
Status: accepted
Context: ADR-013 named Cloudflare Pages as the production host but left account creation, project creation, DNS, credentials, and the deployment mechanism unresolved and external. A human operator has since created the Cloudflare account, the Pages project, and the two credentials a repository-side workflow would need, and reported this back as operator evidence — the same shape B3's Supabase project provisioning and the staging Auth URL exception both used.
Decision: The Cloudflare Pages project is `dashboard-latam`, served at `dashboard-latam.pages.dev`, with no separate Git provider connected (Cloudflare's own GitHub integration is not used). The approved deployment mechanism is Direct Upload: a reviewed GitHub Actions workflow invoking the Wrangler CLI, authenticated via `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` recorded as GitHub Actions secrets in the `production` environment. This decision records the project, domain, and mechanism; it does not itself author or authorize running that workflow, and no deployment has occurred.
Rejected alternatives: Cloudflare's own GitHub integration (would deploy on every push to a connected branch with no reviewable gate, the same reason ADR-005 kept GitHub Pages deployment release-driven rather than push-driven); a Wrangler CLI invocation from a developer machine (credentials would need to leave GitHub-managed secret storage); leaving the mechanism undecided until the publishing workflow itself is authored, which would block D2-B/D2-C from having anything concrete to design against.
Consequences: Blocker B4 is now fully resolved — host, account, project, domain, and mechanism are all decided and configured — and moves to `status: done`. Authoring the actual publishing workflow (the `wrangler pages deploy` invocation, its trigger, and its guardrails) is separate, deferred work under M-D2B, following the exact precedent ADR-005 set for GitHub Pages: the decision here does not itself deploy anything, and G7 continues to halt unconditionally before any production action.
Related milestone: B4 (resolved by this decision); M-D2B (the workflow itself, not started by this change)
Evidence: `production` GitHub Actions environment (confirmed present via `gh api repos/Locker-r/dashboard/environments/production`, read-only, no secret values read); operator report of `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` present in that environment, not independently verifiable by an agent because `gh secret list` is denied unconditionally by this repository's own guard; release/backlog.json B4

## ADR-015 — Trigger and guardrail shape of the production Pages publishing workflow (M-D2B)

Decision ID: ADR-015
Date: 2026-08-08
Status: accepted
Context: ADR-014 named the deployment mechanism (Direct Upload via a GitHub Actions workflow invoking Wrangler) but explicitly left authoring that workflow, its trigger, and its guardrails to M-D2B. A publishing workflow that could run from an ordinary branch push, a manual dispatch, or a downloaded artifact from an unrelated run would make a tag no longer mean "reviewed, gated, and reproducible" (docs/release-governance.md, "What a tag means"), and would let a workflow deploy bytes nobody reviewed.
Decision: `.github/workflows/production-pages-deploy.yml` triggers only on `push` of a tag matching `vMAJOR.MINOR.PATCH` — no `workflow_dispatch`, no branch push, no `pull_request`, no `schedule`, no `workflow_run`/`workflow_call`. Before any build step, the job re-derives the same guarantee from first principles rather than trusting the trigger filter: `github.ref_type == 'tag'`, the tag name matches the semantic-version regex exactly, `git cat-file -t` confirms the tag is annotated, and the tagged commit is both an ancestor of `origin/main` and identical to `$GITHUB_SHA`. The artifact is built only from that checkout with the existing, unmodified `scripts/build-pages-artifact.cjs` — never downloaded from another commit or workflow run — and its manifest version is asserted to equal the tag's version before Wrangler is invoked. The job runs under the `production` GitHub environment (ADR-014) so GitHub's own environment protection rules are the human gate; it references `secrets.CLOUDFLARE_ACCOUNT_ID`/`secrets.CLOUDFLARE_API_TOKEN` by name only and fails closed if either is absent, and separately fails closed if the not-yet-existing `vars.PRODUCTION_SUPABASE_PROJECT_URL`/`vars.PRODUCTION_SUPABASE_PUBLISHABLE_KEY` are unset, since no production Supabase project has been created. The Wrangler invocation is pinned to project `dashboard-latam`, branch `main`, and an exact Wrangler CLI version; it never creates a project, mutates DNS or a custom domain, or connects a Git integration, and the returned deployment URL's host is checked against the pinned `dashboard-latam.pages.dev` domain to catch a per-deployment preview alias. The workflow verifies only that Wrangler succeeded and that the domain matches; it does not fetch or verify deployed content, roll back, or promote an alias — that is M-D2C.
Rejected alternatives: Trusting the `on.push.tags` filter alone without an in-job re-check (a workflow file change or a re-run against a moved ref could otherwise bypass it); adding `workflow_dispatch` for convenience (reintroduces exactly the ambiguous, un-reviewable trigger ADR-005 and the staging workflows already avoided by making dispatch require an exact-match confirmation input, which a tag push cannot provide); downloading the artifact built by an earlier CI run instead of rebuilding from the checkout (breaks the tagged-commit-to-bytes chain this design exists to hold); skipping the manifest/tag version cross-check (would let a stale or mismatched artifact deploy silently); doing the HTTP smoke/rollback verification here instead of leaving it to M-D2C (would blur the gate this milestone is scoped to stop at).
Consequences: M-D2B is implemented but not exercised — no tag has been pushed, the workflow has never run, and no production deployment has occurred. Deploying still requires a human to cut a release per docs/release-governance.md and push an annotated tag; only then does this workflow have anything to act on, and only after `production` environment approval does Wrangler run. M-D2C's scope (deployment verification, rollback rehearsal) is now unblocked to design against a concrete, merged workflow.
Related milestone: M-D2B (this change); M-D2C (deployment verification and rollback rehearsal, depends on this)
Evidence: `.github/workflows/production-pages-deploy.yml`; `tests/production-pages-deploy-workflow.test.cjs`; release/backlog.json M-D2B

## ADR-016 — Production rollback is roll-forward through the normal release flow

Decision ID: ADR-016
Date: 2026-08-09
Status: accepted
Context: M-D2C (docs/project-status.md "Deferred work: D2-C") needs a rollback design before it can rehearse one. ADR-015's production workflow triggers only on a tag push and gives Wrangler no subcommand beyond `pages project list` (read-only) and `pages deploy`; giving rollback a different, lighter-weight path — a Cloudflare deployment-id/alias mutation, a `workflow_dispatch` that redeploys an old tag, or a moved/re-pushed tag — would each either add a mutating surface this repository's guard otherwise refuses, or let rollback bypass the same `production` environment gate a forward deploy must clear, or make "what tag is actually live" ambiguous (`docs/release-governance.md` "Tags and releases are never deleted or moved").
Decision: Production rollback is roll-forward, through the exact flow every other release uses: revert the offending change through a normal, reviewed pull request; cut a new, higher `vMAJOR.MINOR.PATCH`; let `.github/workflows/production-pages-deploy.yml` deploy it, gated by the same `production` GitHub environment approval as any other release. `scripts/release/rollback-rehearsal.cjs` proves a candidate rollback target is usable — it is an annotated tag, an ancestor of `origin/main`, has its own recorded successful production deploy run, and rebuilds to the expected source-derived file hashes — and then only prints the human sequence above; it invokes no `wrangler` command, calls no Cloudflare API, and creates, moves, or pushes no tag. `scripts/verify-production-deployment.cjs` proves a given tag is actually live by comparing the manifest and files served at `dashboard-latam.pages.dev` against what that tag's commit and its own recorded deploy run would produce — using no credential of any kind, since everything it reads is public. Break-glass — a human using Cloudflare's own dashboard to roll back directly when production is broken and there is no time for the sequence above — remains entirely outside this repository's automation and must be reconciled afterward by a normal roll-forward release, so the live bytes correspond to a tag again.
Rejected alternatives: Automating Cloudflare deployment-id or alias rollback (adds a mutating Wrangler/API surface beyond the two subcommands ADR-015 already scoped, and makes the live site correspond to no tag, defeating `verify-production-deployment.cjs`'s manifest-based provenance check); adding `workflow_dispatch` with a tag input to redeploy an old tag (ADR-015 already rejected dispatch on this workflow for the identical reason — an old tag being redeployed makes "what is live" ambiguous, and reintroduces the un-reviewable trigger ADR-005 avoided); moving, re-pushing, or deleting a tag to "restore" a prior state (`docs/release-governance.md` already forbids this); giving rollback a weaker or bypassable gate than a forward deploy (defeats the point of the `production` environment approval).
Consequences: No new production-capable code path exists — rollback reuses the one gated workflow forward deploys already use. The rehearsal and verifier are fully testable and usable today with no production deployment yet on record: with none, the verifier fails closed with `NO_PRODUCTION_DEPLOYMENT_YET` rather than passing vacuously, and the rehearsal refuses any target with no successful deploy run of its own. `docs/release-governance.md`'s "Application code... There is no deployment step to undo" is superseded for the production Pages artifact specifically; it still holds for every other artifact this repository has no deployment step for.
Related milestone: M-D2C
Evidence: `scripts/verify-production-deployment.cjs`; `scripts/release/rollback-rehearsal.cjs`; `tests/production-deploy-verification.test.cjs`; `tests/rollback-rehearsal.test.cjs`; release/backlog.json M-D2C

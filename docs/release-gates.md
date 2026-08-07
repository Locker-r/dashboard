# Release gates

The gate ladder the autonomous release harness walks, what each rung proves,
who executes it, and where the ladder ends.

Print the live ladder with:

```bash
node scripts/release/release.cjs gates
```

The ladder in `scripts/release/release-core.cjs` is authoritative. This
document explains it; it does not define it.

## Classification

Every gate and every command carries one classification. The harness executes
only `read-only`.

| Classification | Meaning | Who may execute |
| --- | --- | --- |
| `read-only` | Observes state without changing it. | Harness, orchestrator, operator |
| `local-write` | Writes inside the working copy or a local service. | Operator |
| `production` | Changes a shared or published system, or grants authority over one. | Operator only, after G7 |
| `destructive` | Discards local state or data that is not trivially recoverable. | Operator only, with explicit per-run authorization |
| `unknown` | The classifier does not recognise it. Never executed by the harness or the orchestrator; the guard allows it interactively unless it is wrapped or encoded. | Operator |

`unknown` failing closed is deliberate. A command the harness cannot reason
about is not a command it may run.

## The ladder

| Gate | Name | Classification | Executor | Proves |
| --- | --- | --- | --- | --- |
| G0 | Repository context | read-only | harness | Package identity is `reactivation-desk-dashboard`; branch, HEAD, and working-tree state are known. |
| G1 | Backlog validation and task selection | read-only | harness | `release/backlog.json` validates, and exactly one next task is selected with a recorded reason for every exclusion. |
| G2 | Governance documents | read-only | harness | Every required governance document exists and is non-empty. |
| G3 | Static and unit gates | read-only | orchestrator | `npm test`, `check:js`, `check:secrets`, `check:migrations`, `check:project-status` all exit 0. |
| G4 | Deterministic artifact verification | local-write | operator | `npm run verify:release`: two byte-identical builds, independent validation, artifact secret scan. |
| G5 | Local runtime verification | read-only | operator | `npm run verify:runtime` against a running local stack. Needs Docker; the harness never starts it. |
| G5b | Acceptance evidence | read-only | harness | Every acceptance criterion of the selected task passed against this exact HEAD. |
| G6 | Human production approval | read-only | harness | A valid approval record exists for the selected task and names the verified HEAD. |
| G7 | Production gate | production | operator | Nothing. It halts. |

G3 is executed by the PowerShell orchestrator in `-Mode Verify`, never by the
Node planner. G4 and G5 are left to the operator: G4 writes into `artifacts/`,
and G5 requires a runtime the harness is forbidden from starting.

## G5b: acceptance evidence

A task is `in-review` when its code exists and its claim does not. G5b is what
keeps those two facts apart.

It reads `release/verification/<taskId>.evidence.json` and passes only when
every `acceptanceCriteria` entry in `release/backlog.json` appears there with
`status: "passed"`, `exitCode: 0`, and a `headSha` equal to the HEAD that G0
verified. Refusal codes:

| Code | Meaning |
| --- | --- |
| `ACCEPTANCE_EVIDENCE_ABSENT` | Nothing has been verified yet. This is the normal state of freshly landed work. |
| `ACCEPTANCE_EVIDENCE_MALFORMED` | The file is not JSON. |
| `ACCEPTANCE_EVIDENCE_INVALID` | Wrong schema version, or recorded for another task. |
| `ACCEPTANCE_EVIDENCE_STALE` | Recorded against a different commit, and product-relevant code changed since. |
| `ACCEPTANCE_CRITERIA_UNPROVEN` | A stated criterion is missing, did not pass, does not name the criterion's command, or reports no detail. |
| `ACCEPTANCE_WORKTREE_DIRTY` | A tracked, product-relevant file is modified but uncommitted. Evidence attests to committed code. |

Evidence does **not** have to name the current HEAD exactly. It is pinned to
the tested product code, not to the literal commit id: the gate accepts a
different commit only when every path that changed between the two is
**drift-allowed** — documentation, canonical status, release governance and
harness tooling, or the evidence/approval directories themselves
(`isEvidenceDriftAllowed` in `scripts/release/release-core.cjs`: `docs/`,
`.claude/`, `scripts/release/`, `.github/`, `release/`, `AGENTS.md`,
`CLAUDE.md`, `README.md`, `CHANGELOG.md`, and the harness's own
`tests/release-harness.test.cjs`, which no backlog criterion runs). This is an allow-list, not a
deny-list — anything else (`src/`, `supabase/`, `tests/`, `scripts/` other than
`scripts/release/`, and so on) is product-relevant by default and makes
evidence stale. The same allow-list governs `ACCEPTANCE_WORKTREE_DIRTY`: an
uncommitted edit to a drift-allowed path — a docs fix, a status update — does
not dirty the gate; an uncommitted edit to product code does.

A status-only commit — updating `docs/project-status.md`, fixing a typo in
`docs/release-plan.md`, editing `AGENTS.md` — does not force B1 or B2 back into
`ACCEPTANCE_EVIDENCE_STALE`. Evidence surviving its own commit (writes under
`release/verification/`) is the special case of the same general rule, not a
separate exception: without some such rule the record would be impossible to
store, because committing the evidence itself moves HEAD.

If a criterion's own command changes — someone edits
`acceptanceCriteria[].command` in `release/backlog.json` — that is caught
independently at the criterion level: the evidence's recorded `command` is
compared against the **current** backlog's criterion command, not the one in
force when the evidence was written, so a changed criterion reports
`ACCEPTANCE_CRITERIA_UNPROVEN` regardless of what the commit-drift check
decides.

What the gate can and cannot do: it checks that each criterion is recorded as
passed, with exit code 0, naming that criterion's command and a non-empty
detail, against code that has not changed. It cannot re-run a criterion that
needs a live Supabase stack, so it cannot detect a determined fabrication — only
a re-run can. It converts a silent omission into an explicit written claim, and
that is the honest limit of it.

Unlike an approval, an agent **may** write evidence — because evidence is
falsifiable. It names a commit and a set of commands, and anyone can re-run
them. An approval is a person accepting consequences, and no re-run can
substitute for that. `release/verification/README.md` states the distinction in
full.

G5b blocking is not a defect. It means the next operation is verification, and
the harness says so rather than proceeding.

## Content rules: changes that are not commands

Some dangerous changes are two words inside a migration rather than a command
line. `classifySecurityContent` reads proposed file content and the guard hook
refuses these in every mode, release run or not:

| Code | Refuses | Applies to |
| --- | --- | --- |
| `RLS_DISABLED` | Turning row-level security off | `supabase/`, `*.sql`, inline SQL in a command |
| `STORAGE_POLICY_DROPPED_WITHOUT_REPLACEMENT` | Dropping a `storage.objects` policy with no replacement | same |
| `PUBLIC_PROOF_BUCKET` | Making a storage bucket public | same |
| `SERVICE_ROLE_KEY_IN_BROWSER_CODE` | An elevated key value in browser-delivered code | `index.html`, `src/`, `config/`, `vendor/` |

Each rule is scoped to where its text would take effect. A fixture in `tests/`
or a quotation in `docs/` changes no database and ships to no browser, so the
rules deliberately do not fire there — the same exemption the repository's own
secret scan already makes. A rule that fires on its own documentation gets
switched off by the first person it inconveniences.

The rules read `content`, `new_string`, and `edits[].new_string`, so `Write`,
`Edit`, and `MultiEdit` are covered alike; inline SQL passed to a client on the
command line is scanned too.

## G6: the approval record

An approval lives at `release/approvals/<taskId>.approval.json` and is written
by a human. `release/approval.example.json` is the template. Required fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`. |
| `taskId` | Must equal the selected task id. |
| `approvedBy` | The person accepting responsibility. |
| `approvedAt` | ISO-8601 timestamp. |
| `scope` | What is authorized, in plain words. |
| `headSha` | The exact commit the approval covers. A different HEAD invalidates it. |

Absence is the normal state and produces `APPROVAL_ABSENT`. Malformed,
incomplete, mismatched-task, and mismatched-HEAD records are refused with their
own codes rather than being repaired.

No agent may create, edit, or delete a file under `release/approvals/`. That
denial is unconditional: it applies in every mode, with every flag, and is
enforced independently by `.claude/settings.json` permissions and by
`.claude/hooks/release-guard.cjs`.

## G7: the production gate

G7 always halts with `HALTED_AT_PRODUCTION_GATE`. It lists, without performing,
the production actions that the selected task would eventually require. For the
current backlog those are:

- `npx supabase db push`
- `npx supabase functions deploy team-management`
- publishing `artifacts/pages-site/` to the chosen host
- `git tag -a <version> -m <version>` and `git push origin <version>`

The halt does not depend on the approval record. An approval authorizes a
*human* to proceed; it never converts the harness into an executor.

## Recognised production and destructive commands

`classifyCommand` recognises these families. The list is enforced in code and
tested in `tests/release-harness.test.cjs`.

**Production:** `git push` to `main`/`master`/`HEAD`, a remote other than `origin`, or with no explicit target; `git push --force|-f|--force-with-lease|--force-if-includes`, `--all|--mirror|--prune`, `--tags|--follow-tags`, `--delete|-d`, `--no-verify`, or a `+`/`:`-prefixed refspec; any refspec whose destination is `refs/tags/…` or version-shaped (`v1.2.0`); `git tag` (except `--list`); `git remote add|set-url|remove|rename`; `gh release|workflow|secret|variable` mutations; `gh auth login|logout|refresh|setup-git`; `gh pr close|edit|comment|review|ready`; `gh pr merge` with `--admin`, `--force`, `--merge`, or `--rebase`, or with no method flag at all; `gh run cancel|rerun|delete`; `gh repo delete|edit|archive|rename|create|fork|clone`; `gh gist create|delete|edit|rename`; `gh issue create|close|edit|comment|delete`; `gh api` with a mutating method (`-X`/`--method`, either form) or field; `supabase db push`; `supabase functions deploy`; `supabase secrets set|unset`; `supabase login`; `supabase projects delete|pause|restore|transfer`; `supabase link` or `supabase projects create` outside the one scoped exception below; `npm publish|unpublish|deploy|dist-tag|owner|access|token`; `docker push`; `terraform apply|destroy|import|taint`; and the hosting CLIs `vercel`, `netlify`, `wrangler`, `firebase`, `fly`, `gcloud`, `aws`, `az`, `heroku`, `kubectl`, `helm`, `surge`, `railway`, `render`, `pulumi`, `serverless`.

**Destructive:** `git reset --hard`; `git clean`; `git filter-branch|filter-repo`; `supabase db reset`; `npm run smoke`; `npm run verify:runtime -- --allow-reset`; `rmdir`; and `rm`/`del`/`Remove-Item` in their sweeping forms — recursive, wildcard, or directory targets. Removing one named file is `local-write`, because a guard that refuses routine cleanup gets switched off and then protects nothing.

Wrappers do not hide any of these. Every segment of a wrapper payload is
classified, not just the first, and the least safe result wins: `bash -c "npm
test && git push origin main"` is `production`, as is the same command inside
`cmd /c`, `powershell -Command`, a pipeline, after an environment-variable
prefix, behind `npx --yes`, `sudo -u root`, or `nice -n 10`, and with a global
flag between the command and its subcommand (`supabase --workdir . db push`).

## The one scoped exception: staging project provisioning

`supabase projects create` and `supabase link` are allowed, but only for
exactly one project: name `dashboard-latam-staging` in organization
`iivhkhxodnoypvfeucob`, with no flag outside
`--org-id`/`--db-password`/`--region`/`--output`/`-o`/`--help` — no `--plan`,
`--size`, `--custom-domain`, or add-on flag. A different name, a different
org, or any other flag falls back to `production`
(`SUPABASE_PROJECT_CREATE_NAME_MISMATCH`, `_ORG_MISMATCH`,
`_DISALLOWED_FLAG`). `supabase link --project-ref hywpwutykwrxkddnofrh` — the
one existing, already-provisioned project — stays `production`
(`SUPABASE_LINK_EXISTING_PROJECT_BLOCKED`) by name, not by inference; a bare
`supabase link` with no ref is `SUPABASE_LINK_AMBIGUOUS_TARGET`.

The classifier cannot see which ref Supabase actually assigns the new
project — refs are opaque, not derivable from the name — so linking to any
*other* ref classifies `local-write`. Confirming the created project's
returned name and organization before running `link` is a procedural step the
operator performs, the same limitation already documented above for `gh pr
merge` and live CI state. Extending this exception to a second project or
organization needs a new, equally explicit scoped authorization — not a
loosened pattern.

## The scoped exception: staging database migration

`supabase db push` is `production` in every form and remains so — bare, with
`--dry-run`, with an explicit `--db-url`, under `npx`, or behind a global flag.
Nothing below relaxes `SUPABASE_DB_PUSH`.

What is authorized is one wrapper, `scripts/release/staging-db-migrate.cjs`,
invoked as exactly `node scripts/release/staging-db-migrate.cjs --dry-run` or
`--apply`, and only when `GITHUB_ACTIONS=true` and
`RELEASE_ENVIRONMENT=staging`. That form classifies `local-write`
(`STAGING_DB_MIGRATION_AUTHORIZED`). Every other case is `production`:

- run anywhere but GitHub Actions — `STAGING_DB_MIGRATION_LOCAL_EXECUTION_BLOCKED`;
- any other release environment — `STAGING_DB_MIGRATION_ENVIRONMENT_MISMATCH`;
- any other argument shape, or any invocation that had to be unwrapped from
  `cmd /c`, a shell, `npx --yes`, a pipeline, or an environment-variable
  prefix — `STAGING_DB_MIGRATION_UNAUTHORIZED_FORM`. The exception matches raw
  tokens, so an evasion is never the authorized command.

The wrapper pins its target and holds no configuration surface: project ref
`cjdxtakgmnzwixrajjry`, host `aws-1-eu-west-3.pooler.supabase.com`, port
`5432`, database `postgres`, environment `staging`. It builds the
percent-encoded connection URL in process memory only, registers a mask for
the password and the URL before the CLI starts, and never writes either to a
log or to disk. It re-checks every precondition at run time; the classifier is
the outer half of the pair, not a substitute for it.

This authorizes staging only. It grants nothing in production, deploys no Edge
Function and no frontend, and does not alter gate G6 or G7 — a production
release still halts for a human approval record. Extending this to a second
project, host, port, database, or environment needs its own reviewed
authorization, not a loosened pattern.

## The scoped exception: staging Edge Function deployment

`supabase functions deploy` is `production` in every form and remains so.
Nothing below relaxes `SUPABASE_FUNCTIONS_DEPLOY`.

What is authorized is one wrapper, `scripts/release/staging-functions-deploy.cjs`,
invoked as exactly `node scripts/release/staging-functions-deploy.cjs --function <name>`,
where `<name>` is one the wrapper itself allowlists (`TARGET.functions`,
currently only `team-management` — the one function the running app calls, at
`src/team-admin.js`), and only when `GITHUB_ACTIONS=true` and
`RELEASE_ENVIRONMENT=staging`. That form classifies `local-write`
(`STAGING_FUNCTIONS_DEPLOY_AUTHORIZED`). Every other case is `production`:

- run anywhere but GitHub Actions — `STAGING_FUNCTIONS_DEPLOY_LOCAL_EXECUTION_BLOCKED`;
- any other release environment — `STAGING_FUNCTIONS_DEPLOY_ENVIRONMENT_MISMATCH`;
- any other argument shape, or any invocation that had to be unwrapped from
  `cmd /c`, a shell, `npx --yes`, a pipeline, or an environment-variable
  prefix — `STAGING_FUNCTIONS_DEPLOY_UNAUTHORIZED_FORM`.

The wrapper pins the project ref (`cjdxtakgmnzwixrajjry`) and the function
allowlist; the classifier authorizes the invocation shape, the wrapper is the
one source of truth for which function names that shape may carry, and it
refuses (`EXIT.USAGE`) any name outside `TARGET.functions` before touching the
CLI. It reads `SUPABASE_ACCESS_TOKEN` from the environment only, registers a
mask for it before the CLI starts, and never writes it to a log or to disk.

This wrapper is added by this change; nothing has deployed through it yet.
Authorizing the path is a policy decision, separate from and prior to using
it. It authorizes staging only, grants nothing in production, configures no
frontend hosting, and does not alter gate G6 or G7. Extending this to a
second project or a function outside the wrapper's own allowlist needs its
own reviewed authorization, not a loosened pattern.

## Frontend hosting: GitHub Pages, staging/pilot only

The Product Owner approved GitHub Pages as the staging/pilot frontend host
for this repository. **Production hosting remains undecided and is not
authorized by this section or any other.** The canonical staging URL is
`https://locker-r.github.io/dashboard/`, read from `GET
/repos/Locker-r/dashboard/pages` — not guessed, not assumed from the repo
name.

Publishing to Pages happens entirely inside a reviewed GitHub Actions
workflow using the official `actions/configure-pages` /
`actions/upload-pages-artifact` / `actions/deploy-pages` actions with
`pages: write` permission scoped to that workflow's job. Those are `uses:`
steps run by the workflow's own token, not commands this repository's
classifier evaluates — authorizing that publishing path is authoring the
workflow file itself, a reviewed code change like any other, exactly as
`staging-db-migrate.yml` and `staging-functions-deploy.yml` were. This
document records the policy; the workflow that exercises it is a separate,
later change, and this change does not add one.

What stays refused, unconditionally: any *ad hoc* mutation of repository
Pages settings outside that workflow — `gh api -X PUT
repos/Locker-r/dashboard/pages` and equivalents remain `GH_API_MUTATION`
(`production`), enabling Pages for a different repository, a custom domain,
and disabling or deleting the Pages site.

## The scoped exception: staging Auth URL configuration

Supabase's Auth Site URL and redirect allowlist have no `supabase` CLI
subcommand; they are mutated through the Supabase Management API. There is
therefore no generic `SUPABASE_*` command family to keep `production` the
way `db push` and `functions deploy` are — `scripts/release/staging-auth-config.cjs`
is the only thing in this repository capable of this mutation at all.

The wrapper is authorized as exactly `node
scripts/release/staging-auth-config.cjs --dry-run` or `--apply`, only when
`GITHUB_ACTIONS=true` and `RELEASE_ENVIRONMENT=staging`
(`STAGING_AUTH_CONFIG_AUTHORIZED`, `local-write`). Every other case is
`production`: local execution
(`STAGING_AUTH_CONFIG_LOCAL_EXECUTION_BLOCKED`), any other release
environment (`STAGING_AUTH_CONFIG_ENVIRONMENT_MISMATCH`), or any other
argument shape or unwrapped invocation
(`STAGING_AUTH_CONFIG_UNAUTHORIZED_FORM`).

The wrapper pins everything itself and accepts no configuring argument:
project ref `cjdxtakgmnzwixrajjry`, Site URL
`https://locker-r.github.io/dashboard/` exactly, and a redirect allowlist
containing that same single exact URL and nothing else — no wildcard, no
second entry. The app has no OAuth, magic-link, or password-reset redirect
flow today (`src/supabase-auth-service.js` calls only
`signInWithPassword`), so a wildcard or a broader allowlist is not something
"existing application behavior strictly requires," and none is authorized.
`--dry-run` only reads the current configuration and reports whether it
already matches; only `--apply` writes. `SUPABASE_ACCESS_TOKEN` is read from
the environment only, masked before any network call, and never logged.

This authorizes staging only. It grants nothing in production, touches no
other Supabase project, and does not alter gate G6 or G7. Extending this to
a second project, a different Site URL, or an additional redirect entry
needs its own reviewed authorization, not a loosened pattern.

## The scoped exception: staging team-management CORS origin

`supabase secrets set`/`unset` are `production` in every other form
(`SUPABASE_SECRETS_MUTATION`). What is authorized is one wrapper,
`scripts/release/staging-team-origin-config.cjs`, invoked as exactly
`--dry-run` or `--apply`, only when `GITHUB_ACTIONS=true` and
`RELEASE_ENVIRONMENT=staging` (`STAGING_TEAM_ORIGIN_CONFIG_AUTHORIZED`,
`local-write`). Every other case is `production`: local execution
(`STAGING_TEAM_ORIGIN_CONFIG_LOCAL_EXECUTION_BLOCKED`), any other release
environment (`STAGING_TEAM_ORIGIN_CONFIG_ENVIRONMENT_MISMATCH`), or any
other argument shape (`STAGING_TEAM_ORIGIN_CONFIG_UNAUTHORIZED_FORM`).

Why this exists: `supabase/functions/team-management/index.ts` checks the
request's `Origin` header against the `TEAM_ALLOWED_ORIGIN` Edge Function
secret and refuses the CORS preflight (`403 ORIGIN_FORBIDDEN`) unless it
matches exactly. Confirmed against the live staging function on 2026-08-07:
an `OPTIONS` request with `Origin: https://locker-r.github.io` returned
`403 ORIGIN_FORBIDDEN`, meaning the secret is unset or set to something
else — the admin cashier-management flow cannot work from the deployed
staging site until it is set. The function's own origin check is correct;
this is a configuration gap, not a code defect.

The wrapper pins everything itself and accepts no configuring argument:
project ref `cjdxtakgmnzwixrajjry`, secret name `TEAM_ALLOWED_ORIGIN`, value
`https://locker-r.github.io` exactly. `--dry-run` only lists current secret
*names* (`supabase secrets list` never prints values) and reports whether
`TEAM_ALLOWED_ORIGIN` is already present; only `--apply` writes.

This authorizes staging only. It grants nothing in production, sets no
other secret, and does not alter gate G6 or G7. Extending this to a second
project, secret name, or value needs its own reviewed authorization, not a
loosened pattern.

## What push and PR automation are actually allowed

`git push` is not one action; "update my feature branch" and "force-rewrite
main" share a verb and nothing else. `classifyGitPush` in
`scripts/release/release-core.cjs` allows exactly one shape: an explicit,
unambiguous push of a single ordinary branch to the remote named `origin`,
carrying none of the flags listed above as production. `git push origin
feat/x`, `git push -u origin feat/x`, and `git push origin HEAD:feat/x` are
`local-write`. A bare `git push`, a push with no refspec, or a push to any
remote other than `origin` is refused as `GIT_PUSH_AMBIGUOUS_TARGET` — the
classifier cannot verify an unnamed or non-`origin` destination is safe, so it
does not guess.

`gh pr create` is `local-write`: it opens a request for review and changes no
branch. `gh pr merge` is `local-write` only with `--squash` and none of
`--admin`, `--force`, `--merge`, `--rebase` — matching
[`release-governance.md`](release-governance.md)'s "Squash merge. One pull
request becomes one commit on `main`." **This classifier cannot see live CI
state.** Whether the required checks named in
[`quality-gates.yml`](../.github/workflows/quality-gates.yml) have actually
passed is enforced by GitHub's branch protection on the server, not by this
text-only guard — confirm with `gh pr checks` before merging. `gh pr checks`,
`gh pr status`, `gh pr view`, `gh pr list`, and `gh run list|view|watch` are
`read-only`. `gh run cancel|rerun|delete` are `production`: re-running or
cancelling a workflow can re-trigger whatever that workflow does.

`unknown` is allowed for a plain unrecognised command — refusing everything the
classifier does not know would make the guard unusable. It is refused when it
appears **inside a shell wrapper** or an encoded payload, which is the shape of
a smuggling attempt rather than of ordinary work.

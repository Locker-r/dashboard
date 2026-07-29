# Supabase runtime smoke tests

The harness validates the real Auth, RPC, and RLS path with three dedicated accounts: one administrator, agent A, and agent B. It creates two players for a unique run, assigns one to each agent, exercises the allowed and denied paths, and removes the run's players in `finally`.

It never targets the previously created player or any record without the exact current-run marker. The production schema does not include the smoke cleanup helper.

## Safety model

- Every account email must start with `smoke_test` and all three accounts must be distinct.
- Every player ID starts with `SMOKE_TEST_<run_id>_`; `run_id` is 12–40 lowercase letters/digits.
- Every player has a unique messenger contact beginning with `SMOKE_TEST:<run_id>:`; the final suffix distinguishes the two rows without defeating contact-duplicate protection.
- Writes require `SMOKE_TEST_WRITE_CONFIRMATION=I_UNDERSTAND_SMOKE_TEST_WRITES`.
- The configured URL must exactly equal `SMOKE_TEST_ALLOWED_PROJECT_URL`.
- Local mode accepts only loopback HTTP URLs.
- Staging requires HTTPS `*.supabase.co` plus `SMOKE_TEST_STAGING_CONFIRMATION=STAGING_ONLY_NOT_PRODUCTION`.
- Cleanup requires admin Auth, exact run ID, `DELETE_SMOKE_TEST_<run_id>`, marker-prefix equality, ID-prefix equality, and `created_by` equality. It deletes only matched `players`; child comments/history disappear through existing cascades.
- Passwords and keys are environment variables. The scripts never print them.

## Local mode (preferred)

Requirements: Docker and the project-scoped Supabase CLI installed by `npm ci`. The committed local migrations reproduce the foundation, atomic RPCs, and smoke-only cleanup RPC. The local stack is never linked to a remote project.

Set three passwords in the current PowerShell session:

```powershell
$env:SMOKE_TEST_ADMIN_PASSWORD = '<local-only password>'
$env:SMOKE_TEST_AGENT_A_PASSWORD = '<local-only password>'
$env:SMOKE_TEST_AGENT_B_PASSWORD = '<local-only password>'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LocalRuntimeSmokeTest.ps1
```

The wrapper starts local Supabase, runs `supabase db reset --local`, captures local-only keys without displaying them, provisions the three fixture accounts, runs the test, and clears the service key from its process. Optional `-RunId abc123def456` makes a run reproducible.

## Dry-run and configuration checks

Dry-run validates mode, URL allowlist, opt-in, and run ID without credentials or writes:

```powershell
$env:SMOKE_TEST_MODE = 'local'
$env:SMOKE_TEST_PROJECT_URL = 'http://127.0.0.1:54321'
$env:SMOKE_TEST_ALLOWED_PROJECT_URL = $env:SMOKE_TEST_PROJECT_URL
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-RuntimeSmokeTest.ps1 -DryRun -RunId abc123def456
```

After setting all required variables, validate them without signing in:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-RuntimeSmokeConfig.ps1 -RunId abc123def456
```

## Dedicated staging mode

Do not use production. Create a separate staging Supabase project and three dedicated prefixed Auth users/profiles. Apply `schema.sql`, `atomic-writes.sql`, and the staging-only `smoke-test-harness.sql` there. Set these variables only in the current shell:

- `SMOKE_TEST_MODE=staging`
- `SMOKE_TEST_PROJECT_URL` and the identical `SMOKE_TEST_ALLOWED_PROJECT_URL`
- `SMOKE_TEST_STAGING_CONFIRMATION=STAGING_ONLY_NOT_PRODUCTION`
- `SMOKE_TEST_WRITE_CONFIRMATION=I_UNDERSTAND_SMOKE_TEST_WRITES`
- `SMOKE_TEST_PUBLISHABLE_KEY`
- `SMOKE_TEST_ADMIN_EMAIL`, `SMOKE_TEST_ADMIN_PASSWORD`
- `SMOKE_TEST_AGENT_A_EMAIL`, `SMOKE_TEST_AGENT_A_PASSWORD`
- `SMOKE_TEST_AGENT_B_EMAIL`, `SMOKE_TEST_AGENT_B_PASSWORD`

No service-role credential is used in staging. Run `Invoke-RuntimeSmokeTest.ps1` only after `Test-RuntimeSmokeConfig.ps1` succeeds.

## Emergency cleanup

Cleanup is scoped to one run and uses the same URL, allowlist, opt-ins, publishable key, and admin credentials:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Remove-RuntimeSmokeRun.ps1 -RunId abc123def456
```

The command cannot delete the earlier manually created player because its ID, marker, run ID, and `created_by` tuple cannot satisfy the cleanup predicate.

## Automated scenarios

The harness checks admin and both agent logins, creation of exactly two players, assignment, agent visibility of the assigned player, invisibility and mutation denial for the other player's data, an allowed `assigned -> in_work` transition, exactly one matching history row, a comment, follow-up persistence, invalid-transition rejection, admin visibility, duplicate rejection, and post-cleanup absence.

Regular CI runs only unit and structural safety checks. It receives no Supabase credentials and performs no runtime writes. Before a production release, staging results and the target project's migration review remain manual release evidence.

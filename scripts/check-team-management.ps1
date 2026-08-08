$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $root 'supabase\migrations\20260729000400_team_management.sql'
$agentMigration = Join-Path $root 'supabase\migrations\20260805000200_agent_management.sql'
$edge = Join-Path $root 'supabase\functions\team-management\index.ts'
$doc = Join-Path $root 'docs\team-management.md'
foreach ($path in @($migration, $agentMigration, $edge, $doc)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing team-management artifact: $path" }
}
$sql = Get-Content -LiteralPath $migration -Raw
$agentSql = Get-Content -LiteralPath $agentMigration -Raw
$source = Get-Content -LiteralPath $edge -Raw
foreach ($script in @($sql, $agentSql)) {
  if ($script -notmatch 'grant execute on function[\s\S]+to service_role') { throw 'Team RPCs are not granted to service_role.' }
  if ($script -match 'grant execute on function[\s\S]+to authenticated') { throw 'Team RPCs must not be granted to authenticated.' }
}
if ($source -match 'console\.(log|error)') { throw 'Unsafe Edge Function logging found.' }
if ($source -notmatch 'auth\.getUser' -or $source -notmatch "role !== 'admin'") { throw 'JWT/admin authorization guard missing.' }
if ($source -match 'resend-invitation') { throw 'Unsafe resend invitation route found.' }

# Auth-user deletion is permitted for exactly one purpose: compensating a
# create-member request whose profile insert failed, so the request never leaves
# an Auth user without a profile. It must never become a reachable operation.
# The rule below is therefore about reachability, not about the identifier: at
# most one call site, matching the compensation statement exactly, and no action
# name through which a caller could ask for a deletion.
$deleteCalls = [regex]::Matches($source, 'deleteUser')
if ($deleteCalls.Count -gt 1) { throw 'Auth user deletion appears more than once; only the create-member compensation is allowed.' }
if ($deleteCalls.Count -eq 1 -and $source -notmatch [regex]::Escape('const removal = await admin.auth.admin.deleteUser(createdUser.id);')) {
  throw 'Auth user deletion is not the approved create-member compensation call.'
}
$actionsLine = [regex]::Match($source, 'const ACTIONS = new Set\(\[(?<body>[^\]]*)\]\)')
if (-not $actionsLine.Success) { throw 'Could not locate the Edge Function action allowlist.' }
if ($actionsLine.Groups['body'].Value -match 'delete|remove|destroy|purge') { throw 'A destructive action name is exposed in the allowlist.' }

# The temporary password must reach the Auth admin API and nothing else.
if ($source -match 'temporaryPassword[^\n]*(profiles|p_name|p_username|details)') { throw 'Temporary password reaches a profile write.' }

# Audit history is retire-not-erase by construction, not by convention: the
# foreign keys must restrict deletion of an audited profile, and no role --
# not even service_role, which this project always grants per-table and
# never by default -- may hold DELETE (or ALL) on the audit table itself.
# These are static facts about the tracked migration, the same ones the
# runtime smoke suites (local and staging) exercise dynamically.
if ($sql -notmatch 'actor_id\s+uuid\s+not\s+null\s+references\s+public\.profiles\(id\)\s+on\s+delete\s+restrict') {
  throw 'admin_audit_events.actor_id must reference profiles(id) ON DELETE RESTRICT.'
}
if ($sql -notmatch 'target_user_id\s+uuid\s+references\s+public\.profiles\(id\)\s+on\s+delete\s+restrict') {
  throw 'admin_audit_events.target_user_id must reference profiles(id) ON DELETE RESTRICT.'
}
if ($sql -match 'grant\s+(all|delete)[\s\S]{0,120}?on\s+public\.admin_audit_events') {
  throw 'admin_audit_events must not grant DELETE or ALL to any role.'
}
if ($sql -match 'on\s+public\.admin_audit_events\s+to\s+service_role') {
  throw 'service_role must not be granted any privilege on admin_audit_events.'
}

Write-Output 'Team management SQL and Edge Function structure checks passed.'

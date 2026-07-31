$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $root 'supabase\migrations\20260729000400_team_management.sql'
$edge = Join-Path $root 'supabase\functions\team-management\index.ts'
$doc = Join-Path $root 'docs\team-management.md'
foreach ($path in @($migration, $edge, $doc)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing team-management artifact: $path" }
}
$sql = Get-Content -LiteralPath $migration -Raw
$source = Get-Content -LiteralPath $edge -Raw
if ($sql -notmatch 'grant execute on function[\s\S]+to service_role') { throw 'Team RPCs are not granted to service_role.' }
if ($sql -match 'grant execute on function[\s\S]+to authenticated') { throw 'Team RPCs must not be granted to authenticated.' }
if ($source -match 'console\.(log|error)' -or $source -match 'deleteUser') { throw 'Unsafe Edge Function logging or deletion found.' }
if ($source -notmatch 'auth\.getUser' -or $source -notmatch "role !== 'admin'") { throw 'JWT/admin authorization guard missing.' }
if ($source -match 'resend-invitation') { throw 'Unsafe resend invitation route found.' }
Write-Output 'Team management SQL and Edge Function structure checks passed.'

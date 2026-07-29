$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$migration = Join-Path $root 'supabase\atomic-writes.sql'
$verification = Join-Path $root 'supabase\verify-atomic-writes.sql'
foreach ($path in @($migration, $verification)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing required SQL file: $path" }
  $content = Get-Content -LiteralPath $path -Raw
  if ($content -match '(?i)service_role|supabase_service|secret[_-]?key') { throw "Potential secret-bearing identifier in $path" }
}
$sql = Get-Content -LiteralPath $migration -Raw
if ($sql -notmatch '(?is)^--.*\bbegin;.*commit;\s*$') { throw 'Migration must be wrapped in one explicit transaction.' }
$names = @('create_players_atomic','assign_players_atomic','change_player_status_atomic','add_player_comment_atomic','set_player_follow_up_atomic')
foreach ($name in $names) {
  if (($sql | Select-String -Pattern "create or replace function public\.$name" -AllMatches).Matches.Count -ne 1) { throw "Expected exactly one definition for $name" }
}
Write-Host 'Atomic write SQL safety and structure checks passed.'

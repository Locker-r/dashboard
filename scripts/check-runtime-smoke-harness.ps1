$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sql = Get-Content -LiteralPath (Join-Path $root 'supabase\smoke-test-harness.sql') -Raw
foreach ($required in @('cleanup_smoke_test_run_atomic','SMOKE_TEST_','created_by = v_actor.id','DELETE_SMOKE_TEST_')) {
  if (-not $sql.Contains($required)) { throw "Smoke cleanup SQL is missing: $required" }
}
if (($sql | Select-String -Pattern '(?i)delete\s+from' -AllMatches).Matches.Count -ne 1) { throw 'Smoke cleanup must contain exactly one DELETE statement.' }
if ($sql -match '(?i)delete\s+from\s+public\.(profiles|player_comments|player_status_history)') { throw 'Smoke cleanup may delete only marked players and rely on cascades.' }
$pairs = @(
  @('supabase\schema.sql','supabase\migrations\20260729000100_dashboard_foundation.sql'),
  @('supabase\atomic-writes.sql','supabase\migrations\20260729000200_atomic_writes.sql'),
  @('supabase\smoke-test-harness.sql','supabase\migrations\20260729000300_smoke_test_harness.sql')
)
foreach ($pair in $pairs) {
  $left = (Get-Content -LiteralPath (Join-Path $root $pair[0]) -Raw).Replace("`r`n","`n").TrimEnd()
  $right = (Get-Content -LiteralPath (Join-Path $root $pair[1]) -Raw).Replace("`r`n","`n").TrimEnd()
  if ($left -cne $right) { throw "Local migration drift: $($pair[1])" }
}
Write-Host 'Runtime smoke harness structure checks passed.'

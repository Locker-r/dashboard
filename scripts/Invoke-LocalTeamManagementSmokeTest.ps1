param([string]$RunId = ('team' + [guid]::NewGuid().ToString('N').Substring(0,16)))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LocalRuntimeSmokeTest.ps1 -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw 'Base local runtime smoke test failed.' }
  $ErrorActionPreference = 'Continue'
  $statusLines = & npx.cmd supabase status -o env 2>$null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read local Supabase status.' }
  $values = @{}
  foreach ($line in $statusLines) { if ($line -match '^([A-Z_]+)="?(.*?)"?$') { $values[$matches[1]]=$matches[2].TrimEnd('"') } }
  if (-not $values.API_URL -or -not $values.ANON_KEY) { throw 'Local Supabase status is incomplete.' }
  $env:SMOKE_TEST_PROJECT_URL=$values.API_URL; $env:SMOKE_TEST_PUBLISHABLE_KEY=$values.ANON_KEY
  if (-not $env:SMOKE_TEST_ADMIN_EMAIL) { $env:SMOKE_TEST_ADMIN_EMAIL='smoke_test_admin@local.invalid' }
  if (-not $env:SMOKE_TEST_AGENT_A_EMAIL) { $env:SMOKE_TEST_AGENT_A_EMAIL='smoke_test_agent_a@local.invalid' }
  if (-not $env:SMOKE_TEST_AGENT_B_EMAIL) { $env:SMOKE_TEST_AGENT_B_EMAIL='smoke_test_agent_b@local.invalid' }
  & node .\scripts\team-management-smoke.cjs $RunId
  if ($LASTEXITCODE -ne 0) { throw 'Team management runtime smoke test failed.' }
} finally {
  Remove-Item Env:SMOKE_TEST_PUBLISHABLE_KEY -ErrorAction SilentlyContinue
  Pop-Location
}

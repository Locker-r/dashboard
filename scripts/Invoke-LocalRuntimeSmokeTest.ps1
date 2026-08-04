param([string]$RunId)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  foreach ($name in @('SMOKE_TEST_ADMIN_PASSWORD','SMOKE_TEST_AGENT_A_PASSWORD','SMOKE_TEST_AGENT_B_PASSWORD')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing environment variable: $name" }
  }
  if ($env:SMOKE_TEST_REQUIRE_ALREADY_RUNNING -eq '1') {
    $ErrorActionPreference = 'Continue'
    $preflightStatus = & npx.cmd supabase status -o env 2>$null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Local Supabase stopped before reset; automatic startup is disabled for this run.' }
    $preflightValues = @{}
    foreach ($line in $preflightStatus) { if ($line -match '^([A-Z_]+)="?(.*?)"?$') { $preflightValues[$matches[1]] = $matches[2].TrimEnd('"') } }
    if ($preflightValues.API_URL -ne 'http://127.0.0.1:54321') { throw 'Local Supabase reported a noncanonical API URL before reset.' }
  } else {
    $ErrorActionPreference = 'Continue'
    $null = & npx.cmd supabase start -x realtime,storage-api,imgproxy,postgres-meta,studio,logflare,vector,supavisor 2>&1
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Local Supabase failed to start.' }
  }
  $ErrorActionPreference = 'Continue'
  $null = & npx.cmd supabase db reset --local --no-seed 2>&1
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw 'Local Supabase database reset failed.' }

  $ErrorActionPreference = 'Continue'
  $statusLines = & npx.cmd supabase status -o env 2>$null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read local Supabase status.' }
  $values = @{}
  foreach ($line in $statusLines) {
    if ($line -match '^([A-Z_]+)="?(.*?)"?$') { $values[$matches[1]] = $matches[2].TrimEnd('"') }
  }
  foreach ($name in @('API_URL','ANON_KEY','SERVICE_ROLE_KEY')) {
    if (-not $values[$name]) { throw "Local Supabase status omitted $name." }
  }

  $env:SMOKE_TEST_MODE = 'local'
  $env:SMOKE_TEST_PROJECT_URL = $values.API_URL
  $env:SMOKE_TEST_ALLOWED_PROJECT_URL = $values.API_URL
  $env:SMOKE_TEST_PUBLISHABLE_KEY = $values.ANON_KEY
  $env:SMOKE_TEST_LOCAL_SERVICE_KEY = $values.SERVICE_ROLE_KEY
  $env:SMOKE_TEST_WRITE_CONFIRMATION = 'I_UNDERSTAND_SMOKE_TEST_WRITES'
  if (-not $env:SMOKE_TEST_ADMIN_EMAIL) { $env:SMOKE_TEST_ADMIN_EMAIL = 'smoke_test_admin@local.invalid' }
  if (-not $env:SMOKE_TEST_AGENT_A_EMAIL) { $env:SMOKE_TEST_AGENT_A_EMAIL = 'smoke_test_agent_a@local.invalid' }
  if (-not $env:SMOKE_TEST_AGENT_B_EMAIL) { $env:SMOKE_TEST_AGENT_B_EMAIL = 'smoke_test_agent_b@local.invalid' }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-LocalSmokeUsers.ps1
  if ($LASTEXITCODE -ne 0) { throw 'Local fixture provisioning failed.' }
  $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File','.\scripts\Invoke-RuntimeSmokeTest.ps1')
  if ($RunId) { $arguments += @('-RunId', $RunId) }
  & powershell.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Local runtime smoke test failed.' }
} finally {
  Remove-Item Env:SMOKE_TEST_LOCAL_SERVICE_KEY -ErrorAction SilentlyContinue
  Pop-Location
}

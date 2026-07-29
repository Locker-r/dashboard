$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed.' }
  & npm.cmd run check:js
  if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax checks failed.' }
  & npm.cmd run check:secrets
  if ($LASTEXITCODE -ne 0) { throw 'Tracked-file secret scan failed.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check-atomic-writes.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Atomic write checks failed.' }
  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'git diff --check failed.' }
  Write-Host 'All local quality gates passed.'
} finally {
  Pop-Location
}

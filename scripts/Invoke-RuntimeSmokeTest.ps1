param(
  [switch]$DryRun,
  [string]$RunId
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$arguments = @((Join-Path $PSScriptRoot 'runtime-smoke.cjs'))
if ($DryRun) { $arguments += '--dry-run' }
if ($RunId) { $arguments += @('--run-id', $RunId) }
Push-Location $root
try {
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Runtime smoke test failed.' }
} finally { Pop-Location }

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]{12,40}$')]
  [string]$RunId
)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'runtime-smoke.cjs') --cleanup --run-id $RunId
if ($LASTEXITCODE -ne 0) { throw 'Runtime smoke cleanup failed.' }

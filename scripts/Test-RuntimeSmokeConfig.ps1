param([string]$RunId)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'runtime-smoke.cjs'), '--check-config')
if ($RunId) { $arguments += @('--run-id', $RunId) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Runtime smoke configuration is invalid.' }

$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path -Parent $PSScriptRoot) 'supabase\atomic-writes.sql'
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing SQL migration: $path" }
Get-Content -LiteralPath $path -Raw | Set-Clipboard
Write-Host 'Atomic writes SQL copied. Review it before manually applying in Supabase SQL Editor.'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$verificationPath = Join-Path $projectRoot 'supabase\verify-storage-foundation.sql'
$localConfigPath = Join-Path $projectRoot 'config\supabase-config.local.js'

if (-not (Test-Path -LiteralPath $verificationPath -PathType Leaf)) {
  throw "Verification SQL was not found: $verificationPath"
}

if (-not (Test-Path -LiteralPath $localConfigPath -PathType Leaf)) {
  throw 'Local Supabase configuration is missing.'
}

$localConfig = Get-Content -LiteralPath $localConfigPath -Raw
$projectUrlMatch = [regex]::Match(
  $localConfig,
  'projectUrl\s*:\s*[''"]https://([a-z0-9-]+)\.supabase\.co/?[''"]',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if (-not $projectUrlMatch.Success) {
  throw 'A valid Supabase Project URL was not found in the local configuration.'
}

$projectRef = $projectUrlMatch.Groups[1].Value
$sqlEditorUrl = "https://supabase.com/dashboard/project/$projectRef/sql/new"

Get-Content -LiteralPath $verificationPath -Raw | Set-Clipboard
Start-Process $sqlEditorUrl

Write-Host 'Read-only verification SQL copied to the clipboard.'
Write-Host 'The project SQL Editor was opened. Paste the SQL and run it manually.'

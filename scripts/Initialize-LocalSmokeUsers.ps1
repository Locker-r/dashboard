$ErrorActionPreference = 'Stop'
if ($env:SMOKE_TEST_MODE -ne 'local') { throw 'SMOKE_TEST_MODE must be local.' }
& node (Join-Path $PSScriptRoot 'provision-local-smoke-users.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Local smoke account provisioning failed.' }

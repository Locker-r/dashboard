<#
.SYNOPSIS
  Windows orchestrator for the autonomous release harness.

.DESCRIPTION
  Runs the read-only planner, optionally executes the read-only static gates,
  writes a run report, and always halts at the production gate.

  The orchestrator executes a command only after the harness classifier has
  called that exact command read-only, immediately before running it. It has no
  branch that performs a production action and no switch that adds one.

.PARAMETER Mode
  Simulate (default) reports only. Verify additionally executes the gate G3
  commands, each re-classified first.

.PARAMETER Json
  Emit the versioned JSON payload instead of the readable report.

.PARAMETER ReportPath
  Where to write the report. Defaults to an ignored path under artifacts/release/.

.PARAMETER NoReport
  Do not write a report file.

.OUTPUTS
  Exit 0 unused. 1 a gate failed. 2 the planner was blocked. 3 halted at the
  production gate, which is the expected end of a healthy run. 64 usage,
  70 internal.
#>
param(
  [ValidateSet('Simulate', 'Verify')][string]$Mode = 'Simulate',
  [switch]$Json,
  [string]$ReportPath,
  [switch]$NoReport
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'dev') 'common.ps1')

$EXIT_VALIDATION = 1
$EXIT_BLOCKED = 2
$EXIT_HALTED = 3
$EXIT_INTERNAL = 70

function Invoke-ReleaseCli {
  param([string[]]$Arguments, [string]$WorkingDirectory)
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkingDirectory
    try {
      $output = @(& node @Arguments 2>&1)
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
}

# The gate before the gate: the orchestrator asks the harness what a command is
# before it runs it, every time, and refuses anything that is not read-only.
function Test-ReadOnlyCommand {
  param([string]$Command, [string]$WorkingDirectory)
  $result = Invoke-ReleaseCli -Arguments @('scripts/release/release.cjs', 'classify', '--command', $Command, '--json') -WorkingDirectory $WorkingDirectory
  return ($result.ExitCode -eq 0)
}

$results = New-Object Collections.Generic.List[object]
$configurationError = $false
$root = $null

try {
  $root = Get-GitRoot
} catch {
  $root = (Get-Location).Path
  $configurationError = $true
  $results.Add((New-CheckResult 'Git repository' 'Failed' $true 0 $_.Exception.Message 'git rev-parse --show-toplevel'))
}

$plan = $null
$plannerExit = $EXIT_INTERNAL

if (-not $configurationError) {
  $modeValue = $Mode.ToLowerInvariant()
  $planner = Invoke-ReleaseCli -Arguments @('scripts/release/release.cjs', 'simulate', '--mode', $modeValue, '--json') -WorkingDirectory $root
  $plannerExit = $planner.ExitCode
  try {
    $plan = $planner.Output | ConvertFrom-Json
  } catch {
    $configurationError = $true
    $results.Add((New-CheckResult 'Release planner' 'Failed' $true 0 (Protect-SensitiveText $planner.Output) 'node scripts/release/release.cjs simulate --json'))
  }
}

if ($null -ne $plan) {
  $selectedLabel = 'none'
  if ($null -ne $plan.selectedTask) { $selectedLabel = "$($plan.selectedTask.id) - $($plan.selectedTask.title)" }
  $plannerStatus = 'Passed'
  if ($plannerExit -eq $EXIT_BLOCKED) { $plannerStatus = 'Failed' }
  $results.Add((New-CheckResult 'Release planner' $plannerStatus $true 0 "Next task: $selectedLabel. Eligible order: $($plan.rankedIds -join ' > ')." 'node scripts/release/release.cjs simulate --json'))

  foreach ($gate in $plan.gates) {
    $status = 'Passed'
    switch ($gate.status) {
      'passed'  { $status = 'Passed' }
      'planned' { $status = 'Skipped' }
      'blocked' { $status = 'Warning' }
      'failed'  { $status = 'Failed' }
      'halted'  { $status = 'Warning' }
      default   { $status = 'Warning' }
    }
    # G6 reporting an absent approval is the normal steady state, not a defect.
    $required = ($gate.status -eq 'failed')
    $results.Add((New-CheckResult "$($gate.id) $($gate.name)" $status $required 0 $gate.summary $gate.classification))
  }

  if ($Mode -eq 'Verify') {
    foreach ($entry in $plan.executionPlan) {
      if (-not (Test-ReadOnlyCommand -Command $entry.command -WorkingDirectory $root)) {
        $results.Add((New-CheckResult "Refused: $($entry.command)" 'Failed' $true 0 'The classifier did not confirm this command as read-only immediately before execution, so the orchestrator refused it.' $entry.command))
        continue
      }
      $tokens = @($entry.command -split '\s+' | Where-Object { $_ })
      $file = $tokens[0]
      if ($file -eq 'npm') { $file = 'npm.cmd' }
      $arguments = @()
      if ($tokens.Count -gt 1) { $arguments = $tokens[1..($tokens.Count - 1)] }
      $results.Add((Invoke-CheckedCommand "$($entry.gate): $($entry.command)" $file $arguments $true 900 $root))
    }
  }

  # Independent of everything above: the harness must not have executed a single
  # non read-only command, and the production gate must have halted.
  $nonReadOnly = @($plan.executedCommands | Where-Object { $_.classification -ne 'read-only' })
  $ledgerStatus = 'Passed'
  if ($nonReadOnly.Count -gt 0 -or $plan.productionActionsExecuted -ne 0) { $ledgerStatus = 'Failed' }
  $results.Add((New-CheckResult 'Execution ledger' $ledgerStatus $true 0 "$($plan.executedCommands.Count) command(s) executed by the planner, all classified read-only. Production actions executed: $($plan.productionActionsExecuted)." ''))

  $haltStatus = 'Passed'
  if ($plan.failureCode -ne 'HALTED_AT_PRODUCTION_GATE') { $haltStatus = 'Warning' }
  $results.Add((New-CheckResult 'Production gate' $haltStatus $false 0 "Halted at $($plan.haltedAtGate) with $($plan.failureCode). $($plan.refusedProductionActions.Count) production action(s) recorded and not executed." ''))
}

$gateFailures = @($results | Where-Object { $_.Required -and $_.Status -eq 'Failed' })
$exitCode = $EXIT_HALTED
if ($configurationError) { $exitCode = $EXIT_INTERNAL }
elseif ($plannerExit -ge 64) { $exitCode = $plannerExit }
elseif ($plannerExit -eq $EXIT_BLOCKED) { $exitCode = $EXIT_BLOCKED }
elseif ($gateFailures.Count -gt 0) { $exitCode = $EXIT_VALIDATION }

$resultArray = @($results | ForEach-Object { $_ })
$payload = [pscustomobject]@{
  SchemaVersion = 1
  Tool          = 'release-orchestrator'
  Mode          = $Mode
  ExitCode      = $exitCode
  Halted        = ($exitCode -eq $EXIT_HALTED)
  Plan          = $plan
  Results       = $resultArray
}

if (-not $NoReport) {
  $target = $ReportPath
  if ([string]::IsNullOrWhiteSpace($target)) {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $target = "artifacts/release/release-run-$stamp.json"
  }
  Write-ToolchainReport $payload $target -Json -GitRoot $root
}

if ($Json) {
  $payload | ConvertTo-Json -Depth 12
} else {
  Write-Stage 'Task selection'
  if ($null -ne $plan) {
    if ($null -ne $plan.selectedTask) {
      Write-Host "NEXT TASK: $($plan.selectedTask.id) - $($plan.selectedTask.title)" -ForegroundColor Green
      Write-Host "  Severity: $($plan.selectedTask.severity)"
      if ($null -ne $plan.selectedTask.reason) {
        Write-Host "  Why: $($plan.selectedTask.reason.severity)"
        Write-Host "       $($plan.selectedTask.reason.workaround)"
        Write-Host "       $($plan.selectedTask.reason.overRunnerUp)"
      }
    } else {
      Write-Host 'NEXT TASK: none eligible.' -ForegroundColor Yellow
    }
    Write-Host "  Eligible order: $($plan.rankedIds -join ' > ')"
    foreach ($entry in $plan.excluded) { Write-Host "  Excluded $($entry.id): $($entry.code) - $($entry.detail)" }
  }

  Write-Stage 'Gate ladder'
  Show-CheckSummary $results

  Write-Stage 'Production gate'
  if ($null -ne $plan) {
    foreach ($action in $plan.refusedProductionActions) { Write-Host "  NOT EXECUTED  $($action.action)" -ForegroundColor Yellow }
    Write-Host ''
    Write-Host "  Production actions executed: $($plan.productionActionsExecuted)"
  }
  Write-Host ''
  if ($exitCode -eq $EXIT_HALTED) {
    Write-Host 'HALTED AT PRODUCTION GATE - human approval required' -ForegroundColor Yellow
    Write-Host 'Next steps are an operator procedure: docs/release-plan.md section R7.' -ForegroundColor Yellow
  } elseif ($exitCode -eq $EXIT_BLOCKED) {
    Write-Host 'BLOCKED - the release run could not reach the production gate' -ForegroundColor Red
  } elseif ($exitCode -eq $EXIT_VALIDATION) {
    Write-Host 'GATE FAILED - fix the cause, not the gate' -ForegroundColor Red
  } else {
    Write-Host 'INTERNAL ERROR' -ForegroundColor Red
  }
}

exit $exitCode

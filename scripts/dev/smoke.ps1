param([switch]$AllowDatabaseReset,[switch]$StartSupabase,[switch]$Json,[string]$ReportPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

# M-2B2b: acquires the same shared advisory database-reset lock
# verify:runtime's runtime-smoke-reset stage acquires (M-2B2a), so a direct
# `npm run smoke -- -AllowDatabaseReset` and a concurrent `verify:runtime
# --allow-reset` refuse each other instead of racing a real database reset.
# Skipped entirely when RUNTIME_LOCK_ALREADY_HELD=1: that is verify.cjs
# telling this script it already holds the lock around this exact child
# process, and acquiring a second time here would be a nested, self-refusing
# acquisition against a lock this same run already owns. See ADR-012 --
# never nested, never stolen, never waited on, never auto-cleared.
function Invoke-DestructiveRuntimeSmoke {
  param($Results, $Root)
  $bridge = Join-Path $PSScriptRoot 'runtime-lock.cjs'
  $ownsLock = $false
  $lock = $null
  if ($env:RUNTIME_LOCK_ALREADY_HELD -ne '1') {
    $acquireOutput = & node $bridge acquire --operation database-reset --owner $Root 2>&1
    if ($LASTEXITCODE -ne 0) {
      $reason = ($acquireOutput | Out-String).Trim()
      $Results.Add((New-CheckResult 'Base runtime smoke' 'Failed' $true 0 $reason 'scripts/dev/runtime-lock.cjs')) | Out-Null
      $Results.Add((New-CheckResult 'Team/runtime concurrency smoke' 'Skipped' $true 0 'The shared runtime lock was refused.' 'scripts/dev/runtime-lock.cjs')) | Out-Null
      return
    }
    $lock = $acquireOutput | ConvertFrom-Json
    $ownsLock = $true
  }
  try {
    $Results.Add((Invoke-CheckedCommand 'Base runtime smoke' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/Invoke-LocalRuntimeSmokeTest.ps1') $true 900 $Root 'Wait')) | Out-Null
    if ($Results[$Results.Count-1].Status -eq 'Passed') {
      $Results.Add((Invoke-CheckedCommand 'Team/runtime concurrency smoke' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/Invoke-LocalTeamManagementSmokeTest.ps1') $true 900 $Root 'Wait')) | Out-Null
    } else {
      $Results.Add((New-CheckResult 'Team/runtime concurrency smoke' 'Skipped' $true 0 'Base runtime smoke failed.' 'scripts/Invoke-LocalTeamManagementSmokeTest.ps1')) | Out-Null
    }
  } finally {
    if ($ownsLock -and $lock) {
      & node $bridge release --operation database-reset --path $lock.path --token $lock.token | Out-Null
    }
  }
}

$root=Get-GitRoot;$results=New-Object Collections.Generic.List[object];$configurationError=$false;$plan=@([pscustomobject]@{Name='Supabase status';Classification='read-only';Command='npx.cmd supabase status'},[pscustomobject]@{Name='Start Supabase';Classification='mutating-local';Command='npx.cmd supabase start'},[pscustomobject]@{Name='Base runtime smoke';Classification='destructive-local';Command='Invoke-LocalRuntimeSmokeTest.ps1 (contains guarded database reset)'},[pscustomobject]@{Name='Team runtime smoke';Classification='destructive-local';Command='Invoke-LocalTeamManagementSmokeTest.ps1 (delegates to base wrapper)'})
if(-not$Json){Write-Stage 'Execution plan';$plan|Format-Table -AutoSize};if($StartSupabase){$results.Add((Invoke-CheckedCommand 'Supabase start' 'npx.cmd' @('supabase','start') $true 180 $root))};$results.Add((Invoke-CheckedCommand 'Supabase status' 'npx.cmd' @('supabase','status') $true 45 $root))
$configurationError=$results[$results.Count-1].Status-ne'Passed';if($configurationError){$reason='Local Supabase status failed; destructive checks were not started.';$results.Add((New-CheckResult 'Base runtime smoke' 'Skipped' $true 0 $reason 'scripts/Invoke-LocalRuntimeSmokeTest.ps1'));$results.Add((New-CheckResult 'Team/runtime concurrency smoke' 'Skipped' $true 0 $reason 'scripts/Invoke-LocalTeamManagementSmokeTest.ps1'))}elseif(-not$AllowDatabaseReset){$reason='Existing runtime wrappers require a database reset; pass -AllowDatabaseReset only for a disposable local Supabase database.';$results.Add((New-CheckResult 'Base runtime smoke' 'Failed' $true 0 $reason 'scripts/Invoke-LocalRuntimeSmokeTest.ps1'));$results.Add((New-CheckResult 'Team/runtime concurrency smoke' 'Failed' $true 0 $reason 'scripts/Invoke-LocalTeamManagementSmokeTest.ps1'))}else{Invoke-DestructiveRuntimeSmoke -Results $results -Root $root}
$exitCode=Get-ToolchainExitCode $results -ConfigurationError:$configurationError;$coverage=[ordered]@{Auth='Runtime suite';Sessions='Runtime suite';RLS='Runtime suite';AtomicRPC='Runtime suite';TeamManagement='Team suite';Concurrency='Team suite';LastActiveAdmin='Team suite';RoleDeactivation='Team suite';Reassignment='Team suite';RequestIdIdempotency='Team suite';PLAYER_ASSIGNMENT_MISMATCH='Team suite';REASSIGNMENT_COUNT_MISMATCH='No deterministic concrete race test'};$resultArray=@($results|ForEach-Object{$_});$payload=[pscustomobject]@{Passed=($exitCode-eq 0);ExitCode=$exitCode;Plan=$plan;Results=$resultArray;Coverage=$coverage};if($ReportPath){Write-ToolchainReport $payload $ReportPath -Json:$Json -GitRoot $root};if($Json){$payload|ConvertTo-Json -Depth 8}else{Show-CheckSummary $results};exit $exitCode

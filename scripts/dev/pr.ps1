param([Parameter(Mandatory=$true)][string]$CommitMessage,[Parameter(Mandatory=$true)][string]$PrTitle,[string]$BaseBranch='main',[string]$BodyFile,[switch]$RunPreflight,[switch]$RunReview,[switch]$Draft,[switch]$Execute,[switch]$Yes,[string[]]$Paths)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root=Get-GitRoot;$branch=Get-CurrentBranch
if($branch-in@('main','master')){Write-Error 'PR workflow is forbidden on main/master.';exit 2}
if($Execute-and$branch-eq'HEAD'){Write-Error 'PR execution requires a named feature branch; detached HEAD is supported only in dry-run mode.';exit 2}
$conflicts=@(& git diff --name-only --diff-filter=U);if($conflicts.Count){Write-Error 'Merge conflicts must be resolved first.';exit 1}
if($Execute-and(-not$Paths-or$Paths.Count-eq 0)){Write-Error '-Paths is required with -Execute.';exit 2}
if($BodyFile){$bodyPath=if([IO.Path]::IsPathRooted($BodyFile)){$BodyFile}else{Join-Path $root $BodyFile};if(-not(Test-Path -LiteralPath $bodyPath -PathType Leaf)){Write-Error 'BodyFile does not exist.';exit 2}}
if($RunPreflight){& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'preflight.ps1');if($LASTEXITCODE-ne 0){Write-Error 'Preflight blocked PR workflow.';exit 1}}
if($RunReview){& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'review.ps1') -BaseBranch $BaseBranch;if($LASTEXITCODE-ne 0){Write-Error 'Review blocked PR workflow.';exit 1}}
$status=@(& git status --short);Write-Host "Branch: $branch";Write-Host 'Changed files:';$status|ForEach-Object{Write-Host "  $_"};Write-Host "Planned commit: $CommitMessage";Write-Host "Planned push: git push -u origin $branch";Write-Host "Planned PR: $PrTitle -> $BaseBranch"
if(-not$Execute){Write-Host 'DRY RUN: no Git or GitHub state changed.';exit 0}
foreach($path in $Paths){if([string]::IsNullOrWhiteSpace($path)-or[IO.Path]::IsPathRooted($path)-or$path-match'(^|[\\/])\.\.([\\/]|$)'){Write-Error "Unsafe path: $path";exit 2};$full=[IO.Path]::GetFullPath((Join-Path $root $path));if(-not$full.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){Write-Error "Path escapes repository: $path";exit 2};$tracked=& git ls-files --error-unmatch -- $path 2>$null;if(-not(Test-Path -LiteralPath $full)-and$LASTEXITCODE-ne 0){Write-Error "Path does not exist and is not tracked: $path";exit 2}}
$existingStaged=@(& git diff --cached --name-only);$preExistingOutside=@($existingStaged|Where-Object{$Paths-notcontains$_});if($preExistingOutside.Count){Write-Error "Index already contains files outside -Paths: $($preExistingOutside-join', ')";exit 1};& git add -- @Paths;if($LASTEXITCODE-ne 0){exit 1};$staged=@(& git diff --cached --name-only);$outside=@($staged|Where-Object{$Paths-notcontains$_});if($outside.Count){Write-Error "Index contains files outside -Paths: $($outside-join', ')";exit 1};if(-not$staged.Count){Write-Error 'No staged changes; empty commit refused.';exit 1}
& git diff --cached
if(-not$Yes){if(Test-NonInteractive){Write-Error 'Confirmation required; use -Yes only in a controlled non-interactive flow.';exit 2};$answer=Read-Host 'Type YES to commit, push, and create PR';if($answer-ne'YES'){Write-Host 'Cancelled.';exit 1}}
& git commit -m $CommitMessage;if($LASTEXITCODE-ne 0){exit 1};& git push -u origin $branch;if($LASTEXITCODE-ne 0){Write-Error 'Commit exists locally. Resolve push issue, then rerun or push manually.';exit 1}
$existing=(& gh pr list --head $branch --base $BaseBranch --state open --json url --jq '.[0].url' 2>$null);if($existing){Write-Host "Existing PR: $existing";exit 0}
$args=@('pr','create','--base',$BaseBranch,'--head',$branch,'--title',$PrTitle);if($Draft){$args+='--draft'};if($BodyFile){$args+=@('--body-file',$bodyPath)}else{$args+=@('--body','Created by scripts/dev/pr.ps1. Review validation output before merge.')};$output=& gh @args;if($LASTEXITCODE-ne 0){Write-Error 'Commit was pushed. Create the PR manually with gh pr create.';exit 1};Write-Host $output

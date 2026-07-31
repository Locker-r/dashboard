Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Stage([string]$Name) { Write-Host "`n== $Name ==" -ForegroundColor Cyan }
function Protect-SensitiveText([AllowNull()][string]$Text) {
  if ($null -eq $Text) { return '' }; $value=[string]$Text
  $value=[regex]::Replace($value,'(?i)(authorization\s*:\s*bearer\s+)[^\s]+','$1[REDACTED]')
  $value=[regex]::Replace($value,'(?i)((?:token|password|secret|api[_-]?key|service[_-]?role[_-]?key)\s*[=:]\s*)[^\s,;]+','$1[REDACTED]')
  $value=[regex]::Replace($value,'(?i)(postgres(?:ql)?://[^:/\s]+:)[^@\s]+(@)','$1[REDACTED]$2')
  $value=[regex]::Replace($value,'(?i)\b(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)\b','[REDACTED]')
  return $value
}
function New-CheckResult { param([string]$Name,[ValidateSet('Passed','Failed','Skipped','Warning')][string]$Status,[bool]$Required=$true,[double]$Duration=0,[string]$Details='',[string]$Command='');$safe=Protect-SensitiveText $Details;if($safe.Length-gt 4000){$safe=$safe.Substring(0,4000)+"`n[output truncated]"};[pscustomobject]@{Name=$Name;Status=$Status;Required=$Required;Duration=[math]::Round($Duration,3);Details=$safe;Command=$Command} }
function Get-ToolchainExitCode([object[]]$Results,[switch]$ConfigurationError) { if($ConfigurationError){return 2};if(@($Results|Where-Object{$_.Required-and$_.Status-eq'Failed'}).Count){return 1};return 0 }
function Test-CommandAvailable([string]$Name) { return $null-ne(Get-Command $Name -ErrorAction SilentlyContinue) }
function Resolve-ExternalCommand([string]$Name,[string]$GitRoot) {
  $commands=@(Get-Command $Name -All -ErrorAction SilentlyContinue)
  if(-not$commands.Count){return $null}
  $rootPrefix=[IO.Path]::GetFullPath($GitRoot).TrimEnd('\')+'\node_modules\'
  $preferred=$commands|Where-Object{$_.Source-and-not([IO.Path]::GetFullPath($_.Source).StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase))}|Select-Object -First 1
  if(-not$preferred){$preferred=$commands|Select-Object -First 1}
  return $preferred.Source
}
function Get-GitRoot { $root=(& git rev-parse --show-toplevel 2>$null);if($LASTEXITCODE-ne 0-or-not$root){throw 'Current directory is not inside a Git repository.'};[IO.Path]::GetFullPath(($root|Select-Object -First 1).Trim()) }
function Get-CurrentBranch { $previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$branchOutput=@(& git branch --show-current 2>$null);$gitExitCode=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($gitExitCode-ne 0){throw 'Cannot determine current Git branch.'};$branch=($branchOutput-join'').Trim();if([string]::IsNullOrWhiteSpace($branch)){return 'HEAD'};return $branch }
function Test-CleanWorkingTree { $status=@(& git status --porcelain 2>$null);if($LASTEXITCODE-ne 0){throw 'Cannot read Git status.'};return $status.Count-eq 0 }
function New-SafeReportDirectory([string]$ReportPath,[string]$GitRoot) { if([string]::IsNullOrWhiteSpace($ReportPath)){return $null};$target=if([IO.Path]::IsPathRooted($ReportPath)){[IO.Path]::GetFullPath($ReportPath)}else{[IO.Path]::GetFullPath((Join-Path $GitRoot $ReportPath))};$prefix=$GitRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;if(-not$target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'ReportPath must stay inside the Git repository.'};$directory=Split-Path -Parent $target;if($directory-and-not(Test-Path -LiteralPath $directory)){New-Item -ItemType Directory -Path $directory -Force|Out-Null};return $target }
function Invoke-CheckedCommand {
  param([string]$Name,[string]$FilePath,[string[]]$Arguments=@(),[bool]$Required=$true,[int]$TimeoutSeconds=120,[string]$WorkingDirectory=(Get-Location).Path)
  $watch=[Diagnostics.Stopwatch]::StartNew();$display=($FilePath+' '+($Arguments-join' ')).Trim()
  try {
    $resolved=Resolve-ExternalCommand $FilePath $WorkingDirectory;if(-not$resolved){return New-CheckResult $Name $(if($Required){'Failed'}else{'Warning'}) $Required $watch.Elapsed.TotalSeconds "Command not found: $FilePath" $display}
    $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$resolved;$psi.WorkingDirectory=$WorkingDirectory;$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.CreateNoWindow=$true
    if($PSVersionTable.PSVersion.Major-ge 7){foreach($argument in $Arguments){[void]$psi.ArgumentList.Add($argument)}}else{$psi.Arguments=(@($Arguments|ForEach-Object{'"'+([string]$_).Replace('"','\"')+'"'}))-join' '}
    $process=New-Object Diagnostics.Process;$process.StartInfo=$psi;[void]$process.Start();$stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync()
    if(-not$process.WaitForExit($TimeoutSeconds*1000)){try{$process.Kill()}catch{};return New-CheckResult $Name 'Failed' $Required $watch.Elapsed.TotalSeconds "Timed out after $TimeoutSeconds seconds; child process terminated." $display}
    $details=(Protect-SensitiveText (($stdoutTask.Result,$stderrTask.Result|Where-Object{$_})-join"`n")).Trim();if($process.ExitCode-eq 0){return New-CheckResult $Name 'Passed' $Required $watch.Elapsed.TotalSeconds $details $display};return New-CheckResult $Name $(if($Required){'Failed'}else{'Warning'}) $Required $watch.Elapsed.TotalSeconds "Exit $($process.ExitCode). $details" $display
  }catch{return New-CheckResult $Name $(if($Required){'Failed'}else{'Warning'}) $Required $watch.Elapsed.TotalSeconds $_.Exception.Message $display}finally{$watch.Stop()}
}
function Show-CheckSummary([object[]]$Results){$Results|Select-Object Name,Status,Required,Duration,Details|Format-Table -AutoSize -Wrap}
function Write-ToolchainReport { param([object]$Payload,[string]$ReportPath,[switch]$Json,[string]$GitRoot);if([string]::IsNullOrWhiteSpace($ReportPath)){return};$target=New-SafeReportDirectory $ReportPath $GitRoot;$content=if($Json){$Payload|ConvertTo-Json -Depth 8}else{[string]$Payload};[IO.File]::WriteAllText($target,(Protect-SensitiveText $content),(New-Object Text.UTF8Encoding($false))) }
function Test-NonInteractive { return [bool]($env:CI-or-not[Environment]::UserInteractive-or[Console]::IsInputRedirected) }

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const dev = path.join(root, 'scripts', 'dev');
const read = name => fs.readFileSync(path.join(dev, name), 'utf8');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
function run(script,args=[]){return spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dev,script),...args],{cwd:root,encoding:'utf8',timeout:180000});}

test('common returns structured results, redacts secrets, and computes exit codes',()=>{
  const file=path.join(dev,'common.ps1').replaceAll("'","''");
  const cmd=`. '${file}'; $p=New-CheckResult pass Passed $true 0 'token=abc'; $f=New-CheckResult fail Failed $true; [pscustomobject]@{Redacted=$p.Details;Ok=(Get-ToolchainExitCode @($p));Failed=(Get-ToolchainExitCode @($f));Config=(Get-ToolchainExitCode @() -ConfigurationError)}|ConvertTo-Json -Compress`;
  const r=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',cmd],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout.trim());assert.match(v.Redacted,/REDACTED/);assert.deepEqual([v.Ok,v.Failed,v.Config],[0,1,2]);
});
test('smoke plan refuses reset-dependent runtime without opt-in',()=>{const r=run('smoke.ps1',['-Json']);assert.equal(r.status,1);const v=JSON.parse(r.stdout);assert.equal(v.Passed,false);assert.ok(v.Plan.some(x=>x.Classification==='destructive-local'));assert.ok(v.Results.some(x=>x.Name==='Base runtime smoke'&&x.Status==='Failed'));});
test('preflight source implements JSON reports and required failure propagation',()=>{const s=read('preflight.ps1');assert.match(s,/ConvertTo-Json/);assert.match(s,/Write-ToolchainReport/);assert.match(s,/Get-ToolchainExitCode/);assert.match(s,/Supabase status/);});
test('review creates markdown and detects sensitive diff categories',()=>{const report=`artifacts/review-test-${process.pid}.md`;const r=run('review.ps1',['-ReportPath',report]);assert.equal(r.status,0,r.stderr);const content=fs.readFileSync(path.join(root,report),'utf8');assert.match(content,/# Review report/);assert.match(content,/## Recommendation/);const s=read('review.ps1');assert.match(s,/SECURITY DEFINER/);assert.match(s,/ROW LEVEL SECURITY/);assert.match(s,/supabase\/migrations/);});
test('pr is dry-run first and does not alter Git',()=>{const before=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout;const r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Paths','README.md']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN/);const after=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout;assert.equal(after,before);const s=read('pr.ps1');assert.match(s,/main','master/);assert.match(s,/-Paths is required/);assert.match(s,/git add --/);});
test('scripts exclude banned automation and guard reset',()=>{const all=fs.readdirSync(dev).filter(x=>x.endsWith('.ps1')).map(read).join('\n');assert.doesNotMatch(all,/Invoke-Expression/i);assert.doesNotMatch(all,/git\s+push\s+--force/i);assert.doesNotMatch(all,/docker\s+volume\s+rm/i);assert.doesNotMatch(all,/gh\s+pr\s+merge/i);assert.match(read('smoke.ps1'),/AllowDatabaseReset/);});

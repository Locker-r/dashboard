const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const dev = path.join(root, 'scripts', 'dev');
const read = name => fs.readFileSync(path.join(dev, name), 'utf8');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
function run(script,args=[],cwd=root){return spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dev,script),...args],{cwd,encoding:'utf8',timeout:180000});}
function git(cwd,args){const result=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
function withTempRepo(callback){
  const repo=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'developer-toolchain-'));
  try {
    git(repo,['init']);git(repo,['config','user.name','Toolchain Test']);git(repo,['config','user.email','toolchain@example.invalid']);
    fs.writeFileSync(path.join(repo,'fixture.txt'),'fixture\n');git(repo,['add','--','fixture.txt']);git(repo,['commit','-m','fixture']);git(repo,['branch','-M','main']);
    return callback(repo,git(repo,['rev-parse','HEAD']));
  } finally { fs.rmSync(repo,{recursive:true,force:true}); }
}
function currentBranch(cwd){
  const common=path.join(dev,'common.ps1').replaceAll("'","''");
  return spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',`. '${common}'; Get-CurrentBranch`],{cwd,encoding:'utf8'});
}

test('common returns structured results, redacts secrets, and computes exit codes',()=>{
  const file=path.join(dev,'common.ps1').replaceAll("'","''");
  const cmd=`. '${file}'; $p=New-CheckResult pass Passed $true 0 'token=abc'; $f=New-CheckResult fail Failed $true; [pscustomobject]@{Redacted=$p.Details;Ok=(Get-ToolchainExitCode @($p));Failed=(Get-ToolchainExitCode @($f));Config=(Get-ToolchainExitCode @() -ConfigurationError)}|ConvertTo-Json -Compress`;
  const r=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',cmd],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout.trim());assert.match(v.Redacted,/REDACTED/);assert.deepEqual([v.Ok,v.Failed,v.Config],[0,1,2]);
});
test('smoke plan refuses reset-dependent runtime without opt-in',()=>{const r=run('smoke.ps1',['-Json']);assert.equal(r.status,1);const v=JSON.parse(r.stdout);assert.equal(v.Passed,false);assert.ok(v.Plan.some(x=>x.Classification==='destructive-local'));assert.ok(v.Results.some(x=>x.Name==='Base runtime smoke'&&x.Status==='Failed'));});
test('preflight source implements JSON reports and required failure propagation',()=>{const s=read('preflight.ps1');assert.match(s,/ConvertTo-Json/);assert.match(s,/Write-ToolchainReport/);assert.match(s,/Get-ToolchainExitCode/);assert.match(s,/Supabase status/);});
test('review creates markdown and detects sensitive diff categories',()=>{const report=`artifacts/review-test-${process.pid}.md`;const r=run('review.ps1',['-ReportPath',report]);assert.equal(r.status,0,r.stderr);const content=fs.readFileSync(path.join(root,report),'utf8');assert.match(content,/# Review report/);assert.match(content,/## Recommendation/);const s=read('review.ps1');assert.match(s,/SECURITY DEFINER/);assert.match(s,/ROW LEVEL SECURITY/);assert.match(s,/supabase\/migrations/);});
test('pr is dry-run first and does not alter Git',()=>{const before=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout;const r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Paths','README.md']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN/);const after=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).stdout;assert.equal(after,before);const s=read('pr.ps1');assert.match(s,/main','master/);assert.match(s,/-Paths is required/);assert.match(s,/git add --/);});
test('current branch helper distinguishes a named branch from detached HEAD',()=>withTempRepo((repo,sha)=>{
  let r=currentBranch(repo);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'main');
  git(repo,['checkout','--detach',sha]);r=currentBranch(repo);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'HEAD');
}));
test('current branch helper preserves a real Git failure',()=>{
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'developer-toolchain-no-git-'));
  try { const r=currentBranch(directory);assert.notEqual(r.status,0);assert.match(r.stderr,/Cannot determine current Git branch/); }
  finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('review reports detached HEAD from a real temporary repository',()=>withTempRepo((repo,sha)=>{
  git(repo,['checkout','--detach',sha]);const r=run('review.ps1',['-BaseBranch','main','-ReportPath','artifacts/review.md'],repo);assert.equal(r.status,0,r.stderr);
  const report=fs.readFileSync(path.join(repo,'artifacts','review.md'),'utf8');assert.match(report,/Current branch: `HEAD`/);
}));
test('PR dry-run is read-only in detached HEAD',()=>withTempRepo((repo,sha)=>{
  git(repo,['checkout','--detach',sha]);const before=git(repo,['status','--porcelain']);const r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test'],repo);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN/);assert.equal(git(repo,['status','--porcelain']),before);assert.equal(git(repo,['rev-parse','HEAD']),sha);
}));
test('PR execution rejects detached HEAD before staging or external actions',()=>withTempRepo((repo,sha)=>{
  git(repo,['checkout','--detach',sha]);fs.writeFileSync(path.join(repo,'fixture.txt'),'changed\n');const before=git(repo,['diff','--','fixture.txt']);
  const r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Execute','-Yes','-Paths','fixture.txt'],repo);
  assert.notEqual(r.status,0);assert.match(`${r.stdout}\n${r.stderr}`,/requires a named feature branch/i);assert.equal(git(repo,['diff','--cached','--name-only']),'');assert.equal(git(repo,['diff','--','fixture.txt']),before);assert.equal(git(repo,['rev-parse','HEAD']),sha);
}));
test('PR branch guards preserve feature dry-run and reject main execution',()=>withTempRepo(repo=>{
  git(repo,['checkout','-b','feature/test']);let r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test'],repo);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN/);
  git(repo,['checkout','main']);r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Execute','-Yes','-Paths','fixture.txt'],repo);assert.notEqual(r.status,0);assert.match(`${r.stdout}\n${r.stderr}`,/forbidden on main\/master/i);assert.equal(git(repo,['diff','--cached','--name-only']),'');
}));
test('scripts exclude banned automation and guard reset',()=>{const all=fs.readdirSync(dev).filter(x=>x.endsWith('.ps1')).map(read).join('\n');assert.doesNotMatch(all,/Invoke-Expression/i);assert.doesNotMatch(all,/git\s+push\s+--force/i);assert.doesNotMatch(all,/docker\s+volume\s+rm/i);assert.doesNotMatch(all,/gh\s+pr\s+merge/i);assert.match(read('smoke.ps1'),/AllowDatabaseReset/);});

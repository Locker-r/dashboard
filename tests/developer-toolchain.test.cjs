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
function withRemoteOnlyMain(callback){
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'developer-toolchain-remote-'));
  const bare=path.join(directory,'origin.git'),source=path.join(directory,'source'),work=path.join(directory,'work');
  try {
    fs.mkdirSync(bare);git(bare,['init','--bare']);fs.mkdirSync(source);git(source,['init']);git(source,['config','user.name','Toolchain Test']);git(source,['config','user.email','toolchain@example.invalid']);
    fs.writeFileSync(path.join(source,'fixture.txt'),'fixture\n');git(source,['add','--','fixture.txt']);git(source,['commit','-m','fixture']);git(source,['branch','-M','main']);git(source,['remote','add','origin',bare]);git(source,['push','origin','main']);
    fs.mkdirSync(work);git(work,['init']);git(work,['remote','add','origin',bare]);git(work,['fetch','origin','main']);git(work,['checkout','--detach','origin/main']);
    assert.equal(spawnSync('git',['show-ref','--verify','--quiet','refs/heads/main'],{cwd:work}).status,1);assert.equal(spawnSync('git',['show-ref','--verify','--quiet','refs/remotes/origin/main'],{cwd:work}).status,0);
    return callback(work);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
}

test('common returns structured results, redacts secrets, and computes exit codes',()=>{
  const file=path.join(dev,'common.ps1').replaceAll("'","''");
  const cmd=`. '${file}'; $p=New-CheckResult pass Passed $true 0 'token=abc'; $f=New-CheckResult fail Failed $true; [pscustomobject]@{Redacted=$p.Details;Ok=(Get-ToolchainExitCode @($p));Failed=(Get-ToolchainExitCode @($f));Config=(Get-ToolchainExitCode @() -ConfigurationError)}|ConvertTo-Json -Compress`;
  const r=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',cmd],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout.trim());assert.match(v.Redacted,/REDACTED/);assert.deepEqual([v.Ok,v.Failed,v.Config],[0,1,2]);
});
test('common wait timeout lets a nested process finish instead of orphaning it',()=>{
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'toolchain-wait-timeout-'));
  try {
    const marker=path.join(directory,'grandchild-finished.txt'),outer=path.join(directory,'outer.cjs'),grandchild=path.join(directory,'grandchild.cjs');
    fs.writeFileSync(grandchild,"const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[2],'finished\\n'),75);\n");
    fs.writeFileSync(outer,"const{spawn}=require('node:child_process');const c=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit',windowsHide:true});c.on('exit',code=>process.exit(code===0?0:1));\n");
    const quote=value=>value.replaceAll("'","''"),common=quote(path.join(dev,'common.ps1')),cwd=quote(directory);
    const cmd=`. '${common}'; $r=Invoke-CheckedCommand nested node @('${quote(outer)}','${quote(grandchild)}','${quote(marker)}') $true 0 '${cwd}' Wait; $r|ConvertTo-Json -Compress`;
    const result=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',cmd],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout.trim());assert.equal(value.Status,'Failed');assert.match(value.Details,/allowed to finish safely/);assert.equal(fs.readFileSync(marker,'utf8'),'finished\n');
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('guarded local reset refuses a stopped Supabase race without starting or resetting it',{skip:process.platform!=='win32'},()=>{
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'toolchain-stopped-race-'));
  try {
    const calls=path.join(directory,'calls.txt'),fake=path.join(directory,'npx.cmd');fs.writeFileSync(fake,`@echo off\r\necho %*>>"${calls}"\r\nexit /b 1\r\n`);
    const env={...process.env,PATH:`${directory};${process.env.PATH}`,SMOKE_TEST_REQUIRE_ALREADY_RUNNING:'1',SMOKE_TEST_ADMIN_PASSWORD:'fixture-admin',SMOKE_TEST_AGENT_A_PASSWORD:'fixture-a',SMOKE_TEST_AGENT_B_PASSWORD:'fixture-b'};
    const result=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','Invoke-LocalRuntimeSmokeTest.ps1')],{cwd:root,env,encoding:'utf8',timeout:10000});
    assert.notEqual(result.status,0);const invoked=fs.readFileSync(calls,'utf8');assert.match(invoked,/supabase status -o env/);assert.doesNotMatch(invoked,/supabase start|db reset/);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('smoke plan refuses reset-dependent runtime without opt-in',()=>{const r=run('smoke.ps1',['-Json']);assert.ok([1,2].includes(r.status));const v=JSON.parse(r.stdout);assert.equal(v.Passed,false);assert.ok(v.Plan.some(x=>x.Classification==='destructive-local'));assert.ok(v.Results.some(x=>x.Name==='Base runtime smoke'&&x.Status!=='Passed'));});
test('preflight source implements JSON reports and required failure propagation',()=>{const s=read('preflight.ps1');assert.match(s,/ConvertTo-Json/);assert.match(s,/Write-ToolchainReport/);assert.match(s,/Get-ToolchainExitCode/);assert.match(s,/Supabase status/);});
test('smoke renders the execution plan stage in non-JSON mode',()=>{
  const r=run('smoke.ps1');
  assert.ok([1,2].includes(r.status));
  assert.match(r.stdout,/== Execution plan ==/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`,/is not recognized as the name of a cmdlet/i);
});
test('preflight never executes runtime smoke and never resets the database',()=>{
  const s=read('preflight.ps1');
  assert.doesNotMatch(s,/'-File','scripts\/dev\/smoke\.ps1'/);
  assert.match(s,/New-CheckResult 'Runtime smoke' 'Skipped' \$false/);
});
test('preflight states unambiguously that runtime verification did not execute',()=>{
  const s=read('preflight.ps1');
  assert.match(s,/SKIPPED \(database reset required\)/);
  assert.match(s,/Runtime verification has NOT been executed/);
  assert.match(s,/smoke\.ps1 -AllowDatabaseReset/);
  const banner=s.slice(s.indexOf('READY FOR DEVELOPMENT'));
  assert.match(banner,/if\(\$IncludeRuntime\)\{[\s\S]*Runtime verification has NOT been executed[\s\S]*-AllowDatabaseReset/);
});
// Runs in an isolated fixture repo: executing review.ps1 against the ambient working tree made this test
// depend on whatever the current branch happens to contain, so any branch legitimately adding destructive
// SQL (for example a retention purge) turned a correct BLOCKED verdict into a test failure.
test('review creates markdown and detects sensitive diff categories',()=>withTempRepo(repo=>{
  const report='artifacts/review-test.md';
  const r=run('review.ps1',['-ReportPath',report],repo);
  assert.equal(r.status,0,r.stderr);
  const content=fs.readFileSync(path.join(repo,report),'utf8');
  assert.match(content,/# Review report/);assert.match(content,/## Recommendation/);
  const s=read('review.ps1');assert.match(s,/SECURITY DEFINER/);assert.match(s,/ROW LEVEL SECURITY/);assert.match(s,/supabase\/migrations/);
}));
test('review blocks a diff that adds destructive SQL to a migration',()=>withTempRepo(repo=>{
  git(repo,['checkout','-b','feature/destructive']);
  fs.mkdirSync(path.join(repo,'supabase','migrations'),{recursive:true});
  fs.writeFileSync(path.join(repo,'supabase','migrations','20990101000100_probe.sql'),'delete from public.some_table;\n');
  git(repo,['add','--','supabase/migrations']);git(repo,['commit','-m','destructive']);
  const r=run('review.ps1',['-BaseBranch','main','-ReportPath','artifacts/review.md'],repo);
  assert.equal(r.status,1,'destructive SQL must block');
  assert.match(fs.readFileSync(path.join(repo,'artifacts','review.md'),'utf8'),/Potentially destructive SQL added/);
}));
test('pr is dry-run first and does not alter Git',()=>withTempRepo(repo=>{
  git(repo,['checkout','-b','feature/test-pr-dry-run']);const beforeStatus=git(repo,['status','--porcelain']);const beforeHead=git(repo,['rev-parse','HEAD']);
  const r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Paths','fixture.txt'],repo);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN/);assert.match(r.stdout,/Planned push:/);assert.match(r.stdout,/Planned PR:/);
  assert.equal(git(repo,['status','--porcelain']),beforeStatus);assert.equal(git(repo,['rev-parse','HEAD']),beforeHead);assert.equal(git(repo,['diff','--cached','--name-only']),'');assert.equal(git(repo,['remote']),'');
  const s=read('pr.ps1');assert.match(s,/main','master/);assert.match(s,/-Paths is required/);assert.match(s,/git add --/);
}));
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
test('review prefers a local base branch and reports its resolved ref',()=>withTempRepo(repo=>{
  git(repo,['checkout','-b','feature/test']);const r=run('review.ps1',['-BaseBranch','main','-ReportPath','artifacts/review.md'],repo);assert.equal(r.status,0,r.stderr);assert.match(fs.readFileSync(path.join(repo,'artifacts','review.md'),'utf8'),/Resolved base ref: `main`/);
}));
test('review falls back to origin main without a local main branch',()=>withRemoteOnlyMain(repo=>{
  const r=run('review.ps1',['-BaseBranch','main','-ReportPath','artifacts/review.md'],repo);assert.equal(r.status,0,r.stderr);const report=fs.readFileSync(path.join(repo,'artifacts','review.md'),'utf8');assert.match(report,/Current branch: `HEAD`/);assert.match(report,/Resolved base ref: `origin\/main`/);
}));
test('review accepts an exact origin remote-tracking ref',()=>withRemoteOnlyMain(repo=>{
  const r=run('review.ps1',['-BaseBranch','origin/main','-ReportPath','artifacts/review.md'],repo);assert.equal(r.status,0,r.stderr);assert.match(fs.readFileSync(path.join(repo,'artifacts','review.md'),'utf8'),/Resolved base ref: `origin\/main`/);
}));
test('review reports a controlled error for a missing base ref',()=>withTempRepo(repo=>{
  const r=run('review.ps1',['-BaseBranch','missing-branch','-ReportPath','artifacts/review.md'],repo);assert.notEqual(r.status,0);const output=`${r.stdout}\n${r.stderr}`;assert.match(output,/Cannot resolve base Git ref 'missing-branch'/);assert.doesNotMatch(output,/null-valued expression/i);assert.equal(fs.existsSync(path.join(repo,'artifacts','review.md')),false);
}));
test('review reports a controlled error when histories have no merge base',()=>withTempRepo(repo=>{
  git(repo,['checkout','--orphan','unrelated']);git(repo,['rm','-f','fixture.txt']);fs.writeFileSync(path.join(repo,'other.txt'),'other\n');git(repo,['add','--','other.txt']);git(repo,['commit','-m','unrelated']);const r=run('review.ps1',['-BaseBranch','main','-ReportPath','artifacts/review.md'],repo);assert.notEqual(r.status,0);const output=`${r.stdout}\n${r.stderr}`;assert.match(output,/Cannot determine Git merge-base/);assert.match(output,/fetch sufficient history/);assert.doesNotMatch(output,/null-valued expression/i);
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
  git(repo,['branch','-M','master']);r=run('pr.ps1',['-CommitMessage','test','-PrTitle','test','-Execute','-Yes','-Paths','fixture.txt'],repo);assert.notEqual(r.status,0);assert.match(`${r.stdout}\n${r.stderr}`,/forbidden on main\/master/i);assert.equal(git(repo,['diff','--cached','--name-only']),'');
}));
test('scripts exclude banned automation and guard reset',()=>{const all=fs.readdirSync(dev).filter(x=>x.endsWith('.ps1')).map(read).join('\n');assert.doesNotMatch(all,/Invoke-Expression/i);assert.doesNotMatch(all,/git\s+push\s+--force/i);assert.doesNotMatch(all,/docker\s+volume\s+rm/i);assert.doesNotMatch(all,/gh\s+pr\s+merge/i);assert.match(read('smoke.ps1'),/AllowDatabaseReset/);});

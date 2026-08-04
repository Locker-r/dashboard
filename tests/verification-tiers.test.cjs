'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const doctor = require('../scripts/dev/doctor.cjs');
const pages = require('../scripts/build-pages-artifact.cjs');
const verify = require('../scripts/dev/verify.cjs');
const localFixture = require('./fixtures/local-environment.cjs');

const HEAD = 'a'.repeat(40);
const ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\verification dashboard' : '/srv/verification dashboard');
const SAFE_RELEASE_ENV = Object.freeze({
  DASHBOARD_SUPABASE_PROJECT_URL: 'https://verification.supabase.co',
  DASHBOARD_SUPABASE_PUBLISHABLE_KEY: `sb_${'publishable'}_${'A'.repeat(24)}`
});

function tierOptions(tier, overrides = {}) {
  return Object.freeze({ help: false, tier, json: false, offline: false, allowReset: false, ...overrides });
}

function deterministicClock(start = '2026-08-04T08:00:00.000Z') {
  let tick = 0;
  const baseline = Date.parse(start);
  return () => new Date(baseline + tick++ * 5);
}

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function commandResult(status = 0, stdout = '', stderr = '', extra = {}) {
  return { status, signal: null, stdout, stderr, error: null, ...extra };
}

function createRunner(handler = null) {
  const calls = [];
  const runCommand = async (file, args, options = {}) => {
    const call = { file, args: [...args], options: { ...options } };
    calls.push(call);
    if (handler) {
      const result = await handler(call, calls);
      if (result) return result;
    }
    return commandResult(0, 'fixture passed\n');
  };
  return { calls, runCommand };
}

function baseOverrides(overrides = {}) {
  const capture = overrides.capture || captureStreams();
  const runner = overrides.runner || createRunner();
  return {
    repository: overrides.repository || { root: ROOT, branch: 'feature/verification', head: HEAD },
    platform: overrides.platform || 'win32',
    env: overrides.env || {},
    now: overrides.now || deterministicClock(),
    runCommand: runner.runCommand,
    streams: capture.streams,
    controller: overrides.controller || { interrupted: false, child: null },
    installSignalHandlers: false,
    runDoctor: overrides.runDoctor,
    onStageStart: overrides.onStageStart,
    releaseOps: overrides.releaseOps,
    randomToken: overrides.randomToken || (() => 'fixture-owner-token'),
    fs: overrides.fs || fs,
    _capture: capture,
    _runner: runner
  };
}

async function runTier(tier, config = {}) {
  const overrides = baseOverrides(config);
  const execution = await verify.runVerification(tierOptions(tier, config.options), overrides);
  return { ...execution, capture: overrides._capture, calls: overrides._runner.calls };
}

async function healthyDoctor(overrides = {}) {
  const fixture = localFixture.createEnvironment(overrides);
  const result = await doctor.runDoctor({ now: '2026-08-04T08:00:00.000Z', deps: fixture.deps });
  return { fixture, result };
}

function createFakeReleaseOps(overrides = {}) {
  const calls = [];
  const workspace = Object.freeze({
    root: path.join(ROOT, 'artifacts', 'verify-release-fixture'),
    slots: Object.freeze({
      a: Object.freeze({ parent: path.join(ROOT, 'artifacts', 'verify-release-fixture', 'a'), output: path.join(ROOT, 'artifacts', 'verify-release-fixture', 'a', 'pages-site') }),
      b: Object.freeze({ parent: path.join(ROOT, 'artifacts', 'verify-release-fixture', 'b'), output: path.join(ROOT, 'artifacts', 'verify-release-fixture', 'b', 'pages-site') })
    })
  });
  const manifest = 'b'.repeat(64);
  const ops = {
    create(root) {
      calls.push({ name: 'create', root });
      if (overrides.create) return overrides.create(root, workspace);
      return workspace;
    },
    build(value, slot, config, root) {
      calls.push({ name: 'build', workspace: value, slot, config: { ...config }, root });
      if (overrides.build) return overrides.build(value, slot, config, root);
      return Object.freeze({ fileCount: pages.ARTIFACT_FILES.length, manifestDigest: manifest, cleanupWarning: null });
    },
    compare(value) {
      calls.push({ name: 'compare', workspace: value });
      if (overrides.compare) return overrides.compare(value);
      return Object.freeze({ files: pages.ARTIFACT_FILES.length, digest: 'c'.repeat(64) });
    },
    validate(value, config, root) {
      calls.push({ name: 'validate', workspace: value, config: { ...config }, root });
      if (overrides.validate) return overrides.validate(value, config, root);
      return Object.freeze({
        first: Object.freeze({ fileCount: pages.ARTIFACT_FILES.length, manifestDigest: manifest }),
        second: Object.freeze({ fileCount: pages.ARTIFACT_FILES.length, manifestDigest: manifest })
      });
    },
    scan(value) {
      calls.push({ name: 'scan', workspace: value });
      if (overrides.scan) return overrides.scan(value);
      return Object.freeze({ filesScanned: pages.ARTIFACT_FILES.length * 2 });
    },
    cleanup(value) {
      calls.push({ name: 'cleanup', workspace: value });
      if (overrides.cleanup) return overrides.cleanup(value);
      return undefined;
    }
  };
  return { ops, calls, workspace };
}

function stageIds(result) {
  return result.stages.map(stage => stage.id);
}

function callText(call) {
  return [call.file, ...call.args].join(' ');
}

test('help, missing/unknown tiers, and unknown options are deterministic usage outcomes', async () => {
  for (const [argv, expectedCode] of [
    [[], verify.EXIT_USAGE],
    [['unknown'], verify.EXIT_USAGE],
    [['fast', '--unknown'], verify.EXIT_USAGE],
    [['pr', '--allow-reset'], verify.EXIT_USAGE]
  ]) {
    const capture = captureStreams();
    const code = await verify.main(argv, { streams: capture.streams, installSignalHandlers: false });
    assert.equal(code, expectedCode);
    assert.match(capture.stderr(), /Usage: node scripts\/dev\/verify\.cjs/);
  }

  const capture = captureStreams();
  assert.equal(await verify.main(['--help'], { streams: capture.streams, installSignalHandlers: false }), 0);
  assert.match(capture.stdout(), /--allow-reset/);
  assert.equal(capture.stderr(), '');
});

test('human and JSON output carry the common contract with deterministic injected time', async () => {
  const humanCapture = captureStreams();
  const outputSeenAtCommandStart = [];
  const humanRunner = createRunner(() => {
    outputSeenAtCommandStart.push(humanCapture.stdout());
    return null;
  });
  const humanCode = await verify.main(['fast'], baseOverrides({ capture: humanCapture, runner: humanRunner }));
  assert.equal(humanCode, 0);
  assert.match(outputSeenAtCommandStart[0], /^\[RUNNING\] Repository identity and Git state/m);
  assert.equal((humanCapture.stdout().match(/^\[RUNNING\]/gm) || []).length, 5, 'every executed stage is announced before its result summary');
  assert.match(humanCapture.stdout(), /Verification tier: fast/);
  assert.match(humanCapture.stdout(), /Repository:/);
  assert.match(humanCapture.stdout(), /Branch: feature\/verification/);
  assert.match(humanCapture.stdout(), new RegExp(`HEAD: ${HEAD}`));
  assert.ok(humanCapture.stdout().trimEnd().endsWith('VERIFY FAST PASSED'));

  const jsonCapture = captureStreams();
  const jsonCode = await verify.main(['fast', '--json'], baseOverrides({ capture: jsonCapture, runner: createRunner() }));
  assert.equal(jsonCode, 0);
  const parsed = JSON.parse(jsonCapture.stdout());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tier, 'fast');
  assert.equal(parsed.repository, ROOT);
  assert.equal(parsed.branch, 'feature/verification');
  assert.equal(parsed.head, HEAD);
  assert.equal(parsed.status, 'passed');
  assert.equal(parsed.destructive, false);
  assert.equal(parsed.startedAt, '2026-08-04T08:00:00.000Z');
  assert.ok(parsed.completedAt > parsed.startedAt);
  assert.equal(parsed.failureCode, null);
  assert.equal(parsed.failureStage, null);
  assert.equal(jsonCapture.stderr(), '');
});

test('spaces and Unicode repository paths survive output and command working directories', async () => {
  const unicodeRoot = path.resolve(path.sep === '\\' ? 'C:\\Проекты\\panel con espacio\\dashboard' : '/tmp/Проекты/panel con espacio/dashboard');
  const run = await runTier('fast', { repository: { root: unicodeRoot, branch: 'feature/ñ', head: HEAD } });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.repository, unicodeRoot);
  assert.equal(run.result.branch, 'feature/ñ');
  assert.ok(run.calls.every(call => call.options.cwd === unicodeRoot));
});

test('Windows stages use fixed npm.cmd executable and argument arrays', async () => {
  const run = await runTier('pr');
  assert.equal(run.exitCode, 0);
  const npmCalls = run.calls.filter(call => call.file === 'npm.cmd');
  assert.equal(npmCalls.length, 6);
  assert.deepEqual(npmCalls[0].args, ['test']);
  assert.deepEqual(npmCalls[1].args, ['run', 'check:js']);
  assert.deepEqual(npmCalls.at(-1).args, ['run', 'preflight']);
  assert.ok(npmCalls.every(call => Array.isArray(call.args)));
  assert.ok(npmCalls.every(call => !Object.hasOwn(call.options, 'shell')));
});
test('the default Windows runner maps npm.cmd to the trusted npm CLI without a shell', async () => {
  const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const controller = { interrupted: false, child: null };
  let spawned = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const deps = verify.createDefaultDeps({
    platform: 'win32',
    env: { npm_execpath: npmCli },
    controller,
    fs: { statSync(target) { assert.equal(target, npmCli); return { isFile: () => true }; } },
    spawnProcess(file, args, options) {
      spawned = { file, args, options };
      setImmediate(() => child.emit('close', 0, null));
      return child;
    }
  });
  const result = await deps.runCommand('npm.cmd', ['run', 'check:js'], { cwd: ROOT, timeoutMs: 1000 });
  assert.equal(result.status, 0);
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args, [npmCli, 'run', 'check:js']);
  assert.equal(spawned.options.shell, false);
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(controller.child, null);
});
test('timeout waits for confirmed owned-child close and escalates an ignored graceful signal', async () => {
  const controller = { interrupted: false, child: null };
  const signals = [];
  let closed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => { closed = true; child.emit('close', null, 'SIGKILL'); });
    return true;
  };
  const deps = verify.createDefaultDeps({
    platform: process.platform,
    env: {},
    controller,
    killGraceMs: 1,
    spawnProcess() { return child; }
  });
  const result = await deps.runCommand(process.execPath, ['fixture'], { cwd: ROOT, timeoutMs: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(closed, true, 'the runner must not resolve before the owned child closes');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(controller.child, null);
});
test('destructive timeout and interruption wait instead of orphaning an owned process tree', async () => {
  const controller = { interrupted: false, child: null };
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => { signals.push(signal); return true; };
  const deps = verify.createDefaultDeps({
    platform: process.platform,
    env: {},
    controller,
    spawnProcess() {
      setTimeout(() => child.emit('close', 0, null), 10);
      return child;
    }
  });
  const pending = deps.runCommand(process.execPath, ['fixture'], {
    cwd: ROOT,
    timeoutMs: 1,
    terminationPolicy: 'wait'
  });
  await new Promise(resolve => setTimeout(resolve, 3));
  const capture = captureStreams();
  const timer = verify.requestInterruption(controller, { killGraceMs: 1, streams: capture.streams });
  assert.equal(timer, null);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, []);
  assert.match(capture.stderr(), /waiting for the owned process tree to finish safely/);
  assert.equal(controller.child, null);
});
test('repeated ordinary signals retain the destructive wait handler until verification finishes', async () => {
  const signalSource = new EventEmitter();
  const capture = captureStreams();
  const kills = [];
  const controller = {
    interrupted: false,
    terminationPolicy: 'wait',
    child: { kill(signal) { kills.push(signal); return true; } }
  };
  let resolveCommand;
  const runner = createRunner(() => new Promise(resolve => { resolveCommand = resolve; }));
  const overrides = baseOverrides({ capture, runner, controller });
  overrides.installSignalHandlers = true;
  overrides.signalSource = signalSource;
  const pending = verify.main(['fast'], overrides);
  while (!resolveCommand) await new Promise(resolve => setImmediate(resolve));
  signalSource.emit('SIGINT');
  signalSource.emit('SIGINT');
  resolveCommand(commandResult(0, 'fixture completed\n'));
  assert.equal(await pending, verify.EXIT_VALIDATION);
  assert.deepEqual(kills, []);
  assert.equal((capture.stderr().match(/waiting for the owned process tree to finish safely/g) || []).length, 2);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
test('destructive wait policy permits a real nested child to finish after timeout', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify nested process-'));
  const marker = path.join(repository, 'grandchild-finished.txt');
  try {
    const grandchild = "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'finished\\n'),75);";
    const outer = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit',windowsHide:true});c.on('exit',code=>process.exit(code===0?0:1));";
    const controller = { interrupted: false, child: null };
    const deps = verify.createDefaultDeps({ platform: process.platform, env: process.env, controller });
    const result = await deps.runCommand(process.execPath, ['-e', outer, grandchild, marker], {
      cwd: repository,
      timeoutMs: 10,
      terminationPolicy: 'wait'
    });
    assert.equal(result.timedOut, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'finished\n');
    assert.equal(controller.child, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
test('credential-shaped stdout and stderr are redacted in result and human output', async () => {
  const jwt = `eyJ${'A'.repeat(12)}.${'B'.repeat(12)}.${'C'.repeat(12)}`;
  const secretKey = `sb_${'secret'}_${'D'.repeat(24)}`;
  const gitHubToken = `gh${'p'}_${'E'.repeat(24)}`;
  const gitHubRefreshToken = `gh${'r'}_${'R'.repeat(24)}`;
  const fineGrainedToken = `github_${'pat'}_${'F'.repeat(30)}`;
  const privateKey = [`-----BEGIN ${'PRIVATE KEY-----'}`, 'fixture-private-material', `-----END ${'PRIVATE KEY-----'}`].join('\n');
  const encryptedPrivateKey = [`-----BEGIN ${'ENCRYPTED PRIVATE KEY-----'}`, 'fixture-encrypted-material', `-----END ${'ENCRYPTED PRIVATE KEY-----'}`].join('\n');
  const dsaPrivateKey = [`-----BEGIN ${'DSA PRIVATE KEY-----'}`, 'fixture-dsa-material', `-----END ${'DSA PRIVATE KEY-----'}`].join('\n');
  const bareCredential = 'bare-fixture-credential';
  const runner = createRunner(() => commandResult(
    1,
    `password=hunter2 ${jwt} ${bareCredential} ${fineGrainedToken}`,
    `${secretKey} ${gitHubToken} ${gitHubRefreshToken}\n${privateKey}\n${encryptedPrivateKey}\n${dsaPrivateKey}`
  ));
  const run = await runTier('pr', { runner, env: { VERIFICATION_PASSWORD: bareCredential } });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  const serialized = JSON.stringify(run.result);
  for (const secret of [
    'hunter2', jwt, secretKey, gitHubToken, gitHubRefreshToken, fineGrainedToken,
    'fixture-private-material', 'fixture-encrypted-material', 'fixture-dsa-material', bareCredential
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /REDACTED/);
  const human = verify.formatHuman(run.result);
  assert.equal(human.includes('hunter2'), false);
  assert.ok(human.trimEnd().endsWith('VERIFY PR FAILED'));
});
test('opaque environment credentials are redacted before truncation in command and internal failures', async () => {
  const credential = 'opaque-fixture-token-0123456789-tailmark';
  const payload = `${'X'.repeat(100)}${credential}${'Z'.repeat(11990)}`;
  const commandRun = await runTier('pr', {
    env: { VERIFICATION_TOKEN: credential },
    runner: createRunner(() => commandResult(1, payload, ''))
  });
  assert.equal(commandRun.exitCode, verify.EXIT_VALIDATION);
  assert.equal(commandRun.result.stages[0].details.includes(credential.slice(-16)), false);

  const internalRun = await runTier('runtime', {
    env: { VERIFICATION_TOKEN: credential },
    runDoctor: async () => { throw new Error(payload); }
  });
  assert.equal(internalRun.exitCode, verify.EXIT_INTERNAL);
  assert.equal(internalRun.result.stages[0].details.includes(credential.slice(-16)), false);
});
test('an internal exception maps to exit 70 and never prints a false pass', async () => {
  const runner = createRunner(() => { throw new Error('synthetic internal fault'); });
  const run = await runTier('pr', { runner });
  assert.equal(run.exitCode, verify.EXIT_INTERNAL);
  assert.equal(run.result.status, 'failed');
  assert.equal(run.result.failureCode, 'INTERNAL_ORCHESTRATION_FAILURE');
  assert.equal(run.result.failureStage, 'unit-tests');
  assert.ok(verify.formatHuman(run.result).trimEnd().endsWith('VERIFY PR FAILED'));
});

test('interruption stops new stages and is never rendered as pass', async () => {
  const controller = { interrupted: false, child: null };
  const runner = createRunner(() => {
    controller.interrupted = true;
    return commandResult(null, '', 'interrupted', { signal: 'SIGINT' });
  });
  const run = await runTier('pr', { runner, controller });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.status, 'interrupted');
  assert.equal(run.result.failureCode, 'INTERRUPTED');
  assert.equal(run.result.stages[0].status, 'interrupted');
  assert.ok(run.result.stages.slice(1).every(stage => stage.status === 'skipped'));
  assert.equal(run.calls.length, 1);
});
test('an interruption observed between stages cannot become a false pass', async () => {
  const controller = { interrupted: true, child: null };
  const run = await runTier('pr', { controller });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.status, 'interrupted');
  assert.equal(run.result.stages[0].status, 'interrupted');
  assert.ok(run.result.stages.slice(1).every(stage => stage.status === 'skipped'));
  assert.equal(run.calls.length, 0);
});
test('an interruption arriving after a passed stage marks the next stage interrupted', async () => {
  const controller = { interrupted: false, child: null };
  let tick = 0;
  const baseline = Date.parse('2026-08-04T08:00:00.000Z');
  const now = () => {
    tick += 1;
    if (tick === 3) controller.interrupted = true;
    return new Date(baseline + tick * 5);
  };
  const run = await runTier('pr', { controller, now });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.deepEqual(run.result.stages.slice(0, 3).map(stage => stage.status), ['passed', 'interrupted', 'skipped']);
  assert.equal(run.result.failureStage, 'javascript-syntax');
  assert.equal(run.calls.length, 1);
});

test('verify:fast has the exact lightweight stages and invokes no environment, audit, artifact, or network work', async () => {
  let doctorCalls = 0;
  const release = createFakeReleaseOps();
  const run = await runTier('fast', {
    runDoctor: async () => { doctorCalls += 1; throw new Error('must not run'); },
    releaseOps: release.ops
  });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(stageIds(run.result), [
    'repository-state',
    'javascript-syntax',
    'diff-whitespace',
    'project-status',
    'focused-tests'
  ]);
  assert.equal(doctorCalls, 0);
  assert.equal(release.calls.length, 0);
  const commands = run.calls.map(callText).join('\n');
  assert.doesNotMatch(commands, /docker|supabase|audit|build:pages|https?:|gh /i);
  assert.match(run.result.stages[0].details, /not sufficient for PR creation or merge/);
});

test('verify:fast propagates the first stage failure and skips later stages', async () => {
  const runner = createRunner(call => call.file === 'npm.cmd' && call.args.includes('check:js')
    ? commandResult(1, '', 'syntax failed')
    : null);
  const run = await runTier('fast', { runner });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.failureStage, 'javascript-syntax');
  assert.deepEqual(run.result.stages.map(stage => stage.status), ['passed', 'failed', 'skipped', 'skipped', 'skipped']);
});

test('verify:pr executes the exact mandatory order and no reset/push/merge/tag/deploy action', async () => {
  const run = await runTier('pr');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(stageIds(run.result), verify.PR_STAGE_SPECS.map(stage => stage.id));
  assert.deepEqual(run.calls.map(callText), [
    'npm.cmd test',
    'npm.cmd run check:js',
    'npm.cmd run check:secrets',
    'npm.cmd run check:migrations',
    'npm.cmd run check:project-status',
    'npm.cmd run preflight',
    'git diff --check'
  ]);
  assert.doesNotMatch(run.calls.map(callText).join('\n'), /--allow-reset|git push|git tag|gh pr|npm publish|deploy/i);
});

test('verify:pr preserves the first meaningful failure and marks every later stage skipped', async () => {
  const runner = createRunner(call => call.file === 'npm.cmd' && call.args.join(' ') === 'run check:secrets'
    ? commandResult(1, '', 'tracked secret scan failed')
    : null);
  const run = await runTier('pr', { runner });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.failureCode, 'SECRET_SCAN_FAILED');
  assert.equal(run.result.failureStage, 'secret-scan');
  assert.equal(run.result.stages[2].status, 'failed');
  assert.ok(run.result.stages.slice(3).every(stage => stage.status === 'skipped'));
  assert.equal(run.calls.length, 3);
});

test('verify:pr preserves exit-2 project-status and preflight blockers', async t => {
  for (const [name, command, failureStage, failureCode] of [
    ['project status', 'run check:project-status', 'project-status', 'PROJECT_STATUS_BLOCKED'],
    ['preflight', 'run preflight', 'preflight', 'PREFLIGHT_BLOCKED']
  ]) {
    await t.test(name, async () => {
      const runner = createRunner(call => call.args.join(' ') === command
        ? commandResult(2, '', 'fixture precondition blocker')
        : null);
      const run = await runTier('pr', { runner });
      assert.equal(run.exitCode, verify.EXIT_BLOCKED);
      assert.equal(run.result.status, 'blocked');
      assert.equal(run.result.failureStage, failureStage);
      assert.equal(run.result.failureCode, failureCode);
    });
  }
});

test('a timed-out stage is a blocker rather than an operator interruption', async () => {
  const runner = createRunner(() => commandResult(null, '', 'fixture timeout', {
    signal: 'SIGKILL',
    error: new Error('command timed out'),
    timedOut: true
  }));
  const run = await runTier('pr', { runner });
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.status, 'blocked');
  assert.equal(run.result.failureCode, 'STAGE_TIMEOUT');
  assert.equal(run.result.failureStage, 'unit-tests');
  assert.ok(run.result.stages.slice(1).every(stage => stage.status === 'skipped'));
});

test('verify:runtime default passes only non-destructive checks and explicitly skips reset', async () => {
  const healthy = await healthyDoctor();
  const runner = createRunner();
  const run = await runTier('runtime', { runner, runDoctor: async () => healthy.result });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(stageIds(run.result), [
    'runtime-doctor', 'docker-cli', 'docker-daemon', 'supabase-status',
    'local-dashboard-config', 'auth-health', 'smoke-users', 'runtime-ownership',
    'runtime-config-dry-run', 'runtime-smoke-reset'
  ]);
  const reset = run.result.stages.at(-1);
  assert.equal(reset.status, 'skipped');
  assert.equal(reset.required, false);
  assert.match(reset.details, /requires explicit --allow-reset/);
  assert.equal(run.result.status, 'passed');
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0].args, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    'scripts/Invoke-RuntimeSmokeTest.ps1', '-DryRun', '-RunId', 'verifyruntime0001'
  ]);
  assert.equal(run.calls[0].options.env.SMOKE_TEST_PROJECT_URL, doctor.LOCAL_SUPABASE_URL);
  assert.equal(Object.keys(run.calls[0].options.env).some(key => /PASSWORD/.test(key)), false);
});

test('verify:runtime maps missing Docker, stopped Docker, and stopped Supabase to environment blockers', async t => {
  for (const [name, doctorOverrides, failureStage, failureCode] of [
    ['Docker CLI missing', { dockerCli: false }, 'docker-cli', 'DOCKER_CLI_MISSING'],
    ['Docker daemon stopped', { dockerDaemon: false }, 'docker-daemon', 'DOCKER_DAEMON_STOPPED'],
    ['Supabase stopped', { supabaseRunning: false }, 'supabase-status', 'SUPABASE_STOPPED']
  ]) {
    await t.test(name, async () => {
      const snapshot = await healthyDoctor(doctorOverrides);
      const run = await runTier('runtime', { runDoctor: async () => snapshot.result });
      assert.equal(run.exitCode, verify.EXIT_BLOCKED);
      assert.equal(run.result.failureStage, failureStage);
      assert.equal(run.result.failureCode, failureCode);
      assert.ok(run.result.stages.slice(run.result.stages.findIndex(stage => stage.id === failureStage) + 1).every(stage => stage.status === 'skipped'));
    });
  }
});

test('verify:runtime refuses hosted and malformed Dashboard project URLs', async t => {
  for (const [name, source] of [
    ['hosted', localFixture.supabaseConfigSource({ projectUrl: 'https://hostedref.supabase.co' })],
    ['malformed', localFixture.supabaseConfigSource({ projectUrl: 'not-a-project-url' })],
    ['noncanonical loopback', localFixture.supabaseConfigSource({ projectUrl: 'http://localhost:54321' })]
  ]) {
    await t.test(name, async () => {
      const snapshot = await healthyDoctor({ supabaseConfig: source });
      const run = await runTier('runtime', { runDoctor: async () => snapshot.result });
      assert.equal(run.exitCode, verify.EXIT_BLOCKED);
      assert.equal(run.result.failureStage, 'local-dashboard-config');
      assert.match(run.result.failureCode, /RUNTIME_CONFIG_UNSAFE/);
      assert.equal(run.calls.some(call => call.args.includes('-AllowDatabaseReset')), false);
    });
  }
});

test('verify:runtime propagates doctor blockers not owned by a dedicated runtime stage', async () => {
  const snapshot = await healthyDoctor({ nodeVersion: '20.11.0' });
  const run = await runTier('runtime', { runDoctor: async () => snapshot.result });
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.failureStage, 'runtime-ownership');
  assert.equal(run.result.failureCode, 'RUNTIME_PRECONDITION_BLOCKED');
  assert.match(run.result.stages.find(stage => stage.id === 'runtime-doctor').details, /NODE_VERSION_UNSUPPORTED/);
});

test('verify:runtime blocks unhealthy Auth, missing smoke users, and competing reset ownership', async t => {
  for (const [name, doctorOverrides, failureStage, code] of [
    ['Auth unhealthy', { authHealthy: false }, 'auth-health', 'AUTH_UNHEALTHY'],
    ['smoke users missing', { smokeUsers: [], smokeProfiles: [] }, 'smoke-users', 'SMOKE_USERS_NOT_READY'],
    ['competing reset process', { processes: [{ pid: 8181, name: 'powershell.exe', commandLine: 'powershell scripts/Invoke-LocalRuntimeSmokeTest.ps1' }] }, 'runtime-ownership', 'RUNTIME_OWNERSHIP_AMBIGUOUS']
  ]) {
    await t.test(name, async () => {
      const snapshot = await healthyDoctor(doctorOverrides);
      const run = await runTier('runtime', { runDoctor: async () => snapshot.result });
      assert.equal(run.exitCode, verify.EXIT_BLOCKED);
      assert.equal(run.result.failureStage, failureStage);
      assert.equal(run.result.failureCode, code);
      assert.equal(run.calls.some(call => /taskkill|Stop-Process|docker stop/i.test(callText(call))), false);
    });
  }
});

test('verify:runtime --allow-reset reaches only the sanctioned guarded wrapper after a fresh safety check', async () => {
  const healthy = await healthyDoctor();
  let doctorCalls = 0;
  const runner = createRunner();
  const capture = captureStreams();
  const run = await runTier('runtime', {
    options: { allowReset: true },
    runner,
    capture,
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'fixture-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'fixture-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'fixture-agent-b',
      SMOKE_TEST_MODE: 'hosted',
      SMOKE_TEST_PROJECT_URL: 'https://unsafe.supabase.co',
      SMOKE_TEST_ALLOWED_PROJECT_URL: 'https://unsafe.supabase.co',
      SMOKE_TEST_LOCAL_SERVICE_KEY: localFixture.SERVICE_JWT
    },
    runDoctor: async () => { doctorCalls += 1; return healthy.result; }
  });
  assert.equal(run.exitCode, 0);
  assert.equal(doctorCalls, 2, 'doctor must run again immediately before destructive execution');
  assert.equal(run.result.destructive, true);
  assert.match(capture.stderr(), /DESTRUCTIVE LOCAL VERIFICATION/);
  const resetCalls = run.calls.filter(call => call.args.includes('-AllowDatabaseReset'));
  assert.equal(resetCalls.length, 1);
  assert.deepEqual(resetCalls[0].args, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/dev/smoke.ps1', '-AllowDatabaseReset'
  ]);
  assert.equal(resetCalls[0].options.env.SMOKE_TEST_MODE, 'local');
  assert.equal(resetCalls[0].options.env.SMOKE_TEST_PROJECT_URL, doctor.LOCAL_SUPABASE_URL);
  assert.equal(resetCalls[0].options.env.SMOKE_TEST_ALLOWED_PROJECT_URL, doctor.LOCAL_SUPABASE_URL);
  assert.equal(resetCalls[0].options.env.SMOKE_TEST_REQUIRE_ALREADY_RUNNING, '1');
  assert.equal(resetCalls[0].options.env.SMOKE_TEST_ADMIN_PASSWORD, 'fixture-admin');
  assert.equal(Object.hasOwn(resetCalls[0].options.env, 'SMOKE_TEST_LOCAL_SERVICE_KEY'), false);
  assert.equal(run.calls.some(call => call.args.includes('Invoke-LocalRuntimeSmokeTest.ps1')), false);
  assert.equal(run.calls.some(call => /start|stop|kill/i.test(call.args[0] || '')), false);
  const commonSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev', 'common.ps1'), 'utf8');
  const smokeSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev', 'smoke.ps1'), 'utf8');
  assert.match(commonSource, /ValidateSet\('Terminate','Wait'\)/);
  assert.match(commonSource, /TimeoutPolicy-eq'Wait'[\s\S]*process\.WaitForExit\(\)/);
  assert.equal((smokeSource.match(/\$root 'Wait'/g) || []).length, 2, 'both destructive wrapper calls must use cooperative timeout waiting');
  assert.match(smokeSource, /configurationError[\s\S]*destructive checks were not started/);
});

test('verify:runtime --allow-reset refuses a safety regression found by the fresh doctor', async () => {
  const initial = await healthyDoctor();
  const refreshed = await healthyDoctor({
    supabaseConfig: localFixture.supabaseConfigSource({ projectUrl: 'https://hostedref.supabase.co' })
  });
  let doctorCalls = 0;
  const run = await runTier('runtime', {
    options: { allowReset: true },
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'fixture-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'fixture-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'fixture-agent-b'
    },
    runDoctor: async () => ++doctorCalls === 1 ? initial.result : refreshed.result
  });
  assert.equal(doctorCalls, 2);
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.failureStage, 'runtime-smoke-reset');
  assert.equal(run.result.failureCode, 'RUNTIME_CONFIG_UNSAFE');
  assert.equal(run.calls.some(call => call.args.includes('-AllowDatabaseReset')), false);
});

test('interruption during the fresh reset doctor cannot launch the destructive wrapper', async () => {
  const healthy=await healthyDoctor(),controller={interrupted:false,child:null};let doctorCalls=0;
  const run=await runTier('runtime',{controller,options:{allowReset:true},env:{SMOKE_TEST_ADMIN_PASSWORD:'fixture-admin',SMOKE_TEST_AGENT_A_PASSWORD:'fixture-a',SMOKE_TEST_AGENT_B_PASSWORD:'fixture-b'},runDoctor:async()=>{doctorCalls+=1;if(doctorCalls===2)controller.interrupted=true;return healthy.result;}});
  assert.equal(run.exitCode,verify.EXIT_VALIDATION);assert.equal(run.result.failureStage,'runtime-smoke-reset');assert.equal(run.result.status,'interrupted');assert.equal(run.calls.some(call=>call.args.includes('-AllowDatabaseReset')),false);
});

test('verify:runtime blocks reset when credentials are absent and redacts service-key-shaped failures', async () => {
  const healthy = await healthyDoctor();
  const missing = await runTier('runtime', { options: { allowReset: true }, runDoctor: async () => healthy.result });
  assert.equal(missing.exitCode, verify.EXIT_BLOCKED);
  assert.equal(missing.result.failureCode, 'RESET_CREDENTIALS_MISSING');
  assert.equal(missing.calls.some(call => call.args.includes('-AllowDatabaseReset')), false);

  const serviceKey = localFixture.SERVICE_JWT;
  const runner = createRunner(call => call.args.includes('-AllowDatabaseReset')
    ? commandResult(1, '', `service_role_key=${serviceKey}`)
    : null);
  const failed = await runTier('runtime', {
    options: { allowReset: true },
    runner,
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'fixture-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'fixture-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'fixture-agent-b'
    },
    runDoctor: async () => healthy.result
  });
  assert.equal(failed.exitCode, verify.EXIT_VALIDATION);
  assert.equal(JSON.stringify(failed.result).includes(serviceKey), false);
  assert.match(JSON.stringify(failed.result), /REDACTED/);
});

test('verify:release reuses PR gates then audits, builds twice, validates, governs, scans, and cleans up', async () => {
  const release = createFakeReleaseOps();
  const run = await runTier('release', { env: { ...SAFE_RELEASE_ENV }, releaseOps: release.ops });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.status, 'passed');
  assert.deepEqual(stageIds(run.result).slice(0, verify.PR_STAGE_SPECS.length), verify.PR_STAGE_SPECS.map(stage => stage.id));
  assert.deepEqual(stageIds(run.result).slice(verify.PR_STAGE_SPECS.length), [
    'dependency-audit',
    'release-public-config',
    'artifact-build-a',
    'artifact-build-b',
    'artifact-determinism',
    'artifact-validation',
    'release-migration-governance',
    'release-governance',
    'workflow-structure',
    'artifact-content-contract',
    'artifact-secret-scan',
    'release-workspace-cleanup'
  ]);
  assert.deepEqual(release.calls.map(call => call.name), ['create', 'build', 'build', 'compare', 'validate', 'scan', 'cleanup']);
  assert.deepEqual(release.calls.filter(call => call.name === 'build').map(call => call.slot), ['a', 'b']);
  assert.ok(run.calls.some(call => call.file === 'npm.cmd' && call.args.join(' ') === 'audit --omit=dev --audit-level=high'));
  const ignoreCall = run.calls.find(call => call.file === 'git' && call.args[0] === 'check-ignore');
  assert.ok(ignoreCall);
  assert.deepEqual(ignoreCall.args.slice(0, 4), ['check-ignore', '--quiet', '--no-index', '--']);
  assert.match(ignoreCall.args.at(-1), /^artifacts\/verify-release-fixture\/$/);
  assert.ok(run.calls.some(call => call.args.includes('tests/release-governance.test.cjs')));
  for (const call of run.calls) {
    const executable = path.basename(call.file).toLowerCase();
    assert.notEqual(executable, 'gh');
    assert.notEqual(call.file === 'git' && ['push', 'tag'].includes(call.args[0]), true);
    assert.notEqual(call.file === 'npm.cmd' && ['publish', 'deploy'].includes(call.args[0]), true);
  }
});

test('verify:release blocks missing, unsafe, and offline public verification prerequisites', async t => {
  await t.test('missing public config', async () => {
    const release = createFakeReleaseOps();
    const run = await runTier('release', { env: {}, releaseOps: release.ops });
    assert.equal(run.exitCode, verify.EXIT_BLOCKED);
    assert.equal(run.result.failureCode, 'RELEASE_PUBLIC_CONFIG_REQUIRED');
    assert.equal(release.calls.length, 0);
  });

  await t.test('secret key config', async () => {
    const release = createFakeReleaseOps();
    const unsafe = `sb_${'secret'}_${'X'.repeat(24)}`;
    const run = await runTier('release', {
      env: { ...SAFE_RELEASE_ENV, DASHBOARD_SUPABASE_PUBLISHABLE_KEY: unsafe },
      releaseOps: release.ops
    });
    assert.equal(run.exitCode, verify.EXIT_BLOCKED);
    assert.equal(run.result.failureCode, 'RELEASE_PUBLIC_CONFIG_UNSAFE');
    assert.equal(JSON.stringify(run.result).includes(unsafe), false);
    assert.equal(release.calls.length, 0);
  });

  await t.test('offline audit refusal', async () => {
    const release = createFakeReleaseOps();
    const run = await runTier('release', {
      options: { offline: true },
      env: { ...SAFE_RELEASE_ENV },
      releaseOps: release.ops
    });
    assert.equal(run.exitCode, verify.EXIT_BLOCKED);
    assert.equal(run.result.failureCode, 'AUDIT_OFFLINE_BLOCKED');
    assert.equal(run.calls.some(call => call.args[0] === 'audit'), false);
    assert.equal(release.calls.length, 0);
  });

  await t.test('generated workspace is not ignored', async () => {
    const release = createFakeReleaseOps();
    const runner = createRunner(call => call.file === 'git' && call.args[0] === 'check-ignore'
      ? commandResult(1, '', 'workspace is not ignored')
      : null);
    const run = await runTier('release', {
      runner,
      env: { ...SAFE_RELEASE_ENV },
      releaseOps: release.ops
    });
    assert.equal(run.exitCode, verify.EXIT_BLOCKED);
    assert.equal(run.result.failureCode, 'RELEASE_WORKSPACE_NOT_IGNORED');
    assert.deepEqual(release.calls.map(call => call.name), ['create', 'cleanup']);
  });
});

test('verify:release distinguishes registry unavailability from a vulnerability failure', async t => {
  await t.test('network blocker', async () => {
    const runner = createRunner(call => call.args[0] === 'audit'
      ? commandResult(1, '', 'npm error code ENETUNREACH registry access unavailable')
      : null);
    const run = await runTier('release', { runner, env: { ...SAFE_RELEASE_ENV }, releaseOps: createFakeReleaseOps().ops });
    assert.equal(run.exitCode, verify.EXIT_BLOCKED);
    assert.equal(run.result.failureCode, 'AUDIT_REGISTRY_UNAVAILABLE');
  });
  await t.test('audit finding', async () => {
    const runner = createRunner(call => call.args[0] === 'audit'
      ? commandResult(1, '', 'high severity vulnerability found')
      : null);
    const run = await runTier('release', { runner, env: { ...SAFE_RELEASE_ENV }, releaseOps: createFakeReleaseOps().ops });
    assert.equal(run.exitCode, verify.EXIT_VALIDATION);
    assert.equal(run.result.failureCode, 'DEPENDENCY_AUDIT_FAILED');
  });
  await t.test('vulnerability description containing network', async () => {
    const runner = createRunner(call => call.args[0] === 'audit'
      ? commandResult(1, '', 'high severity vulnerability permits a network attacker')
      : null);
    const run = await runTier('release', { runner, env: { ...SAFE_RELEASE_ENV }, releaseOps: createFakeReleaseOps().ops });
    assert.equal(run.exitCode, verify.EXIT_VALIDATION);
    assert.equal(run.result.failureCode, 'DEPENDENCY_AUDIT_FAILED');
  });
});

test('artifact nondeterminism preserves recovery material and skips every later release stage', async () => {
  const release = createFakeReleaseOps({
    compare() {
      throw new verify.VerificationError('ARTIFACT_NONDETERMINISTIC', 'fixture byte mismatch', verify.EXIT_VALIDATION, { preserveReleaseWorkspace: true });
    }
  });
  const run = await runTier('release', { env: { ...SAFE_RELEASE_ENV }, releaseOps: release.ops });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.failureStage, 'artifact-determinism');
  assert.equal(run.result.failureCode, 'ARTIFACT_NONDETERMINISTIC');
  assert.equal(release.calls.some(call => call.name === 'cleanup'), false);
  assert.equal(run.result.stages.at(-1).id, 'release-workspace-cleanup');
  assert.equal(run.result.stages.at(-1).status, 'skipped');
  assert.match(run.result.stages.at(-1).details, /Recovery material preserved/);
});

test('cleanup failure never masks the first validation failure', async () => {
  const release = createFakeReleaseOps({ cleanup() { throw new Error('synthetic cleanup failure'); } });
  const runner = createRunner(call => call.args.includes('tests/release-governance.test.cjs')
    ? commandResult(1, '', 'governance mutation detected')
    : null);
  const run = await runTier('release', { runner, env: { ...SAFE_RELEASE_ENV }, releaseOps: release.ops });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.failureStage, 'release-governance');
  assert.equal(run.result.failureCode, 'RELEASE_GOVERNANCE_FAILED');
  assert.equal(run.result.stages.at(-1).id, 'release-workspace-cleanup');
  assert.equal(run.result.stages.at(-1).status, 'failed');
  assert.match(run.result.stages.at(-1).details, /synthetic cleanup failure/);
});

test('cleanup announcement failure never masks the first validation failure', async () => {
  const release = createFakeReleaseOps();
  const runner = createRunner(call => call.args.includes('tests/release-governance.test.cjs')
    ? commandResult(1, '', 'governance mutation detected')
    : null);
  const run = await runTier('release', {
    runner,
    env: { ...SAFE_RELEASE_ENV },
    releaseOps: release.ops,
    onStageStart(stage) {
      if (stage.id === 'release-workspace-cleanup') throw new Error('synthetic cleanup announcement failure');
    }
  });
  assert.equal(run.exitCode, verify.EXIT_VALIDATION);
  assert.equal(run.result.failureStage, 'release-governance');
  assert.equal(run.result.failureCode, 'RELEASE_GOVERNANCE_FAILED');
  assert.equal(run.result.stages.at(-1).id, 'release-workspace-cleanup');
  assert.equal(run.result.stages.at(-1).status, 'failed');
  assert.match(run.result.stages.at(-1).details, /synthetic cleanup announcement failure/);
});

test('cleanup failure without an earlier failure becomes exit 70', async () => {
  const release = createFakeReleaseOps({ cleanup() { throw new Error('synthetic cleanup failure'); } });
  const run = await runTier('release', { env: { ...SAFE_RELEASE_ENV }, releaseOps: release.ops });
  assert.equal(run.exitCode, verify.EXIT_INTERNAL);
  assert.equal(run.result.failureStage, 'release-workspace-cleanup');
  assert.equal(run.result.failureCode, 'RELEASE_CLEANUP_FAILED');
  assert.ok(verify.formatHuman(run.result).trimEnd().endsWith('VERIFY RELEASE FAILED'));
});

test('default release workspace cleanup removes only an identity/token-owned run directory', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify workspace ü-'));
  try {
    const deps = verify.createDefaultDeps({
      platform: process.platform,
      fs,
      env: {},
      randomToken: () => 'owned-token',
      repository: { root: repository, branch: 'feature/test', head: HEAD },
      runCommand: async () => commandResult()
    });
    const ops = verify.createReleaseOps(deps);
    const workspace = ops.create(repository);
    assert.equal(fs.existsSync(workspace.root), true);
    ops.cleanup(workspace);
    assert.equal(fs.existsSync(workspace.root), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('default release workspace cleanup preserves a foreign entry', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify foreign workspace-'));
  try {
    const deps = verify.createDefaultDeps({
      platform: process.platform,
      fs,
      env: {},
      randomToken: () => 'owned-token',
      repository: { root: repository, branch: 'feature/test', head: HEAD },
      runCommand: async () => commandResult()
    });
    const ops = verify.createReleaseOps(deps);
    const workspace = ops.create(repository);
    const foreign = path.join(workspace.root, 'foreign-recovery.txt');
    fs.writeFileSync(foreign, 'operator material\n');
    assert.throws(() => ops.cleanup(workspace), error => error.code === 'RELEASE_CLEANUP_FOREIGN_ENTRY');
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'operator material\n');
    assert.equal(fs.existsSync(workspace.root), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('release workspace setup failure reports and preserves its identity-checked partial directory', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify setup failure-'));
  let partialRoot = null;
  try {
    const injectedFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'mkdtempSync') {
          return prefix => {
            partialRoot = fs.mkdtempSync(prefix);
            return partialRoot;
          };
        }
        if (property === 'writeFileSync') {
          return (targetPath, ...args) => {
            if (path.basename(targetPath) === '.verify-owner.json') {
              const error = new Error('synthetic marker write failure');
              error.code = 'ENOSPC';
              throw error;
            }
            return fs.writeFileSync(targetPath, ...args);
          };
        }
        return Reflect.get(target, property);
      }
    });
    const deps = verify.createDefaultDeps({
      platform: process.platform,
      fs: injectedFs,
      env: {},
      randomToken: () => 'owned-token'
    });
    const ops = verify.createReleaseOps(deps);
    assert.throws(
      () => ops.create(repository),
      error => error.code === 'RELEASE_WORKSPACE_SETUP_FAILED' &&
        error.preserveReleaseWorkspace && error.recoveryPath === partialRoot
    );
    assert.equal(fs.existsSync(partialRoot), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('release workspace setup refuses a substituted non-directory before any marker write', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify setup substitution-'));
  let createdRoot = null;
  let markerWrites = 0;
  try {
    const injectedFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'mkdtempSync') {
          return prefix => {
            createdRoot = fs.mkdtempSync(prefix);
            return createdRoot;
          };
        }
        if (property === 'lstatSync') {
          return targetPath => targetPath === createdRoot
            ? { isSymbolicLink: () => true, isDirectory: () => false, dev: 0, ino: 0, birthtimeMs: 0 }
            : fs.lstatSync(targetPath);
        }
        if (property === 'writeFileSync') {
          return (...args) => { markerWrites += 1; return fs.writeFileSync(...args); };
        }
        return Reflect.get(target, property);
      }
    });
    const deps = verify.createDefaultDeps({
      platform: process.platform,
      fs: injectedFs,
      env: {},
      randomToken: () => 'owned-token'
    });
    assert.throws(
      () => verify.createReleaseOps(deps).create(repository),
      error => error.code === 'RELEASE_WORKSPACE_SETUP_FAILED' && error.preserveReleaseWorkspace
    );
    assert.equal(markerWrites, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('release cleanup revalidates an atomic claim and never deletes a substituted directory', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify cleanup substitution-'));
  let claimPath = null;
  let removalCalls = 0;
  try {
    const injectedFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            claimPath = destination;
            const displaced = `${source}.displaced-owned`;
            fs.renameSync(source, displaced);
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, 'foreign-material.txt'), 'foreign operator material\n');
            fs.renameSync(source, destination);
          };
        }
        if (property === 'rmSync') {
          return (...args) => { removalCalls += 1; return fs.rmSync(...args); };
        }
        return Reflect.get(target, property);
      }
    });
    const deps = verify.createDefaultDeps({
      platform: process.platform,
      fs: injectedFs,
      env: {},
      randomToken: () => 'owned-token',
      repository: { root: repository, branch: 'feature/test', head: HEAD },
      runCommand: async () => commandResult()
    });
    const ops = verify.createReleaseOps(deps);
    const workspace = ops.create(repository);
    assert.throws(() => ops.cleanup(workspace), error => error.code === 'RELEASE_CLEANUP_OWNERSHIP_CHANGED');
    assert.equal(removalCalls, 0);
    assert.ok(claimPath);
    assert.equal(fs.readFileSync(path.join(claimPath, 'foreign-material.txt'), 'utf8'), 'foreign operator material\n');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('artifact build refuses a substituted slot before writing output', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify slot substitution-'));
  try {
    const deps=verify.createDefaultDeps({platform:process.platform,env:{},randomToken:()=> 'owned-token'}),ops=verify.createReleaseOps(deps),workspace=ops.create(repository);
    const held=`${workspace.root}.held-a`;fs.renameSync(workspace.slots.a.parent,held);fs.mkdirSync(workspace.slots.a.parent);
    assert.throws(()=>ops.build(workspace,'a',{projectUrl:'https://verification.supabase.co',publishableKey:`sb_${'publishable'}_${'A'.repeat(24)}`},repository),error=>error.code==='RELEASE_SLOT_OWNERSHIP_CHANGED');
    assert.equal(fs.existsSync(workspace.slots.a.output),false);
  } finally { fs.rmSync(repository,{recursive:true,force:true}); }
});

test('release cleanup preserves a substituted artifact directory', () => {
  const repository=fs.mkdtempSync(path.join(os.tmpdir(),'verify artifact substitution-'));
  try {
    const ops=verify.createReleaseOps(verify.createDefaultDeps({platform:process.platform,env:{},randomToken:()=> 'owned-token'})),workspace=ops.create(repository),config={projectUrl:SAFE_RELEASE_ENV.DASHBOARD_SUPABASE_PROJECT_URL,publishableKey:SAFE_RELEASE_ENV.DASHBOARD_SUPABASE_PUBLISHABLE_KEY};
    ops.build(workspace,'a',config,path.resolve(__dirname,'..'));const held=`${workspace.root}.held-output`;fs.renameSync(workspace.slots.a.output,held);fs.mkdirSync(workspace.slots.a.output);fs.writeFileSync(path.join(workspace.slots.a.output,'foreign.txt'),'foreign material\n');
    assert.throws(()=>ops.cleanup(workspace),error=>error.code==='RELEASE_ARTIFACT_OWNERSHIP_CHANGED');assert.equal(fs.readFileSync(path.join(workspace.slots.a.output,'foreign.txt'),'utf8'),'foreign material\n');assert.equal(fs.existsSync(workspace.root),true);
  } finally { fs.rmSync(repository,{recursive:true,force:true}); }
});

test('artifact scanning rejects expanded GitHub-token and private-key shapes', async t => {
  for (const [name, secret] of [
    ['fine-grained GitHub token', `github_${'pat'}_${'A'.repeat(30)}`],
    ['GitHub refresh token', `gh${'r'}_${'B'.repeat(24)}`],
    ['encrypted private key', [`-----BEGIN ${'ENCRYPTED PRIVATE KEY-----'}`, 'fixture', `-----END ${'ENCRYPTED PRIVATE KEY-----'}`].join('\n')],
    ['DSA private key', [`-----BEGIN ${'DSA PRIVATE KEY-----'}`, 'fixture', `-----END ${'DSA PRIVATE KEY-----'}`].join('\n')]
  ]) {
    await t.test(name, () => {
      const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'verify artifact scan-'));
      try {
        const root = path.join(repository, 'workspace');
        const slots = {};
        for (const slot of ['a', 'b']) {
          const parent = path.join(root, slot);
          const output = path.join(parent, 'pages-site');
          slots[slot] = { parent, output };
          for (const relative of pages.ARTIFACT_FILES) {
            const target = path.join(output, ...relative.split('/'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, relative === pages.ARTIFACT_FILES[0] && slot === 'a' ? secret : 'safe fixture\n');
          }
        }
        const deps = verify.createDefaultDeps({ platform: process.platform, fs, env: {} });
        const ops = verify.createReleaseOps(deps);
        assert.throws(
          () => ops.scan({ root, slots }),
          error => error.code === 'ARTIFACT_SECRET_SHAPE' && error.preserveReleaseWorkspace
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('stage definitions expose no arbitrary or publishing command input', () => {
  for (const tier of verify.VALID_TIERS) {
    const stages = verify.createStageDefinitions(tier);
    assert.ok(stages.length > 0);
    assert.equal(new Set(stages.map(stage => stage.id)).size, stages.length);
    assert.ok(stages.every(stage => typeof stage.run === 'function'));
    assert.ok(stages.every(stage => typeof stage.id === 'string' && typeof stage.label === 'string'));
  }
  assert.doesNotMatch(verify.USAGE, /command=|--command|--exec/);
});

'use strict';

// M-2B2a: the shared advisory runtime lock, wired into verify.cjs's
// runtime-smoke-reset stage only. The lock primitives themselves
// (acquireRuntimeLock/releaseRuntimeLock/inspectRuntimeLock) are unchanged
// and already covered by tests/agent-worktree.test.cjs; this file proves the
// wiring: the family root this stage computes is the one agent-worktree.cjs
// itself would compute and read (not this worktree's own, different, root),
// and that acquisition/release happens at the right boundary with the right
// fail-closed behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const doctor = require('../scripts/dev/doctor.cjs');
const verify = require('../scripts/dev/verify.cjs');
const automationCore = require('../scripts/dev/automation-core.cjs');
const worktreeTool = require('../scripts/dev/agent-worktree.cjs');
const localFixture = require('./fixtures/local-environment.cjs');

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\lock wiring dashboard' : '/srv/lock wiring dashboard');

/* ==================== shared fixtures (fake fs / fake runner) ==================== */

function deterministicClock(start = '2026-08-08T08:00:00.000Z') {
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

const FIXTURE_GIT_COMMON_DIR = path.join(ROOT, '.git');

function createRunner(handler = null) {
  const calls = [];
  const runCommand = async (file, args, options = {}) => {
    const call = { file, args: [...args], options: { ...options } };
    calls.push(call);
    if (handler) {
      const result = await handler(call, calls);
      if (result) return result;
    }
    if (file === 'git' && args.includes('--git-common-dir')) {
      return commandResult(0, `${FIXTURE_GIT_COMMON_DIR}\n`);
    }
    return commandResult(0, 'fixture passed\n');
  };
  return { calls, runCommand };
}

// Same in-memory lock filesystem as tests/verification-tiers.test.cjs — kept
// as its own local copy since neither file exports test helpers.
function createFakeLockFs() {
  const files = new Map();
  const dirs = new Set();
  const norm = target => path.resolve(String(target));
  const notFound = (op, target) => {
    const error = new Error(`ENOENT: no such file or directory, ${op} '${target}'`);
    error.code = 'ENOENT';
    return error;
  };
  return {
    mkdirSync(target, options = {}) {
      const resolved = norm(target);
      if (!options.recursive) { dirs.add(resolved); return; }
      let current = path.parse(resolved).root;
      for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        dirs.add(current);
      }
    },
    writeFileSync(target, content, options = {}) {
      const resolved = norm(target);
      if (options && options.flag === 'wx' && files.has(resolved)) {
        const error = new Error(`EEXIST: file already exists, open '${resolved}'`);
        error.code = 'EEXIST';
        throw error;
      }
      files.set(resolved, String(content));
      dirs.add(path.dirname(resolved));
    },
    readFileSync(target) {
      const resolved = norm(target);
      if (!files.has(resolved)) throw notFound('open', resolved);
      return files.get(resolved);
    },
    rmSync(target, options = {}) {
      const resolved = norm(target);
      if (!files.has(resolved)) {
        if (options && options.force) return;
        throw notFound('unlink', resolved);
      }
      files.delete(resolved);
    },
    lstatSync(target) {
      const resolved = norm(target);
      if (files.has(resolved)) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(resolved)) return { isFile: () => false, isDirectory: () => true };
      throw notFound('lstat', resolved);
    },
    realpathSync(target) {
      const resolved = norm(target);
      if (files.has(resolved) || dirs.has(resolved)) return resolved;
      throw notFound('realpath', resolved);
    },
    // Exposed only so tests can seed/inspect the lock file directly.
    _files: files
  };
}

function runtimeOverrides(overrides = {}) {
  const capture = overrides.capture || captureStreams();
  const runner = overrides.runner || createRunner();
  return {
    repository: overrides.repository || { root: ROOT, branch: 'feature/lock-wiring', head: 'a'.repeat(40) },
    platform: overrides.platform || 'win32',
    env: overrides.env || {},
    now: overrides.now || deterministicClock(),
    runCommand: runner.runCommand,
    streams: capture.streams,
    controller: overrides.controller || { interrupted: false, child: null },
    installSignalHandlers: false,
    runDoctor: overrides.runDoctor,
    randomToken: overrides.randomToken || (() => 'fixture-owner-token'),
    fs: overrides.fs || createFakeLockFs(),
    _capture: capture,
    _runner: runner
  };
}

async function runRuntimeTier(config = {}) {
  const overrides = runtimeOverrides(config);
  const options = { help: false, tier: 'runtime', json: false, offline: false, allowReset: false, ...config.options };
  const execution = await verify.runVerification(options, overrides);
  return { ...execution, capture: overrides._capture, calls: overrides._runner.calls, fs: overrides.fs };
}

const RESET_ENV = Object.freeze({
  SMOKE_TEST_ADMIN_PASSWORD: 'fixture-admin',
  SMOKE_TEST_AGENT_A_PASSWORD: 'fixture-agent-a',
  SMOKE_TEST_AGENT_B_PASSWORD: 'fixture-agent-b'
});

async function healthyDoctorResult() {
  const fixture = localFixture.createEnvironment();
  return doctor.runDoctor({ now: '2026-08-08T08:00:00.000Z', deps: fixture.deps });
}

// The exact path verify.cjs's runtime-smoke-reset stage acquires the lock at,
// computed the same way resolveRuntimeLockFamilyRoot does, so a test can seed
// a pre-existing lock file at the right place.
function fixtureFamilyRoot() {
  return path.join(path.dirname(ROOT), '.worktrees');
}

function fixtureLockPath(operation = 'database-reset') {
  return path.join(fixtureFamilyRoot(), '.automation-locks', `${operation}.lock.json`);
}

/* ==================== wiring boundary ==================== */

test('without --allow-reset, no lock is acquired and no git common-dir lookup happens', async () => {
  const run = await runRuntimeTier({ runDoctor: async () => healthyDoctorResult() });
  assert.equal(run.result.stages.find(stage => stage.id === 'runtime-smoke-reset').status, 'skipped');
  assert.equal(run.calls.some(call => call.args.includes('--git-common-dir')), false);
  assert.equal(run.fs._files.size, 0);
});

test('every read-only stage above runtime-smoke-reset acquires nothing', async () => {
  const healthy = await healthyDoctorResult();
  const run = await runRuntimeTier({ options: { allowReset: false }, runDoctor: async () => healthy });
  assert.equal(run.exitCode, 0);
  for (const stage of run.result.stages) {
    if (stage.id === 'runtime-smoke-reset') continue;
    assert.notEqual(stage.status, 'blocked', `${stage.id} unexpectedly blocked`);
  }
  assert.equal(run.fs._files.size, 0, 'no lock file exists after a read-only run');
});

test('a successful destructive run acquires the lock at the resolved family root and releases it', async () => {
  const healthy = await healthyDoctorResult();
  let doctorCalls = 0;
  const run = await runRuntimeTier({
    options: { allowReset: true },
    env: RESET_ENV,
    runDoctor: async () => { doctorCalls += 1; return healthy; }
  });
  assert.equal(run.exitCode, 0);
  assert.equal(doctorCalls, 2);
  // The lock file must not still exist: it was acquired, then released in the
  // stage's own finally once the (fixture-faked) destructive command returned.
  assert.equal(run.fs._files.has(path.resolve(fixtureLockPath())), false);
  assert.ok(run.calls.some(call => call.args.includes('--git-common-dir')), 'family root must be resolved via --git-common-dir');
  const resetCall = run.calls.find(call => call.args.includes('-AllowDatabaseReset'));
  assert.ok(resetCall, 'the destructive wrapper must still run once the lock is held');
});

test('the lock is released when the destructive stage itself fails', async () => {
  const healthy = await healthyDoctorResult();
  const runner = createRunner(call => call.args.includes('-AllowDatabaseReset')
    ? commandResult(1, '', 'smoke wrapper failed')
    : null);
  const run = await runRuntimeTier({
    options: { allowReset: true },
    runner,
    env: RESET_ENV,
    runDoctor: async () => healthy
  });
  assert.equal(run.result.failureStage, 'runtime-smoke-reset');
  assert.notEqual(run.result.status, 'passed');
  assert.equal(run.fs._files.has(path.resolve(fixtureLockPath())), false, 'lock must be released even though the stage failed');
});

test('the lock is released when the destructive stage is interrupted mid-run', async () => {
  const healthy = await healthyDoctorResult();
  const controller = { interrupted: false, child: null };
  const runner = createRunner(call => {
    if (call.args.includes('-AllowDatabaseReset')) controller.interrupted = true;
    return null;
  });
  const run = await runRuntimeTier({
    options: { allowReset: true },
    runner,
    controller,
    env: RESET_ENV,
    runDoctor: async () => healthy
  });
  assert.equal(run.result.status, 'interrupted');
  assert.equal(run.fs._files.has(path.resolve(fixtureLockPath())), false, 'lock must be released even on interruption');
});

test('a live collision is refused as RUNTIME_LOCK_HELD with exit 2, never stolen, and the destructive command never runs', async () => {
  const healthy = await healthyDoctorResult();
  const fakeFs = createFakeLockFs();
  // Seed a lock file for the current process's own PID, so inspectRuntimeLock
  // reports it as live without needing a second real process.
  fakeFs.mkdirSync(path.dirname(fixtureLockPath()), { recursive: true });
  fakeFs.writeFileSync(fixtureLockPath(), JSON.stringify({
    schemaVersion: 1, operation: 'database-reset', ownerWorktree: 'other-worktree',
    pid: process.pid, processStart: null, acquiredAt: '2026-08-08T00:00:00.000Z', token: 'someone-elses-token'
  }), { encoding: 'utf8' });
  const run = await runRuntimeTier({
    options: { allowReset: true },
    fs: fakeFs,
    env: RESET_ENV,
    runDoctor: async () => healthy
  });
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.failureCode, 'RUNTIME_LOCK_HELD');
  assert.equal(run.calls.some(call => call.args.includes('-AllowDatabaseReset')), false, 'never steals: the destructive command must not run');
  // Preserved, not cleared: the seeded lock (with its foreign token) is exactly as written.
  const preserved = JSON.parse(fakeFs.readFileSync(path.resolve(fixtureLockPath())));
  assert.equal(preserved.token, 'someone-elses-token');
});

test('a stale collision (dead PID) is still refused, never auto-cleared, and the destructive command never runs', async () => {
  const healthy = await healthyDoctorResult();
  const fakeFs = createFakeLockFs();
  fakeFs.mkdirSync(path.dirname(fixtureLockPath()), { recursive: true });
  // A PID essentially guaranteed not to be alive.
  fakeFs.writeFileSync(fixtureLockPath(), JSON.stringify({
    schemaVersion: 1, operation: 'database-reset', ownerWorktree: 'other-worktree',
    pid: 999999, processStart: null, acquiredAt: '2026-08-08T00:00:00.000Z', token: 'stale-token'
  }), { encoding: 'utf8' });
  const run = await runRuntimeTier({
    options: { allowReset: true },
    fs: fakeFs,
    env: RESET_ENV,
    runDoctor: async () => healthy
  });
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.failureCode, 'RUNTIME_LOCK_HELD');
  assert.equal(run.calls.some(call => call.args.includes('-AllowDatabaseReset')), false);
  assert.ok(fakeFs._files.has(path.resolve(fixtureLockPath())), 'a stale lock is preserved, not cleared, so a human must inspect it');
});

test('a malformed lock file is preserved rather than cleared or overwritten', async () => {
  const healthy = await healthyDoctorResult();
  const fakeFs = createFakeLockFs();
  fakeFs.mkdirSync(path.dirname(fixtureLockPath()), { recursive: true });
  fakeFs.writeFileSync(fixtureLockPath(), 'not valid json{{{', { encoding: 'utf8' });
  const run = await runRuntimeTier({
    options: { allowReset: true },
    fs: fakeFs,
    env: RESET_ENV,
    runDoctor: async () => healthy
  });
  assert.equal(run.exitCode, verify.EXIT_BLOCKED);
  assert.equal(run.result.failureCode, 'RUNTIME_LOCK_HELD');
  assert.equal(fakeFs.readFileSync(path.resolve(fixtureLockPath())), 'not valid json{{{');
});

/* ==================== family-root parity (real Git fixtures) ==================== */

// Real Git fixtures, mirroring tests/agent-worktree.test.cjs: family-root
// parity across processes cannot be proven with mocked git output, since the
// whole point is that verify.cjs must compute the exact directory
// agent-worktree.cjs itself would read when it lists or removes a worktree.

const fixtureRoots = [];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function createRealFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-wiring-')));
  fixtureRoots.push(base);
  const repository = path.join(base, 'proyecto dashboard');
  fs.mkdirSync(repository);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.email', 'fixture@example.invalid');
  git(repository, 'config', 'user.name', 'Lock Wiring Fixture');
  git(repository, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repository, 'package.json'), `${JSON.stringify({ name: doctor.PACKAGE_NAME, version: '1.0.0' }, null, 2)}\n`);
  git(repository, 'add', '--', 'package.json');
  git(repository, 'commit', '-q', '-m', 'fixture base');
  return { base, repository };
}

async function realAsyncRunCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs || 30000, windowsHide: true, shell: false,
    env: options.env || process.env
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null
  };
}

test.after(() => {
  for (const root of fixtureRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('the family root verify.cjs computes from a linked worktree is the exact directory agent-worktree.cjs reads, and a lock taken there is visible to it', async () => {
  const fixture = createRealFixture();
  const capture = captureStreams();

  // Created the same way `npm run agent:worktree -- create` would: through
  // agent-worktree.cjs's own CLI, with no --parent override, so it lands at
  // the documented default (<repository-parent>/.worktrees/<repo-name>/<name>).
  const created = worktreeTool.main(
    ['create', '--name', 'locktest', '--role', 'claude', '--branch', 'feature/lock-parity', '--create-branch', '--json'],
    { repositoryRoot: fixture.repository, streams: capture.streams, now: () => new Date('2026-08-08T09:00:00.000Z'), randomToken: () => 'lockparitytoken0001' }
  );
  assert.equal(created, 0);
  const createdPayload = JSON.parse(capture.stdout());
  const linkedWorktreePath = createdPayload.path;
  assert.ok(fs.existsSync(linkedWorktreePath));

  // verify.cjs's side: resolve the family root as if running from inside the
  // linked worktree, exactly as `npm run verify:runtime -- --allow-reset`
  // would if invoked from an automation worktree.
  const familyRootFromVerify = await verify.resolveRuntimeLockFamilyRoot({
    repository: { root: linkedWorktreePath },
    deps: { runCommand: realAsyncRunCommand, env: process.env, fs, platform: process.platform }
  });

  // agent-worktree.cjs's side: the family root it would derive on its own,
  // from the primary repository, for its documented default parent.
  const coreDeps = automationCore.createDeps({ repositoryRoot: fixture.repository });
  const listingBefore = worktreeTool.listWorktreeRecords(coreDeps, { parent: null });
  const familyRootFromWorktreeTool = path.dirname(path.resolve(listingBefore.parent));
  assert.equal(familyRootFromVerify, familyRootFromWorktreeTool);

  // Acquire a real lock at the family root verify.cjs computed, using the
  // unchanged automation-core primitive, then confirm agent-worktree.cjs's
  // own listing (run independently, from the primary repository) sees it.
  const lock = automationCore.acquireRuntimeLock(coreDeps, familyRootFromVerify, 'database-reset', {
    ownerWorktree: linkedWorktreePath
  });
  try {
    const listingAfter = worktreeTool.listWorktreeRecords(coreDeps, { parent: null });
    const seen = listingAfter.runtimeLocks.find(entry => entry.operation === 'database-reset');
    assert.ok(seen, 'agent-worktree.cjs must see the lock verify.cjs acquired');
    assert.equal(seen.live, true);
    assert.equal(seen.ownerWorktree, linkedWorktreePath);
  } finally {
    automationCore.releaseRuntimeLock(coreDeps, familyRootFromVerify, lock);
  }
});

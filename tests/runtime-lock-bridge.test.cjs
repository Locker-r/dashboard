'use strict';

// M-2B2b: the remaining destructive runtime entry point — `npm run smoke`
// (scripts/dev/smoke.ps1), invoked directly rather than through
// `verify:runtime` — now respects the same shared advisory database-reset
// lock via this thin CLI bridge (scripts/dev/runtime-lock.cjs). The lock
// primitives it calls (acquireRuntimeLock/releaseRuntimeLock) are unchanged
// and already covered by tests/agent-worktree.test.cjs; this file covers
// only the bridge's own CLI behaviour, and a source-level check that
// smoke.ps1 actually wires it in at the right boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const automationCore = require('../scripts/dev/automation-core.cjs');
const runtimeLock = require('../scripts/dev/runtime-lock.cjs');

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\lock bridge dashboard' : '/srv/lock bridge dashboard');
const FIXTURE_GIT_COMMON_DIR = path.join(ROOT, '.git');

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: { stdout: { write: v => { stdout += String(v); } }, stderr: { write: v => { stderr += String(v); } } },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

// Same in-memory lock filesystem used by tests/runtime-lock-wiring.test.cjs
// and tests/verification-tiers.test.cjs — kept as its own local copy since
// none of those files export test helpers.
function createFakeLockFs() {
  const files = new Map();
  const dirs = new Set();
  const norm = target => path.resolve(String(target));
  const notFound = (op, target) => { const e = new Error(`ENOENT: ${op} '${target}'`); e.code = 'ENOENT'; return e; };
  return {
    mkdirSync(target, options = {}) {
      const resolved = norm(target);
      if (!options.recursive) { dirs.add(resolved); return; }
      let current = path.parse(resolved).root;
      for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); dirs.add(current); }
    },
    writeFileSync(target, content, options = {}) {
      const resolved = norm(target);
      if (options && options.flag === 'wx' && files.has(resolved)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      files.set(resolved, String(content));
      dirs.add(path.dirname(resolved));
    },
    readFileSync(target) { const resolved = norm(target); if (!files.has(resolved)) throw notFound('open', resolved); return files.get(resolved); },
    rmSync(target, options = {}) {
      const resolved = norm(target);
      if (!files.has(resolved)) { if (options && options.force) return; throw notFound('unlink', resolved); }
      files.delete(resolved);
    },
    lstatSync(target) {
      const resolved = norm(target);
      if (files.has(resolved)) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(resolved)) return { isFile: () => false, isDirectory: () => true };
      throw notFound('lstat', resolved);
    },
    realpathSync(target) { const resolved = norm(target); if (files.has(resolved) || dirs.has(resolved)) return resolved; throw notFound('realpath', resolved); },
    _files: files
  };
}

function fakeDeps(overrides = {}) {
  const runCommand = async (file, args) => {
    if (file === 'git' && args.includes('--git-common-dir')) return { status: 0, stdout: `${FIXTURE_GIT_COMMON_DIR}\n` };
    return { status: 0, stdout: '' };
  };
  return automationCore.createDeps({
    fs: overrides.fs || createFakeLockFs(),
    platform: 'win32',
    runCommand,
    randomToken: () => 'bridgetesttoken0001',
    ...overrides
  });
}

/* ==================== CLI parsing ==================== */

test('parseArgs requires a known command and --operation, and rejects unknown options', () => {
  assert.throws(() => runtimeLock.parseArgs([]), error => error.code === 'COMMAND_INVALID');
  assert.throws(() => runtimeLock.parseArgs(['bogus']), error => error.code === 'COMMAND_INVALID');
  assert.throws(() => runtimeLock.parseArgs(['acquire']), error => error.code === 'OPERATION_REQUIRED');
  assert.throws(() => runtimeLock.parseArgs(['acquire', '--operation', 'database-reset', '--unknown']), error => error.code === 'OPTION_INVALID');
  const options = runtimeLock.parseArgs(['acquire', '--operation', 'database-reset', '--owner', 'me']);
  assert.equal(options.command, 'acquire');
  assert.equal(options.operation, 'database-reset');
  assert.equal(options.owner, 'me');
});

test('--help short-circuits before any command is required', () => {
  assert.deepEqual(runtimeLock.parseArgs(['--help']), { help: true, command: null });
});

/* ==================== acquire / release round trip ==================== */

test('acquire prints {path, token} on success, and release then reports released:true', async () => {
  const capture = captureStreams();
  const deps = fakeDeps();
  const acquireExit = await runtimeLock.main(['acquire', '--operation', 'database-reset', '--owner', 'test'], { deps, streams: capture.streams });
  assert.equal(acquireExit, automationCore.EXIT_OK);
  const acquired = JSON.parse(capture.stdout());
  assert.ok(acquired.path);
  assert.ok(acquired.token);
  assert.equal(acquired.operation, 'database-reset');

  const releaseCapture = captureStreams();
  const releaseExit = await runtimeLock.main(
    ['release', '--operation', 'database-reset', '--path', acquired.path, '--token', acquired.token],
    { deps, streams: releaseCapture.streams }
  );
  assert.equal(releaseExit, automationCore.EXIT_OK);
  assert.deepEqual(JSON.parse(releaseCapture.stdout()), { released: true });
});

test('a collision refuses with RUNTIME_LOCK_HELD and exit 2, and never steals the lock', async () => {
  const deps = fakeDeps();
  const first = captureStreams();
  await runtimeLock.main(['acquire', '--operation', 'database-reset'], { deps, streams: first.streams });
  const second = captureStreams();
  const exitCode = await runtimeLock.main(['acquire', '--operation', 'database-reset'], { deps, streams: second.streams });
  assert.equal(exitCode, automationCore.EXIT_BLOCKED);
  assert.match(second.stderr(), /RUNTIME_LOCK_HELD/);
});

test('release requires both --path and --token', async () => {
  const deps = fakeDeps();
  const capture = captureStreams();
  const exitCode = await runtimeLock.main(['release', '--operation', 'database-reset', '--path', '/x'], { deps, streams: capture.streams });
  assert.equal(exitCode, automationCore.EXIT_USAGE);
});

test('release preserves a foreign-token lock rather than removing it', async () => {
  const deps = fakeDeps();
  const acquireCapture = captureStreams();
  await runtimeLock.main(['acquire', '--operation', 'database-reset'], { deps, streams: acquireCapture.streams });
  const acquired = JSON.parse(acquireCapture.stdout());
  const releaseCapture = captureStreams();
  await runtimeLock.main(
    ['release', '--operation', 'database-reset', '--path', acquired.path, '--token', 'not-the-real-token'],
    { deps, streams: releaseCapture.streams }
  );
  const result = JSON.parse(releaseCapture.stdout());
  assert.equal(result.released, false);
  assert.ok(deps.fs.readFileSync(path.resolve(acquired.path)), 'the foreign lock must still exist');
});

/* ==================== smoke.ps1 wiring (source-level) ==================== */

test('smoke.ps1 acquires the lock via the bridge before the destructive wrapper, releases in finally, and skips when the caller already holds it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev', 'smoke.ps1'), 'utf8');
  assert.match(source, /RUNTIME_LOCK_ALREADY_HELD/);
  assert.match(source, /\$bridge\s*=\s*Join-Path\s+\$PSScriptRoot\s+'runtime-lock\.cjs'/);
  assert.match(source, /\$bridge\s+acquire\s+--operation\s+database-reset/);
  assert.match(source, /\$bridge\s+release\s+--operation\s+database-reset/);
  const funcStart = source.indexOf('function Invoke-DestructiveRuntimeSmoke');
  const funcEnd = source.indexOf('\n$root=Get-GitRoot');
  assert.ok(funcStart >= 0 && funcEnd > funcStart);
  const body = source.slice(funcStart, funcEnd);
  const skipCheckIndex = body.indexOf('RUNTIME_LOCK_ALREADY_HELD');
  const tryIndex = body.indexOf('try {');
  const finallyIndex = body.indexOf('} finally {');
  assert.ok(skipCheckIndex >= 0 && skipCheckIndex < tryIndex, 'the skip check must happen before the guarded invocation');
  assert.ok(tryIndex >= 0 && finallyIndex > tryIndex, 'the destructive invocation must be wrapped in try/finally so release always runs');
  assert.match(body.slice(finallyIndex), /release --operation database-reset/);
});

test('verify.cjs tells smoke.ps1 it already holds the lock, in the same environment the destructive stage passes down', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev', 'verify.cjs'), 'utf8');
  assert.match(source, /copy\.RUNTIME_LOCK_ALREADY_HELD\s*=\s*'1'/);
});

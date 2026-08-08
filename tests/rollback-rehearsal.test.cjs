'use strict';

// scripts/release/rollback-rehearsal.cjs proves a candidate rollback target
// is usable (annotated tag, ancestor of main, has its own successful
// production deploy, rebuilds to the expected bytes) and then only prints
// the human rollback sequence — it never invokes wrangler, never calls
// Cloudflare, never creates/moves/pushes a tag, never dispatches a workflow.
// These tests use injected git/gh/fetch stubs only — no real network call is
// ever made, and no mutating command is ever satisfied by the stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const rehearsal = require('../scripts/release/rollback-rehearsal.cjs');
const verifier = require('../scripts/verify-production-deployment.cjs');
const artifact = require('../scripts/build-pages-artifact.cjs');

const TARGET = 'v1.2.3';
const TARGET_SHA = 'a'.repeat(40);
const APPLICATION = 'reactivation-desk-dashboard';
const LOCAL_SUPABASE_TAG = '<script src="./config/supabase-config.local.js"></script>';
const LOCAL_DATA_TAG = '<script src="./config/data-config.local.js"></script>';

function fakeSourceTree() {
  const tree = new Map();
  tree.set('package.json', JSON.stringify({ name: APPLICATION, version: '1.2.3' }));
  tree.set('index.html', `<!doctype html>\n<html>\n${LOCAL_SUPABASE_TAG}\n${LOCAL_DATA_TAG}\n</html>\n`);
  for (const file of artifact.RUNTIME_SOURCE_FILES) tree.set(file, `// fixture content for ${file}\n`);
  return tree;
}

function reproducedBytes(relativePath, sourceTree) {
  const raw = Buffer.from(sourceTree.get(relativePath), 'utf8');
  const normalized = artifact.normalizeText(raw, relativePath);
  const content = relativePath === 'index.html' ? artifact.transformIndex(normalized) : normalized;
  return Buffer.from(content, 'utf8');
}

function successRun(overrides = {}) {
  return { id: 5001, status: 'completed', conclusion: 'success', event: 'push', head_branch: TARGET, head_sha: TARGET_SHA, html_url: 'https://example.invalid/run', ...overrides };
}

// Same shape as the verifier's own test fake: an unexpected command throws,
// which is exactly how "no wrangler/tag/push call ever happens" is proven —
// the stub has no branch that would satisfy one.
function fakeRun({ tags = { [TARGET]: { sha: TARGET_SHA, annotated: true, ancestor: true } }, sourceTree, runsResponse = [successRun()] } = {}) {
  return (command, args, options = {}) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      const spec = String(args[3] || '');
      const tag = spec.replace('^{commit}', '');
      const entry = tags[tag];
      return entry ? { status: 0, stdout: `${entry.sha}\n` } : { status: 1, stdout: '' };
    }
    if (command === 'git' && args[0] === 'cat-file' && args[1] === '-t') {
      const entry = tags[args[2]];
      if (!entry) return { status: 1, stdout: '' };
      return { status: 0, stdout: `${entry.annotated ? 'tag' : 'commit'}\n` };
    }
    if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const sha = args[2];
      const entry = Object.values(tags).find(candidate => candidate.sha === sha);
      return { status: entry && entry.ancestor !== false ? 0 : 1, stdout: '' };
    }
    if (command === 'git' && args[0] === 'show') {
      const spec = args[1];
      const relativePath = spec.slice(spec.indexOf(':') + 1);
      const content = sourceTree.get(relativePath);
      if (content === undefined) return { status: 1, stdout: options.encoding === null ? Buffer.alloc(0) : '' };
      const buffer = Buffer.from(content, 'utf8');
      return { status: 0, stdout: options.encoding === null ? buffer : content };
    }
    if (command === 'gh' && args[0] === 'api') {
      if (runsResponse instanceof Error) return { status: 1, stderr: runsResponse.message };
      return { status: 0, stdout: JSON.stringify({ workflow_runs: runsResponse }) };
    }
    throw new Error(`unexpected command in test: ${command} ${(args || []).join(' ')}`);
  };
}

function buildWorld(options = {}) {
  const { target = TARGET, version = '1.2.3', sourceTree = fakeSourceTree(), tags, runsResponse, live = true } = options;

  const files = [];
  const liveBytes = new Map();
  for (const relativePath of artifact.SOURCE_FILES) {
    const bytes = reproducedBytes(relativePath, sourceTree);
    files.push({ path: relativePath, size: bytes.length, sha256: artifact.sha256(bytes) });
    liveBytes.set(relativePath, bytes);
  }
  const nojekyllBytes = Buffer.alloc(0);
  files.push({ path: '.nojekyll', size: 0, sha256: artifact.sha256(nojekyllBytes) });
  const runtimeConfigBytes = Buffer.from('window.__RUNTIME_CONFIG__ = {};\n', 'utf8');
  files.push({ path: artifact.RUNTIME_CONFIG_PATH, size: runtimeConfigBytes.length, sha256: artifact.sha256(runtimeConfigBytes) });

  const manifest = { schemaVersion: 1, application: APPLICATION, version, files };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');

  const run = fakeRun({ tags: tags || { [target]: { sha: TARGET_SHA, annotated: true, ancestor: true } }, sourceTree, runsResponse });

  const fetchUrl = async url => {
    if (!live) throw new Error('ECONNREFUSED');
    if (url === `https://dashboard-latam.pages.dev/${artifact.MANIFEST_PATH}`) return { status: 200, body: manifestBuffer };
    const relativePath = url.replace('https://dashboard-latam.pages.dev/', '');
    const bytes = liveBytes.get(relativePath);
    if (bytes === undefined) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: bytes };
  };

  return { run, fetchUrl, sourceTree };
}

/* ==================== fixed exit codes ==================== */

test('the exit code set is fixed and matches the verifier', () => {
  assert.deepEqual(rehearsal.EXIT, { OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });
  assert.deepEqual(rehearsal.EXIT, verifier.EXIT);
});

test('missing --target is a usage error', async () => {
  const status = await rehearsal.main([], { run() { throw new Error('must not be called'); }, log() {}, emit() {} });
  assert.equal(status, rehearsal.EXIT.USAGE);
});

test('a malformed target is a validation error', async () => {
  const status = await rehearsal.main(['--target', 'not-a-tag'], { run() { throw new Error('must not be called'); }, log() {}, emit() {} });
  assert.equal(status, rehearsal.EXIT.VALIDATION);
});

/* ==================== target provenance ==================== */

test('an unresolvable target tag is refused', async () => {
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ tags: {}, runsResponse: [successRun()] }), fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

test('a lightweight (non-annotated) rollback target is refused', async () => {
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ tags: { [TARGET]: { sha: TARGET_SHA, annotated: false, ancestor: true } }, runsResponse: [successRun()] }),
    fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

test('a target that is not an ancestor of origin/main is refused', async () => {
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ tags: { [TARGET]: { sha: TARGET_SHA, annotated: true, ancestor: false } }, runsResponse: [successRun()] }),
    fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

test('a target with no successful prior production deploy run is refused', async () => {
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ runsResponse: [] }), fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

test('a target whose only run is for a different tag is refused', async () => {
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ runsResponse: [successRun({ head_branch: 'v9.9.9', head_sha: 'b'.repeat(40) })] }),
    fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

test('a target whose package.json version does not match the tag is refused', async () => {
  const sourceTree = fakeSourceTree();
  sourceTree.set('package.json', JSON.stringify({ name: APPLICATION, version: '9.9.9' }));
  const status = await rehearsal.main(['--target', TARGET], {
    run: fakeRun({ sourceTree, runsResponse: [successRun()] }), fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.BLOCKED);
});

/* ==================== success: proves usable, prints the sequence, executes nothing ==================== */

test('a fully valid target is proved usable and the human sequence is printed', async () => {
  const world = buildWorld();
  const logs = [];
  const status = await rehearsal.main(['--target', TARGET], { run: world.run, fetchUrl: world.fetchUrl, log: line => logs.push(line), emit() {} });
  assert.equal(status, rehearsal.EXIT.OK);
  const joined = logs.join('\n');
  assert.ok(joined.includes('git revert'));
  assert.ok(joined.includes('git tag -a'));
  assert.ok(joined.includes('production'));
  assert.ok(joined.includes('verify-production-deployment.cjs'));
});

test('the rehearsal succeeds even when the live site is unreachable — rollback is rehearsed precisely when production may be broken', async () => {
  const world = buildWorld({ live: false });
  const logs = [];
  const status = await rehearsal.main(['--target', TARGET], { run: world.run, fetchUrl: world.fetchUrl, log: line => logs.push(line), emit() {} });
  assert.equal(status, rehearsal.EXIT.OK);
  assert.ok(logs.some(line => line.toLowerCase().includes('live comparison')));
});

test('--json emits a schemaVersion-carrying envelope including the printable sequence', async () => {
  const world = buildWorld();
  let emitted = null;
  const status = await rehearsal.main(['--target', TARGET, '--json'], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit: line => { emitted = line; } });
  assert.equal(status, rehearsal.EXIT.OK);
  const parsed = JSON.parse(emitted);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 'REHEARSAL_PROVED_USABLE');
  assert.ok(Array.isArray(parsed.sequence));
  assert.ok(parsed.sequence.join('\n').includes('git tag -a'));
});

/* ==================== no mutation, ever ==================== */

test('the rehearsal never invokes wrangler, npx, or any Cloudflare command', async () => {
  const world = buildWorld();
  const commands = [];
  const status = await rehearsal.main(['--target', TARGET], {
    run: (command, args, options) => { commands.push([command, args]); return world.run(command, args, options); },
    fetchUrl: world.fetchUrl, log() {}, emit() {}
  });
  assert.equal(status, rehearsal.EXIT.OK);
  for (const [command] of commands) {
    assert.notEqual(command, 'wrangler');
    assert.notEqual(command, 'npx');
  }
});

test('the rehearsal never creates, moves, or pushes a tag, and never dispatches a workflow', async () => {
  const world = buildWorld();
  const commands = [];
  await rehearsal.main(['--target', TARGET], {
    run: (command, args, options) => { commands.push([command, args]); return world.run(command, args, options); },
    fetchUrl: world.fetchUrl, log() {}, emit() {}
  });
  for (const [command, args] of commands) {
    if (command === 'git') {
      assert.ok(['rev-parse', 'cat-file', 'merge-base', 'show'].includes(args[0]), `unexpected git subcommand: ${args[0]}`);
    }
    if (command === 'gh') {
      assert.notEqual(args[0], 'workflow');
      assert.notEqual(args.join(' ').includes('workflow_dispatch'), true);
    }
  }
});

test('the gh api call is an unambiguous GET with no mutating flag', async () => {
  const world = buildWorld();
  const calls = [];
  await rehearsal.main(['--target', TARGET], {
    run: (command, args, options) => { calls.push([command, args]); return world.run(command, args, options); },
    fetchUrl: world.fetchUrl, log() {}, emit() {}
  });
  const ghCall = calls.find(([command]) => command === 'gh');
  assert.ok(ghCall);
  for (const flag of ['-f', '-F', '--field', '--raw-field', '-X', '--method']) {
    assert.ok(!ghCall[1].includes(flag), `gh api call must not use ${flag}`);
  }
});

test('no secret-shaped value ever appears in log, emit, or the printed sequence', async () => {
  const world = buildWorld();
  const outputs = [];
  await rehearsal.main(['--target', TARGET], { run: world.run, fetchUrl: world.fetchUrl, log: line => outputs.push(line), emit: line => outputs.push(line) });
  const joined = outputs.join('\n');
  for (const pattern of [/CLOUDFLARE_API_TOKEN/, /CLOUDFLARE_ACCOUNT_ID/, /sb_secret_/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]) {
    assert.ok(!pattern.test(joined), `output must not contain ${pattern}`);
  }
});

test('the printed sequence never contains a ready-to-run mutating command line — every git tag/push line is illustrative, not argv', () => {
  const sequence = rehearsal.humanRollbackSequence(TARGET);
  const joined = sequence.join('\n');
  assert.ok(joined.includes('git tag -a v<newVersion>'));
  assert.ok(joined.includes('git push origin v<newVersion>'));
  assert.ok(joined.includes('Break-glass'));
  assert.ok(joined.toLowerCase().includes('cloudflare dashboard'));
});

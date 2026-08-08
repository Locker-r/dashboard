'use strict';

// scripts/verify-production-deployment.cjs proves three independent facts
// about a released tag without ever holding a Cloudflare or Supabase
// credential: run provenance (a successful production-pages-deploy.yml run
// for the exact tag), byte provenance (the live manifest matches what the
// tagged commit would produce), and liveness (every listed file actually
// serves matching bytes). These tests use injected git/gh/fetch stubs only —
// no real network call is ever made.

const test = require('node:test');
const assert = require('node:assert/strict');
const verifier = require('../scripts/verify-production-deployment.cjs');
const artifact = require('../scripts/build-pages-artifact.cjs');

const TAG = 'v1.2.3';
const TAG_SHA = 'a'.repeat(40);
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
  return { id: 5001, status: 'completed', conclusion: 'success', event: 'push', head_branch: TAG, head_sha: TAG_SHA, html_url: 'https://example.invalid/run', ...overrides };
}

// A fake git+gh dispatcher, in the same shape as
// tests/verify-staging-smoke-evidence.test.cjs's fakeRun: an unexpected
// command throws, which is how "no wrangler/Cloudflare/tag/push call ever
// happens" is proven — the stub has no such branch to satisfy one.
function fakeRun({ tags = { [TAG]: { sha: TAG_SHA, annotated: true } }, sourceTree, runsResponse = [successRun()] } = {}) {
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
      const separatorIndex = spec.indexOf(':');
      const relativePath = spec.slice(separatorIndex + 1);
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

// Builds a self-consistent fake world: source content, the manifest that
// would be live at dashboard-latam.pages.dev, and the bytes each file path
// actually serves — then applies one optional mutation so tests can prove a
// specific failure mode. Bytes and hashes are computed independently of
// verify-production-deployment.cjs's own rebuildExpectedHashes, using the
// same underlying build-pages-artifact.cjs primitives directly, so a passing
// comparison test is not tautological against the code under test.
function buildWorld(options = {}) {
  const {
    tag = TAG, version = '1.2.3', sourceTree = fakeSourceTree(), tags, runsResponse,
    mutateManifest = null, mutateFileHash = null, dropFileFromManifest = null,
    extraManifestFile = null, brokenLiveAsset = null
  } = options;

  const files = [];
  const liveBytes = new Map();
  for (const relativePath of artifact.SOURCE_FILES) {
    const bytes = reproducedBytes(relativePath, sourceTree);
    files.push({ path: relativePath, size: bytes.length, sha256: artifact.sha256(bytes) });
    liveBytes.set(relativePath, bytes);
  }
  const nojekyllBytes = Buffer.alloc(0);
  files.push({ path: '.nojekyll', size: 0, sha256: artifact.sha256(nojekyllBytes) });
  liveBytes.set('.nojekyll', nojekyllBytes);
  const runtimeConfigBytes = Buffer.from('window.__RUNTIME_CONFIG__ = { projectUrl: "https://example.supabase.co", publishableKey: "sb_publishable_example" };\n', 'utf8');
  files.push({ path: artifact.RUNTIME_CONFIG_PATH, size: runtimeConfigBytes.length, sha256: artifact.sha256(runtimeConfigBytes) });
  liveBytes.set(artifact.RUNTIME_CONFIG_PATH, runtimeConfigBytes);

  if (mutateFileHash) {
    const entry = files.find(file => file.path === mutateFileHash);
    if (entry) entry.sha256 = 'f'.repeat(64);
  }
  if (dropFileFromManifest) {
    const index = files.findIndex(file => file.path === dropFileFromManifest);
    if (index >= 0) files.splice(index, 1);
  }
  if (extraManifestFile) {
    files.push({ path: extraManifestFile, size: 1, sha256: 'e'.repeat(64) });
  }

  let manifest = { schemaVersion: 1, application: APPLICATION, version, files };
  if (mutateManifest) manifest = mutateManifest(manifest);
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');

  const run = fakeRun({ tags: tags || { [tag]: { sha: TAG_SHA, annotated: true } }, sourceTree, runsResponse });

  const fetchUrl = async url => {
    if (url === `https://dashboard-latam.pages.dev/${artifact.MANIFEST_PATH}`) {
      return { status: 200, body: manifestBuffer };
    }
    const relativePath = url.replace('https://dashboard-latam.pages.dev/', '');
    if (brokenLiveAsset && relativePath === brokenLiveAsset) {
      return { status: 404, body: Buffer.alloc(0) };
    }
    const bytes = liveBytes.get(relativePath);
    if (bytes === undefined) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: bytes };
  };

  return { run, fetchUrl, sourceTree };
}

/* ==================== fixed exit codes ==================== */

test('the exit code set is fixed', () => {
  assert.deepEqual(verifier.EXIT, { OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });
});

test('missing --tag is a usage error', async () => {
  const status = await verifier.main([], { run() { throw new Error('must not be called'); }, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.USAGE);
});

test('an unsupported argument is a usage error', async () => {
  const status = await verifier.main(['--bogus'], { run() { throw new Error('must not be called'); }, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.USAGE);
});

test('a malformed tag is a validation error, not a blocked/internal one', async () => {
  const status = await verifier.main(['--tag', 'v1.2'], { run() { throw new Error('must not be called'); }, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.VALIDATION);
});

/* ==================== A. run provenance ==================== */

test('no deployment yet: an empty run list fails closed with NO_PRODUCTION_DEPLOYMENT_YET, not a vacuous pass', async () => {
  const logs = [];
  const status = await verifier.main(['--tag', TAG], { run: fakeRun({ runsResponse: [] }), log: line => logs.push(line), emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
  assert.ok(logs.some(line => line.includes('NO_PRODUCTION_DEPLOYMENT_YET')));
});

test('a failed run for the tag is refused, not treated as a deployment', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ runsResponse: [successRun({ conclusion: 'failure' })] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a cancelled/in-progress run for the tag is refused', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ runsResponse: [successRun({ status: 'in_progress', conclusion: null })] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a successful run for a different ref (not this tag) is refused', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ runsResponse: [successRun({ head_branch: 'main', event: 'push' })] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a successful run whose head_sha does not match the tag is refused', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ runsResponse: [successRun({ head_sha: 'b'.repeat(40) })] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('an unresolvable tag is refused before the API is even consulted for qualification', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ tags: {}, runsResponse: [successRun()] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a lightweight (non-annotated) tag is refused', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ tags: { [TAG]: { sha: TAG_SHA, annotated: false } }, runsResponse: [successRun()] }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('the gh api call targets exactly production-pages-deploy.yml, as an unambiguous GET', async () => {
  const calls = [];
  await verifier.main(['--tag', TAG], {
    run: (command, args, options) => {
      calls.push([command, args]);
      return fakeRun({ runsResponse: [successRun()] })(command, args, options);
    },
    fetchUrl: async () => ({ status: 404, body: Buffer.alloc(0) }),
    log() {}, emit() {}
  });
  const ghCall = calls.find(([command]) => command === 'gh');
  assert.ok(ghCall);
  assert.match(ghCall[1].join(' '), /repos\/Locker-r\/dashboard\/actions\/workflows\/production-pages-deploy\.yml\/runs/);
  for (const flag of ['-f', '-F', '--field', '--raw-field', '-X', '--method']) {
    assert.ok(!ghCall[1].includes(flag), `gh api call must not use ${flag}`);
  }
});

test('a gh api failure fails closed as internal, not open', async () => {
  const status = await verifier.main(['--tag', TAG], {
    run: fakeRun({ runsResponse: new Error('rate limited') }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.INTERNAL);
});

/* ==================== B. byte provenance ==================== */

test('a live manifest that is unreachable is refused, not skipped', async () => {
  const world = buildWorld();
  const status = await verifier.main(['--tag', TAG], {
    run: world.run, fetchUrl: async () => ({ status: 503, body: Buffer.alloc(0) }), log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a live manifest version that does not match the tag is refused', async () => {
  const world = buildWorld({ mutateManifest: manifest => ({ ...manifest, version: '9.9.9' }) });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a live manifest application name that does not match is refused', async () => {
  const world = buildWorld({ mutateManifest: manifest => ({ ...manifest, application: 'some-other-app' }) });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('any single reproducible file hash mismatch is refused', async () => {
  const world = buildWorld({ mutateFileHash: 'src/domain.js' });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a live manifest missing a required file is refused', async () => {
  const world = buildWorld({ dropFileFromManifest: 'src/auth.js' });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a live manifest listing an unexpected extra file is refused', async () => {
  const world = buildWorld({ extraManifestFile: 'src/unexpected-file.js' });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

/* ==================== C. liveness ==================== */

test('a listed file that does not serve (non-200) is refused', async () => {
  const world = buildWorld({ brokenLiveAsset: 'src/domain.js' });
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit() {} });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

test('a fetch that throws (network failure) is refused, not treated as pass', async () => {
  const world = buildWorld();
  const status = await verifier.main(['--tag', TAG], {
    run: world.run,
    fetchUrl: async url => {
      if (url.endsWith('deployment-manifest.json')) return world.fetchUrl(url);
      throw new Error('ECONNRESET');
    },
    log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.BLOCKED);
});

/* ==================== success ==================== */

test('a fully consistent world verifies successfully', async () => {
  const world = buildWorld();
  const logs = [];
  const status = await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log: line => logs.push(line), emit() {} });
  assert.equal(status, verifier.EXIT.OK);
  assert.ok(logs.some(line => line.includes('VERIFIED')));
});

test('--json emits a schemaVersion-carrying envelope on success', async () => {
  const world = buildWorld();
  let emitted = null;
  const status = await verifier.main(['--tag', TAG, '--json'], { run: world.run, fetchUrl: world.fetchUrl, log() {}, emit: line => { emitted = line; } });
  assert.equal(status, verifier.EXIT.OK);
  const parsed = JSON.parse(emitted);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, 'VERIFIED');
});

/* ==================== no secrets, no mutation ==================== */

test('no secret-shaped value ever appears in log or emit output', async () => {
  const world = buildWorld();
  const outputs = [];
  await verifier.main(['--tag', TAG], { run: world.run, fetchUrl: world.fetchUrl, log: line => outputs.push(line), emit: line => outputs.push(line) });
  const joined = outputs.join('\n');
  for (const pattern of [/CLOUDFLARE_API_TOKEN/, /CLOUDFLARE_ACCOUNT_ID/, /sb_secret_/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]) {
    assert.ok(!pattern.test(joined), `output must not contain ${pattern}`);
  }
});

test('only git (read-only subcommands) and gh api (GET) are ever invoked — no wrangler, no tag/push mutation', async () => {
  const world = buildWorld();
  const commands = [];
  const status = await verifier.main(['--tag', TAG], {
    run: (command, args, options) => { commands.push([command, args]); return world.run(command, args, options); },
    fetchUrl: world.fetchUrl, log() {}, emit() {}
  });
  assert.equal(status, verifier.EXIT.OK);
  for (const [command, args] of commands) {
    assert.notEqual(command, 'wrangler');
    assert.notEqual(command, 'npx');
    if (command === 'git') {
      assert.ok(['rev-parse', 'cat-file', 'merge-base', 'show'].includes(args[0]), `unexpected git subcommand: ${args[0]}`);
      assert.notEqual(args[0], 'tag');
      assert.notEqual(args[0], 'push');
    }
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const builder = require('../scripts/build-pages-artifact.cjs');

const VALID_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const OTHER_VALID_URL = 'https://zyxwvutsrqponmlkjihg.supabase.co';
const VALID_KEY = 'sb_publishable_abcdefghijklmnopqrstuvwxyz012345';
const OTHER_VALID_KEY = 'sb_publishable_zyxwvutsrqponmlkjihg987654';

function fixtureScript(relativePath) {
  const name = relativePath.replace(/[^a-z0-9]+/gi, '_');
  return `(function ${name}(root) { root.${name} = true; })(typeof globalThis !== 'undefined' ? globalThis : this);\n`;
}

function fixtureIndex() {
  const runtimeTags = builder.RUNTIME_SOURCE_FILES
    .map(relativePath => `<script src="./${relativePath}"></script>`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">',
    '</head>',
    '<body>',
    '<script src="./config/supabase-config.local.js"></script>',
    '<script src="./config/data-config.local.js"></script>',
    runtimeTags,
    '<script>globalThis.fixtureBooted = true;</script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function writeText(target, value, lineEnding = '\n') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value.replace(/\r\n?/g, '\n').replace(/\n/g, lineEnding), 'utf8');
}

function withMixedLineEndings(value) {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line, index) => {
    if (index === lines.length - 1) return line;
    return `${line}${['\n', '\r\n', '\r'][index % 3]}`;
  }).join('');
}

function createFixture(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-artifact-'));
  const sourceRoot = path.join(base, 'source');
  const outputParent = path.join(base, 'output');
  const outputDirectory = path.join(outputParent, 'pages-site');
  const lineEnding = options.lineEnding || '\n';
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(outputParent, { recursive: true });
  writeText(
    path.join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: 'fixture-dashboard', version: '9.8.7' }, null, 2)}\n`,
    lineEnding
  );
  writeText(path.join(sourceRoot, 'index.html'), fixtureIndex(), lineEnding);
  for (const relativePath of builder.RUNTIME_SOURCE_FILES) {
    writeText(path.join(sourceRoot, ...relativePath.split('/')), fixtureScript(relativePath), lineEnding);
  }
  return { base, sourceRoot, outputParent, outputDirectory };
}

function withFixture(callback, options = {}) {
  const fixture = createFixture(options);
  try {
    return callback(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

function validBuildOptions(fixture, overrides = {}) {
  return {
    sourceRoot: fixture.sourceRoot,
    outputDirectory: fixture.outputDirectory,
    projectUrl: VALID_URL,
    publishableKey: VALID_KEY,
    ...overrides
  };
}

function listTree(root) {
  const files = [];
  const directories = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  }
  visit(root);
  return { files: files.sort(), directories: directories.sort() };
}

function snapshotFiles(root) {
  const snapshot = {};
  const tree = listTree(root);
  for (const relativePath of tree.files) {
    snapshot[relativePath] = fs.readFileSync(path.join(root, ...relativePath.split('/'))).toString('base64');
  }
  return { directories: tree.directories, files: snapshot };
}

function rewriteManifest(fixture) {
  const metadata = builder.readApplicationMetadata(fixture.sourceRoot);
  const manifest = builder.createManifest(fixture.outputDirectory, metadata);
  fs.writeFileSync(
    path.join(fixture.outputDirectory, builder.MANIFEST_PATH),
    builder.canonicalJson(manifest),
    'utf8'
  );
}

function expectArtifactError(callback, code) {
  assert.throws(callback, error => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function essentialEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

function directoryIdentity(target) {
  const info = fs.lstatSync(target, { bigint: true });
  return Object.freeze({ dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs });
}

function assertDirectoryIdentity(target, expected) {
  assert.deepEqual(directoryIdentity(target), expected);
}

function identityIfPresent(target) {
  try {
    return directoryIdentity(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function createOperationLedger() {
  const operations = [];
  return Object.freeze({
    operations,
    renameSync(from, to) {
      operations.push(Object.freeze({
        kind: 'rename',
        from,
        to,
        fromIdentity: identityIfPresent(from),
        toIdentity: identityIfPresent(to)
      }));
      fs.renameSync(from, to);
    },
    removeDirectory(target) {
      operations.push(Object.freeze({
        kind: 'remove',
        target,
        targetIdentity: identityIfPresent(target)
      }));
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
}

function assertLedgerNeverTouchedIdentity(ledger, identity) {
  for (const operation of ledger.operations) {
    for (const field of ['fromIdentity', 'toIdentity', 'targetIdentity']) {
      if (operation[field]) assert.notDeepEqual(operation[field], identity);
    }
  }
}

function replaceDirectoryWithLink(sourceRoot, relativePath, targetName, linkType) {
  const approved = path.join(sourceRoot, ...relativePath.split('/'));
  const target = path.join(sourceRoot, targetName);
  fs.renameSync(approved, target);
  fs.symlinkSync(target, approved, linkType);
  return { approved, target };
}

function assertProbeResolvesInsideSource(sourceRoot, probe) {
  const resolved = fs.realpathSync(probe);
  const relative = path.relative(sourceRoot, resolved);
  assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false);
  assert.match(fs.readFileSync(probe, 'utf8'), /globalThis|fixture/i);
}

async function exerciseLinkedSourceAncestors(t, linkType) {
  await t.test('linked src ancestor', () => withFixture(fixture => {
    const linked = replaceDirectoryWithLink(fixture.sourceRoot, 'src', 'unapproved-src', linkType);
    const probe = path.join(linked.approved, 'auth.js');
    assertProbeResolvesInsideSource(fixture.sourceRoot, probe);
    const before = snapshotFiles(linked.target);

    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_ANCESTOR_UNSAFE');

    assert.deepEqual(snapshotFiles(linked.target), before);
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));

  await t.test('linked src/data ancestor', () => withFixture(fixture => {
    const linked = replaceDirectoryWithLink(fixture.sourceRoot, 'src/data', 'unapproved-data', linkType);
    const probe = path.join(linked.approved, 'data-service.js');
    assertProbeResolvesInsideSource(fixture.sourceRoot, probe);
    const before = snapshotFiles(linked.target);

    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_ANCESTOR_UNSAFE');

    assert.deepEqual(snapshotFiles(linked.target), before);
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));

  await t.test('nested linked source parents', () => withFixture(fixture => {
    const sourceDirectory = path.join(fixture.sourceRoot, 'src');
    const redirectedSource = path.join(fixture.sourceRoot, 'unapproved-src');
    const redirectedData = path.join(fixture.sourceRoot, 'unapproved-data');
    fs.renameSync(sourceDirectory, redirectedSource);
    fs.renameSync(path.join(redirectedSource, 'data'), redirectedData);
    fs.symlinkSync(redirectedData, path.join(redirectedSource, 'data'), linkType);
    fs.symlinkSync(redirectedSource, sourceDirectory, linkType);
    const probe = path.join(sourceDirectory, 'data', 'data-service.js');
    assertProbeResolvesInsideSource(fixture.sourceRoot, probe);
    const before = fs.readFileSync(probe);

    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_ANCESTOR_UNSAFE');

    assert.deepEqual(fs.readFileSync(probe), before);
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));
}

test('the fixed contract contains exactly the approved 19 files and four directories', () => {
  assert.deepEqual(builder.ARTIFACT_FILES, [
    '.nojekyll',
    'config/runtime-config.js',
    'deployment-manifest.json',
    'index.html',
    'src/analytics.js',
    'src/auth.js',
    'src/contact-reveal.js',
    'src/data/data-service-factory.js',
    'src/data/data-service.js',
    'src/data/local-storage-data-service.js',
    'src/data/supabase-data-service.js',
    'src/domain.js',
    'src/lead-import.js',
    'src/lead-proof.js',
    'src/migration-preflight.js',
    'src/supabase-auth-service.js',
    'src/team-admin.js',
    'src/test-data-cleanup.js',
    'vendor/supabase.js'
  ]);
  assert.deepEqual(builder.ARTIFACT_DIRECTORIES, ['config', 'src', 'src/data', 'vendor']);
  assert.deepEqual(builder.RUNTIME_SOURCE_FILES, [
    'vendor/supabase.js',
    'src/supabase-auth-service.js',
    'src/migration-preflight.js',
    'src/test-data-cleanup.js',
    'src/domain.js',
    'src/auth.js',
    'src/analytics.js',
    'src/lead-import.js',
    'src/lead-proof.js',
    'src/team-admin.js',
    'src/data/data-service.js',
    'src/data/local-storage-data-service.js',
    'src/data/supabase-data-service.js',
    'src/data/data-service-factory.js',
    'src/contact-reveal.js'
  ]);
  assert.deepEqual(builder.EXPECTED_SCRIPT_REFERENCES, [
    './config/runtime-config.js',
    './vendor/supabase.js',
    './src/supabase-auth-service.js',
    './src/migration-preflight.js',
    './src/test-data-cleanup.js',
    './src/domain.js',
    './src/auth.js',
    './src/analytics.js',
    './src/lead-import.js',
    './src/lead-proof.js',
    './src/team-admin.js',
    './src/data/data-service.js',
    './src/data/local-storage-data-service.js',
    './src/data/supabase-data-service.js',
    './src/data/data-service-factory.js',
    './src/contact-reveal.js'
  ]);
  assert.deepEqual(builder.EXPECTED_EXTERNAL_LINKS, [
    'https://fonts.googleapis.com',
    'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap'
  ]);
  assert.equal(builder.SOURCE_FILES.length, 16);
});

test('a valid build emits and independently validates the exact canonical artifact', () => {
  withFixture(fixture => {
    const result = builder.buildPagesArtifact(validBuildOptions(fixture));
    assert.equal(result.fileCount, 19);
    assert.match(result.manifestDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.cleanupWarning, null);
    assert.deepEqual(listTree(fixture.outputDirectory), {
      files: builder.ARTIFACT_FILES,
      directories: builder.ARTIFACT_DIRECTORIES
    });

    for (const relativePath of builder.ARTIFACT_FILES) {
      const bytes = fs.readFileSync(path.join(fixture.outputDirectory, ...relativePath.split('/')));
      assert.equal(bytes.includes(13), false, `${relativePath} contains CR bytes`);
    }
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, '.nojekyll')).length, 0);
    assert.equal(
      builder.validatePagesArtifact({ ...validBuildOptions(fixture), artifactDirectory: fixture.outputDirectory }).manifestDigest,
      result.manifestDigest
    );
  });
});

test('identical inputs and LF/CRLF-equivalent inputs produce byte-identical artifacts', () => {
  const lf = createFixture({ lineEnding: '\n' });
  const crlf = createFixture({ lineEnding: '\r\n' });
  const repeated = createFixture({ lineEnding: '\n' });
  try {
    builder.buildPagesArtifact(validBuildOptions(lf));
    builder.buildPagesArtifact(validBuildOptions(crlf));
    builder.buildPagesArtifact(validBuildOptions(repeated));
    const expected = snapshotFiles(lf.outputDirectory);
    assert.deepEqual(snapshotFiles(crlf.outputDirectory), expected);
    assert.deepEqual(snapshotFiles(repeated.outputDirectory), expected);
  } finally {
    for (const fixture of [lf, crlf, repeated]) fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('BOM, mixed line endings, bare CR, and multibyte text canonicalize deterministically', () => {
  const canonical = createFixture();
  const variant = createFixture();
  try {
    for (const fixture of [canonical, variant]) {
      fs.appendFileSync(path.join(fixture.sourceRoot, 'src', 'auth.js'), '// Multibyte: РџСЂРёРІРµС‚, РјРёСЂ\n', 'utf8');
    }
    const packagePath = path.join(variant.sourceRoot, 'package.json');
    fs.writeFileSync(packagePath, `\uFEFF${fs.readFileSync(packagePath, 'utf8').replace(/\n/g, '\r')}`, 'utf8');
    const indexPath = path.join(variant.sourceRoot, 'index.html');
    fs.writeFileSync(indexPath, withMixedLineEndings(fs.readFileSync(indexPath, 'utf8')), 'utf8');
    const authPath = path.join(variant.sourceRoot, 'src', 'auth.js');
    fs.writeFileSync(authPath, withMixedLineEndings(fs.readFileSync(authPath, 'utf8')), 'utf8');

    builder.buildPagesArtifact(validBuildOptions(canonical));
    builder.buildPagesArtifact(validBuildOptions(variant));
    assert.deepEqual(snapshotFiles(variant.outputDirectory), snapshotFiles(canonical.outputDirectory));

    const authEntry = JSON.parse(fs.readFileSync(
      path.join(variant.outputDirectory, builder.MANIFEST_PATH),
      'utf8'
    )).files.find(entry => entry.path === 'src/auth.js');
    assert.equal(
      authEntry.size,
      fs.readFileSync(path.join(variant.outputDirectory, 'src', 'auth.js')).length
    );
  } finally {
    for (const fixture of [canonical, variant]) fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('the artifact index changes only the exact local configuration block', () => {
  withFixture(fixture => {
    const sourceBefore = fs.readFileSync(path.join(fixture.sourceRoot, 'index.html'));
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const sourceAfter = fs.readFileSync(path.join(fixture.sourceRoot, 'index.html'));
    const artifactIndex = fs.readFileSync(path.join(fixture.outputDirectory, 'index.html'), 'utf8');
    const normalizedSource = builder.normalizeText(sourceBefore, 'index.html');
    const expected = normalizedSource.replace(
      '<script src="./config/supabase-config.local.js"></script>\n<script src="./config/data-config.local.js"></script>',
      '<script src="./config/runtime-config.js"></script>'
    );
    assert.deepEqual(sourceAfter, sourceBefore);
    assert.equal(artifactIndex, expected);
    assert.doesNotMatch(artifactIndex, /\.local\.js/);
    assert.equal((artifactIndex.match(/\.\/config\/runtime-config\.js/g) || []).length, 1);
    assert.ok(artifactIndex.indexOf('./config/runtime-config.js') < artifactIndex.indexOf('./vendor/supabase.js'));
  });
});

test('runtime config contains only the existing frozen globals and fixed Supabase mode', () => {
  const source = builder.generateRuntimeConfig({ projectUrl: `${VALID_URL}/`, publishableKey: VALID_KEY });
  const expected = [
    '(function configureRuntime(root) {',
    "  'use strict';",
    '',
    '  root.REACTIVATION_SUPABASE_CONFIG = Object.freeze({',
    `    projectUrl: "${VALID_URL}",`,
    `    publishableKey: "${VALID_KEY}"`,
    '  });',
    "  root.REACTIVATION_DATA_CONFIG = Object.freeze({ mode: 'supabase' });",
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
  ].join('\n');
  assert.equal(source, expected);

  const context = vm.createContext(Object.create(null));
  new vm.Script(source).runInContext(context, { timeout: 1000 });
  assert.deepEqual(Object.keys(context).sort(), [
    'REACTIVATION_DATA_CONFIG',
    'REACTIVATION_SUPABASE_CONFIG'
  ]);
  assert.deepEqual(Object.keys(context.REACTIVATION_SUPABASE_CONFIG), ['projectUrl', 'publishableKey']);
  assert.deepEqual(Object.keys(context.REACTIVATION_DATA_CONFIG), ['mode']);
  assert.equal(context.REACTIVATION_SUPABASE_CONFIG.projectUrl, VALID_URL);
  assert.equal(context.REACTIVATION_SUPABASE_CONFIG.publishableKey, VALID_KEY);
  assert.equal(context.REACTIVATION_DATA_CONFIG.mode, 'supabase');
  assert.equal(Object.isFrozen(context.REACTIVATION_SUPABASE_CONFIG), true);
  assert.equal(Object.isFrozen(context.REACTIVATION_DATA_CONFIG), true);
  assert.doesNotMatch(source, /local|timestamp|commit|workflow|deployment/i);
});

test('ignored and unapproved source content is never read, copied, or modified', () => {
  withFixture(fixture => {
    const decoys = {
      'config/supabase-config.local.js': 'LOCAL-SUPABASE-CANARY\n',
      'config/data-config.local.js': 'LOCAL-DATA-CANARY\n',
      '.env': 'ENV-CANARY\n',
      'artifacts/review.md': 'REPORT-CANARY\n',
      'tests/evil.test.cjs': 'TEST-CANARY\n',
      'docs/internal.md': 'DOCS-CANARY\n',
      'scripts/debug.cjs': 'SCRIPT-CANARY\n',
      'src/evil.js': 'SOURCE-GLOB-CANARY\n',
      'node_modules/pkg/index.js': 'DEPENDENCY-CANARY\n',
      '.github/workflows/evil.yml': 'WORKFLOW-CANARY\n',
      'supabase/migrations/evil.sql': 'SQL-CANARY\n',
      'recovery/export.json': 'RECOVERY-CANARY\n',
      'snapshots/state.json': 'SNAPSHOT-CANARY\n',
      'package-lock.json': 'LOCKFILE-CANARY\n',
      '.git/HEAD': 'GIT-CANARY\n'
    };
    for (const [relativePath, content] of Object.entries(decoys)) {
      writeText(path.join(fixture.sourceRoot, ...relativePath.split('/')), content);
    }
    const before = snapshotFiles(fixture.sourceRoot);
    builder.buildPagesArtifact(validBuildOptions(fixture));
    assert.deepEqual(snapshotFiles(fixture.sourceRoot), before);
    const artifactText = Object.keys(snapshotFiles(fixture.outputDirectory).files)
      .map(relativePath => fs.readFileSync(path.join(fixture.outputDirectory, ...relativePath.split('/')), 'utf8'))
      .join('\n');
    for (const content of Object.values(decoys)) assert.equal(artifactText.includes(content.trim()), false);
  });
});

test('a successful build transaction replaces only an existing builder-owned output', () => {
  withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const first = snapshotFiles(fixture.outputDirectory);

    builder.buildPagesArtifact(validBuildOptions(fixture, {
      projectUrl: OTHER_VALID_URL,
      publishableKey: OTHER_VALID_KEY
    }));
    const second = snapshotFiles(fixture.outputDirectory);
    assert.notDeepEqual(second, first);
    const config = fs.readFileSync(path.join(fixture.outputDirectory, 'config', 'runtime-config.js'), 'utf8');
    assert.match(config, new RegExp(OTHER_VALID_URL.replaceAll('.', '\\.')));
    assert.equal(config.includes(VALID_KEY), false);
    assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(), ['pages-site']);
  });
});

test('an unowned or internally inconsistent existing pages-site directory is rejected untouched', async t => {
  await t.test('ordinary unowned directory', () => withFixture(fixture => {
    fs.mkdirSync(fixture.outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixture.outputDirectory, 'important.txt'), 'must survive\n');
    const before = snapshotFiles(fixture.outputDirectory);
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'OUTPUT_EXISTING_UNOWNED');
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), before);
    assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(), ['pages-site']);
  }));

  await t.test('tampered builder artifact', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    fs.appendFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), '// damage\n');
    const before = snapshotFiles(fixture.outputDirectory);
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'OUTPUT_EXISTING_UNOWNED');
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), before);
    assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(), ['pages-site']);
  }));
});

test('staged validation failure preserves an existing output and cleans transaction paths', () => {
  withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const existing = snapshotFiles(fixture.outputDirectory);
    const forbidden = 'sb_' + 'secret_' + 'x'.repeat(32);
    fs.appendFileSync(
      path.join(fixture.sourceRoot, 'src', 'auth.js'),
      `const generatedCredentialCanary = ${JSON.stringify(forbidden)};\n`
    );
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'ARTIFACT_SECRET_KEY');
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), existing);
    assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(), ['pages-site']);
  });
});

test('artifact credential scanning covers every file and permits only the generated publishable key', async t => {
  const credentialCases = [
    ['JWT', ['eyJ' + 'a'.repeat(16), 'eyJ' + 'b'.repeat(16), 'c'.repeat(20)].join('.'), 'ARTIFACT_JWT'],
    ['GitHub token', 'gh' + 'o_' + 'a'.repeat(24), 'ARTIFACT_GITHUB_TOKEN'],
    ['private key', '-----BEGIN ' + 'PRIVATE KEY-----', 'ARTIFACT_PRIVATE_KEY']
  ];
  for (const [name, value, code] of credentialCases) {
    await t.test(name, () => withFixture(fixture => {
      fs.appendFileSync(
        path.join(fixture.sourceRoot, 'src', 'auth.js'),
        `const credentialCanary = ${JSON.stringify(value)};\n`
      );
      expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), code);
      assert.equal(fs.existsSync(fixture.outputDirectory), false);
    }));
  }

  await t.test('publishable key duplicated outside generated config', () => withFixture(fixture => {
    fs.appendFileSync(
      path.join(fixture.sourceRoot, 'src', 'auth.js'),
      `const duplicatePublicKey = ${JSON.stringify(VALID_KEY)};\n`
    );
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'ARTIFACT_KEY_LOCATION_INVALID');
  }));

  await t.test('manifest metadata is scanned', () => withFixture(fixture => {
    const packagePath = path.join(fixture.sourceRoot, 'package.json');
    const metadataCredential = 'gh' + 'o_' + 'z'.repeat(24);
    fs.writeFileSync(packagePath, `${JSON.stringify({ name: metadataCredential, version: '9.8.7' }, null, 2)}\n`);
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'ARTIFACT_GITHUB_TOKEN');
  }));

  await t.test('bare SDK marker is not treated as a credential', () => withFixture(fixture => {
    fs.appendFileSync(
      path.join(fixture.sourceRoot, 'vendor', 'supabase.js'),
      `const documentedMarker = ${JSON.stringify('sb_' + 'secret_')};\n`
    );
    assert.equal(builder.buildPagesArtifact(validBuildOptions(fixture)).fileCount, 19);
  }));
});

test('promotion uses exclusive final-path claiming and fail-closed recovery', async t => {
  function prepare(fixture, withExisting = true) {
    if (withExisting) {
      fs.mkdirSync(fixture.outputDirectory, { recursive: true });
      fs.writeFileSync(path.join(fixture.outputDirectory, 'old.txt'), 'old');
    }
    const staging = path.join(fixture.outputParent, 'pages-site.tmp-injected');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
    return staging;
  }

  function injectedRenameFailures(callNumbers) {
    let calls = 0;
    return (from, to) => {
      calls += 1;
      if (callNumbers.includes(calls)) {
        const error = new Error(`injected rename failure ${calls}`);
        error.code = 'EACCES';
        throw error;
      }
      fs.renameSync(from, to);
    };
  }

  const ownership = () => undefined;

  await t.test('old-output backup rename failure touches neither directory', () => withFixture(fixture => {
    const staging = prepare(fixture);
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: injectedRenameFailures([1]),
      validateExisting: ownership
    }), /injected rename failure 1/);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
  }));

  await t.test('normal replacement validates and cleans only owned recovery directories', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const result = builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      validateExisting: target => {
        assert.deepEqual(fs.readdirSync(target), ['old.txt']);
      },
      validatePromoted: target => {
        assert.deepEqual(fs.readdirSync(target), ['new.txt']);
        assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
        return Object.freeze({ validated: true });
      }
    });
    assert.equal(result.validationResult.validated, true);
    assert.equal(result.cleanupWarning, null);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(fixture.outputParent).sort(), ['pages-site']);
  }));

  await t.test('POSIX directory rename replaces an existing empty destination', t => withFixture(fixture => {
    if (process.platform === 'win32') return t.skip('Windows directory rename does not have POSIX replacement semantics');
    const source = path.join(fixture.outputParent, 'native-source');
    const destination = path.join(fixture.outputParent, 'native-destination');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'source.txt'), 'source');
    fs.mkdirSync(destination);
    const sourceIdentity = directoryIdentity(source);
    const destinationIdentity = directoryIdentity(destination);

    fs.renameSync(source, destination);

    assert.equal(fs.existsSync(source), false);
    assertDirectoryIdentity(destination, sourceIdentity);
    assert.notDeepEqual(directoryIdentity(destination), destinationIdentity);
    assert.equal(fs.readFileSync(path.join(destination, 'source.txt'), 'utf8'), 'source');
  }));

  await t.test('an empty foreign output created after backup is never replaced on any platform', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const stagingIdentity = directoryIdentity(staging);
    const ledger = createOperationLedger();
    let promotedValidationCalls = 0;
    let recoveryError;
    let recoveryPaths;
    let foreignIdentity;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') {
          recoveryPaths = paths;
          fs.mkdirSync(fixture.outputDirectory);
          foreignIdentity = directoryIdentity(fixture.outputDirectory);
        }
      },
      validateExisting: ownership,
      validatePromoted: () => { promotedValidationCalls += 1; }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    assert.equal(recoveryError.cause && recoveryError.cause.code, 'EEXIST');
    assert.equal(promotedValidationCalls, 0);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), { directories: [], files: {} });
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.equal(fs.readFileSync(path.join(recoveryPaths.backupDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assertDirectoryIdentity(staging, stagingIdentity);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'rename').length, 1);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
    assertLedgerNeverTouchedIdentity(ledger, foreignIdentity);
    assert.match(recoveryError.message, /claimed exclusively/);
    assert.match(recoveryError.message, /output=.*pages-site; staging=.*pages-site\.tmp-injected; backup=.*pages-site\.backup-/);
    assert.match(recoveryError.message, /lock=.*\.pages-site\.build\.lock/);
  }));

  await t.test('foreign substitution during failing validation is never moved, removed, or accepted', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const stagingIdentity = directoryIdentity(staging);
    const ledger = createOperationLedger();
    const validationFailure = new Error('injected promoted validation failure');
    const heldCandidate = path.join(fixture.outputParent, 'held-materialized-candidate');
    let foreignIdentity;
    let backupDirectory;
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') backupDirectory = paths.backupDirectory;
      },
      validateExisting: ownership,
      validatePromoted: target => {
        if (target !== fixture.outputDirectory) return Object.freeze({ validated: true });
        fs.renameSync(target, heldCandidate);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'foreign.txt'), 'foreign');
        foreignIdentity = directoryIdentity(target);
        throw validationFailure;
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    assert.equal(recoveryError.cause, validationFailure);
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), {
      directories: [],
      files: { 'foreign.txt': Buffer.from('foreign').toString('base64') }
    });
    assert.equal(fs.readFileSync(path.join(heldCandidate, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assertDirectoryIdentity(staging, stagingIdentity);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'rename').length, 1);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
    assertLedgerNeverTouchedIdentity(ledger, foreignIdentity);
  }));

  await t.test('byte-identical foreign substitution after successful validation is rejected by identity', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const stagingIdentity = directoryIdentity(staging);
    const ledger = createOperationLedger();
    const heldCandidate = path.join(fixture.outputParent, 'held-byte-identical-candidate');
    let foreignIdentity;
    let foreignSnapshot;
    let backupDirectory;
    let substituted = false;
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') backupDirectory = paths.backupDirectory;
      },
      validateExisting: ownership,
      validatePromoted: target => {
        assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
        if (target === fixture.outputDirectory && !substituted) {
          substituted = true;
          fs.renameSync(target, heldCandidate);
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, 'new.txt'), 'new');
          foreignIdentity = directoryIdentity(target);
          foreignSnapshot = snapshotFiles(target);
          assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
          assert.deepEqual(foreignSnapshot, snapshotFiles(heldCandidate));
        }
        return Object.freeze({ validated: true });
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    assert.equal(substituted, true);
    assert.match(recoveryError.message, /substituted before commit/);
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), foreignSnapshot);
    assert.deepEqual(snapshotFiles(heldCandidate), foreignSnapshot);
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assertDirectoryIdentity(staging, stagingIdentity);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'rename').length, 1);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
    assertLedgerNeverTouchedIdentity(ledger, foreignIdentity);
  }));

  await t.test('in-place output mutation after validation fails the final exact validation before cleanup', () => withFixture(fixture => {
    const staging = prepare(fixture);
    let backupDirectory;
    let validationCalls = 0;
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      validateExisting: ownership,
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') backupDirectory = paths.backupDirectory;
        if (phase === 'before-commit-cleanup') {
          fs.writeFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'foreign mutation');
        }
      },
      validatePromoted: target => {
        validationCalls += 1;
        assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
        return Object.freeze({ validated: true });
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });
    assert.equal(validationCalls, 3);
    assert.match(recoveryError.message, /final pre-cleanup validation/);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'utf8'), 'foreign mutation');
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
  }));

  await t.test('a foreign staging addition is detected before recursive cleanup', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const ledger = createOperationLedger();
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      validateExisting: target => {
        assert.deepEqual(fs.readdirSync(target), ['old.txt']);
      },
      validatePromoted: target => {
        assert.deepEqual(fs.readdirSync(target), ['new.txt']);
        return Object.freeze({ validated: true });
      },
      onTransactionPhase: (phase, paths) => {
        if (phase === 'before-commit-cleanup') {
          fs.writeFileSync(path.join(staging, 'foreign-staging.txt'), 'foreign staging');
        }
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });
    assert.match(recoveryError.message, /staging artifact failed/i);
    assert.equal(fs.readFileSync(path.join(staging, 'foreign-staging.txt'), 'utf8'), 'foreign staging');
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
  }));

  await t.test('a foreign backup addition independently fails ownership validation before cleanup', () => withFixture(fixture => {
    const staging = prepare(fixture);
    const ledger = createOperationLedger();
    let backupDirectory;
    let backupValidationCalls = 0;
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      validateExisting: target => {
        backupValidationCalls += 1;
        assert.deepEqual(fs.readdirSync(target), ['old.txt']);
      },
      validatePromoted: target => {
        assert.deepEqual(fs.readdirSync(target), ['new.txt']);
        return Object.freeze({ validated: true });
      },
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') backupDirectory = paths.backupDirectory;
        if (phase === 'before-commit-cleanup') {
          fs.writeFileSync(path.join(backupDirectory, 'foreign-backup.txt'), 'foreign backup');
        }
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });
    assert.equal(backupValidationCalls, 3);
    assert.match(recoveryError.message, /prior-output backup failed/i);
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'foreign-backup.txt'), 'utf8'), 'foreign backup');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
  }));

  await t.test('first publication also refuses a foreign output created before exclusive claim', () => withFixture(fixture => {
    const staging = prepare(fixture, false);
    let foreignIdentity;
    expectArtifactError(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      onTransactionPhase: phase => {
        if (phase === 'after-backup') {
          fs.mkdirSync(fixture.outputDirectory);
          foreignIdentity = directoryIdentity(fixture.outputDirectory);
        }
      }
    }), 'OUTPUT_TRANSACTION_RECOVERY_FAILED');
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(fs.readdirSync(fixture.outputDirectory), []);
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
  }));

  await t.test('first-publication validation failure preserves claimed output and staging for recovery', () => withFixture(fixture => {
    const staging = prepare(fixture, false);
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      validatePromoted: () => { throw new Error('injected promoted validation failure'); }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });
    assert.match(recoveryError.message, /no output or recovery path was moved or removed/);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
  }));

  await t.test('substitution immediately after output claim is detected before any foreign write', () => withFixture(fixture => {
    const staging = prepare(fixture, false);
    const ledger = createOperationLedger();
    const heldClaim = path.join(fixture.outputParent, 'held-empty-claim');
    let foreignIdentity;
    expectArtifactError(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: phase => {
        if (phase === 'after-output-claim') {
          fs.renameSync(fixture.outputDirectory, heldClaim);
          fs.mkdirSync(fixture.outputDirectory);
          fs.writeFileSync(path.join(fixture.outputDirectory, 'foreign.txt'), 'foreign');
          foreignIdentity = directoryIdentity(fixture.outputDirectory);
        }
      }
    }), 'OUTPUT_TRANSACTION_RECOVERY_FAILED');
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(fs.readdirSync(fixture.outputDirectory), ['foreign.txt']);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'foreign.txt'), 'utf8'), 'foreign');
    assert.deepEqual(fs.readdirSync(heldClaim), []);
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assert.equal(ledger.operations.length, 0);
  }));

  await t.test('output mutation during staging cleanup is detected before the prior backup is removed', () => withFixture(fixture => {
    const staging = prepare(fixture);
    let backupDirectory;
    let removeCalls = 0;
    let recoveryError;
    assert.throws(() => builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      validateExisting: target => {
        assert.deepEqual(fs.readdirSync(target), ['old.txt']);
      },
      validatePromoted: target => {
        assert.deepEqual(fs.readdirSync(target), ['new.txt']);
        assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
        return Object.freeze({ validated: true });
      },
      onTransactionPhase: (phase, paths) => {
        if (phase === 'after-backup') backupDirectory = paths.backupDirectory;
      },
      removeDirectory: target => {
        removeCalls += 1;
        assert.equal(target, staging);
        fs.rmSync(target, { recursive: true, force: true });
        fs.writeFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'mutated during cleanup');
      }
    }), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });
    assert.equal(removeCalls, 1);
    assert.match(recoveryError.message, /changed after staging cleanup/);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'utf8'), 'mutated during cleanup');
    assert.equal(fs.readFileSync(path.join(backupDirectory, 'old.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(staging), false);
  }));

  await t.test('known cleanup I/O failures are nonfatal, explicit, and retain both recovery copies', () => withFixture(fixture => {
    const staging = prepare(fixture);
    let cleanupCalls = 0;
    const result = builder.transactionalReplaceDirectory(staging, fixture.outputDirectory, {
      validateExisting: ownership,
      validatePromoted: () => Object.freeze({ validated: true }),
      removeDirectory: () => {
        cleanupCalls += 1;
        throw new Error('injected cleanup failure');
      }
    });
    assert.equal(result.validationResult.validated, true);
    assert.equal(cleanupCalls, 2);
    assert.match(result.cleanupWarning, /staging could not be removed/);
    assert.match(result.cleanupWarning, /prior output backup could not be removed/);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(staging, 'new.txt'), 'utf8'), 'new');
    assert.ok(fs.readdirSync(fixture.outputParent).some(name => name.startsWith('pages-site.backup-')));
  }));
});

test('the complete builder preserves every recovery path and the original failure', async t => {
  await t.test('cleanup failure never masks the primary backup-rename error', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const previousSnapshot = snapshotFiles(fixture.outputDirectory);
    const primaryFailure = new Error('injected primary backup rename failure');
    primaryFailure.code = 'EACCES';
    const cleanupFailure = new Error('injected staging cleanup failure');
    let cleanupCalls = 0;
    let stagingDirectory;
    let lockPath;
    let lockIdentity;
    let lockToken;
    let caught;

    assert.throws(() => builder.buildPagesArtifact(validBuildOptions(fixture, {
      renameSync: () => {
        stagingDirectory = path.join(
          fixture.outputParent,
          fs.readdirSync(fixture.outputParent).find(name => name.startsWith('pages-site.tmp-'))
        );
        lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
        lockIdentity = directoryIdentity(lockPath);
        lockToken = fs.readFileSync(lockPath, 'utf8');
        throw primaryFailure;
      },
      removeDirectory: target => {
        cleanupCalls += 1;
        assert.equal(target, stagingDirectory);
        throw cleanupFailure;
      }
    })), error => {
      caught = error;
      return error === primaryFailure;
    });

    assert.equal(caught, primaryFailure);
    assert.equal(caught.code, 'EACCES');
    assert.match(caught.message, /^injected primary backup rename failure/);
    assert.equal(caught.cleanupFailure, cleanupFailure);
    assert.equal(caught.preserveTransaction, true);
    assert.match(caught.cleanupWarning, /staging=.*pages-site\.tmp-/);
    assert.match(caught.cleanupWarning, /lock=.*\.pages-site\.build\.lock/);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), previousSnapshot);
    assert.equal(fs.existsSync(path.join(stagingDirectory, builder.MANIFEST_PATH)), true);
    assertDirectoryIdentity(lockPath, lockIdentity);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockToken);
  }));

  await t.test('missing staging during error cleanup keeps the primary error and lock', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const previousSnapshot = snapshotFiles(fixture.outputDirectory);
    const primaryFailure = new Error('injected primary error after staging removal');
    primaryFailure.code = 'EACCES';
    let lockPath;
    let lockIdentity;
    let lockToken;
    let caught;

    assert.throws(() => builder.buildPagesArtifact(validBuildOptions(fixture, {
      renameSync: () => {
        const stagingName = fs.readdirSync(fixture.outputParent).find(name => name.startsWith('pages-site.tmp-'));
        fs.rmSync(path.join(fixture.outputParent, stagingName), { recursive: true, force: true });
        lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
        lockIdentity = directoryIdentity(lockPath);
        lockToken = fs.readFileSync(lockPath, 'utf8');
        throw primaryFailure;
      }
    })), error => {
      caught = error;
      return error === primaryFailure;
    });

    assert.equal(caught, primaryFailure);
    assert.equal(caught.code, 'EACCES');
    assert.equal(caught.cleanupFailure && caught.cleanupFailure.code, 'CLEANUP_TARGET_CHANGED');
    assert.match(caught.message, /^injected primary error after staging removal/);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), previousSnapshot);
    assertDirectoryIdentity(lockPath, lockIdentity);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockToken);
  }));

  await t.test('after-backup empty-directory recreation preserves foreign output, staging, backup, and lock', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const previousSnapshot = snapshotFiles(fixture.outputDirectory);
    const ledger = createOperationLedger();
    let recoveryPaths;
    let foreignIdentity;
    let stagingIdentity;
    let stagingSnapshot;
    let backupIdentity;
    let lockIdentity;
    let lockToken;
    let recoveryError;

    assert.throws(() => builder.buildPagesArtifact(validBuildOptions(fixture, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase !== 'after-backup') return;
        recoveryPaths = paths;
        fs.mkdirSync(fixture.outputDirectory);
        foreignIdentity = directoryIdentity(fixture.outputDirectory);
        stagingIdentity = directoryIdentity(paths.stagingDirectory);
        stagingSnapshot = snapshotFiles(paths.stagingDirectory);
        backupIdentity = directoryIdentity(paths.backupDirectory);
        const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
        lockIdentity = directoryIdentity(lockPath);
        lockToken = fs.readFileSync(lockPath, 'utf8');
      }
    })), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
    assert.equal(recoveryError.cause && recoveryError.cause.code, 'EEXIST');
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), { directories: [], files: {} });
    assertDirectoryIdentity(recoveryPaths.stagingDirectory, stagingIdentity);
    assert.deepEqual(snapshotFiles(recoveryPaths.stagingDirectory), stagingSnapshot);
    assertDirectoryIdentity(recoveryPaths.backupDirectory, backupIdentity);
    assert.deepEqual(snapshotFiles(recoveryPaths.backupDirectory), previousSnapshot);
    assertDirectoryIdentity(lockPath, lockIdentity);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockToken);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'rename').length, 1);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
    assertLedgerNeverTouchedIdentity(ledger, foreignIdentity);
    assert.match(recoveryError.message, /output=.*pages-site; staging=.*pages-site\.tmp-/);
    assert.match(recoveryError.message, /backup=.*pages-site\.backup-/);
    assert.match(recoveryError.message, /lock=.*\.pages-site\.build\.lock/);
  }));

  await t.test('byte-identical substitution after real promoted validation is still rejected', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const previousSnapshot = snapshotFiles(fixture.outputDirectory);
    const ledger = createOperationLedger();
    const heldCandidate = path.join(fixture.outputParent, 'held-validated-candidate');
    let recoveryPaths;
    let candidateSnapshot;
    let foreignIdentity;
    let stagingIdentity;
    let stagingSnapshot;
    let backupIdentity;
    let lockIdentity;
    let lockToken;
    let recoveryError;
    assert.throws(() => builder.buildPagesArtifact(validBuildOptions(fixture, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase !== 'after-promoted-validation') return;
        recoveryPaths = paths;
        candidateSnapshot = snapshotFiles(fixture.outputDirectory);
        fs.renameSync(fixture.outputDirectory, heldCandidate);
        fs.cpSync(heldCandidate, fixture.outputDirectory, { recursive: true });
        foreignIdentity = directoryIdentity(fixture.outputDirectory);
        stagingIdentity = directoryIdentity(paths.stagingDirectory);
        stagingSnapshot = snapshotFiles(paths.stagingDirectory);
        backupIdentity = directoryIdentity(paths.backupDirectory);
        const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
        lockIdentity = directoryIdentity(lockPath);
        lockToken = fs.readFileSync(lockPath, 'utf8');
      }
    })), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
    assert.match(recoveryError.message, /substituted before commit/);
    assertDirectoryIdentity(fixture.outputDirectory, foreignIdentity);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), candidateSnapshot);
    assert.deepEqual(snapshotFiles(heldCandidate), candidateSnapshot);
    assertDirectoryIdentity(recoveryPaths.stagingDirectory, stagingIdentity);
    assert.deepEqual(snapshotFiles(recoveryPaths.stagingDirectory), stagingSnapshot);
    assertDirectoryIdentity(recoveryPaths.backupDirectory, backupIdentity);
    assert.deepEqual(snapshotFiles(recoveryPaths.backupDirectory), previousSnapshot);
    assertDirectoryIdentity(lockPath, lockIdentity);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockToken);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'rename').length, 1);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
    assertLedgerNeverTouchedIdentity(ledger, foreignIdentity);
  }));

  await t.test('a substituted build lock fails closed before staging or backup cleanup', () => withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const previousSnapshot = snapshotFiles(fixture.outputDirectory);
    const ledger = createOperationLedger();
    const foreignToken = 'foreign-lock-owner';
    let recoveryPaths;
    let foreignLockIdentity;
    let recoveryError;
    assert.throws(() => builder.buildPagesArtifact(validBuildOptions(fixture, {
      renameSync: ledger.renameSync,
      removeDirectory: ledger.removeDirectory,
      onTransactionPhase: (phase, paths) => {
        if (phase !== 'before-commit-cleanup') return;
        recoveryPaths = paths;
        const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
        fs.rmSync(lockPath);
        fs.writeFileSync(lockPath, foreignToken);
        foreignLockIdentity = directoryIdentity(lockPath);
      }
    })), error => {
      recoveryError = error;
      return error.code === 'OUTPUT_TRANSACTION_RECOVERY_FAILED' && error.preserveTransaction === true;
    });

    const lockPath = path.join(fixture.outputParent, '.pages-site.build.lock');
    assert.match(recoveryError.message, /build lock changed/i);
    assertDirectoryIdentity(lockPath, foreignLockIdentity);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreignToken);
    assert.deepEqual(snapshotFiles(recoveryPaths.backupDirectory), previousSnapshot);
    assert.equal(fs.existsSync(path.join(recoveryPaths.stagingDirectory, builder.MANIFEST_PATH)), true);
    assert.equal(ledger.operations.filter(operation => operation.kind === 'remove').length, 0);
  }));

});

test('runtime input validation accepts only the canonical public configuration contract', async t => {
  assert.deepEqual(builder.validateRuntimeInputs({ projectUrl: `${VALID_URL}/`, publishableKey: VALID_KEY }), {
    projectUrl: VALID_URL,
    publishableKey: VALID_KEY
  });
  assert.equal(builder.validateRuntimeInputs({
    projectUrl: VALID_URL,
    publishableKey: `sb_publishable_${'a'.repeat(16)}`
  }).publishableKey.length, 'sb_publishable_'.length + 16);
  assert.equal(builder.validateRuntimeInputs({
    projectUrl: VALID_URL,
    publishableKey: `sb_publishable_${'z'.repeat(256)}`
  }).publishableKey.length, 'sb_publishable_'.length + 256);

  const invalidCases = [
    ['empty URL', { projectUrl: '', publishableKey: VALID_KEY }, 'CONFIG_URL_MISSING'],
    ['whitespace URL', { projectUrl: ' ', publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['non-string URL', { projectUrl: 42, publishableKey: VALID_KEY }, 'CONFIG_URL_MISSING'],
    ['missing URL', { publishableKey: VALID_KEY }, 'CONFIG_URL_MISSING'],
    ['empty key', { projectUrl: VALID_URL, publishableKey: '' }, 'CONFIG_KEY_MISSING'],
    ['whitespace key', { projectUrl: VALID_URL, publishableKey: ' ' }, 'CONFIG_KEY_INVALID'],
    ['non-string key', { projectUrl: VALID_URL, publishableKey: {} }, 'CONFIG_KEY_MISSING'],
    ['missing key', { projectUrl: VALID_URL }, 'CONFIG_KEY_MISSING'],
    ['URL placeholder', { projectUrl: 'https://YOUR_PROJECT_REF.supabase.co', publishableKey: VALID_KEY }, 'CONFIG_PLACEHOLDER'],
    ['mixed-case key placeholder', { projectUrl: VALID_URL, publishableKey: 'yOuR_sUpAbAsE_pUbLiShAbLe_KeY' }, 'CONFIG_PLACEHOLDER'],
    ['HTTP URL', { projectUrl: VALID_URL.replace('https:', 'http:'), publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['foreign hostname', { projectUrl: 'https://abcdefghijklmnopqrst.supabase.co.evil.test', publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['missing project ref', { projectUrl: 'https://supabase.co', publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['userinfo', { projectUrl: 'https://user:password@abcdefghijklmnopqrst.supabase.co', publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['port', { projectUrl: 'https://abcdefghijklmnopqrst.supabase.co:443', publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['path', { projectUrl: `${VALID_URL}/rest/v1`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['query', { projectUrl: `${VALID_URL}?value=1`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['empty query', { projectUrl: `${VALID_URL}?`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['fragment', { projectUrl: `${VALID_URL}#fragment`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['empty fragment', { projectUrl: `${VALID_URL}#`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['backslash URL', { projectUrl: VALID_URL.replace('https://', 'https:\\\\'), publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['URL whitespace', { projectUrl: ` ${VALID_URL}`, publishableKey: VALID_KEY }, 'CONFIG_URL_INVALID'],
    ['wrong key class', { projectUrl: VALID_URL, publishableKey: 'anon_' + 'x'.repeat(32) }, 'CONFIG_KEY_INVALID'],
    ['secret key', { projectUrl: VALID_URL, publishableKey: 'sb_' + 'secret_' + 'x'.repeat(32) }, 'CONFIG_KEY_INVALID'],
    ['service role', { projectUrl: VALID_URL, publishableKey: 'sb_publishable_service_role_' + 'x'.repeat(24) }, 'CONFIG_KEY_INVALID'],
    ['JWT', { projectUrl: VALID_URL, publishableKey: ['eyJ' + 'x'.repeat(16), 'eyJ' + 'y'.repeat(16), 'z'.repeat(20)].join('.') }, 'CONFIG_KEY_INVALID'],
    ['key whitespace', { projectUrl: VALID_URL, publishableKey: ` ${VALID_KEY}` }, 'CONFIG_KEY_INVALID'],
    ['key newline', { projectUrl: VALID_URL, publishableKey: `${VALID_KEY}\n` }, 'CONFIG_KEY_INVALID'],
    ['key DEL', { projectUrl: VALID_URL, publishableKey: `${VALID_KEY}\u007f` }, 'CONFIG_KEY_INVALID'],
    ['key below minimum', { projectUrl: VALID_URL, publishableKey: `sb_publishable_${'x'.repeat(15)}` }, 'CONFIG_KEY_INVALID'],
    ['embedded secret shape', { projectUrl: VALID_URL, publishableKey: `sb_publishable_${'x'.repeat(16)}${'sb_' + 'secret_' + 'y'.repeat(20)}` }, 'CONFIG_KEY_INVALID'],
    ['key injection', { projectUrl: VALID_URL, publishableKey: 'sb_publishable_' + 'x'.repeat(20) + '";alert(1)' }, 'CONFIG_KEY_INVALID'],
    ['key too long', { projectUrl: VALID_URL, publishableKey: 'sb_publishable_' + 'x'.repeat(257) }, 'CONFIG_KEY_INVALID']
  ];

  for (const [name, input, code] of invalidCases) {
    await t.test(name, () => expectArtifactError(() => builder.validateRuntimeInputs(input), code));
  }
});

test('manifest application metadata is bounded consistently before construction', async t => {
  const cases = [
    ['long application name', { name: 'a'.repeat(129), version: '9.8.7' }],
    ['control character in application name', { name: 'fixture\u0000dashboard', version: '9.8.7' }],
    ['long version', { name: 'fixture-dashboard', version: 'v'.repeat(129) }],
    ['control character in version', { name: 'fixture-dashboard', version: '9.8.7\u0000' }]
  ];
  for (const [name, metadata] of cases) {
    await t.test(name, () => withFixture(fixture => {
      fs.writeFileSync(
        path.join(fixture.sourceRoot, 'package.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8'
      );
      expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'PACKAGE_INVALID');
      assert.equal(fs.existsSync(fixture.outputDirectory), false);
    }));
  }
});

test('CLI failures never disclose supplied URL or key values', () => {
  withFixture(fixture => {
    const suppliedUrl = 'https://user:distinctive-password@abcdefghijklmnopqrst.supabase.co';
    const suppliedKey = 'sb_' + 'secret_' + 'distinctivecredentialvalue1234567890';
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-pages-artifact.cjs'), '--output', fixture.outputDirectory], {
      encoding: 'utf8',
      timeout: 10000,
      env: essentialEnvironment({
        DASHBOARD_SUPABASE_PROJECT_URL: suppliedUrl,
        DASHBOARD_SUPABASE_PUBLISHABLE_KEY: suppliedKey
      })
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /CONFIG_URL_INVALID/);
    assert.equal(output.includes(suppliedUrl), false);
    assert.equal(output.includes(suppliedKey), false);
    assert.equal(output.includes('distinctive-password'), false);
    assert.equal(output.includes('distinctivecredentialvalue'), false);
    assert.equal(fs.existsSync(fixture.outputDirectory), false);

    const invalidKey = `sb_publishable_${'x'.repeat(20)}-invalid-suffix!`;
    const keyFailure = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-pages-artifact.cjs'), '--output', fixture.outputDirectory], {
      encoding: 'utf8',
      timeout: 10000,
      env: essentialEnvironment({
        DASHBOARD_SUPABASE_PROJECT_URL: VALID_URL,
        DASHBOARD_SUPABASE_PUBLISHABLE_KEY: invalidKey
      })
    });
    const keyOutput = `${keyFailure.stdout}\n${keyFailure.stderr}`;
    assert.equal(keyFailure.status, 1, keyOutput);
    assert.match(keyOutput, /CONFIG_KEY_INVALID/);
    assert.equal(keyOutput.includes(VALID_URL), false);
    assert.equal(keyOutput.includes(invalidKey), false);
  });
});

test('CLI builds and validates with synthetic public values without logging them', () => {
  withFixture(fixture => {
    const script = path.join(__dirname, '..', 'scripts', 'build-pages-artifact.cjs');
    const environment = essentialEnvironment({
      DASHBOARD_SUPABASE_PROJECT_URL: VALID_URL,
      DASHBOARD_SUPABASE_PUBLISHABLE_KEY: VALID_KEY
    });
    const build = spawnSync(process.execPath, [script, '--output', fixture.outputDirectory], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, env: environment
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    assert.match(build.stdout, /build passed \(19 files, manifest [a-f0-9]{64}\)/);
    assert.equal(`${build.stdout}\n${build.stderr}`.includes(VALID_URL), false);
    assert.equal(`${build.stdout}\n${build.stderr}`.includes(VALID_KEY), false);

    const beforeValidation = snapshotFiles(fixture.outputDirectory);
    const validation = spawnSync(process.execPath, [script, '--validate-only', '--output', fixture.outputDirectory], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, env: environment
    });
    assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
    assert.match(validation.stdout, /validation passed \(19 files, manifest [a-f0-9]{64}\)/);
    assert.equal(`${validation.stdout}\n${validation.stderr}`.includes(VALID_URL), false);
    assert.equal(`${validation.stdout}\n${validation.stderr}`.includes(VALID_KEY), false);
    assert.deepEqual(snapshotFiles(fixture.outputDirectory), beforeValidation);
  });
});

test('every approved source is required and exact path casing is enforced', async t => {
  for (const relativePath of builder.SOURCE_FILES) {
    await t.test(relativePath, () => withFixture(fixture => {
      fs.rmSync(path.join(fixture.sourceRoot, ...relativePath.split('/')));
      expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_MISSING');
      assert.equal(fs.existsSync(fixture.outputDirectory), false);
    }));
  }
});

test('ordinary approved source ancestors remain valid', () => {
  withFixture(fixture => {
    for (const relativePath of ['src', 'src/data', 'vendor']) {
      const info = fs.lstatSync(path.join(fixture.sourceRoot, ...relativePath.split('/')));
      assert.equal(info.isDirectory(), true);
      assert.equal(info.isSymbolicLink(), false);
    }
    const result = builder.buildPagesArtifact(validBuildOptions(fixture));
    assert.equal(result.fileCount, 19);
    assert.equal(builder.validatePagesArtifact({
      ...validBuildOptions(fixture),
      artifactDirectory: fixture.outputDirectory
    }).manifestDigest, result.manifestDigest);
  });
});

test('POSIX source symlink ancestors fail closed', { skip: process.platform === 'win32' }, async t => {
  await exerciseLinkedSourceAncestors(t, 'dir');
});

test('Windows source junction ancestors fail closed', { skip: process.platform !== 'win32' }, async t => {
  await exerciseLinkedSourceAncestors(t, 'junction');
});

test('index transformation rejects every ambiguous configuration block', async t => {
  const mutations = [
    ['missing block', value => value.replace('<script src="./config/supabase-config.local.js"></script>\n', '')],
    ['reversed tags', value => value.replace(
      '<script src="./config/supabase-config.local.js"></script>\n<script src="./config/data-config.local.js"></script>',
      '<script src="./config/data-config.local.js"></script>\n<script src="./config/supabase-config.local.js"></script>'
    )],
    ['separated tags', value => value.replace(
      '<script src="./config/supabase-config.local.js"></script>\n<script src="./config/data-config.local.js"></script>',
      '<script src="./config/supabase-config.local.js"></script>\n<!-- gap -->\n<script src="./config/data-config.local.js"></script>'
    )],
    ['altered quotes', value => value.replace('src="./config/data-config.local.js"', "src='./config/data-config.local.js'")],
    ['duplicate block', value => value.replace('</body>', '<script src="./config/supabase-config.local.js"></script>\n<script src="./config/data-config.local.js"></script>\n</body>')],
    ['already transformed', value => value.replace('</body>', '<script src="./config/runtime-config.js"></script>\n</body>')]
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => withFixture(fixture => {
      const indexPath = path.join(fixture.sourceRoot, 'index.html');
      fs.writeFileSync(indexPath, mutate(fs.readFileSync(indexPath, 'utf8')), 'utf8');
      expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'INDEX_CONFIG_ANCHOR_INVALID');
      assert.equal(fs.existsSync(fixture.outputDirectory), false);
    }));
  }
});

test('invalid UTF-8 and linked approved sources fail before an artifact is committed', async t => {
  await t.test('invalid UTF-8', () => withFixture(fixture => {
    fs.writeFileSync(path.join(fixture.sourceRoot, 'src', 'auth.js'), Buffer.from([0xc3, 0x28]));
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'INVALID_UTF8');
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));

  await t.test('hard link', () => withFixture(fixture => {
    const source = path.join(fixture.sourceRoot, 'src', 'auth.js');
    const external = path.join(fixture.base, 'external-auth.js');
    fs.renameSync(source, external);
    fs.linkSync(external, source);
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_HARDLINK');
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));

  await t.test('symbolic link when supported', t => withFixture(fixture => {
    const source = path.join(fixture.sourceRoot, 'src', 'auth.js');
    const external = path.join(fixture.base, 'external-auth.js');
    fs.renameSync(source, external);
    try {
      fs.symlinkSync(external, source, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symbolic-link creation is not permitted on this host');
      throw error;
    }
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'SOURCE_NOT_REGULAR');
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));
});

test('unsafe existing output and concurrent-build markers are rejected without touching targets', async t => {
  await t.test('existing output file', () => withFixture(fixture => {
    fs.writeFileSync(fixture.outputDirectory, 'sentinel');
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'OUTPUT_EXISTING_UNSAFE');
    assert.equal(fs.readFileSync(fixture.outputDirectory, 'utf8'), 'sentinel');
  }));

  await t.test('existing output symlink when supported', t => withFixture(fixture => {
    const target = path.join(fixture.base, 'outside');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel.txt'), 'outside');
    try {
      fs.symlinkSync(target, fixture.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('junction creation is not permitted on this host');
      throw error;
    }
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'OUTPUT_EXISTING_UNSAFE');
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'outside');
  }));

  await t.test('preexisting lock', () => withFixture(fixture => {
    const lock = path.join(fixture.outputParent, '.pages-site.build.lock');
    fs.writeFileSync(lock, 'sentinel');
    expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), 'OUTPUT_LOCKED');
    assert.equal(fs.readFileSync(lock, 'utf8'), 'sentinel');
    assert.equal(fs.existsSync(fixture.outputDirectory), false);
  }));
});

test('the independent validator rejects exact-tree and content tampering', async t => {
  const cases = [
    ['extra file', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, 'extra.txt'), 'extra'), 'ARTIFACT_FILE_SET_INVALID'],
    ['extra directory', fixture => fs.mkdirSync(path.join(fixture.outputDirectory, 'empty')), 'ARTIFACT_DIRECTORY_SET_INVALID'],
    ['missing runtime config', fixture => fs.rmSync(path.join(fixture.outputDirectory, 'config', 'runtime-config.js')), 'ARTIFACT_FILE_SET_INVALID'],
    ['nonempty nojekyll', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, '.nojekyll'), 'x'), 'NOJEKYLL_INVALID'],
    ['CRLF output', fixture => fs.appendFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), '\r\n'), 'ARTIFACT_TEXT_NOT_CANONICAL'],
    ['bare CR output', fixture => fs.appendFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), '\r'), 'ARTIFACT_TEXT_NOT_CANONICAL'],
    ['BOM output', fixture => {
      const target = path.join(fixture.outputDirectory, 'src', 'auth.js');
      fs.writeFileSync(target, `\uFEFF${fs.readFileSync(target, 'utf8')}`, 'utf8');
    }, 'ARTIFACT_TEXT_NOT_CANONICAL'],
    ['invalid UTF-8 output', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), Buffer.from([0xc3, 0x28])), 'INVALID_UTF8'],
    ['invalid JavaScript', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), 'function {\n'), 'ARTIFACT_JS_INVALID'],
    ['tampered runtime config', fixture => fs.appendFileSync(path.join(fixture.outputDirectory, 'config', 'runtime-config.js'), '// changed\n'), 'RUNTIME_CONFIG_MISMATCH'],
    ['malformed manifest', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, 'deployment-manifest.json'), '{'), 'MANIFEST_JSON_INVALID']
  ];

  for (const [name, mutate, code] of cases) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      mutate(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        code
      );
    }));
  }
});

test('tampering remains detectable after an attacker repairs manifest hashes', async t => {
  const cases = [
    ['copied source', fixture => fs.writeFileSync(path.join(fixture.outputDirectory, 'src', 'auth.js'), 'globalThis.changed = true;\n'), 'COPIED_SOURCE_MISMATCH'],
    ['index outside approved transform', fixture => fs.appendFileSync(path.join(fixture.outputDirectory, 'index.html'), '<!-- changed -->\n'), 'INDEX_ARTIFACT_MISMATCH'],
    ['different canonical config', fixture => fs.writeFileSync(
      path.join(fixture.outputDirectory, 'config', 'runtime-config.js'),
      builder.generateRuntimeConfig({ projectUrl: OTHER_VALID_URL, publishableKey: OTHER_VALID_KEY })
    ), 'RUNTIME_CONFIG_MISMATCH']
  ];

  for (const [name, mutate, code] of cases) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      mutate(fixture);
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        code
      );
    }));
  }
});

test('runtime config mutations fail even with repaired manifest hashes', async t => {
  const cases = [
    ['extra global', value => `${value}globalThis.UNRELATED_GLOBAL = true;\n`],
    ['extra statement', value => value.replace("  'use strict';", "  'use strict';\n  void 0;")],
    ['extra property', value => value.replace(`    publishableKey: "${VALID_KEY}"`, `    publishableKey: "${VALID_KEY}",\n    debug: true`)],
    ['duplicate assignment', value => value.replace(
      "})(typeof globalThis !== 'undefined' ? globalThis : this);",
      "  root.REACTIVATION_DATA_CONFIG = Object.freeze({ mode: 'supabase' });\n})(typeof globalThis !== 'undefined' ? globalThis : this);"
    )],
    ['formatting drift', value => value.replace('    projectUrl:', '   projectUrl:')]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      const configPath = path.join(fixture.outputDirectory, 'config', 'runtime-config.js');
      fs.writeFileSync(configPath, mutate(fs.readFileSync(configPath, 'utf8')), 'utf8');
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        'RUNTIME_CONFIG_MISMATCH'
      );
    }));
  }
});

test('artifact links and hard links are rejected even when file bytes are unchanged', async t => {
  await t.test('hard-linked artifact file', () => withFixture(fixture => {
    const options = validBuildOptions(fixture);
    builder.buildPagesArtifact(options);
    const target = path.join(fixture.outputDirectory, 'src', 'auth.js');
    const external = path.join(fixture.base, 'artifact-auth.js');
    fs.renameSync(target, external);
    fs.linkSync(external, target);
    expectArtifactError(
      () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
      'ARTIFACT_HARDLINK'
    );
  }));

  await t.test('symbolic artifact file when supported', t => withFixture(fixture => {
    const options = validBuildOptions(fixture);
    builder.buildPagesArtifact(options);
    const target = path.join(fixture.outputDirectory, 'src', 'auth.js');
    const external = path.join(fixture.base, 'artifact-auth.js');
    fs.renameSync(target, external);
    try {
      fs.symlinkSync(external, target, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symbolic-link creation is not permitted on this host');
      throw error;
    }
    expectArtifactError(
      () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
      'ARTIFACT_LINK'
    );
  }));

  await t.test('symbolic artifact directory when supported', t => withFixture(fixture => {
    const options = validBuildOptions(fixture);
    builder.buildPagesArtifact(options);
    const target = path.join(fixture.outputDirectory, 'src', 'data');
    const external = path.join(fixture.base, 'artifact-data');
    fs.renameSync(target, external);
    try {
      fs.symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('junction creation is not permitted on this host');
      throw error;
    }
    expectArtifactError(
      () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
      'ARTIFACT_LINK'
    );
  }));
});

test('manifest is minimal, canonical, complete, sorted, and contains no supplied values', () => {
  withFixture(fixture => {
    builder.buildPagesArtifact(validBuildOptions(fixture));
    const manifestPath = path.join(fixture.outputDirectory, 'deployment-manifest.json');
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'application', 'version', 'files']);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.application, 'fixture-dashboard');
    assert.equal(manifest.version, '9.8.7');
    assert.equal(manifest.files.length, 18);
    assert.deepEqual(manifest.files.map(entry => entry.path), builder.PAYLOAD_FILES);
    assert.deepEqual([...manifest.files].map(entry => entry.path).sort(), manifest.files.map(entry => entry.path));
    for (const entry of manifest.files) {
      assert.deepEqual(Object.keys(entry), ['path', 'size', 'sha256']);
      const bytes = fs.readFileSync(path.join(fixture.outputDirectory, ...entry.path.split('/')));
      assert.equal(entry.size, bytes.length);
      assert.equal(entry.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(manifestText, builder.canonicalJson(manifest));
    assert.equal(manifestText.includes(VALID_URL), false);
    assert.equal(manifestText.includes(VALID_KEY), false);
    assert.doesNotMatch(manifestText, /commit|branch|runner|workflow|timestamp|deployment|release/i);
  });
});

test('validator rejects repaired manifests with unknown metadata, reordered entries, or omitted files', async t => {
  const cases = [
    ['unknown metadata', manifest => { manifest.generatedAt = 'never'; }, 'MANIFEST_SHAPE_INVALID'],
    ['wrong schema type', manifest => { manifest.schemaVersion = '1'; }, 'MANIFEST_METADATA_INVALID'],
    ['wrong application type', manifest => { manifest.application = 42; }, 'MANIFEST_METADATA_INVALID'],
    ['reordered entries', manifest => { manifest.files.reverse(); }, 'MANIFEST_CONTENT_INVALID'],
    ['omitted entry', manifest => { manifest.files.pop(); }, 'MANIFEST_CONTENT_INVALID'],
    ['duplicate path', manifest => { manifest.files[1].path = manifest.files[0].path; }, 'MANIFEST_CONTENT_INVALID'],
    ['traversal path', manifest => { manifest.files[0].path = '../outside'; }, 'MANIFEST_CONTENT_INVALID'],
    ['manifest self-entry', manifest => { manifest.files[0].path = builder.MANIFEST_PATH; }, 'MANIFEST_CONTENT_INVALID'],
    ['uppercase digest', manifest => { manifest.files[0].sha256 = manifest.files[0].sha256.toUpperCase(); }, 'MANIFEST_CONTENT_INVALID'],
    ['invalid size', manifest => { manifest.files[0].size = -1; }, 'MANIFEST_CONTENT_INVALID'],
    ['short digest', manifest => { manifest.files[0].sha256 = 'abc'; }, 'MANIFEST_CONTENT_INVALID'],
    ['unknown entry field', manifest => { manifest.files[0].source = 'workspace'; }, 'MANIFEST_CONTENT_INVALID']
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      const manifestPath = path.join(fixture.outputDirectory, 'deployment-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      mutate(manifest);
      fs.writeFileSync(manifestPath, builder.canonicalJson(manifest));
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        code
      );
    }));
  }
});

test('unexpected local and external HTML references fail exact validation', async t => {
  const cases = [
    ['local reference', '<script src="./src/debug.js"></script>\n', 'HTML_SCRIPT_REFERENCES_INVALID'],
    ['external origin', '<link rel="stylesheet" href="https://evil.test/style.css">\n', 'HTML_EXTERNAL_REFERENCES_INVALID'],
    ['unquoted external script', '<script src=https://evil.test/app.js></script>\n', 'HTML_ATTRIBUTE_INVALID'],
    ['quoted greater-than before external source', '<script data-note=">" src="//evil.test/app.js"></script>\n', 'HTML_SCRIPT_REFERENCES_INVALID'],
    ['unquoted protocol-relative link', '<link href=//evil.test/style.css rel=stylesheet>\n', 'HTML_ATTRIBUTE_INVALID'],
    ['unapproved local link', '<link rel="preload" as="script" href="./config/runtime-config.js">\n', 'HTML_EXTERNAL_REFERENCES_INVALID'],
    ['external image', '<img src="https://evil.test/pixel.png">\n', 'HTML_RESOURCE_TAG_INVALID'],
    ['external iframe', '<iframe src="https://evil.test/frame"></iframe>\n', 'HTML_RESOURCE_TAG_INVALID'],
    ['base redirection', '<base href="https://evil.test/">\n', 'HTML_RESOURCE_TAG_INVALID'],
    ['CSS URL', '<style>body{background:url(https://evil.test/pixel.png)}</style>\n', 'HTML_STYLE_REFERENCE_INVALID'],
    ['protocol-relative script', '<script src="//evil.test/app.js"></script>\n', 'HTML_SCRIPT_REFERENCES_INVALID'],
    ['third literal HTTPS URL', '<script>globalThis.extraUrl = "https://evil.test";</script>\n', 'HTML_EXTERNAL_REFERENCES_INVALID']
  ];
  for (const [name, insertion, code] of cases) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      const indexPath = path.join(fixture.outputDirectory, 'index.html');
      fs.appendFileSync(indexPath, insertion);
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        'INDEX_ARTIFACT_MISMATCH'
      );

      const sourceIndexPath = path.join(fixture.sourceRoot, 'index.html');
      fs.appendFileSync(sourceIndexPath, insertion);
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        code
      );
    }));
  }
});

test('entity and CSS escape mutations cannot hide browser resource behavior', async t => {
  const cases = [
    {
      name: 'numeric entity encoded meta refresh',
      insertion: '<meta http-equiv="re&#x66;resh" content="0;url=https&#x3a;//evil.test/">\n',
      code: 'HTML_META_REFRESH_INVALID',
      absentPatterns: [/\brefresh\b/i, /https:\/\//i]
    },
    {
      name: 'named entity encoded meta refresh',
      insertion: '<meta http-equiv="re&#102;resh" content="0;url=https&colon;//evil.test/">\n',
      code: 'HTML_META_REFRESH_INVALID',
      absentPatterns: [/\brefresh\b/i, /https:\/\//i]
    },
    {
      name: 'entity encoded external reference outside refresh',
      insertion: '<meta name="description" content="https&#x3a;//evil.test/">\n',
      code: 'HTML_EXTERNAL_REFERENCES_INVALID',
      absentPatterns: [/https:\/\//i]
    },
    {
      name: 'entity encoded inline CSS URL',
      insertion: '<div style="background:u&#x72;l(&#47;&#47;evil.test/pixel)"></div>\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i]
    },
    {
      name: 'CSS escaped URL function',
      insertion: String.raw`<style>body{background:\75rl(//evil.test/pixel)}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i]
    },
    {
      name: 'CSS escaped import rule',
      insertion: String.raw`<style>@\69mport "//evil.test/style.css";</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/@import\b/i]
    },
    {
      name: 'fully escaped CSS URL token',
      insertion: String.raw`<style>body{background:\75\72\6c\28 //evil.test/pixel)}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i]
    },
    {
      name: 'false style end tag cannot truncate CSS inspection',
      insertion: String.raw`<style>/*</stylex>*/body{background:\75rl(//evil.test/pixel)}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i]
    },
    {
      name: 'escaped external image-set string',
      insertion: String.raw`<style>body{background-image:image-set("https\3a //evil.test/pixel" 1x)}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i, /@import\b/i, /https:\/\//i]
    },
    {
      name: 'escaped external image function string',
      insertion: String.raw`<style>body{background-image:image("https\3a //evil.test/pixel")}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i, /@import\b/i, /https:\/\//i]
    },
    {
      name: 'escaped external src function string',
      insertion: String.raw`<style>@font-face{src:src("https\3a //evil.test/font")}</style>` + '\n',
      code: 'HTML_STYLE_REFERENCE_INVALID',
      absentPatterns: [/url\s*\(/i, /@import\b/i, /https:\/\//i]
    },
    {
      name: 'foreign-content style entity decoding',
      insertion: '<svg><style>svg{background:u&#x72;l(&#47;&#47;evil.test/pixel)}</style></svg>\n',
      code: 'HTML_RESOURCE_TAG_INVALID',
      absentPatterns: [/url\s*\(/i, /https:\/\//i]
    },
    {
      name: 'foreign-content script entity decoding',
      insertion: '<svg><script>fetch("https&#x3a;//evil.test/pixel")</script></svg>\n',
      code: 'HTML_RESOURCE_TAG_INVALID',
      absentPatterns: [/https:\/\//i]
    },
    {
      name: 'MathML foreign-content entry',
      insertion: '<math><mtext>https&#x3a;//evil.test/pixel</mtext></math>\n',
      code: 'HTML_RESOURCE_TAG_INVALID',
      absentPatterns: [/https:\/\//i]
    }
  ];

  for (const { name, insertion, code, absentPatterns } of cases) {
    await t.test(name, () => withFixture(fixture => {
      for (const pattern of absentPatterns) assert.doesNotMatch(insertion, pattern);
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      const existing = snapshotFiles(fixture.outputDirectory);
      fs.appendFileSync(path.join(fixture.sourceRoot, 'index.html'), insertion, 'utf8');

      expectArtifactError(() => builder.buildPagesArtifact(options), code);
      assert.deepEqual(snapshotFiles(fixture.outputDirectory), existing);

      fs.appendFileSync(path.join(fixture.outputDirectory, 'index.html'), insertion, 'utf8');
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        code
      );
    }));
  }
});

test('entity-encoded modern resource attributes cannot hide additional browser requests', async t => {
  const mutations = [
    {
      name: 'responsive preload source set',
      mutate: html => html.replace(
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preload" as="image" href="https://fonts.googleapis.com" imagesrcset="&#47;&#47;evil.test/pixel 1x">'
      )
    },
    {
      name: 'script attribution source',
      mutate: html => html.replace(
        '<script src="./src/auth.js"></script>',
        '<script src="./src/auth.js" attributionsrc="&#47;&#47;evil.test/register"></script>'
      )
    }
  ];

  for (const { name, mutate } of mutations) {
    await t.test(name, () => withFixture(fixture => {
      const options = validBuildOptions(fixture);
      builder.buildPagesArtifact(options);
      const existing = snapshotFiles(fixture.outputDirectory);
      const sourcePath = path.join(fixture.sourceRoot, 'index.html');
      const artifactPath = path.join(fixture.outputDirectory, 'index.html');
      const mutatedSource = mutate(fs.readFileSync(sourcePath, 'utf8'));
      const mutatedArtifact = mutate(fs.readFileSync(artifactPath, 'utf8'));
      assert.notEqual(mutatedSource, fs.readFileSync(sourcePath, 'utf8'));
      assert.doesNotMatch(mutatedSource, /https:\/\/evil\.test/i);
      fs.writeFileSync(sourcePath, mutatedSource, 'utf8');

      expectArtifactError(() => builder.buildPagesArtifact(options), 'HTML_RESOURCE_REFERENCE_INVALID');
      assert.deepEqual(snapshotFiles(fixture.outputDirectory), existing);

      fs.writeFileSync(artifactPath, mutatedArtifact, 'utf8');
      rewriteManifest(fixture);
      expectArtifactError(
        () => builder.validatePagesArtifact({ ...options, artifactDirectory: fixture.outputDirectory }),
        'HTML_RESOURCE_REFERENCE_INVALID'
      );
    }));
  }
});

test('malformed encoded browser syntax fails closed while benign encodings remain valid', async t => {
  const malformed = [
    ['out-of-range numeric entity', '<meta name="description" content="&#x110000;">\n', 'HTML_ENTITY_INVALID'],
    ['unterminated numeric entity', '<meta name="description" content="&#x3a">\n', 'HTML_ENTITY_INVALID'],
    ['unknown named entity', '<meta name="description" content="&notARealEntity;">\n', 'HTML_ENTITY_INVALID'],
    ['unterminated CSS escape', String.raw`<style>body{color:red\</style>` + '\n', 'HTML_STYLE_ESCAPE_INVALID']
  ];
  for (const [name, insertion, code] of malformed) {
    await t.test(name, () => withFixture(fixture => {
      fs.appendFileSync(path.join(fixture.sourceRoot, 'index.html'), insertion, 'utf8');
      expectArtifactError(() => builder.buildPagesArtifact(validBuildOptions(fixture)), code);
      assert.equal(fs.existsSync(fixture.outputDirectory), false);
    }));
  }

  await t.test('benign HTML entities and CSS escapes', () => withFixture(fixture => {
    fs.appendFileSync(
      path.join(fixture.sourceRoot, 'index.html'),
      '<div title="A &amp; B" style="color:\\72 ed"></div>\n',
      'utf8'
    );
    const result = builder.buildPagesArtifact(validBuildOptions(fixture));
    assert.equal(result.fileCount, 19);
  }));
});

test('builder requires a pages-site output name and never leaves partial output on input failure', () => {
  withFixture(fixture => {
    expectArtifactError(
      () => builder.buildPagesArtifact(validBuildOptions(fixture, { outputDirectory: path.join(fixture.outputParent, 'wrong-name') })),
      'OUTPUT_NAME_INVALID'
    );
    expectArtifactError(
      () => builder.buildPagesArtifact(validBuildOptions(fixture, { publishableKey: undefined })),
      'CONFIG_KEY_MISSING'
    );
    const missingParentOutput = path.join(fixture.base, 'missing-parent', 'nested', 'pages-site');
    expectArtifactError(
      () => builder.buildPagesArtifact(validBuildOptions(fixture, { outputDirectory: missingParentOutput })),
      'OUTPUT_PARENT_MISSING'
    );
    assert.equal(fs.existsSync(path.join(fixture.base, 'missing-parent')), false);
    assert.deepEqual(fs.readdirSync(fixture.outputParent), []);
  });
});

test('alternative output paths never create through a symlink or junction ancestor', t => {
  withFixture(fixture => {
    const outside = path.join(fixture.base, 'outside');
    const linkedParent = path.join(fixture.base, 'linked-parent');
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('junction creation is not permitted on this host');
      throw error;
    }
    const requested = path.join(linkedParent, 'not-created', 'pages-site');
    expectArtifactError(
      () => builder.buildPagesArtifact(validBuildOptions(fixture, { outputDirectory: requested })),
      'OUTPUT_PARENT_MISSING'
    );
    assert.equal(fs.existsSync(path.join(outside, 'not-created')), false);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const doctor = require('../scripts/dev/doctor.cjs');
const launcher = require('../scripts/dev/dev-local.cjs');
const staticServer = require('../scripts/dev/static-server.cjs');
const fixtures = require('./fixtures/local-environment.cjs');

const { createEnvironment, identityFor } = fixtures;
const repositoryRoot = path.join(__dirname, '..');

/* ==================== static server ==================== */

async function withTemporaryTree(callback) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dev local '));
  const root = path.join(base, 'dash board');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>\r\n<title>local</title>\r\n');
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'const answer = 1;\n');
  fs.writeFileSync(path.join(root, 'scripts', 'secret-tool.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  try {
    return await callback(root, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

test('the static server answers an identity endpoint that names the served repository', async () => {
  await withTemporaryTree(async root => {
    const started = await staticServer.startStaticServer({ root, port: 0, token: 'token-abc', application: doctor.PACKAGE_NAME });
    try {
      const response = await get(started.port, staticServer.IDENTITY_PATH);
      assert.equal(response.status, 200);
      const identity = JSON.parse(response.body.toString('utf8'));
      assert.equal(path.resolve(identity.repositoryRoot), path.resolve(root));
      assert.equal(identity.token, 'token-abc');
      assert.equal(identity.application, doctor.PACKAGE_NAME);
      assert.equal(identity.environment, 'LOCAL');
      assert.equal(identity.pid, process.pid);
    } finally {
      started.server.close();
    }
  });
});

test('the static server serves only the browser allowlist and refuses everything else', async () => {
  await withTemporaryTree(async root => {
    const started = await staticServer.startStaticServer({ root, port: 0, token: 't', application: 'a' });
    try {
      assert.equal((await get(started.port, '/')).status, 200);
      assert.equal((await get(started.port, '/index.html')).status, 200);
      assert.equal((await get(started.port, '/src/auth.js')).status, 200);
      for (const denied of [
        '/scripts/secret-tool.cjs',
        '/package.json',
        '/../outside.txt',
        '/src/../../outside.txt',
        '/config/%2e%2e/%2e%2e/outside.txt',
        '/.git/config',
        '/supabase/config.toml'
      ]) {
        assert.equal((await get(started.port, denied)).status, 404, denied);
      }
    } finally {
      started.server.close();
    }
  });
});

test('the static server preserves file bytes exactly, including CRLF', async () => {
  await withTemporaryTree(async root => {
    const started = await staticServer.startStaticServer({ root, port: 0, token: 't', application: 'a' });
    try {
      const response = await get(started.port, '/index.html');
      assert.deepEqual(response.body, fs.readFileSync(path.join(root, 'index.html')));
      assert.ok(response.body.includes(13), 'CRLF bytes must survive');
    } finally {
      started.server.close();
    }
  });
});

test('the static server refuses non-read methods', async () => {
  await withTemporaryTree(async root => {
    const started = await staticServer.startStaticServer({ root, port: 0, token: 't', application: 'a' });
    try {
      const status = await new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: started.port, path: '/index.html', method: 'POST' }, response => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 405);
    } finally {
      started.server.close();
    }
  });
});

test('request path resolution rejects traversal, dotfiles, and unlisted top-level directories', async () => {
  await withTemporaryTree(root => {
    assert.ok(staticServer.resolveRequestPath(root, '/index.html'));
    assert.ok(staticServer.resolveRequestPath(root, '/'));
    assert.equal(staticServer.resolveRequestPath(root, '/scripts/secret-tool.cjs'), null);
    assert.equal(staticServer.resolveRequestPath(root, '/../outside.txt'), null);
    assert.equal(staticServer.resolveRequestPath(root, '/src/.hidden'), null);
    assert.equal(staticServer.resolveRequestPath(root, '/src/%00auth.js'), null);
  });
});

/* ==================== launcher ==================== */

function createLauncherFixture(overrides = {}) {
  const environment = createEnvironment(overrides);
  const output = [];
  const errors = [];
  const spawned = [];
  const killed = [];

  const deps = {
    ...environment.deps,
    runDoctor: options => doctor.runDoctor({ ...options, deps: environment.deps }),
    createToken: () => 'launcher-token',
    log: line => output.push(String(line)),
    logError: line => errors.push(String(line)),
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    openBrowser: url => output.push(`opened ${url}`),
    spawnServer: async request => {
      spawned.push(request);
      environment.state.identities[request.port] = identityFor(environment.root, { pid: 9999, token: request.token });
      return { child: null, pid: 9999, port: request.port };
    }
  };

  return {
    environment,
    deps,
    output,
    errors,
    spawned,
    killed,
    text: () => `${output.join('\n')}\n${errors.join('\n')}`,
    run: (argv = []) => launcher.runLauncher({ argv, root: environment.root, deps })
  };
}

function healthyOverrides(extra = {}) {
  return {
    statusEntries: [],
    snippets: null,
    dataConfig: fixtures.dataConfigSource({ mode: 'local' }),
    ...extra
  };
}

test('the launcher starts, claims the port, records ownership, and prints the local banner', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.equal(fixture.spawned.length, 1);
  assert.equal(fixture.spawned[0].port, doctor.DEFAULT_DASHBOARD_PORT);
  assert.equal(path.resolve(fixture.spawned[0].root), path.resolve(fixture.environment.root));

  const state = launcher.readState(fixture.deps, fixture.environment.root);
  assert.deepEqual(
    { pid: state.pid, port: state.port, token: state.token, repositoryRoot: state.repositoryRoot },
    { pid: 9999, port: doctor.DEFAULT_DASHBOARD_PORT, token: 'launcher-token', repositoryRoot: path.resolve(fixture.environment.root) }
  );

  const text = fixture.text();
  assert.match(text, /Dashboard\s+: http:\/\/127\.0\.0\.1:3100\//);
  assert.match(text, /Supabase\s+: http:\/\/127\.0\.0\.1:54321/);
  assert.match(text, /Studio\s+: http:\/\/127\.0\.0\.1:54323\//);
  assert.match(text, /Environment : LOCAL/);
  assert.match(text, /Admin email : smoke_test_admin@local\.invalid/);
  assert.match(text, /npm run dev:local -- --stop/);
  assert.match(text, /npx supabase stop/);
});

test('the launcher refuses to start when the diagnostic reports a blocker', async () => {
  const fixture = createLauncherFixture(healthyOverrides({ dockerDaemon: false }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_BLOCKED);
  assert.equal(fixture.spawned.length, 0);
  assert.match(fixture.text(), /Refusing to start/);
  assert.match(fixture.text(), /DOCKER_DAEMON_STOPPED/);
  assert.equal(launcher.readState(fixture.deps, fixture.environment.root), null);
});

test('the launcher refuses a hosted project URL even though the diagnostic already blocked it', async () => {
  const fixture = createLauncherFixture(healthyOverrides({
    supabaseConfig: fixtures.supabaseConfigSource({ projectUrl: 'https://abcdefghij.supabase.co' })
  }));
  assert.equal(await fixture.run([]), doctor.EXIT_BLOCKED);
  assert.equal(fixture.spawned.length, 0);

  const verified = launcher.verifyLocalConfiguration(
    { context: { configuration: { projectUrl: 'https://abcdefghij.supabase.co', publishableKeyClass: 'publishable' } } },
    fixture.deps
  );
  assert.equal(verified, false);
  assert.match(fixture.text(), /must point only to http:\/\/127\.0\.0\.1:54321/);
  assert.match(fixture.text(), /never rewrites ignored local configuration/);
});

test('the launcher refuses a key that is not a browser-public class and never prints it', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  const verified = launcher.verifyLocalConfiguration(
    { context: { configuration: { projectUrl: doctor.LOCAL_SUPABASE_URL, publishableKeyClass: 'secret' } } },
    fixture.deps
  );
  assert.equal(verified, false);
  assert.match(fixture.text(), /classified as 'secret'/);
  assert.equal(fixture.text().includes(fixtures.SECRET_KEY), false);
});

test('the launcher confirms the loopback URL and key class before starting anything', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  await fixture.run([]);
  assert.match(fixture.text(), /Local configuration verified: http:\/\/127\.0\.0\.1:54321 with a publishable key/);
  assert.equal(fixture.text().includes(fixtures.PUBLISHABLE_KEY), false);
});

test('the launcher starts a stopped Supabase and never resets the database', async () => {
  const fixture = createLauncherFixture(healthyOverrides({ supabaseRunning: false }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  const commands = fixture.environment.commands();
  assert.ok(commands.some(command => /supabase start$/.test(command)), commands.join(' | '));
  for (const command of commands) {
    assert.doesNotMatch(command, /db\s+reset/i, command);
    assert.doesNotMatch(command, /docker\s+(rm|stop|kill|prune)/i, command);
    assert.doesNotMatch(command, /supabase\s+stop/i, command);
  }
});

test('the launcher reuses a port that already serves this repository', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  fixture.environment.state.identities[doctor.DEFAULT_DASHBOARD_PORT] = identityFor(fixture.environment.root, { pid: 1234, token: 'other-launcher' });
  fixture.environment.state.listeners = [{ address: '127.0.0.1', port: doctor.DEFAULT_DASHBOARD_PORT, pid: 1234 }];
  fixture.environment.state.processes = [{ pid: 1234, name: 'node.exe', commandLine: 'node scripts/dev/static-server.cjs' }];

  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.equal(fixture.spawned.length, 0, 'a second server must not be started');
  assert.equal(fixture.killed.length, 0);
  assert.match(fixture.text(), /already serves this repository \(pid 1234\); reusing it/);
});

test('the launcher refuses a port served by another project and starts nothing', async () => {
  const foreignRoot = path.resolve(path.sep === '\\' ? 'C:\\Projects\\other-project' : '/srv/other-project');
  const fixture = createLauncherFixture(healthyOverrides());
  fixture.environment.state.identities[doctor.DEFAULT_DASHBOARD_PORT] = identityFor(foreignRoot, { pid: 4321 });
  fixture.environment.state.listeners = [{ address: '127.0.0.1', port: doctor.DEFAULT_DASHBOARD_PORT, pid: 4321 }];

  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_BLOCKED);
  assert.equal(fixture.spawned.length, 0);
  assert.equal(fixture.killed.length, 0, 'a foreign server must never be terminated');
  assert.match(fixture.text(), /served by another project|DASHBOARD_PORT_FOREIGN/);
});

test('the launcher provisions smoke users only through the sanctioned local-only path', async () => {
  const fixture = createLauncherFixture(healthyOverrides({
    smokeUsers: [],
    smokeProfiles: [],
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'local-only-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'local-only-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'local-only-agent-b'
    }
  }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());

  const provisioning = fixture.environment.commandCalls()
    .find(call => call.detail.includes('Initialize-LocalSmokeUsers.ps1'));
  assert.ok(provisioning, fixture.environment.commands().join(' | '));
  assert.equal(provisioning.options.env.SMOKE_TEST_MODE, 'local');
  assert.equal(provisioning.options.env.SMOKE_TEST_PROJECT_URL, doctor.LOCAL_SUPABASE_URL);
  assert.equal(provisioning.options.env.SMOKE_TEST_ADMIN_EMAIL, 'smoke_test_admin@local.invalid');
  assert.equal(fixture.text().includes(fixtures.SERVICE_JWT), false, 'the service key must never be printed');
  assert.ok(fixture.environment.commands().every(command => !/db\s+reset/i.test(command)));
});

test('provisioning is skipped with an instruction instead of an invented credential', async () => {
  const fixture = createLauncherFixture(healthyOverrides({ smokeUsers: [], smokeProfiles: [], env: {} }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.equal(fixture.environment.commands().some(command => command.includes('Initialize-LocalSmokeUsers')), false);
  const text = fixture.text();
  assert.match(text, /required local passwords are not set/);
  assert.match(text, /SMOKE_TEST_ADMIN_PASSWORD/);
  assert.match(text, /choose a local-only password/);
  assert.match(text, /never invents a credential/);
});

test('provisioning is refused when a duplicate username would be corrupted', async () => {
  const fixture = createLauncherFixture(healthyOverrides({
    smokeProfiles: [
      { id: 'user-0', username: 'SMOKE_TEST_admin', role: 'admin' },
      { id: 'stray', username: 'smoke_test_admin', role: 'agent' },
      { id: 'user-1', username: 'SMOKE_TEST_agent_a', role: 'agent' },
      { id: 'user-2', username: 'SMOKE_TEST_agent_b', role: 'agent' }
    ],
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'local-only-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'local-only-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'local-only-agent-b'
    }
  }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.equal(fixture.environment.commands().some(command => command.includes('Initialize-LocalSmokeUsers')), false);
  assert.match(fixture.text(), /conflicting profile rows/);
  assert.match(fixture.text(), /would corrupt usernames/);
});

test('--no-provision skips provisioning entirely', async () => {
  const fixture = createLauncherFixture(healthyOverrides({
    env: {
      SMOKE_TEST_ADMIN_PASSWORD: 'local-only-admin',
      SMOKE_TEST_AGENT_A_PASSWORD: 'local-only-agent-a',
      SMOKE_TEST_AGENT_B_PASSWORD: 'local-only-agent-b'
    }
  }));
  await fixture.run(['--no-provision']);
  assert.equal(fixture.environment.commands().some(command => command.includes('Initialize-LocalSmokeUsers')), false);
  assert.match(fixture.text(), /provisioning skipped \(--no-provision\)/);
});

test('the browser opens only when --open is passed', async () => {
  const closed = createLauncherFixture(healthyOverrides());
  await closed.run([]);
  assert.doesNotMatch(closed.text(), /^opened /m);

  const opened = createLauncherFixture(healthyOverrides());
  await opened.run(['--open']);
  assert.match(opened.text(), /opened http:\/\/127\.0\.0\.1:3100\//);
});

test('--stop terminates only the server this launcher started', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  await fixture.run([]);
  assert.equal(fixture.killed.length, 0);

  const code = await fixture.run(['--stop']);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.deepEqual(fixture.killed, [{ pid: 9999, signal: 'SIGTERM' }]);
  assert.equal(launcher.readState(fixture.deps, fixture.environment.root), null);
  assert.match(fixture.text(), /left running/);
});

test('--stop refuses to terminate a process that is not the one it started', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  await fixture.run([]);
  // Another process now answers on the recorded port with a different identity.
  fixture.environment.state.identities[doctor.DEFAULT_DASHBOARD_PORT] = identityFor(fixture.environment.root, { pid: 5555, token: 'not-ours' });

  const code = await fixture.run(['--stop']);
  assert.equal(code, doctor.EXIT_BLOCKED);
  assert.deepEqual(fixture.killed, []);
  assert.match(fixture.text(), /Refusing to stop pid 5555/);
  assert.match(fixture.text(), /never terminates a foreign process/);
});

test('--stop clears stale state without signalling anything', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  await fixture.run([]);
  delete fixture.environment.state.identities[doctor.DEFAULT_DASHBOARD_PORT];

  const code = await fixture.run(['--stop']);
  assert.equal(code, doctor.EXIT_READY);
  assert.deepEqual(fixture.killed, []);
  assert.equal(launcher.readState(fixture.deps, fixture.environment.root), null);
  assert.match(fixture.text(), /Stale launcher state removed\. No process was terminated\./);
});

test('--stop without any state file reports that nothing is owned', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  const code = await fixture.run(['--stop']);
  assert.equal(code, doctor.EXIT_READY);
  assert.deepEqual(fixture.killed, []);
  assert.match(fixture.text(), /nothing owned by this launcher is running/);
});

test('the launcher terminates its own server when the identity does not match', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  fixture.deps.spawnServer = async request => {
    fixture.spawned.push(request);
    fixture.environment.state.identities[request.port] = identityFor(fixture.environment.root, { pid: 9999, token: 'unexpected-token' });
    return { child: null, pid: 9999, port: request.port };
  };
  const code = await fixture.run([]);
  assert.equal(code, 1);
  assert.deepEqual(fixture.killed, [{ pid: 9999, signal: 'SIGTERM' }]);
  assert.equal(launcher.readState(fixture.deps, fixture.environment.root), null);
});

test('a repository path containing spaces is handled by the launcher', async () => {
  const fixture = createLauncherFixture(healthyOverrides({ root: fixtures.SPACED_ROOT }));
  const code = await fixture.run([]);
  assert.equal(code, doctor.EXIT_READY, fixture.text());
  assert.equal(path.resolve(fixture.spawned[0].root), fixtures.SPACED_ROOT);
  assert.equal(launcher.readState(fixture.deps, fixture.environment.root).repositoryRoot, fixtures.SPACED_ROOT);
});

test('launcher argument parsing accepts the documented flags and rejects anything else', async () => {
  assert.deepEqual(launcher.parseLauncherArgs(['--open', '--no-provision']), { open: true, provision: false, stop: false, json: false, port: null, help: false });
  assert.deepEqual(launcher.parseLauncherArgs(['--port', '4200']).port, '4200');
  assert.throws(() => launcher.parseLauncherArgs(['--reset']), error => error.usage === true);

  const fixture = createLauncherFixture(healthyOverrides());
  assert.equal(await fixture.run(['--reset']), doctor.EXIT_USAGE);
  assert.equal(fixture.spawned.length, 0);
});

test('the launcher emits a machine-readable summary with --json', async () => {
  const fixture = createLauncherFixture(healthyOverrides());
  await fixture.run(['--json']);
  const payload = JSON.parse(fixture.output[0]);
  assert.equal(payload.doctor.status, doctor.STATUS_READY);
  assert.equal(payload.doctor.exitCode, doctor.EXIT_READY);
});

test('the launcher source contains no destructive or foreign-process operation', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'dev', 'dev-local.cjs'), 'utf8');
  assert.doesNotMatch(source, /db\s+reset/);
  assert.doesNotMatch(source, /supabase'?,?\s*'stop'/);
  assert.doesNotMatch(source, /docker[^\n]*\b(rm|prune|kill|stop)\b/);
  assert.doesNotMatch(source, /taskkill|Stop-Process|SIGKILL/i);
  assert.doesNotMatch(source, /createUser|admin\.createUser/);
  // The only removal is the launcher's own state file: never a directory, never recursive.
  assert.doesNotMatch(source, /rmSync\([^)]*recursive/);
  assert.deepEqual(source.match(/rmSync\([^)]*\)/g), ['rmSync(target, { force: true })']);
  // Every termination goes through killProcess with a pid this launcher recorded.
  const killCalls = source.match(/killProcess\([^)]*\)/g) || [];
  assert.ok(killCalls.length >= 3);
  for (const call of killCalls) {
    assert.match(call, /killProcess\((pid, signal|claim\.pid|started\.pid|state\.pid)/, call);
  }
});

test('the npm scripts expose the documented commands', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.doctor, 'node scripts/dev/doctor.cjs');
  assert.equal(manifest.scripts['dev:local'], 'node scripts/dev/dev-local.cjs');
});

test('the launcher help text is available without touching the environment', () => {
  const result = spawnSync(process.execPath, [path.join('scripts', 'dev', 'dev-local.cjs'), '--help'], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 60000
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--no-provision/);
  assert.match(result.stdout, /never resets the database/);
  assert.equal(fs.existsSync(path.join(repositoryRoot, launcher.STATE_RELATIVE_PATH)), false);
});

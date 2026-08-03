'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const doctor = require('../scripts/dev/doctor.cjs');
const authService = require('../src/supabase-auth-service.js');
const fixtures = require('./fixtures/local-environment.cjs');

const { createEnvironment, findingByCode, findingCodes, identityFor } = fixtures;
const root = path.join(__dirname, '..');

function severity(result, code) {
  const finding = findingByCode(result, code);
  return finding ? finding.severity : null;
}

/* ==================== classification units ==================== */

test('project URL classification separates local, hosted, malformed, and unrelated origins', () => {
  for (const projectUrl of [
    'http://127.0.0.1',
    'http://127.0.0.1:54321',
    'http://localhost',
    'http://localhost:54321',
    'http://[::1]',
    'http://[::1]:54321'
  ]) {
    assert.equal(doctor.classifyProjectUrl(projectUrl).kind, 'local', projectUrl);
  }
  assert.equal(doctor.classifyProjectUrl('https://abcdefghij.supabase.co').kind, 'hosted');
  assert.equal(doctor.classifyProjectUrl('https://abcdefghij.supabase.co/rest/v1').kind, 'malformed');
  assert.equal(doctor.classifyProjectUrl('not a url').kind, 'malformed');
  assert.equal(doctor.classifyProjectUrl('').kind, 'missing');
  assert.equal(doctor.classifyProjectUrl('https://dashboard.example.com').kind, 'other');
});

test('doctor and browser auth both reject raw loopback parser tricks', () => {
  const invalidLocalUrls = [
    ['decimal IPv4', 'http://2130706433:54321'],
    ['hexadecimal IPv4', 'http://0x7f000001:54321'],
    ['octal IPv4', 'http://017700000001:54321'],
    ['mixed IPv4', 'http://0x7f.0.0.1:54321'],
    ['short IPv4', 'http://127.1:54321'],
    ['credentials', 'http://user:pw@127.0.0.1:54321'],
    ['query', 'http://127.0.0.1:54321?value=1'],
    ['fragment', 'http://127.0.0.1:54321#fragment'],
    ['path', 'http://127.0.0.1:54321/rest/v1'],
    ['extra authority slashes', 'http:////127.0.0.1:54321'],
    ['backslash authority', 'http:\\\\127.0.0.1:54321'],
    ['dot-segment normalization', 'http://127.0.0.1:54321/a/..'],
    ['empty query', 'http://127.0.0.1:54321?'],
    ['empty fragment', 'http://127.0.0.1:54321#'],
    ['empty userinfo', 'http://@127.0.0.1:54321'],
    ['mixed separators', 'http:/\\127.0.0.1:54321'],
    ['expanded IPv6', 'http://[0:0:0:0:0:0:0:1]:54321'],
    ['trailing root slash', 'http://127.0.0.1:54321/'],
    ['surrounding whitespace', ' http://127.0.0.1:54321 ']
  ];

  for (const [name, projectUrl] of invalidLocalUrls) {
    assert.equal(doctor.classifyProjectUrl(projectUrl).kind, 'malformed', name);
    assert.throws(() => authService.normalizeConfig({ projectUrl, publishableKey: 'publishable' }),
      error => error.code === 'config_invalid', name + ' must also be rejected by browser auth');
  }
});

test('key classification separates publishable from secret classes without echoing the value', () => {
  assert.deepEqual(
    { ...doctor.classifyKey(fixtures.PUBLISHABLE_KEY), length: 0 },
    { class: 'publishable', safeForBrowser: true, length: 0 }
  );
  assert.equal(doctor.classifyKey(fixtures.SECRET_KEY).class, 'secret');
  assert.equal(doctor.classifyKey(fixtures.SECRET_KEY).safeForBrowser, false);
  assert.equal(doctor.classifyKey(fixtures.ANON_JWT).class, 'legacy-anon-jwt');
  assert.equal(doctor.classifyKey(fixtures.SERVICE_JWT).class, 'secret');
  assert.equal(doctor.classifyKey('').class, 'missing');
  assert.equal(doctor.classifyKey('YOUR_SUPABASE_PUBLISHABLE_KEY').class, 'placeholder');
  const classified = JSON.stringify(doctor.classifyKey(fixtures.SECRET_KEY));
  assert.equal(classified.includes(fixtures.SECRET_KEY), false);
});

test('snippet classification distinguishes read-only queries from mutating statements', () => {
  assert.equal(doctor.classifySnippet("select id from public.profiles where username like 'smoke_test%';"), 'read-only');
  assert.equal(doctor.classifySnippet('delete from public.profiles;'), 'mutating');
  assert.equal(doctor.classifySnippet('-- delete from public.profiles;\nselect 1;'), 'read-only');
});

test('supabase config and status parsing read the values the report depends on', () => {
  const ports = doctor.parseSupabasePorts(fixtures.CONFIG_TOML);
  assert.deepEqual(ports, { api: 54321, db: 54322, shadow: 54320, pooler: 54329, studio: 54323, smtp: 54324, analytics: 54327 });
  assert.deepEqual(doctor.parseSupabasePorts(fixtures.CONFIG_TOML.replace(/\n/g, '\r\n')), ports);
  const values = doctor.parseStatusEnv(fixtures.defaultStatusEnv());
  assert.equal(values.get('API_URL'), doctor.LOCAL_SUPABASE_URL);
  assert.equal(values.get('SERVICE_ROLE_KEY'), fixtures.SERVICE_JWT);
});

test('listener and process table parsing handles both platform formats', () => {
  const netstat = doctor.parseNetstatListeners([
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       9120',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4'
  ].join('\r\n'));
  assert.deepEqual(netstat, [
    { address: '127.0.0.1', port: 3100, pid: 9120 },
    { address: '0.0.0.0', port: 445, pid: 4 }
  ]);
  const ss = doctor.parseSsListeners('LISTEN 0      511          127.0.0.1:3100      0.0.0.0:*    users:(("node",pid=812,fd=20))');
  assert.deepEqual(ss, [{ address: '127.0.0.1', port: 3100, pid: 812 }]);
  assert.deepEqual(doctor.parsePsProcesses('  812 node /usr/bin/node scripts/dev/static-server.cjs'), [
    { pid: 812, name: 'node', commandLine: '/usr/bin/node scripts/dev/static-server.cjs' }
  ]);
});

test('Windows shim arguments are quoted so a path containing spaces stays one argument', () => {
  assert.equal(doctor.quoteWindowsArgument('status'), 'status');
  assert.equal(doctor.quoteWindowsArgument('-o'), '-o');
  assert.equal(doctor.quoteWindowsArgument('C:\\my dash board\\dashboard'), '"C:\\my dash board\\dashboard"');
  assert.equal(doctor.quoteWindowsArgument('a&b'), '"a&b"');
  assert.equal(doctor.quoteWindowsArgument('say "hi"'), '"say ""hi"""');
  assert.throws(() => doctor.quoteWindowsArgument('line\nbreak'), /control character/);
});

test('the real npm and Supabase CLI probes resolve on this platform', () => {
  const environment = createEnvironment();
  const npm = doctor.createDefaultDeps({}).runCommand('npm', ['--version'], { timeoutMs: 120000 });
  assert.equal(npm.status, 0, `npm --version failed: ${npm.error || npm.stderr}`);
  assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(environment.state.root, environment.root);
});

/* ==================== end-to-end scenarios ==================== */

test('a healthy environment reports READY with a zero exit code', async () => {
  const environment = createEnvironment({
    statusEntries: [],
    snippets: null,
    dataConfig: fixtures.dataConfigSource({ mode: 'local' })
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(result.status, doctor.STATUS_READY, JSON.stringify(result.findings.filter(f => f.severity !== 'ok'), null, 2));
  assert.equal(result.exitCode, doctor.EXIT_READY);
  assert.equal(result.dashboardPort, doctor.DEFAULT_DASHBOARD_PORT);
});

test('doctor is read-only: it never resets, provisions, deletes, or starts Docker', async () => {
  const environment = createEnvironment();
  await doctor.runDoctor({ deps: environment.deps });
  const commands = environment.commands();
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.doesNotMatch(command, /db\s+reset/i, command);
    assert.doesNotMatch(command, /supabase\s+start/i, command);
    assert.doesNotMatch(command, /docker\s+(start|run|rm|stop|compose)/i, command);
    assert.doesNotMatch(command, /Initialize-LocalSmokeUsers|provision-local-smoke-users/i, command);
    assert.doesNotMatch(command, /\b(rm|del|Remove-Item)\b/i, command);
    assert.doesNotMatch(command, /git\s+(checkout|reset|clean|commit|push)/i, command);
  }
});

test('an unavailable Docker CLI blocks with an install remediation', async () => {
  const environment = createEnvironment({ dockerCli: false });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(result.status, doctor.STATUS_BLOCKED);
  assert.equal(result.exitCode, doctor.EXIT_BLOCKED);
  const finding = findingByCode(result, 'DOCKER_CLI_MISSING');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.remediation, /Docker Desktop/);
});

test('an installed Docker CLI with a stopped daemon blocks and never starts Docker', async () => {
  const environment = createEnvironment({ dockerDaemon: false });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'DOCKER_DAEMON_STOPPED'), 'blocker');
  assert.equal(findingByCode(result, 'DOCKER_CLI_MISSING'), null);
  assert.match(findingByCode(result, 'DOCKER_DAEMON_STOPPED').remediation, /never starts Docker for you/);
  assert.equal(severity(result, 'SUPABASE_STATUS_UNKNOWN'), 'warning');
  assert.ok(environment.commands().every(command => !/docker\s+(start|run)/i.test(command)));
});

test('a stopped Supabase warns, and a running Supabase reports the API origin', async () => {
  const stopped = createEnvironment({ supabaseRunning: false, statusEntries: [], snippets: null });
  const stoppedResult = await doctor.runDoctor({ deps: stopped.deps });
  assert.equal(severity(stoppedResult, 'SUPABASE_STOPPED'), 'warning');
  assert.equal(stoppedResult.status, doctor.STATUS_WARNINGS);
  assert.equal(stoppedResult.exitCode, doctor.EXIT_WARNINGS);
  assert.match(findingByCode(stoppedResult, 'SUPABASE_STOPPED').remediation, /dev:local/);

  const running = createEnvironment({ statusEntries: [], snippets: null });
  const runningResult = await doctor.runDoctor({ deps: running.deps });
  assert.equal(severity(runningResult, 'SUPABASE_RUNNING'), 'ok');
  assert.equal(runningResult.facts.supabaseApiUrl, doctor.LOCAL_SUPABASE_URL);
});

test('expected Supabase ports and their process ownership are reported', async () => {
  const environment = createEnvironment({
    listeners: [
      { address: '127.0.0.1', port: 54321, pid: 700 },
      { address: '127.0.0.1', port: 54322, pid: 701 }
    ],
    processes: [
      { pid: 700, name: 'com.docker.backend.exe', commandLine: 'com.docker.backend.exe' },
      { pid: 701, name: 'com.docker.backend.exe', commandLine: 'com.docker.backend.exe' }
    ]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.deepEqual(result.facts.expectedSupabasePorts.api, 54321);
  const ownership = result.facts.portOwnership;
  const api = ownership.find(entry => entry.port === 54321);
  assert.deepEqual({ listening: api.listening, pid: api.pid, processName: api.processName }, { listening: true, pid: 700, processName: 'com.docker.backend.exe' });
  assert.equal(ownership.find(entry => entry.port === 3100).listening, false);
});

test('the selected dashboard port is reusable when it already serves this repository', async () => {
  const environment = createEnvironment({
    listeners: [{ address: '127.0.0.1', port: 3100, pid: 9120 }],
    processes: [{ pid: 9120, name: 'node.exe', commandLine: 'node scripts/dev/static-server.cjs' }]
  });
  environment.state.identities[3100] = identityFor(environment.root, { pid: 9120 });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'DASHBOARD_PORT_OWNED'), 'ok');
  assert.equal(findingByCode(result, 'DASHBOARD_PORT_FOREIGN'), null);
});

test('the selected dashboard port blocks when another project serves it', async () => {
  const environment = createEnvironment({
    listeners: [{ address: '127.0.0.1', port: 3100, pid: 4321 }],
    processes: [{ pid: 4321, name: 'node.exe', commandLine: 'node other-project/server.js' }]
  });
  environment.state.identities[3100] = identityFor(path.resolve(path.sep === '\\' ? 'C:\\Projects\\other' : '/srv/other'), { pid: 4321 });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'DASHBOARD_PORT_FOREIGN'), 'blocker');
  assert.equal(result.status, doctor.STATUS_BLOCKED);
  assert.match(findingByCode(result, 'DASHBOARD_PORT_FOREIGN').remediation, /--port/);
});

test('a foreign server on the documented port 3000 is reported as a warning', async () => {
  const environment = createEnvironment({
    listeners: [{ address: '127.0.0.1', port: 3000, pid: 777 }],
    processes: [{ pid: 777, name: 'node.exe', commandLine: 'node unrelated-app/index.js' }]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'PORT_3000_FOREIGN'), 'warning');
  assert.equal(result.facts.legacyPortServesThisRepository, false);
  assert.match(findingByCode(result, 'PORT_3000_FOREIGN').detail, /another project/);
});

test('a hosted project URL in the local configuration is a blocker', async () => {
  const environment = createEnvironment({
    supabaseConfig: fixtures.supabaseConfigSource({ projectUrl: 'https://abcdefghij.supabase.co' })
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'CONFIG_URL_HOSTED'), 'blocker');
  assert.match(findingByCode(result, 'CONFIG_URL_HOSTED').remediation, /127\.0\.0\.1:54321/);
  assert.match(findingByCode(result, 'CONFIG_URL_HOSTED').remediation, /Never edit that file automatically/);
});

test('malformed and parser-normalized project URLs are blockers with a concrete remediation', async () => {
  for (const projectUrl of [
    'http://127.0.0.1:54321/rest/v1?x=1',
    'http://2130706433:54321'
  ]) {
    const environment = createEnvironment({
      supabaseConfig: fixtures.supabaseConfigSource({ projectUrl })
    });
    const result = await doctor.runDoctor({ deps: environment.deps });
    assert.equal(severity(result, 'CONFIG_URL_MALFORMED'), 'blocker', projectUrl);
    assert.match(findingByCode(result, 'CONFIG_URL_MALFORMED').detail, /not usable/);
  }
});

test('a secret-class key in the browser configuration blocks and is never printed', async () => {
  const environment = createEnvironment({
    supabaseConfig: fixtures.supabaseConfigSource({ key: fixtures.SECRET_KEY })
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'CONFIG_KEY_SECRET'), 'blocker');
  assert.equal(result.facts.publishableKeyClass, 'secret');
  const serialized = JSON.stringify(result) + doctor.formatHuman(result);
  assert.equal(serialized.includes(fixtures.SECRET_KEY), false);
});

test('a publishable key is classified without the value reaching any output', async () => {
  const environment = createEnvironment();
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(result.facts.publishableKeyClass, 'publishable');
  assert.match(findingByCode(result, 'CONFIG_KEY_CLASS').detail, /never printed/);
  const serialized = JSON.stringify(doctor.redactDeep(result)) + doctor.formatHuman(result);
  assert.equal(serialized.includes(fixtures.PUBLISHABLE_KEY), false);
});

test('a missing local configuration blocks with a safe template instead of a guessed credential', async () => {
  const environment = createEnvironment({ supabaseConfig: null, dataConfig: null });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const finding = findingByCode(result, 'CONFIG_SUPABASE_MISSING');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.remediation, /paste the local publishable key/);
  assert.match(finding.remediation, /npx supabase status/);
  assert.equal(severity(result, 'CONFIG_DATA_MISSING'), 'warning');
  assert.match(findingByCode(result, 'CONFIG_DATA_MISSING').remediation, /REACTIVATION_DATA_CONFIG/);
});

test('the data mode and the local auth capability are both reported', async () => {
  const supabaseMode = createEnvironment();
  const supabaseResult = await doctor.runDoctor({ deps: supabaseMode.deps });
  assert.equal(supabaseResult.facts.dataMode, 'supabase');
  const capability = findingByCode(supabaseResult, 'FRONTEND_LOCAL_AUTH_SUPPORTED');
  assert.equal(capability.severity, 'ok');
  assert.match(capability.detail, /sign-in, session restore, and sign-out/);

  const localMode = createEnvironment({ dataConfig: fixtures.dataConfigSource({ mode: 'local' }) });
  const localResult = await doctor.runDoctor({ deps: localMode.deps });
  assert.equal(localResult.facts.dataMode, 'local');
  // No self-suppression: the finding does not depend on the data mode.
  assert.equal(findingByCode(localResult, 'FRONTEND_LOCAL_AUTH_SUPPORTED').severity, 'ok');
});

test('doctor never claims local sign-in is unsupported once the auth service accepts loopback', async () => {
  const localOrigin = doctor.LOCAL_SUPABASE_URL;

  // The claim and the implementation are checked against each other, so the two
  // cannot drift apart again: whatever doctor reports about the loopback origin
  // has to match what the browser auth service actually does with it.
  assert.equal(
    authService.normalizeConfig({ projectUrl: localOrigin, publishableKey: 'publishable' }).projectUrl,
    localOrigin);

  for (const dataConfig of [undefined, fixtures.dataConfigSource({ mode: 'local' })]) {
    const environment = createEnvironment(dataConfig ? { dataConfig } : {});
    const result = await doctor.runDoctor({ deps: environment.deps });
    assert.equal(findingByCode(result, 'FRONTEND_LOOPBACK_AUTH_UNSUPPORTED'), null);

    // No remediation anywhere may sell a data-mode switch as the way to sign in,
    // and none may assert that local sign-in fails.
    for (const finding of result.findings) {
      const text = `${finding.detail || ''} ${finding.remediation || ''}`;
      assert.equal(/sign-?in fails|cannot succeed locally/i.test(text), false,
        `finding ${finding.code} still claims local sign-in fails`);
      assert.equal(/For UI work set mode to 'local'/i.test(text), false,
        `finding ${finding.code} still recommends switching data mode to sign in`);
    }
  }
});

test('auth health is probed only against a loopback endpoint', async () => {
  const healthy = createEnvironment({ statusEntries: [], snippets: null });
  assert.equal(severity(await doctor.runDoctor({ deps: healthy.deps }), 'AUTH_HEALTHY'), 'ok');

  const unhealthy = createEnvironment({ authHealthy: false });
  assert.equal(severity(await doctor.runDoctor({ deps: unhealthy.deps }), 'AUTH_HEALTH_FAILED'), 'warning');

  const hosted = createEnvironment({
    supabaseConfig: fixtures.supabaseConfigSource({ projectUrl: 'https://abcdefghij.supabase.co' }),
    statusEnv: fixtures.defaultStatusEnv().replace(doctor.LOCAL_SUPABASE_URL, 'https://abcdefghij.supabase.co')
  });
  await doctor.runDoctor({ deps: hosted.deps });
  assert.ok(hosted.calls.filter(item => item.kind === 'probe').every(item => item.detail.startsWith('http://127.0.0.1')));
});

test('a missing smoke user is reported with the sanctioned provisioning remediation', async () => {
  const environment = createEnvironment({ smokeUsers: [], smokeProfiles: [] });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const finding = findingByCode(result, 'SMOKE_USER_MISSING');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /smoke_test_admin@local\.invalid/);
  assert.match(finding.remediation, /dev:local/);
  assert.equal(result.facts.smokeUsers.filter(account => account.state === 'user-missing').length, 3);
});

test('a user without a profile row and a profile bound to another id are distinguished', async () => {
  const profileless = createEnvironment({ smokeProfiles: [] });
  const profilelessResult = await doctor.runDoctor({ deps: profileless.deps });
  assert.equal(severity(profilelessResult, 'SMOKE_PROFILE_MISSING'), 'warning');

  const mismatch = createEnvironment({
    smokeProfiles: [
      { id: 'user-0', username: 'SOMEONE_ELSE', role: 'admin' },
      { id: 'user-1', username: 'SMOKE_TEST_agent_a', role: 'agent' },
      { id: 'user-2', username: 'SMOKE_TEST_agent_b', role: 'agent' }
    ]
  });
  const mismatchResult = await doctor.runDoctor({ deps: mismatch.deps });
  assert.equal(severity(mismatchResult, 'SMOKE_PROFILE_MISMATCH'), 'warning');
});

test('duplicate smoke usernames are surfaced as a corruption risk', async () => {
  const environment = createEnvironment({
    smokeProfiles: [
      { id: 'user-0', username: 'SMOKE_TEST_admin', role: 'admin' },
      { id: 'stray', username: 'smoke_test_admin', role: 'agent' },
      { id: 'user-1', username: 'SMOKE_TEST_agent_a', role: 'agent' },
      { id: 'user-2', username: 'SMOKE_TEST_agent_b', role: 'agent' }
    ]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const finding = findingByCode(result, 'SMOKE_USERNAME_DUPLICATE');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.remediation, /refuses to provision/);
  assert.deepEqual(result.facts.duplicateSmokeUsernames, ['smoke_test_admin']);
});

// Regression: a conflicting row was only reported when the account was otherwise
// healthy, so the exact corruption case - a stray row owning a smoke username
// while the Auth user is absent - produced no finding at all.
test('a single conflicting profile row is reported even when the Auth user is missing', async () => {
  const environment = createEnvironment({
    smokeUsers: [],
    smokeProfiles: [{ id: 'someone-else', username: 'SMOKE_TEST_admin', role: 'agent' }]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const finding = findingByCode(result, 'SMOKE_USERNAME_DUPLICATE');
  assert.ok(finding, 'a profile row holding a smoke username must be reported without a matching Auth user');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /SMOKE_TEST_admin/);
  assert.match(finding.remediation, /refuses to provision/);
  assert.deepEqual(result.facts.duplicateSmokeUsernames, [], 'no username occurs twice; the finding comes from the conflict count');
  assert.equal(result.facts.smokeUsers.find(account => account.key === 'admin').conflictingProfileCount, 1);
  assert.equal(findingByCode(result, 'SMOKE_USERS_READY'), null);
});

test('a conflicting profile row is reported alongside another defect on the same account', async () => {
  const environment = createEnvironment({
    smokeProfiles: [
      { id: 'user-0', username: 'RENAMED_admin', role: 'admin' },
      { id: 'stray', username: 'SMOKE_TEST_admin', role: 'agent' },
      { id: 'user-1', username: 'SMOKE_TEST_agent_a', role: 'agent' },
      { id: 'user-2', username: 'SMOKE_TEST_agent_b', role: 'agent' }
    ]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'SMOKE_PROFILE_MISMATCH'), 'warning');
  assert.equal(severity(result, 'SMOKE_USERNAME_DUPLICATE'), 'warning', 'the mismatch must not mask the conflict');
  assert.deepEqual(result.facts.duplicateSmokeUsernames, []);
  assert.equal(result.facts.smokeUsers.find(account => account.key === 'admin').conflictingProfileCount, 1);
});

test('an unconflicted database still reports the accounts as ready', async () => {
  const environment = createEnvironment();
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'SMOKE_USERS_READY'), 'ok');
  assert.equal(findingByCode(result, 'SMOKE_USERNAME_DUPLICATE'), null);
  assert.ok(result.facts.smokeUsers.every(account => account.conflictingProfileCount === 0));
});

test('a competing smoke, reset, or provisioning process blocks', async () => {
  for (const commandLine of [
    'powershell.exe -File scripts\\Invoke-LocalRuntimeSmokeTest.ps1',
    'node scripts/provision-local-smoke-users.cjs',
    'npx supabase db reset --local'
  ]) {
    const environment = createEnvironment({ processes: [{ pid: 8080, name: 'proc.exe', commandLine }] });
    const result = await doctor.runDoctor({ deps: environment.deps });
    assert.equal(severity(result, 'SMOKE_PROCESS_ACTIVE'), 'blocker', commandLine);
    assert.match(findingByCode(result, 'SMOKE_PROCESS_ACTIVE').remediation, /never terminates a process/);
  }
});

test('a concurrent agent process scoped to this repository warns but never blocks', async () => {
  const environment = createEnvironment({
    processes: [
      { pid: 4242, name: 'claude.exe', commandLine: `claude.exe --cwd ${fixtures.DEFAULT_ROOT}` },
      { pid: 9001, name: 'codex.exe', commandLine: `codex.exe app-server --workspace ${fixtures.DEFAULT_ROOT}` },
      { pid: 9002, name: 'codex.exe', commandLine: 'codex.exe app-server --workspace /some/other/place' }
    ]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const finding = findingByCode(result, 'AGENT_PROCESS_ACTIVE');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.detail, /pid 9001/);
  assert.doesNotMatch(finding.detail, /pid 4242/, 'the diagnostic must not report itself');
  assert.doesNotMatch(finding.detail, /pid 9002/);
});

test('a dirty tracked tree warns while a clean tree passes', async () => {
  const dirty = createEnvironment({ statusEntries: [' M src/auth.js', 'A  tests/new.test.cjs'] });
  const dirtyResult = await doctor.runDoctor({ deps: dirty.deps });
  assert.equal(severity(dirtyResult, 'GIT_TREE_DIRTY'), 'warning');
  assert.match(findingByCode(dirtyResult, 'GIT_TREE_DIRTY').detail, /src\/auth\.js/);

  const clean = createEnvironment({ statusEntries: [] });
  assert.equal(severity(await doctor.runDoctor({ deps: clean.deps }), 'GIT_TREE_CLEAN'), 'ok');
});

test('pre-existing untracked snippets are allowed, classified, and never deleted', async () => {
  const environment = createEnvironment({ statusEntries: ['?? supabase/snippets/'] });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'GIT_UNTRACKED_ALLOWED'), 'ok');
  assert.equal(findingByCode(result, 'GIT_UNTRACKED_UNEXPECTED'), null);
  const snippets = findingByCode(result, 'SNIPPETS_PRESENT');
  assert.equal(snippets.severity, 'warning');
  assert.match(snippets.detail, /read-only/);
  assert.match(snippets.remediation, /delete them yourself/);
  assert.deepEqual(result.facts.snippets, [{ name: 'Untitled query 173.sql', classification: 'read-only' }]);
});

test('a mutating snippet is classified separately', async () => {
  const environment = createEnvironment({
    snippets: [{ name: 'cleanup.sql', content: 'delete from public.profiles where username like \'SMOKE_TEST%\';' }]
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'SNIPPETS_MUTATING'), 'warning');
  assert.match(findingByCode(result, 'SNIPPETS_MUTATING').detail, /cleanup\.sql \(mutating\)/);
});

test('unexpected untracked paths and recovery artifacts are reported without removal', async () => {
  const environment = createEnvironment({
    statusEntries: ['?? scratch-notes.md', '?? supabase/snippets/'],
    rootEntries: ['package.json', 'reactivation-desk-recovery-sensitive-2026.json']
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const untracked = findingByCode(result, 'GIT_UNTRACKED_UNEXPECTED');
  assert.equal(untracked.severity, 'warning');
  assert.match(untracked.detail, /scratch-notes\.md/);
  assert.doesNotMatch(untracked.detail, /snippets/);
  assert.match(untracked.remediation, /never deletes files/);
  const recovery = findingByCode(result, 'RECOVERY_ARTIFACT_PRESENT');
  assert.equal(recovery.severity, 'warning');
  assert.match(recovery.detail, /recovery-sensitive/);
});

test('local main divergence from origin/main is reported from the last fetch', async () => {
  const diverged = createEnvironment({ ahead: 1, behind: 3 });
  const divergedResult = await doctor.runDoctor({ deps: diverged.deps });
  assert.equal(severity(divergedResult, 'GIT_MAIN_DIVERGED'), 'warning');
  assert.deepEqual(divergedResult.facts.mainComparison, { available: true, ahead: 1, behind: 3, note: 'reflects the last fetch of origin' });

  const missing = createEnvironment({ mainRefsAvailable: false });
  assert.equal(severity(await doctor.runDoctor({ deps: missing.deps }), 'GIT_MAIN_REF_MISSING'), 'warning');
});

test('a directory that is not the dashboard repository blocks immediately', async () => {
  const notGit = createEnvironment({ isGitRepository: false });
  const notGitResult = await doctor.runDoctor({ deps: notGit.deps });
  assert.equal(severity(notGitResult, 'REPO_NOT_GIT'), 'blocker');
  assert.equal(notGitResult.status, doctor.STATUS_BLOCKED);

  const otherRepository = createEnvironment({ packageName: 'some-other-project' });
  assert.equal(severity(await doctor.runDoctor({ deps: otherRepository.deps }), 'REPO_NOT_DASHBOARD'), 'blocker');
});

test('an unsupported Node version blocks', async () => {
  const environment = createEnvironment({ nodeVersion: '20.11.0' });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(severity(result, 'NODE_VERSION_UNSUPPORTED'), 'blocker');
});

test('a repository path containing spaces is handled throughout', async () => {
  const environment = createEnvironment({
    root: fixtures.SPACED_ROOT,
    statusEntries: [],
    snippets: null,
    dataConfig: fixtures.dataConfigSource({ mode: 'local' })
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  assert.equal(result.facts.repositoryRoot, fixtures.SPACED_ROOT);
  assert.equal(result.status, doctor.STATUS_READY, JSON.stringify(result.findings.filter(f => f.severity !== 'ok')));
});

test('configuration files are read identically with LF, CRLF, and a byte order mark', async () => {
  const variants = [
    { lineEnding: '\n', bom: false },
    { lineEnding: '\r\n', bom: false },
    { lineEnding: '\r\n', bom: true }
  ];
  for (const variant of variants) {
    const environment = createEnvironment({
      supabaseConfig: fixtures.supabaseConfigSource(variant),
      dataConfig: fixtures.dataConfigSource({ lineEnding: variant.lineEnding }),
      statusEntries: [],
      snippets: null
    });
    const result = await doctor.runDoctor({ deps: environment.deps });
    assert.equal(result.facts.configuredProjectUrl, doctor.LOCAL_SUPABASE_URL, JSON.stringify(variant));
    assert.equal(result.facts.publishableKeyClass, 'publishable', JSON.stringify(variant));
    assert.equal(result.facts.dataMode, 'supabase', JSON.stringify(variant));
  }
});

test('secret-shaped values from any inspected output are redacted', async () => {
  const environment = createEnvironment({
    statusEntries: [`?? ${fixtures.SECRET_KEY}-notes.txt`],
    statusEnv: `${fixtures.defaultStatusEnv()}\nEXTRA_TOKEN="${fixtures.SERVICE_JWT}"\n`
  });
  const result = await doctor.runDoctor({ deps: environment.deps });
  const serialized = `${JSON.stringify(doctor.redactDeep(result))}\n${doctor.formatHuman(result)}`;
  assert.equal(serialized.includes(fixtures.SECRET_KEY), false);
  assert.equal(serialized.includes(fixtures.SERVICE_JWT), false);
  assert.equal(serialized.includes(fixtures.ANON_JWT), false);
  assert.match(serialized, /REDACTED/);
});

test('the redaction helper covers bearer tokens, connection strings, and key classes', () => {
  assert.match(doctor.redact('Authorization: Bearer abc.def.ghi'), /\[REDACTED\]/);
  assert.match(doctor.redact('postgresql://postgres:hunter2@127.0.0.1:54322/postgres'), /postgres:\[REDACTED\]@/);
  assert.match(doctor.redact(`service_role_key=${fixtures.SECRET_KEY}`), /\[REDACTED\]/);
  assert.equal(doctor.redact(null), '');
  assert.deepEqual(doctor.redactDeep({ nested: [`key: ${fixtures.SECRET_KEY}`] }).nested[0].includes('sb_secret'), false);
});

/* ==================== interface ==================== */

test('the port selection accepts an override and rejects an invalid value', () => {
  assert.equal(doctor.resolveDashboardPort({}, {}), doctor.DEFAULT_DASHBOARD_PORT);
  assert.equal(doctor.resolveDashboardPort({ port: '4200' }, {}), 4200);
  assert.equal(doctor.resolveDashboardPort({}, { DASHBOARD_DEV_PORT: '4300' }), 4300);
  assert.throws(() => doctor.resolveDashboardPort({ port: '80' }, {}), /between 1024 and 65535/);
  assert.throws(() => doctor.resolveDashboardPort({ port: 'abc' }, {}), error => error.usage === true);
});

test('argument parsing accepts the documented flags and rejects anything else', () => {
  assert.deepEqual(doctor.parseArgs(['--json']), { json: true, port: null });
  assert.deepEqual(doctor.parseArgs(['--port', '4200']), { json: false, port: '4200' });
  assert.deepEqual(doctor.parseArgs(['--port=4200']), { json: false, port: '4200' });
  assert.throws(() => doctor.parseArgs(['--delete-everything']), error => error.usage === true);
});

test('the command line runs against the real repository and emits valid JSON', () => {
  const result = spawnSync(process.execPath, [path.join('scripts', 'dev', 'doctor.cjs'), '--json'], {
    cwd: root, encoding: 'utf8', timeout: 300000
  });
  assert.ok([doctor.EXIT_READY, doctor.EXIT_WARNINGS, doctor.EXIT_BLOCKED].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.ok([doctor.STATUS_READY, doctor.STATUS_WARNINGS, doctor.STATUS_BLOCKED].includes(payload.status));
  assert.equal(payload.exitCode, result.status);
  assert.ok(Array.isArray(payload.findings));
  for (const finding of payload.findings) {
    assert.ok(['ok', 'warning', 'blocker'].includes(finding.severity));
    assert.match(finding.code, /^[A-Z0-9_]+$/);
    if (finding.severity !== 'ok') assert.ok(finding.remediation, `${finding.code} must carry a remediation`);
  }
  assert.doesNotMatch(result.stdout, /sb_publishable_[A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(result.stdout, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
});

test('the human output ends with exactly one status line', () => {
  const result = spawnSync(process.execPath, [path.join('scripts', 'dev', 'doctor.cjs')], {
    cwd: root, encoding: 'utf8', timeout: 300000
  });
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  const statuses = lines.filter(line => [doctor.STATUS_READY, doctor.STATUS_WARNINGS, doctor.STATUS_BLOCKED].includes(line.trim()));
  assert.equal(statuses.length, 1, result.stdout);
  assert.equal(lines[lines.length - 1].trim(), statuses[0]);
});

test('an unknown argument exits with the usage code and changes nothing', () => {
  const result = spawnSync(process.execPath, [path.join('scripts', 'dev', 'doctor.cjs'), '--wipe'], {
    cwd: root, encoding: 'utf8', timeout: 60000
  });
  assert.equal(result.status, doctor.EXIT_USAGE);
  assert.match(result.stderr, /Unknown argument/);
});

test('the diagnostic source contains no destructive or process-terminating operation', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'dev', 'doctor.cjs'), 'utf8');
  assert.doesNotMatch(source, /db\s+reset/);
  assert.doesNotMatch(source, /rmSync|unlinkSync|writeFileSync|mkdirSync/);
  assert.doesNotMatch(source, /process\.kill|taskkill|Stop-Process/i);
  assert.doesNotMatch(source, /docker'?,?\s*\[\s*'(start|run|rm|stop)/);
  assert.doesNotMatch(source, /createUser|admin\.createUser/);
});

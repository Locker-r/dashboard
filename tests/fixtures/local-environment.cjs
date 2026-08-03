'use strict';

// Deterministic fixtures for the local environment diagnostic and launcher.
//
// Nothing here touches Docker, Supabase, a socket, a process table, or the real
// filesystem: every dependency the tools consume is produced from plain data, so
// each scenario is reproducible on any machine and in credential-free CI.

const path = require('node:path');
const doctor = require('../../scripts/dev/doctor.cjs');

const DEFAULT_ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\dashboard' : '/srv/dashboard');
const SPACED_ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\my dash board\\dashboard' : '/srv/my dash board/dashboard');

// Credential-shaped fixtures are assembled at run time so the literals never
// exist in a tracked file and never trip the repository secret scan.
const PUBLISHABLE_KEY = `sb_${'publishable'}_${'AbCdEfGhIjKlMnOpQrStUvWx'}`;
const SECRET_KEY = `sb_${'secret'}_${'AbCdEfGhIjKlMnOpQrStUvWx'}`;

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.${'SignatureSignature'}`;
}
const ANON_JWT = jwt({ role: 'anon', iss: 'supabase' });
const SERVICE_JWT = jwt({ role: 'service_role', iss: 'supabase' });

const CONFIG_TOML = [
  'project_id = "dashboard-runtime-smoke"',
  '',
  '[api]',
  'enabled = true',
  'port = 54321',
  '',
  '[db]',
  'port = 54322',
  'shadow_port = 54320',
  '',
  '[db.pooler]',
  'enabled = false',
  'port = 54329',
  '',
  '[studio]',
  'enabled = true',
  'port = 54323',
  '',
  '[local_smtp]',
  'port = 54324',
  '',
  '[analytics]',
  'enabled = true',
  'port = 54327',
  ''
].join('\n');

function supabaseConfigSource({ projectUrl = doctor.LOCAL_SUPABASE_URL, key = PUBLISHABLE_KEY, lineEnding = '\n', bom = false } = {}) {
  const body = [
    '(function configureSupabase(root) {',
    "  'use strict';",
    '',
    '  root.REACTIVATION_SUPABASE_CONFIG = Object.freeze({',
    `    projectUrl: ${JSON.stringify(projectUrl)},`,
    `    publishableKey: ${JSON.stringify(key)}`,
    '  });',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
  ].join(lineEnding);
  return bom ? `\uFEFF${body}` : body;
}

function dataConfigSource({ mode = 'supabase', lineEnding = '\n' } = {}) {
  return [
    '(function configureDataMode(root) {',
    "  'use strict';",
    '',
    '  root.REACTIVATION_DATA_CONFIG = Object.freeze({',
    `    mode: ${JSON.stringify(mode)}`,
    '  });',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
  ].join(lineEnding);
}

function defaultStatusEnv() {
  return [
    `API_URL="${doctor.LOCAL_SUPABASE_URL}"`,
    'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
    'STUDIO_URL="http://127.0.0.1:54323"',
    `ANON_KEY="${ANON_JWT}"`,
    `SERVICE_ROLE_KEY="${SERVICE_JWT}"`,
    ''
  ].join('\n');
}

function defaultSmokeUsers() {
  return doctor.EXPECTED_SMOKE_USERS.map((fixture, index) => ({ id: `user-${index}`, email: fixture.email }));
}

function defaultSmokeProfiles() {
  return doctor.EXPECTED_SMOKE_USERS.map((fixture, index) => ({ id: `user-${index}`, username: fixture.username, role: fixture.role }));
}

function createEnvironment(overrides = {}) {
  const root = overrides.root || DEFAULT_ROOT;
  const state = {
    root,
    branch: 'feature/example',
    head: 'abcdef0123456789abcdef0123456789abcdef01',
    mainRefsAvailable: true,
    ahead: 0,
    behind: 0,
    statusEntries: ['?? supabase/snippets/'],
    packageName: doctor.PACKAGE_NAME,
    isGitRepository: true,
    configToml: CONFIG_TOML,
    supabaseConfig: supabaseConfigSource(),
    dataConfig: dataConfigSource(),
    snippets: [{ name: 'Untitled query 173.sql', content: "select id, username, role\nfrom public.profiles\nwhere lower(username) like 'smoke_test%';\n" }],
    rootEntries: ['package.json', 'index.html', 'README.md'],
    nodeVersion: '22.23.1',
    npmVersion: '10.9.8',
    dockerCli: true,
    dockerDaemon: true,
    supabaseCli: true,
    supabaseRunning: true,
    statusEnv: defaultStatusEnv(),
    listeners: [],
    processes: [],
    identities: {},
    authHealthy: true,
    smokeUsers: defaultSmokeUsers(),
    smokeProfiles: defaultSmokeProfiles(),
    smokeError: null,
    env: {},
    platform: 'win32',
    selfPid: 4242,
    ...overrides
  };

  const calls = [];
  const record = (kind, detail) => {
    calls.push({ kind, detail });
  };

  const files = () => {
    const map = new Map();
    map.set(path.join(root, 'package.json'), state.packageName === null ? null : JSON.stringify({ name: state.packageName, version: '1.0.0' }));
    map.set(path.join(root, 'supabase', 'config.toml'), state.configToml);
    map.set(path.join(root, 'config', 'supabase-config.local.js'), state.supabaseConfig);
    map.set(path.join(root, 'config', 'data-config.local.js'), state.dataConfig);
    for (const snippet of state.snippets || []) {
      map.set(path.join(root, 'supabase', 'snippets', snippet.name), snippet.content);
    }
    for (const [relative, content] of Object.entries(state.extraFiles || {})) {
      map.set(path.join(root, ...relative.split('/')), content);
    }
    return map;
  };

  function runCommand(file, args = [], options = {}) {
    const command = `${file} ${args.join(' ')}`.trim();
    calls.push({ kind: 'command', detail: command, file, args, options });

    if (file === 'git') {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return state.isGitRepository ? ok(`${root}\n`) : fail('not a git repository');
      }
      if (args[0] === 'branch') return ok(`${state.branch}\n`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(`${state.head}\n`);
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return state.mainRefsAvailable ? ok(`${state.head}\n`) : fail('');
      }
      if (args[0] === 'rev-list') return ok(`${state.ahead}\t${state.behind}\n`);
      if (args[0] === 'status') return ok(state.statusEntries.map(entry => `${entry}\0`).join(''));
      return ok('');
    }
    if (file === 'npm') return state.npmVersion ? ok(`${state.npmVersion}\n`) : fail('npm missing');
    if (file === 'docker' && args[0] === '--version') {
      return state.dockerCli ? ok('Docker version 27.0.0\n') : fail('docker not found', 'spawn docker ENOENT');
    }
    if (file === 'docker' && args[0] === 'info') {
      return state.dockerDaemon ? ok('27.0.0\n') : fail('failed to connect to the docker API; is the daemon running?');
    }
    if (file === 'npx' && args[1] === '--version') {
      return state.supabaseCli ? ok('2.110.0\n') : fail('supabase CLI unavailable');
    }
    if (file === 'npx' && args[1] === 'status') {
      return state.supabaseRunning ? ok(state.statusEnv) : fail('supabase local development setup is not running');
    }
    if (file === 'npx' && args[1] === 'start') {
      state.supabaseRunning = true;
      return ok('Started supabase local development setup.\n');
    }
    if (state.commandHandler) {
      const handled = state.commandHandler(file, args, { ok, fail });
      if (handled) return handled;
    }
    return ok('');
  }

  function writeFileInto(target, content) {
    const relative = path.relative(root, target).split(path.sep).join('/');
    state.extraFiles = { ...(state.extraFiles || {}), [relative]: content };
    calls.push({ kind: 'write', detail: relative });
  }

  function removeFileFrom(target) {
    const relative = path.relative(root, target).split(path.sep).join('/');
    const remaining = { ...(state.extraFiles || {}) };
    delete remaining[relative];
    state.extraFiles = remaining;
    calls.push({ kind: 'remove', detail: relative });
  }

  function ok(stdout) {
    return { status: 0, stdout, stderr: '', error: null };
  }
  function fail(stderr, error = null) {
    return { status: 1, stdout: '', stderr, error };
  }

  const deps = {
    cwd: root,
    env: state.env,
    selfPid: state.selfPid,
    platform: state.platform,
    nodeVersion: state.nodeVersion,
    runCommand,
    readFile(target) {
      const map = files();
      return map.has(target) ? map.get(target) : null;
    },
    listDirectory(target) {
      if (target === path.join(root, 'supabase', 'snippets')) {
        if (state.snippets === null) return null;
        return state.snippets.map(snippet => ({ name: snippet.name, isFile: true }));
      }
      if (target === root) return (state.rootEntries || []).map(name => ({ name, isFile: true }));
      return null;
    },
    listListeners: () => state.listeners.map(listener => ({ ...listener })),
    listProcesses: () => state.processes.map(item => ({ ...item })),
    async httpProbe(url) {
      record('probe', url);
      const parsed = new URL(url);
      if (parsed.pathname === doctor.IDENTITY_PATH) {
        const identity = state.identities[Number(parsed.port)];
        if (!identity) return { ok: false, status: null, body: '', error: 'connection refused' };
        return { ok: true, status: 200, body: JSON.stringify(identity), error: null };
      }
      if (parsed.pathname === '/auth/v1/health') {
        return state.authHealthy
          ? { ok: true, status: 200, body: '{"name":"GoTrue"}', error: null }
          : { ok: false, status: null, body: '', error: 'connection refused' };
      }
      return { ok: false, status: 404, body: '', error: null };
    },
    async inspectSmokeUsers({ projectUrl, serviceKey, expected }) {
      record('smoke-inspection', projectUrl);
      if (!serviceKey) throw new Error('missing service key');
      if (state.smokeError) throw new Error(state.smokeError);
      return doctor.buildSmokeUserReport(expected, state.smokeUsers, state.smokeProfiles);
    }
  };

  deps.writeFile = writeFileInto;
  deps.removeFile = removeFileFrom;

  return {
    root,
    state,
    calls,
    deps,
    commands: () => calls.filter(item => item.kind === 'command').map(item => item.detail),
    commandCalls: () => calls.filter(item => item.kind === 'command'),
    kind: name => calls.filter(item => item.kind === name).map(item => item.detail)
  };
}

function identityFor(root, { pid = 5150, token = 'fixture-token', application = doctor.PACKAGE_NAME } = {}) {
  return { application, repositoryRoot: root, token, pid, startedAt: '2026-08-03T00:00:00.000Z', environment: 'LOCAL' };
}

function findingCodes(result) {
  return result.findings.map(finding => finding.code);
}

function findingByCode(result, code) {
  return result.findings.find(finding => finding.code === code) || null;
}

module.exports = {
  ANON_JWT,
  CONFIG_TOML,
  DEFAULT_ROOT,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SERVICE_JWT,
  SPACED_ROOT,
  createEnvironment,
  dataConfigSource,
  defaultStatusEnv,
  findingByCode,
  findingCodes,
  identityFor,
  jwt,
  supabaseConfigSource
};

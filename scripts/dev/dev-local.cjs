'use strict';

// Safe local dashboard launcher.
//
// The launcher is deliberately narrow: it diagnoses, refuses, starts, and cleans
// up only what it started. It never resets a database, never creates a user
// outside the sanctioned local-only provisioning path, never edits an ignored
// configuration file, never stops a container or a process it did not start, and
// never prints a key value.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const doctorModule = require('./doctor.cjs');
const {
  DEFAULT_DASHBOARD_PORT,
  EXIT_BLOCKED,
  EXIT_READY,
  EXIT_USAGE,
  EXPECTED_SMOKE_USERS,
  IDENTITY_PATH,
  LOCAL_SUPABASE_URL,
  classifyProjectUrl,
  createDefaultDeps,
  formatHuman,
  redact,
  redactDeep,
  resolveDashboardPort,
  runDoctor,
  smokeUserConflicts
} = doctorModule;

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STATE_RELATIVE_PATH = path.join('artifacts', 'dev-local.state.json');
const EXIT_FAILED = 1;

const ACCEPTED_KEY_CLASSES = Object.freeze(['publishable', 'legacy-anon-jwt']);
const PASSWORD_VARIABLES = Object.freeze([
  'SMOKE_TEST_ADMIN_PASSWORD',
  'SMOKE_TEST_AGENT_A_PASSWORD',
  'SMOKE_TEST_AGENT_B_PASSWORD'
]);

const USAGE = [
  'Usage: npm run dev:local [-- --open] [-- --no-provision] [-- --stop] [-- --port <number>] [-- --json]',
  '',
  '  --open           open the dashboard in the default browser after startup',
  '  --no-provision   skip local smoke-user provisioning',
  '  --stop           stop only the static server this launcher started, then exit',
  '  --port <number>  serve the dashboard on another port (default ' + DEFAULT_DASHBOARD_PORT + ')',
  '  --json           emit a machine-readable summary instead of the banner',
  '',
  'The launcher never resets the database, never removes containers, and never',
  'terminates a process it did not start.',
  '',
  'Exit codes: 0 started or reused, 1 startup failure, 2 refused, 64 invalid usage.'
].join('\n');

function parseLauncherArgs(argv) {
  const options = { open: false, provision: true, stop: false, json: false, port: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--open') options.open = true;
    else if (argument === '--no-provision') options.provision = false;
    else if (argument === '--stop') options.stop = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--port') {
      index += 1;
      options.port = argv[index];
    } else if (argument.startsWith('--port=')) options.port = argument.slice('--port='.length);
    else {
      const error = new Error(`Unknown argument: ${argument}`);
      error.usage = true;
      throw error;
    }
  }
  return options;
}

/* ==================== launcher dependencies ==================== */

function defaultSpawnServer({ root, port, token, application, onLog }) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [
    path.join(root, 'scripts', 'dev', 'static-server.cjs'),
    '--root', root,
    '--port', String(port),
    '--token', token,
    '--application', application
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split('\n').find(candidate => candidate.includes('"ready"'));
      if (line) {
        try {
          const parsed = JSON.parse(line);
          finish(null, { child, pid: child.pid, port: parsed.port });
        } catch {
          // Wait for a complete line.
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (typeof onLog === 'function') onLog(redact(chunk).trimEnd());
    });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`Static server exited before it became ready (code ${code}).`)));
    setTimeout(() => finish(new Error('Static server did not become ready within 15 seconds.')), 15000).unref();
  });
}

function defaultOpenBrowser(url, run) {
  if (process.platform === 'win32') return run('cmd.exe', ['/c', 'start', '', url], { timeoutMs: 15000 });
  if (process.platform === 'darwin') return run('open', [url], { timeoutMs: 15000 });
  return run('xdg-open', [url], { timeoutMs: 15000 });
}

function createLauncherDeps(overrides = {}) {
  const base = createDefaultDeps(overrides);
  return {
    ...base,
    runDoctor: overrides.runDoctor || runDoctor,
    spawnServer: overrides.spawnServer || defaultSpawnServer,
    killProcess: overrides.killProcess || ((pid, signal) => process.kill(pid, signal)),
    openBrowser: overrides.openBrowser || (url => defaultOpenBrowser(url, base.runCommand)),
    writeFile: overrides.writeFile || ((target, content) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }),
    removeFile: overrides.removeFile || (target => {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // A missing state file is already the desired end state.
      }
    }),
    createToken: overrides.createToken || (() => crypto.randomBytes(24).toString('hex')),
    log: overrides.log || (line => process.stdout.write(`${line}\n`)),
    logError: overrides.logError || (line => process.stderr.write(`${line}\n`)),
    onOwnedServer: overrides.onOwnedServer || null
  };
}

/* ==================== state ==================== */

function statePath(root) {
  return path.join(root, STATE_RELATIVE_PATH);
}

function readState(deps, root) {
  const content = deps.readFile(statePath(root));
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(deps, root, state) {
  deps.writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

async function probeIdentity(deps, port) {
  const probe = await deps.httpProbe(`http://127.0.0.1:${port}${IDENTITY_PATH}`, { timeoutMs: 3000 });
  if (!probe.ok || probe.status !== 200) return null;
  try {
    const parsed = JSON.parse(probe.body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function servesThisRepository(identity, root) {
  if (!identity || typeof identity.repositoryRoot !== 'string') return false;
  return path.resolve(identity.repositoryRoot).toLowerCase() === path.resolve(root).toLowerCase();
}

/* ==================== --stop ==================== */

async function stopLauncher(deps, root) {
  const state = readState(deps, root);
  if (!state || !Number.isInteger(state.pid) || !Number.isInteger(state.port)) {
    deps.log('No launcher state file was found; nothing owned by this launcher is running.');
    return EXIT_READY;
  }
  const identity = await probeIdentity(deps, state.port);
  if (!identity) {
    deps.log(`Port ${state.port} is not serving a launcher identity; the recorded server is already gone.`);
    deps.removeFile(statePath(root));
    deps.log('Stale launcher state removed. No process was terminated.');
    return EXIT_READY;
  }
  if (identity.token !== state.token || !servesThisRepository(identity, root) || identity.pid !== state.pid) {
    deps.logError(`Refusing to stop pid ${identity.pid} on port ${state.port}: it is not the server this launcher started.`);
    deps.logError('Stop that process yourself if it is unwanted. The launcher never terminates a foreign process.');
    return EXIT_BLOCKED;
  }
  try {
    deps.killProcess(state.pid, 'SIGTERM');
  } catch (error) {
    deps.logError(`Could not signal pid ${state.pid}: ${redact(error && error.message || error)}`);
    return EXIT_FAILED;
  }
  deps.removeFile(statePath(root));
  deps.log(`Stopped the launcher static server (pid ${state.pid}, port ${state.port}).`);
  deps.log('Local Supabase and every Docker container were left running. Stop Supabase yourself with: npx supabase stop');
  return EXIT_READY;
}

/* ==================== startup steps ==================== */

function verifyLocalConfiguration(doctorResult, deps) {
  const configuration = doctorResult.context.configuration;
  if (!configuration) {
    deps.logError('The diagnostic did not produce a configuration reading; refusing to start.');
    return false;
  }
  if (configuration.projectUrl !== LOCAL_SUPABASE_URL) {
    deps.logError(`Refusing to start: config/supabase-config.local.js must point only to ${LOCAL_SUPABASE_URL} (found ${configuration.projectUrl || 'nothing usable'}).`);
    deps.logError('Edit that file yourself; the launcher never rewrites ignored local configuration.');
    return false;
  }
  if (!ACCEPTED_KEY_CLASSES.includes(configuration.publishableKeyClass)) {
    deps.logError(`Refusing to start: the configured key is classified as '${configuration.publishableKeyClass}', not a browser-public publishable key.`);
    deps.logError('Take the local publishable/anon key from "npx supabase status" and paste it into config/supabase-config.local.js. The key value is never printed here.');
    return false;
  }
  deps.log(`Local configuration verified: ${LOCAL_SUPABASE_URL} with a ${configuration.publishableKeyClass} key (value never printed).`);
  return true;
}

function ensureSupabase(deps, root, doctorResult) {
  if (doctorResult.context.supabaseRunning) {
    deps.log('Local Supabase is already running; reusing it. No reset, no container removal.');
  } else {
    deps.log('Starting local Supabase (npx supabase start). This never resets the database.');
    const start = deps.runCommand('npx', ['supabase', 'start'], { cwd: root, timeoutMs: 600000 });
    if (start.status !== 0) {
      deps.logError(`Local Supabase failed to start: ${redact(start.stderr || start.error || 'unknown failure')}`);
      deps.logError('Inspect the containers without deleting them: docker ps -a');
      return null;
    }
  }
  const status = deps.runCommand('npx', ['supabase', 'status', '-o', 'env'], { cwd: root, timeoutMs: 120000 });
  if (status.status !== 0) {
    deps.logError('Local Supabase status could not be read after startup.');
    return null;
  }
  const values = doctorModule.parseStatusEnv(status.stdout);
  const apiUrl = values.get('API_URL') || '';
  if (classifyProjectUrl(apiUrl).kind !== 'local') {
    deps.logError(`Refusing to continue: local Supabase reported a non-loopback API URL (${redact(apiUrl)}).`);
    return null;
  }
  return values;
}

async function claimDashboardPort(deps, root, port, application) {
  const existing = await probeIdentity(deps, port);
  if (existing) {
    if (!servesThisRepository(existing, root)) {
      deps.logError(`Refusing to reuse port ${port}: it is served by another project (${redact(String(existing.repositoryRoot || 'unknown root'))}).`);
      deps.logError(`Stop that server, or choose another port: npm run dev:local -- --port <free port>`);
      return { refused: true };
    }
    deps.log(`Port ${port} already serves this repository (pid ${existing.pid}); reusing it without starting a second server.`);
    return { reused: true, pid: existing.pid, port };
  }

  const token = deps.createToken();
  let started;
  try {
    started = await deps.spawnServer({ root, port, token, application, onLog: line => deps.logError(line) });
  } catch (error) {
    deps.logError(`Could not start the dashboard static server on port ${port}: ${redact(error && error.message || error)}`);
    return { failed: true };
  }

  const identity = await probeIdentity(deps, started.port);
  if (!servesThisRepository(identity, root) || !identity || identity.token !== token) {
    deps.logError(`The server on port ${started.port} did not identify as this repository; stopping the process this launcher started.`);
    try {
      deps.killProcess(started.pid, 'SIGTERM');
    } catch {
      // The child may already have exited; nothing else is ever signalled.
    }
    return { failed: true };
  }

  writeState(deps, root, {
    schemaVersion: 1,
    pid: started.pid,
    port: started.port,
    token,
    repositoryRoot: path.resolve(root),
    startedAt: new Date().toISOString()
  });
  deps.log(`Serving ${path.resolve(root)} on port ${started.port} (pid ${started.pid}); this launcher owns that process only.`);
  return { started: true, pid: started.pid, port: started.port, token, child: started.child };
}

// Inspects the live local database immediately before provisioning. The
// diagnostic runs before Supabase is started, so in the ordinary case it has no
// user state to report; a gate built on that snapshot would pass vacuously.
async function inspectSmokeUsersNow(deps, statusValues) {
  const serviceKey = statusValues.get('SERVICE_ROLE_KEY') || '';
  const apiUrl = statusValues.get('API_URL') || '';
  if (!serviceKey) {
    return { available: false, reason: 'the local status output contained no service key' };
  }
  if (classifyProjectUrl(apiUrl).kind !== 'local') {
    return { available: false, reason: 'the reported API URL is not a loopback endpoint' };
  }
  const expected = EXPECTED_SMOKE_USERS.map(fixture => ({
    ...fixture,
    email: String(deps.env[fixture.envName] || fixture.email)
  }));
  try {
    const inspection = await deps.inspectSmokeUsers({ projectUrl: apiUrl, serviceKey, expected });
    return { available: true, inspection };
  } catch (error) {
    return { available: false, reason: redact(error && error.message || error) };
  }
}

// Provisioning goes through the existing sanctioned local-only path. The
// launcher supplies no credential of its own: a missing password produces an
// instruction, never a generated value.
function provisionSmokeUsers(deps, root, statusValues, inspectionResult) {
  if (!inspectionResult || !inspectionResult.available) {
    deps.log('Skipping smoke-user provisioning: the local smoke-user state could not be verified.');
    deps.log(`  Reason: ${inspectionResult ? inspectionResult.reason : 'no inspection was performed'}`);
    deps.log('  Provisioning is refused rather than attempted blind, because it could overwrite an existing profile row.');
    return { skipped: 'unverified' };
  }

  const { duplicates, mismatched } = smokeUserConflicts(inspectionResult.inspection);
  if (duplicates.length || mismatched.length) {
    deps.log('Skipping smoke-user provisioning: the local database has conflicting profile rows.');
    if (duplicates.length) deps.log(`  SMOKE_USERNAME_DUPLICATE: smoke usernames bound to unexpected rows: ${duplicates.join(', ')}.`);
    if (mismatched.length) deps.log(`  SMOKE_PROFILE_MISMATCH: profile linkage differs for: ${mismatched.map(account => `${account.email} (${account.state})`).join(', ')}.`);
    deps.log('  Resolve the duplicate or mismatched profile rows manually first; provisioning into them would corrupt usernames.');
    return { skipped: 'conflict' };
  }

  const missing = PASSWORD_VARIABLES.filter(name => !String(deps.env[name] || '').trim());
  if (missing.length) {
    deps.log('Skipping smoke-user provisioning: required local passwords are not set.');
    deps.log(`  Missing: ${missing.join(', ')}`);
    deps.log('  Set them yourself for this shell, then rerun. The launcher never invents a credential:');
    for (const name of missing) deps.log(`    $env:${name} = '<choose a local-only password>'`);
    return { skipped: 'credentials' };
  }

  const serviceKey = statusValues.get('SERVICE_ROLE_KEY') || '';
  const apiUrl = statusValues.get('API_URL') || '';
  const childEnv = {
    ...deps.env,
    SMOKE_TEST_MODE: 'local',
    SMOKE_TEST_PROJECT_URL: apiUrl,
    SMOKE_TEST_ALLOWED_PROJECT_URL: apiUrl,
    SMOKE_TEST_LOCAL_SERVICE_KEY: serviceKey
  };
  for (const fixture of EXPECTED_SMOKE_USERS) {
    if (!childEnv[fixture.envName]) childEnv[fixture.envName] = fixture.email;
  }

  const usePowerShell = deps.platform === 'win32';
  const result = usePowerShell
    ? deps.runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join('scripts', 'Initialize-LocalSmokeUsers.ps1')], { cwd: root, env: childEnv, timeoutMs: 180000 })
    : deps.runCommand(process.execPath, [path.join('scripts', 'provision-local-smoke-users.cjs')], { cwd: root, env: childEnv, timeoutMs: 180000 });

  if (result.status !== 0) {
    deps.logError(`Smoke-user provisioning failed: ${redact(result.stderr || result.stdout || result.error || 'unknown failure')}`);
    return { failed: true };
  }
  deps.log('Smoke users provisioned through scripts/Initialize-LocalSmokeUsers.ps1 (local-only, no database reset).');
  return { provisioned: true };
}

function banner(deps, details) {
  const lines = [
    '',
    '========================================',
    ' Reactivation Desk dashboard - LOCAL',
    '========================================',
    `  Dashboard   : ${details.dashboardUrl}`,
    `  Supabase    : ${details.supabaseUrl}`,
    `  Studio      : ${details.studioUrl}`,
    '  Environment : LOCAL',
    `  Admin email : ${details.adminEmail}`,
    '',
    '  Stop this launcher:',
    '    Ctrl+C in this terminal',
    '    npm run dev:local -- --stop      (from another terminal)',
    '  Local Supabase keeps running until you stop it yourself:',
    '    npx supabase stop',
    '========================================',
    ''
  ];
  for (const line of lines) deps.log(line);
}

/* ==================== orchestration ==================== */

async function runLauncher(options = {}) {
  const deps = createLauncherDeps(options.deps || {});
  const root = options.root || deps.cwd || PROJECT_ROOT;

  let flags;
  try {
    flags = parseLauncherArgs(options.argv || []);
  } catch (error) {
    deps.logError(`${redact(error.message)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (flags.help) {
    deps.log(USAGE);
    return EXIT_READY;
  }
  if (flags.stop) return stopLauncher(deps, root);

  let port;
  try {
    port = resolveDashboardPort(flags, deps.env);
  } catch (error) {
    deps.logError(`${redact(error.message)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const doctorResult = await deps.runDoctor({ port, deps: options.doctorDeps });
  if (flags.json) deps.log(JSON.stringify(redactDeep({ doctor: doctorResult }), null, 2));
  else deps.log(formatHuman(doctorResult));

  if (doctorResult.exitCode >= EXIT_BLOCKED) {
    deps.logError('');
    deps.logError('Refusing to start: the diagnostic reported at least one blocker.');
    for (const finding of doctorResult.findings.filter(item => item.severity === 'blocker')) {
      deps.logError(`  ${finding.code}: ${finding.detail}`);
      if (finding.remediation) deps.logError(`    -> ${finding.remediation}`);
    }
    return EXIT_BLOCKED;
  }

  if (!verifyLocalConfiguration(doctorResult, deps)) return EXIT_BLOCKED;

  const statusValues = ensureSupabase(deps, root, doctorResult);
  if (!statusValues) return EXIT_FAILED;

  const claim = await claimDashboardPort(deps, root, port, doctorModule.PACKAGE_NAME);
  if (claim.refused) return EXIT_BLOCKED;
  if (claim.failed) return EXIT_FAILED;

  if (flags.provision) {
    // Deliberately after ensureSupabase: the gate must see the database as it is
    // now, not as the pre-start diagnostic could not see it.
    const inspectionResult = await inspectSmokeUsersNow(deps, statusValues);
    provisionSmokeUsers(deps, root, statusValues, inspectionResult);
  } else {
    deps.log('Smoke-user provisioning skipped (--no-provision).');
  }

  const dashboardUrl = `http://127.0.0.1:${claim.port}/`;
  const studioPort = doctorResult.facts.expectedSupabasePorts ? doctorResult.facts.expectedSupabasePorts.studio : null;
  banner(deps, {
    dashboardUrl,
    supabaseUrl: statusValues.get('API_URL') || LOCAL_SUPABASE_URL,
    studioUrl: studioPort ? `http://127.0.0.1:${studioPort}/` : 'unavailable',
    adminEmail: deps.env.SMOKE_TEST_ADMIN_EMAIL || EXPECTED_SMOKE_USERS[0].email
  });

  if (flags.open) {
    deps.log(`Opening ${dashboardUrl}`);
    deps.openBrowser(dashboardUrl);
  }

  if (claim.started && claim.child) {
    if (typeof deps.onOwnedServer === 'function') deps.onOwnedServer(claim);
    else await superviseOwnedServer(deps, root, claim);
  }
  return EXIT_READY;
}

// Keeps the launcher in the foreground and terminates exactly one process on
// exit: the static server it started. Docker, Supabase, and every other process
// are left untouched.
function superviseOwnedServer(deps, root, claim) {
  return new Promise(resolve => {
    let stopping = false;
    const cleanup = () => {
      if (stopping) return;
      stopping = true;
      try {
        deps.killProcess(claim.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      deps.removeFile(statePath(root));
      deps.log('Launcher stopped its own static server. Local Supabase and all containers were left running.');
      resolve(EXIT_READY);
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    claim.child.once('exit', () => {
      deps.removeFile(statePath(root));
      resolve(EXIT_READY);
    });
  });
}

async function main(argv) {
  return runLauncher({ argv, root: PROJECT_ROOT });
}

module.exports = {
  ACCEPTED_KEY_CLASSES,
  PASSWORD_VARIABLES,
  STATE_RELATIVE_PATH,
  USAGE,
  claimDashboardPort,
  createLauncherDeps,
  inspectSmokeUsersNow,
  main,
  parseLauncherArgs,
  provisionSmokeUsers,
  readState,
  runLauncher,
  servesThisRepository,
  statePath,
  stopLauncher,
  verifyLocalConfiguration,
  writeState
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`dev:local failed: ${redact(error && error.stack || error)}\n`);
    process.exitCode = EXIT_FAILED;
  });
}

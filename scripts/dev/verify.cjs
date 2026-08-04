'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const doctor = require('./doctor.cjs');
const pages = require('../build-pages-artifact.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 1;
const EXIT_OK = 0;
const EXIT_VALIDATION = 1;
const EXIT_BLOCKED = 2;
const EXIT_USAGE = 64;
const EXIT_INTERNAL = 70;
const VALID_TIERS = Object.freeze(['fast', 'pr', 'runtime', 'release']);
const STATUS_PASSED = 'passed';
const STATUS_FAILED = 'failed';
const STATUS_BLOCKED = 'blocked';
const STATUS_SKIPPED = 'skipped';
const STATUS_INTERRUPTED = 'interrupted';
const RELEASE_MARKER = '.verify-owner.json';
const RELEASE_SLOT_NAMES = Object.freeze(['a', 'b']);
const SAFE_RUNTIME_RUN_ID = 'verifyruntime0001';
const FULL_SHA = /^[0-9a-f]{40}$/i;

const PR_STAGE_SPECS = Object.freeze([
  Object.freeze({ id: 'unit-tests', label: 'Full unit test suite', executable: 'npm', args: ['test'], timeoutMs: 360000 }),
  Object.freeze({ id: 'javascript-syntax', label: 'JavaScript syntax validation', executable: 'npm', args: ['run', 'check:js'], timeoutMs: 180000 }),
  Object.freeze({ id: 'secret-scan', label: 'Tracked-file secret scan', executable: 'npm', args: ['run', 'check:secrets'], timeoutMs: 180000 }),
  Object.freeze({ id: 'migration-governance', label: 'Migration governance', executable: 'npm', args: ['run', 'check:migrations'], timeoutMs: 180000 }),
  Object.freeze({ id: 'project-status', label: 'Project-status validation', executable: 'npm', args: ['run', 'check:project-status'], timeoutMs: 180000, blockedExitCodes: [2], blockerCode: 'PROJECT_STATUS_BLOCKED' }),
  Object.freeze({ id: 'preflight', label: 'Development preflight', executable: 'npm', args: ['run', 'preflight'], timeoutMs: 420000, blockedExitCodes: [2], blockerCode: 'PREFLIGHT_BLOCKED' }),
  Object.freeze({ id: 'diff-whitespace', label: 'Git diff whitespace validation', executable: 'git', args: ['diff', '--check'], timeoutMs: 60000 })
]);

const USAGE = [
  'Usage: node scripts/dev/verify.cjs <fast|pr|runtime|release> [options]',
  '',
  'Options:',
  '  --json         Emit only the versioned JSON result.',
  '  --offline      Refuse network-dependent release verification.',
  '  --allow-reset  Permit the sanctioned local reset suite (runtime only).',
  '  --help, -h     Show this help.',
  '',
  'Verification never commits, pushes, merges, tags, publishes, or deploys.'
].join('\n');

class VerificationError extends Error {
  constructor(code, message, exitCode = EXIT_INTERNAL, options = {}) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.exitCode = exitCode;
    this.preserveReleaseWorkspace = Boolean(options.preserveReleaseWorkspace);
    this.recoveryPath = options.recoveryPath || null;
  }
}

function usageError(code, message) {
  return new VerificationError(code, message, EXIT_USAGE);
}

function sensitiveEnvironmentValues(environment) {
  return Object.entries(environment || {})
    .filter(([name, value]) => /(?:PASSWORD|TOKEN|SECRET|KEY|AUTHORIZATION|DATABASE_URL)/i.test(name) && String(value || '').length >= 4)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
}

function redact(value, sensitiveValues = []) {
  let output = String(value === undefined || value === null ? '' : value);
  for (const sensitive of sensitiveValues) output = output.split(sensitive).join('[REDACTED]');
  output = doctor.redact(output);
  output = output.replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
  output = output.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  output = output.replace(new RegExp('\\bsb_' + 'secret_[A-Za-z0-9_-]{8,}\\b', 'gi'), '[REDACTED]');
  output = output.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]');
  output = output.replace(/((?:password|token|secret|service[_-]?role[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  output = output.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi, '$1[REDACTED]$2');
  return output;
}

function redactDeep(value, sensitiveValues = []) {
  if (typeof value === 'string') return redact(value, sensitiveValues);
  if (Array.isArray(value)) return value.map(entry => redactDeep(entry, sensitiveValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry, sensitiveValues)]));
  }
  return value;
}

function bounded(value, maximum = 12000, sensitiveValues = []) {
  const safe = redact(value, sensitiveValues).trim();
  if (safe.length <= maximum) return safe;
  return `[output truncated to final ${maximum} characters]\n${safe.slice(-maximum)}`;
}

function commandOutput(result, sensitiveValues = []) {
  const parts = [];
  if (result && result.stdout) parts.push(String(result.stdout));
  if (result && result.stderr) parts.push(String(result.stderr));
  if (result && result.error) parts.push(result.error.message || String(result.error));
  return bounded(parts.join('\n'), 12000, sensitiveValues);
}

function parseArgs(argv) {
  const input = Array.from(argv || []);
  if (!input.length) throw usageError('TIER_REQUIRED', 'A verification tier is required.');
  if (input[0] === '--help' || input[0] === '-h') {
    if (input.length !== 1) throw usageError('OPTION_INVALID', 'Help does not accept additional arguments.');
    return Object.freeze({ help: true, tier: null, json: false, offline: false, allowReset: false });
  }

  const tier = String(input.shift()).toLowerCase();
  if (!VALID_TIERS.includes(tier)) throw usageError('TIER_INVALID', `Unknown verification tier '${tier}'.`);
  const options = { help: false, tier, json: false, offline: false, allowReset: false };
  for (const argument of input) {
    if (argument === '--json') options.json = true;
    else if (argument === '--offline') options.offline = true;
    else if (argument === '--allow-reset') options.allowReset = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw usageError('OPTION_INVALID', `Unknown verification option '${argument}'.`);
  }
  if (options.help && input.length !== 1) throw usageError('OPTION_INVALID', 'Help does not accept additional options.');
  if (options.allowReset && tier !== 'runtime') {
    throw usageError('RESET_OPTION_INVALID', '--allow-reset is accepted only by verify:runtime.');
  }
  return Object.freeze(options);
}

function npmExecutable(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function powershellExecutable(platform) {
  return platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

function normalizedCommand(file, args, deps) {
  if (deps.platform !== 'win32' || !/npm\.cmd$/i.test(file)) return { file, args };
  const npmCli = String(deps.env.npm_execpath || '');
  const commandPath = deps.platform === 'win32' ? path.win32 : path;
  if (!commandPath.isAbsolute(npmCli) || commandPath.basename(npmCli).toLowerCase() !== 'npm-cli.js') {
    throw new VerificationError(
      'NPM_EXECUTABLE_UNAVAILABLE',
      'npm.cmd cannot be launched safely without npm_execpath; run the verifier through npm run verify:<tier>.',
      EXIT_BLOCKED
    );
  }
  let info;
  try {
    info = deps.fs.statSync(npmCli);
  } catch {
    throw new VerificationError('NPM_EXECUTABLE_UNAVAILABLE', 'npm_execpath does not identify a readable npm CLI file.', EXIT_BLOCKED);
  }
  if (!info.isFile()) throw new VerificationError('NPM_EXECUTABLE_UNAVAILABLE', 'npm_execpath is not an ordinary file.', EXIT_BLOCKED);
  return { file: process.execPath, args: [npmCli, ...args] };
}

function defaultRunCommand(file, args, options, deps) {
  return new Promise(resolve => {
    let command;
    try {
      command = normalizedCommand(file, args, deps);
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error });
      return;
    }

    let child;
    try {
      child = deps.spawnProcess(command.file, command.args, {
        cwd: options.cwd,
        env: options.env || deps.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error });
      return;
    }

    const terminationPolicy = options.terminationPolicy === 'wait' ? 'wait' : 'terminate';
    if (deps.controller) {
      deps.controller.child = child;
      deps.controller.terminationPolicy = terminationPolicy;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let forceTimer = null;
    let timeoutError = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (deps.controller && deps.controller.child === child) {
        deps.controller.child = null;
        deps.controller.terminationPolicy = null;
      }
      resolve(result);
    };
    const completed = (status, signal, error = null) => finish(timeoutError ? {
      status: null,
      signal,
      stdout,
      stderr: `${stderr}\n${timeoutError.message}`,
      error: timeoutError,
      timedOut: true
    } : { status, signal, stdout, stderr, error });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => completed(null, null, error));
    child.on('close', (status, signal) => completed(status, signal));
    timer = options.timeoutMs > 0 ? setTimeout(() => {
      timeoutError = new Error(`Timed out after ${options.timeoutMs} ms; the verifier requested termination of its owned child.`);
      if (terminationPolicy === 'wait') {
        timeoutError = new Error(`Timed out after ${options.timeoutMs} ms; waiting for the destructive owned process tree to finish safely.`);
        return;
      }
      try { child.kill('SIGTERM'); } catch {}
      if (settled) return;
      forceTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
      }, deps.killGraceMs);
    }, options.timeoutMs) : null;
  });
}

function nowValue(deps) {
  const value = deps.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new VerificationError('CLOCK_INVALID', 'Injected clock returned an invalid value.');
  return date;
}

function createDefaultDeps(overrides = {}) {
  const deps = {
    env: overrides.env || process.env,
    platform: overrides.platform || process.platform,
    fs: overrides.fs || fs,
    now: overrides.now || (() => new Date()),
    randomToken: overrides.randomToken || (() => crypto.randomBytes(16).toString('hex')),
    repository: overrides.repository || null,
    controller: overrides.controller || { interrupted: false, child: null },
    streams: overrides.streams || process,
    doctorDeps: overrides.doctorDeps,
    runDoctor: overrides.runDoctor || (options => doctor.runDoctor(options)),
    onStageStart: overrides.onStageStart || null,
    spawnProcess: overrides.spawnProcess || spawn,
    killGraceMs: Number.isFinite(overrides.killGraceMs) ? Math.max(0, overrides.killGraceMs) : 2000,
    releaseOps: overrides.releaseOps || null
  };
  deps.sensitiveValues = overrides.sensitiveValues || sensitiveEnvironmentValues(deps.env);
  deps.runCommand = overrides.runCommand || ((file, args, options = {}) => defaultRunCommand(file, args, options, deps));
  deps.releaseOps = deps.releaseOps || createReleaseOps(deps);
  return deps;
}

async function resolveRepository(deps) {
  if (deps.repository) {
    const repository = {
      root: path.resolve(String(deps.repository.root)),
      branch: String(deps.repository.branch || 'HEAD'),
      head: String(deps.repository.head || '').toLowerCase()
    };
    if (!FULL_SHA.test(repository.head)) throw new VerificationError('GIT_HEAD_INVALID', 'Repository HEAD must be a full Git SHA.', EXIT_BLOCKED);
    return Object.freeze(repository);
  }

  async function git(args, code) {
    const result = await deps.runCommand('git', args, { cwd: PROJECT_ROOT, env: deps.env, timeoutMs: 30000 });
    if (!result || result.status !== 0) {
      throw new VerificationError(code, commandOutput(result, deps.sensitiveValues) || 'Git repository context is unavailable.', EXIT_BLOCKED);
    }
    return String(result.stdout || '').trim();
  }

  const root = path.resolve(await git(['rev-parse', '--show-toplevel'], 'REPOSITORY_UNAVAILABLE'));
  let metadata;
  try {
    metadata = JSON.parse(deps.fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    throw new VerificationError('REPOSITORY_IDENTITY_INVALID', 'Repository package.json is missing or invalid.', EXIT_BLOCKED);
  }
  if (!metadata || metadata.name !== doctor.PACKAGE_NAME) {
    throw new VerificationError('REPOSITORY_IDENTITY_INVALID', `Expected package '${doctor.PACKAGE_NAME}'.`, EXIT_BLOCKED);
  }
  const branch = await git(['branch', '--show-current'], 'GIT_BRANCH_UNAVAILABLE');
  const head = (await git(['rev-parse', 'HEAD'], 'GIT_HEAD_UNAVAILABLE')).toLowerCase();
  if (!FULL_SHA.test(head)) throw new VerificationError('GIT_HEAD_INVALID', 'Git HEAD is not a full SHA.', EXIT_BLOCKED);
  return Object.freeze({ root, branch: branch || 'HEAD', head });
}

function displayCommand(file, args) {
  return [file, ...args].join(' ');
}

function assertCommandIsNonPublishing(file, args) {
  const executable = path.basename(String(file)).toLowerCase();
  const first = String(args[0] || '').toLowerCase();
  if (executable === 'gh' || executable === 'gh.exe') {
    throw new VerificationError('FORBIDDEN_COMMAND', 'Verification may not invoke GitHub mutation commands.');
  }
  if (executable === 'git' || executable === 'git.exe') {
    if (['push', 'tag'].includes(first)) throw new VerificationError('FORBIDDEN_COMMAND', `Verification may not run git ${first}.`);
  }
  if (/^npm(?:\.cmd)?$/.test(executable) && ['publish', 'deploy'].includes(first)) {
    throw new VerificationError('FORBIDDEN_COMMAND', `Verification may not run npm ${first}.`);
  }
}

function resultFor(status, details = '', options = {}) {
  return {
    status,
    details: bounded(details, 12000, options.sensitiveValues || []),
    failureCode: options.failureCode || null,
    failureExitCode: options.failureExitCode || null,
    command: options.command || null
  };
}

function isNetworkFailure(output) {
  return /\b(?:EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENOTCACHED|ERR_SOCKET_TIMEOUT|FETCH_ERROR)\b|npm (?:error|err!) network|network request failed|request to \S+ failed|registry (?:access|request) (?:is )?unavailable|unable to resolve|socket hang up|TLS handshake/i.test(output);
}

async function invokeFixedCommand(context, file, args, options = {}) {
  assertCommandIsNonPublishing(file, args);
  const command = displayCommand(file, args);
  const sensitiveValues = sensitiveEnvironmentValues(options.env || context.deps.env);
  if (context.deps.controller.interrupted) {
    return resultFor(STATUS_INTERRUPTED, 'Verification was interrupted before the owned command started.', {
      failureCode: 'INTERRUPTED', failureExitCode: EXIT_VALIDATION, command, sensitiveValues
    });
  }
  const result = await context.deps.runCommand(file, args, {
    cwd: options.cwd || context.repository.root,
    env: options.env || context.deps.env,
    timeoutMs: options.timeoutMs || 180000,
    terminationPolicy: options.terminationPolicy || 'terminate'
  });
  if (context.deps.controller.interrupted) {
    return resultFor(STATUS_INTERRUPTED, commandOutput(result, sensitiveValues) || 'Verification was interrupted.', {
      failureCode: 'INTERRUPTED',
      failureExitCode: EXIT_VALIDATION,
      command,
      sensitiveValues
    });
  }
  if (result && result.timedOut) {
    return resultFor(STATUS_BLOCKED, commandOutput(result, sensitiveValues) || 'The owned command timed out.', {
      failureCode: 'STAGE_TIMEOUT',
      failureExitCode: EXIT_BLOCKED,
      command,
      sensitiveValues
    });
  }
  if (result && result.signal) {
    return resultFor(STATUS_BLOCKED, commandOutput(result, sensitiveValues) || `The owned command ended after signal ${result.signal}.`, {
      failureCode: 'COMMAND_SIGNALLED',
      failureExitCode: EXIT_BLOCKED,
      command,
      sensitiveValues
    });
  }
  if (!result || result.status === null || result.status === undefined || result.error) {
    const error = result && result.error;
    const code = error instanceof VerificationError ? error.code : (result && result.timedOut ? 'STAGE_TIMEOUT' : 'COMMAND_UNAVAILABLE');
    const exitCode = error instanceof VerificationError ? error.exitCode : EXIT_BLOCKED;
    return resultFor(STATUS_BLOCKED, commandOutput(result, sensitiveValues) || 'Command could not be executed.', {
      failureCode: code,
      failureExitCode: exitCode,
      command,
      sensitiveValues
    });
  }
  if (result.status === 0) return resultFor(STATUS_PASSED, commandOutput(result, sensitiveValues), { command, sensitiveValues });
  const output = commandOutput(result, sensitiveValues);
  if (options.audit && isNetworkFailure(output)) {
    return resultFor(STATUS_BLOCKED, output || 'Dependency audit could not reach the configured registry.', {
      failureCode: 'AUDIT_REGISTRY_UNAVAILABLE',
      failureExitCode: EXIT_BLOCKED,
      command,
      sensitiveValues
    });
  }
  const exitCodeBlocker = Array.isArray(options.blockedExitCodes) && options.blockedExitCodes.includes(result.status);
  const environmentFailure = options.environmentFailure || exitCodeBlocker;
  return resultFor(environmentFailure ? STATUS_BLOCKED : STATUS_FAILED, output || `Command exited ${result.status}.`, {
    failureCode: exitCodeBlocker && options.blockerCode
      ? options.blockerCode
      : options.failureCode || `${options.id || 'STAGE'}_FAILED`,
    failureExitCode: environmentFailure ? EXIT_BLOCKED : EXIT_VALIDATION,
    command,
    sensitiveValues
  });
}

function npmStage(spec) {
  return Object.freeze({
    id: spec.id,
    label: spec.label,
    required: true,
    destructive: false,
    async run(context) {
      return invokeFixedCommand(context, npmExecutable(context.deps.platform), spec.args, {
        id: spec.id,
        timeoutMs: spec.timeoutMs,
        failureCode: `${spec.id.toUpperCase().replaceAll('-', '_')}_FAILED`,
        blockedExitCodes: spec.blockedExitCodes,
        blockerCode: spec.blockerCode
      });
    }
  });
}

function gitStage(id, label, args, timeoutMs = 60000) {
  return Object.freeze({
    id,
    label,
    required: true,
    destructive: false,
    run: context => invokeFixedCommand(context, 'git', args, {
      id,
      timeoutMs,
      failureCode: `${id.toUpperCase().replaceAll('-', '_')}_FAILED`
    })
  });
}

function internalStage(id, label, run, options = {}) {
  return Object.freeze({ id, label, run, required: options.required !== false, destructive: Boolean(options.destructive) });
}

function findingCodes(report, severity) {
  return (report && Array.isArray(report.findings) ? report.findings : [])
    .filter(finding => !severity || finding.severity === severity)
    .map(finding => finding.code);
}

function hasFinding(report, code) {
  return findingCodes(report).includes(code);
}

function doctorDetails(report) {
  const warnings = findingCodes(report, 'warning');
  const blockers = findingCodes(report, 'blocker');
  return [
    `Doctor status: ${report.status}.`,
    warnings.length ? `Warnings: ${warnings.join(', ')}.` : 'Warnings: none.',
    blockers.length ? `Blockers: ${blockers.join(', ')}.` : 'Blockers: none.'
  ].join(' ');
}

function blocked(code, message) {
  return resultFor(STATUS_BLOCKED, message, { failureCode: code, failureExitCode: EXIT_BLOCKED });
}

function passed(message) {
  return resultFor(STATUS_PASSED, message);
}

function skipped(message) {
  return resultFor(STATUS_SKIPPED, message);
}

function runtimeReport(context) {
  if (!context.state.doctor) throw new VerificationError('RUNTIME_DOCTOR_MISSING', 'Runtime doctor result is unavailable.');
  return context.state.doctor;
}

function evaluateDockerCli(context) {
  const report = runtimeReport(context);
  if (!report.facts || !report.facts.docker || !report.facts.docker.cliAvailable || hasFinding(report, 'DOCKER_CLI_MISSING')) {
    return blocked('DOCKER_CLI_MISSING', 'Docker CLI is unavailable. Install Docker Desktop, then rerun npm run verify:runtime.');
  }
  return passed('Docker CLI is available.');
}

function evaluateDockerDaemon(context) {
  const report = runtimeReport(context);
  if (!report.facts.docker.daemonRunning || hasFinding(report, 'DOCKER_DAEMON_STOPPED')) {
    return blocked('DOCKER_DAEMON_STOPPED', 'Docker daemon is stopped. Start Docker Desktop yourself, then rerun npm run verify:runtime.');
  }
  return passed(`Docker daemon is running${report.facts.docker.serverVersion ? ` (${report.facts.docker.serverVersion})` : ''}.`);
}

function evaluateSupabase(context) {
  const report = runtimeReport(context);
  const apiUrl = report.facts && report.facts.supabaseApiUrl;
  const classified = doctor.classifyProjectUrl(apiUrl);
  if (!report.facts.supabaseCli || hasFinding(report, 'SUPABASE_CLI_MISSING')) {
    return blocked('SUPABASE_CLI_MISSING', 'Supabase CLI is unavailable. Run npm install, then rerun npm run verify:runtime.');
  }
  if (!report.context.supabaseRunning || !apiUrl || classified.kind !== 'local') {
    return blocked('SUPABASE_STOPPED', 'Local Supabase is stopped or its API URL is unavailable. Run npx supabase start yourself; verification never starts it automatically.');
  }
  if (classified.origin !== doctor.LOCAL_SUPABASE_URL) {
    return blocked('SUPABASE_URL_NONCANONICAL', `Local Supabase must report exactly ${doctor.LOCAL_SUPABASE_URL}.`);
  }
  return passed(`Local Supabase is running at ${doctor.LOCAL_SUPABASE_URL}.`);
}

function evaluateLocalConfig(context) {
  const report = runtimeReport(context);
  const configuration = report.context && report.context.configuration;
  if (!configuration || configuration.projectUrlKind !== 'local' || configuration.projectUrl !== doctor.LOCAL_SUPABASE_URL) {
    return blocked('RUNTIME_CONFIG_UNSAFE', `Dashboard configuration must use exactly ${doctor.LOCAL_SUPABASE_URL}; hosted, malformed, and unknown targets are refused.`);
  }
  if (!['publishable', 'legacy-anon-jwt'].includes(configuration.publishableKeyClass)) {
    return blocked('RUNTIME_KEY_UNSAFE', 'Dashboard configuration must use a browser-public local key class. Secret and unknown keys are refused.');
  }
  return passed('Dashboard configuration is canonical local configuration with a browser-public key class.');
}

function evaluateAuth(context) {
  const report = runtimeReport(context);
  if (!hasFinding(report, 'AUTH_HEALTHY')) {
    return blocked('AUTH_UNHEALTHY', 'Local Auth health did not pass. Inspect npm run doctor and restore the loopback Auth endpoint before retrying.');
  }
  return passed('Local Auth health is ready.');
}

function evaluateSmokeUsers(context) {
  const report = runtimeReport(context);
  if (hasFinding(report, 'SMOKE_USERS_READY')) return passed('Expected smoke users and profiles are present and linked.');
  const conflicts = ['SMOKE_PROFILE_MISMATCH', 'SMOKE_USERNAME_DUPLICATE'].filter(code => hasFinding(report, code));
  if (conflicts.length) {
    return blocked('SMOKE_USER_STATE_UNSAFE', `Smoke-user state is ambiguous (${conflicts.join(', ')}); reset/provisioning is refused.`);
  }
  const provisionable = ['SMOKE_USER_MISSING', 'SMOKE_PROFILE_MISSING'].some(code => hasFinding(report, code));
  if (context.options.allowReset && provisionable) {
    return passed('Smoke users are incomplete; the explicitly authorized sanctioned reset path may provision them.');
  }
  return blocked('SMOKE_USERS_NOT_READY', 'Expected smoke users are missing or could not be verified. Use the sanctioned local provisioning path before non-destructive runtime verification.');
}

function evaluateRuntimeOwnership(context) {
  const report = runtimeReport(context);
  if (hasFinding(report, 'SMOKE_PROCESS_ACTIVE')) {
    return blocked('RUNTIME_OWNERSHIP_AMBIGUOUS', 'A smoke, reset, cleanup, or provisioning process is already active. Wait for it to finish; verification never terminates it.');
  }
  if (hasFinding(report, 'DASHBOARD_PORT_FOREIGN')) {
    return blocked('RUNTIME_OWNERSHIP_AMBIGUOUS', 'The selected Dashboard port is owned by another process. Resolve ownership manually; verification never terminates it.');
  }
  const handled = new Set([
    'DOCKER_CLI_MISSING', 'DOCKER_DAEMON_STOPPED', 'SUPABASE_CLI_MISSING',
    'CONFIG_SUPABASE_MISSING', 'CONFIG_SUPABASE_INVALID', 'CONFIG_URL_HOSTED',
    'CONFIG_URL_MALFORMED', 'CONFIG_KEY_SECRET', 'SMOKE_PROCESS_ACTIVE',
    'DASHBOARD_PORT_FOREIGN'
  ]);
  const remaining = findingCodes(report, 'blocker').filter(code => !handled.has(code));
  if (remaining.length) return blocked('RUNTIME_PRECONDITION_BLOCKED', `Runtime doctor reported blocker(s): ${remaining.join(', ')}.`);
  return passed('No competing smoke/reset process or ambiguous runtime ownership was detected.');
}

function safeDryRunEnvironment(environment) {
  const copy = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (!/^SMOKE_TEST_/i.test(key)) copy[key] = value;
  }
  copy.SMOKE_TEST_MODE = 'local';
  copy.SMOKE_TEST_PROJECT_URL = doctor.LOCAL_SUPABASE_URL;
  copy.SMOKE_TEST_ALLOWED_PROJECT_URL = doctor.LOCAL_SUPABASE_URL;
  copy.SMOKE_TEST_REQUIRE_ALREADY_RUNNING = '1';
  return copy;
}

function safeResetEnvironment(environment) {
  const copy = safeDryRunEnvironment(environment);
  for (const name of [
    'SMOKE_TEST_ADMIN_PASSWORD',
    'SMOKE_TEST_AGENT_A_PASSWORD',
    'SMOKE_TEST_AGENT_B_PASSWORD'
  ]) {
    if (String(environment && environment[name] || '').trim()) copy[name] = environment[name];
  }
  return copy;
}

function runtimeDoctorIsSafeForReset(report) {
  const context = { state: { doctor: report }, options: { allowReset: true } };
  for (const evaluator of [evaluateDockerCli, evaluateDockerDaemon, evaluateSupabase, evaluateLocalConfig, evaluateAuth, evaluateSmokeUsers, evaluateRuntimeOwnership]) {
    const result = evaluator(context);
    if (result.status !== STATUS_PASSED) return result;
  }
  return null;
}

function requiredResetCredentialNames(environment) {
  return [
    'SMOKE_TEST_ADMIN_PASSWORD',
    'SMOKE_TEST_AGENT_A_PASSWORD',
    'SMOKE_TEST_AGENT_B_PASSWORD'
  ].filter(name => !String(environment[name] || '').trim());
}

function createRuntimeStages() {
  return [
    internalStage('runtime-doctor', 'Read-only environment doctor', async context => {
      const report = await context.deps.runDoctor({
        now: context.startedAt,
        deps: context.deps.doctorDeps
      });
      if (!report || !Array.isArray(report.findings) || !report.facts || !report.context) {
        throw new VerificationError('RUNTIME_DOCTOR_INVALID', 'Runtime doctor returned an invalid result.');
      }
      context.state.doctor = report;
      return passed(doctorDetails(report));
    }),
    internalStage('docker-cli', 'Docker CLI availability', evaluateDockerCli),
    internalStage('docker-daemon', 'Docker daemon availability', evaluateDockerDaemon),
    internalStage('supabase-status', 'Local Supabase status', evaluateSupabase),
    internalStage('local-dashboard-config', 'Canonical local Dashboard configuration', evaluateLocalConfig),
    internalStage('auth-health', 'Local Auth health', evaluateAuth),
    internalStage('smoke-users', 'Smoke-user state', evaluateSmokeUsers),
    internalStage('runtime-ownership', 'Runtime process and ownership safety', evaluateRuntimeOwnership),
    internalStage('runtime-config-dry-run', 'Existing runtime harness dry-run', context => invokeFixedCommand(
      context,
      powershellExecutable(context.deps.platform),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/Invoke-RuntimeSmokeTest.ps1', '-DryRun', '-RunId', SAFE_RUNTIME_RUN_ID],
      {
        id: 'runtime-config-dry-run',
        timeoutMs: 120000,
        environmentFailure: true,
        env: safeDryRunEnvironment(context.deps.env),
        failureCode: 'RUNTIME_DRY_RUN_FAILED'
      }
    )),
    internalStage('runtime-smoke-reset', 'Destructive local runtime smoke suite', async context => {
      if (!context.options.allowReset) return skipped('SKIPPED — requires explicit --allow-reset. No database reset was executed.');
      const missing = requiredResetCredentialNames(context.deps.env);
      if (missing.length) {
        return blocked('RESET_CREDENTIALS_MISSING', `Reset authorization is present, but required local smoke credentials are missing: ${missing.join(', ')}.`);
      }
      const refreshed = await context.deps.runDoctor({ now: nowValue(context.deps).toISOString(), deps: context.deps.doctorDeps });
      const unsafe = runtimeDoctorIsSafeForReset(refreshed);
      if (unsafe) return unsafe;
      context.state.destructiveWarning = 'DESTRUCTIVE LOCAL VERIFICATION: the sanctioned smoke wrapper will reset the disposable local database.';
      context.deps.streams.stderr.write(`${context.state.destructiveWarning}\n`);
      return invokeFixedCommand(
        context,
        powershellExecutable(context.deps.platform),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/dev/smoke.ps1', '-AllowDatabaseReset'],
        {
          id: 'runtime-smoke-reset',
          timeoutMs: 2100000,
          failureCode: 'RUNTIME_SMOKE_FAILED',
          env: safeResetEnvironment(context.deps.env),
          terminationPolicy: 'wait'
        }
      );
    }, { destructive: true, required: false })
  ];
}

function createFastStages() {
  return [
    internalStage('repository-state', 'Repository identity and Git state', async context => {
      const status = await context.deps.runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
        cwd: context.repository.root,
        env: context.deps.env,
        timeoutMs: 30000
      });
      if (!status || status.status !== 0) return blocked('GIT_STATUS_UNAVAILABLE', commandOutput(status) || 'Git status is unavailable.');
      const entries = String(status.stdout || '').split('\0').filter(Boolean);
      const untracked = entries.filter(entry => entry.startsWith('?? ')).map(entry => entry.slice(3));
      const tracked = entries.filter(entry => !entry.startsWith('?? '));
      const allowed = untracked.filter(entry => entry === 'supabase/snippets/' || entry.startsWith('supabase/snippets/'));
      const unexpected = untracked.filter(entry => !allowed.includes(entry));
      const renderPaths = values => values.length ? values.map(value => JSON.stringify(value)).join(', ') : 'none';
      return passed([
        `${context.repository.branch} @ ${context.repository.head}.`,
        `Tracked changes: ${tracked.length}.`,
        `Allowed untracked paths: ${renderPaths(allowed)}.`,
        `Other untracked paths: ${renderPaths(unexpected)}.`,
        'Working-tree changes are reported but are not rejected by verify:fast.',
        'verify:fast is not sufficient for PR creation or merge.'
      ].join(' '));
    }),
    npmStage({ id: 'javascript-syntax', label: 'JavaScript syntax validation', args: ['run', 'check:js'], timeoutMs: 180000 }),
    gitStage('diff-whitespace', 'Git diff whitespace validation', ['diff', '--check']),
    npmStage({ id: 'project-status', label: 'Project-status validation', args: ['run', 'check:project-status'], timeoutMs: 180000, blockedExitCodes: [2], blockerCode: 'PROJECT_STATUS_BLOCKED' }),
    internalStage('focused-tests', 'Deterministic focused unit tests', context => invokeFixedCommand(
      context,
      process.execPath,
      ['--test', 'tests/project-status.test.cjs', 'tests/prompt-generator.test.cjs', 'tests/verification-tiers.test.cjs'],
      { id: 'focused-tests', timeoutMs: 300000, failureCode: 'FOCUSED_TESTS_FAILED' }
    ))
  ];
}

function createPrStages() {
  return PR_STAGE_SPECS.map(npmStageOrGit);
}

function npmStageOrGit(spec) {
  return spec.executable === 'git' ? gitStage(spec.id, spec.label, spec.args, spec.timeoutMs) : npmStage(spec);
}

function releaseConfig(environment) {
  try {
    return pages.validateRuntimeInputs({
      projectUrl: environment.DASHBOARD_SUPABASE_PROJECT_URL,
      publishableKey: environment.DASHBOARD_SUPABASE_PUBLISHABLE_KEY
    });
  } catch (error) {
    const message = 'Release verification requires explicit browser-public fixture or operator configuration in DASHBOARD_SUPABASE_PROJECT_URL and DASHBOARD_SUPABASE_PUBLISHABLE_KEY. Hosted HTTPS and sb_publishable_ values only; no value is fabricated.';
    throw new VerificationError(
      error && error.code === 'CONFIG_KEY_INVALID' ? 'RELEASE_PUBLIC_CONFIG_UNSAFE' : 'RELEASE_PUBLIC_CONFIG_REQUIRED',
      message,
      EXIT_BLOCKED
    );
  }
}

function statIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino), birthtimeMs: Number(info.birthtimeMs) });
}

function sameIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function samePath(left, right, platform = process.platform) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function pathEntryExists(io, target) {
  try {
    io.lstatSync(target);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function ownershipToken(deps) {
  const token = String(deps.randomToken());
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new VerificationError('RELEASE_OWNER_TOKEN_INVALID', 'Release workspace ownership token generation failed.');
  }
  return token;
}

function workspaceAtRoot(workspace, root) {
  const slots = Object.fromEntries(RELEASE_SLOT_NAMES.map(name => {
    const parent = path.join(root, name);
    return [name, Object.freeze({ parent, output: path.join(parent, 'pages-site'), identity: workspace.slots[name].identity, outputState: workspace.slots[name].outputState })];
  }));
  return Object.freeze({
    root,
    token: workspace.token,
    identity: workspace.identity,
    markerPath: path.join(root, RELEASE_MARKER),
    slots: Object.freeze(slots)
  });
}

function createReleaseOps(deps) {
  const io = deps.fs;

  function create(repositoryRoot) {
    const artifactParent = path.join(repositoryRoot, 'artifacts');
    if (!io.existsSync(artifactParent)) io.mkdirSync(artifactParent);
    const parentInfo = io.lstatSync(artifactParent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || !samePath(io.realpathSync(artifactParent), artifactParent, deps.platform)) {
      throw new VerificationError('RELEASE_WORKSPACE_PARENT_UNSAFE', 'artifacts must be an ordinary, non-linked directory.', EXIT_BLOCKED);
    }
    const token = ownershipToken(deps);
    const root = io.mkdtempSync(path.join(artifactParent, 'verify-release-'));
    let identity = null;
    try {
      const rootInfo = io.lstatSync(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !samePath(io.realpathSync(root), root, deps.platform)) {
        throw new VerificationError('RELEASE_WORKSPACE_ROOT_UNSAFE', 'The new release workspace is not an ordinary canonical directory.');
      }
      identity = statIdentity(rootInfo);
      const markerPath = path.join(root, RELEASE_MARKER);
      io.writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1, token })}\n`, { encoding: 'utf8', flag: 'wx' });
      const slots = {};
      for (const name of RELEASE_SLOT_NAMES) {
        const parent = path.join(root, name);
        io.mkdirSync(parent);
        const slotInfo = io.lstatSync(parent);
        if (slotInfo.isSymbolicLink() || !slotInfo.isDirectory() || !samePath(io.realpathSync(parent), parent, deps.platform)) throw new VerificationError('RELEASE_SLOT_UNSAFE', `Release slot ${name} is not an ordinary canonical directory.`);
        slots[name] = Object.freeze({ parent, output: path.join(parent, 'pages-site'), identity: statIdentity(slotInfo), outputState: { identity: null } });
      }
      return Object.freeze({ root, token, identity, markerPath, slots: Object.freeze(slots) });
    } catch (error) {
      let ownership = 'could not be revalidated';
      try {
        const current = io.lstatSync(root);
        if (!current.isSymbolicLink() && current.isDirectory() && identity &&
            sameIdentity(statIdentity(current), identity) && samePath(io.realpathSync(root), root, deps.platform)) {
          ownership = 'remains identity-verified';
        }
      } catch {}
      throw new VerificationError(
        'RELEASE_WORKSPACE_SETUP_FAILED',
        `Release workspace setup failed and the partial directory ${ownership}; recovery material was preserved at ${root}. ${error.message}`,
        EXIT_INTERNAL,
        { preserveReleaseWorkspace: true, recoveryPath: root }
      );
    }
  }

  function build(workspace, slot, config, repositoryRoot) {
    validateCleanupOwnership(workspace);
    const result = pages.buildPagesArtifact({
      sourceRoot: repositoryRoot,
      outputDirectory: workspace.slots[slot].output,
      projectUrl: config.projectUrl,
      publishableKey: config.publishableKey
    });
    const outputInfo = io.lstatSync(workspace.slots[slot].output);
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || !samePath(io.realpathSync(workspace.slots[slot].output), workspace.slots[slot].output, deps.platform)) throw new VerificationError('RELEASE_ARTIFACT_UNSAFE', `Release artifact ${slot} is not an ordinary canonical directory.`, EXIT_INTERNAL, { preserveReleaseWorkspace: true });
    workspace.slots[slot].outputState.identity = statIdentity(outputInfo);
    if (result.cleanupWarning) {
      throw new VerificationError('ARTIFACT_CLEANUP_WARNING', result.cleanupWarning, EXIT_INTERNAL, { preserveReleaseWorkspace: true });
    }
    return result;
  }

  function compare(workspace) {
    const first = workspace.slots.a.output;
    const second = workspace.slots.b.output;
    const hash = crypto.createHash('sha256');
    for (const relative of pages.ARTIFACT_FILES) {
      const left = io.readFileSync(path.join(first, ...relative.split('/')));
      const right = io.readFileSync(path.join(second, ...relative.split('/')));
      if (!left.equals(right)) {
        throw new VerificationError('ARTIFACT_NONDETERMINISTIC', `Artifact bytes differ for ${relative}.`, EXIT_VALIDATION, { preserveReleaseWorkspace: true });
      }
      hash.update(relative, 'utf8');
      hash.update(Buffer.from([0]));
      hash.update(left);
    }
    return Object.freeze({ digest: hash.digest('hex'), files: pages.ARTIFACT_FILES.length });
  }

  function validate(workspace, config, repositoryRoot) {
    const first = pages.validatePagesArtifact({ sourceRoot: repositoryRoot, artifactDirectory: workspace.slots.a.output, ...config });
    const second = pages.validatePagesArtifact({ sourceRoot: repositoryRoot, artifactDirectory: workspace.slots.b.output, ...config });
    return Object.freeze({ first, second });
  }

  function scan(workspace) {
    const patterns = [
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      new RegExp('\\bsb_' + 'secret_[A-Za-z0-9_-]{8,}\\b', 'i'),
      /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i,
      /authorization\s*:\s*(?:bearer|basic)\s+[^\s]+/i,
      /postgres(?:ql)?:\/\/[^:/\s]+:[^@\s]+@/i
    ];
    for (const slot of RELEASE_SLOT_NAMES) {
      for (const relative of pages.ARTIFACT_FILES) {
        const content = io.readFileSync(path.join(workspace.slots[slot].output, ...relative.split('/')), 'utf8');
        if (patterns.some(pattern => pattern.test(content))) {
          throw new VerificationError('ARTIFACT_SECRET_SHAPE', `Secret-shaped content detected in ${relative}.`, EXIT_VALIDATION, { preserveReleaseWorkspace: true });
        }
      }
    }
    return Object.freeze({ filesScanned: pages.ARTIFACT_FILES.length * RELEASE_SLOT_NAMES.length });
  }

  function validateCleanupOwnership(workspace) {
    const info = io.lstatSync(workspace.root);
    if (info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(statIdentity(info), workspace.identity)) {
      throw new VerificationError('RELEASE_CLEANUP_OWNERSHIP_CHANGED', 'Release workspace identity changed; recovery material was preserved.');
    }
    if (!samePath(io.realpathSync(workspace.root), workspace.root, deps.platform)) {
      throw new VerificationError('RELEASE_CLEANUP_OWNERSHIP_CHANGED', 'Release workspace resolves through a link; it was preserved.');
    }
    let marker;
    try { marker = JSON.parse(io.readFileSync(workspace.markerPath, 'utf8')); } catch {
      throw new VerificationError('RELEASE_CLEANUP_MARKER_INVALID', 'Release workspace marker is missing or invalid; it was preserved.');
    }
    if (!marker || marker.schemaVersion !== 1 || marker.token !== workspace.token) {
      throw new VerificationError('RELEASE_CLEANUP_MARKER_INVALID', 'Release workspace ownership token changed; it was preserved.');
    }
    const rootEntries = io.readdirSync(workspace.root).sort();
    const expectedRoot = [RELEASE_MARKER, ...RELEASE_SLOT_NAMES].sort();
    if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRoot)) {
      throw new VerificationError('RELEASE_CLEANUP_FOREIGN_ENTRY', 'Release workspace contains an unexpected recovery or foreign entry; it was preserved.');
    }
    for (const name of RELEASE_SLOT_NAMES) {
      const slotInfo = io.lstatSync(workspace.slots[name].parent);
      if (slotInfo.isSymbolicLink() || !slotInfo.isDirectory() || !sameIdentity(statIdentity(slotInfo), workspace.slots[name].identity) || !samePath(io.realpathSync(workspace.slots[name].parent), workspace.slots[name].parent, deps.platform)) {
        throw new VerificationError('RELEASE_SLOT_OWNERSHIP_CHANGED', `Release slot ${name} ownership changed; all material was preserved.`);
      }
      const entries = io.readdirSync(workspace.slots[name].parent).sort();
      if (entries.length > 1 || (entries.length === 1 && entries[0] !== 'pages-site')) {
        throw new VerificationError('RELEASE_CLEANUP_FOREIGN_ENTRY', `Release slot ${name} contains unexpected recovery or foreign material; it was preserved.`);
      }
      if (entries.length === 1) {
        const outputInfo = io.lstatSync(workspace.slots[name].output), expected = workspace.slots[name].outputState.identity;
        if (!expected || outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || !sameIdentity(statIdentity(outputInfo), expected) || !samePath(io.realpathSync(workspace.slots[name].output), workspace.slots[name].output, deps.platform)) throw new VerificationError('RELEASE_ARTIFACT_OWNERSHIP_CHANGED', `Release artifact ${name} ownership changed; all material was preserved.`);
      }
    }
  }

  function cleanup(workspace) {
    validateCleanupOwnership(workspace);
    const claimPath = path.join(path.dirname(workspace.root), `.verify-cleanup-${ownershipToken(deps)}`);
    if (pathEntryExists(io, claimPath)) {
      throw new VerificationError('RELEASE_CLEANUP_CLAIM_EXISTS', 'A cleanup claim path already exists; all material was preserved.', EXIT_INTERNAL, {
        recoveryPath: workspace.root
      });
    }
    try {
      io.renameSync(workspace.root, claimPath);
    } catch (error) {
      throw new VerificationError('RELEASE_CLEANUP_CLAIM_FAILED', `Could not atomically claim the owned release workspace: ${error.message}`, EXIT_INTERNAL, {
        recoveryPath: workspace.root
      });
    }

    const claimed = workspaceAtRoot(workspace, claimPath);
    try {
      validateCleanupOwnership(claimed);
    } catch (error) {
      if (error instanceof VerificationError) error.recoveryPath = claimPath;
      throw error;
    }
    if (pathEntryExists(io, workspace.root)) {
      throw new VerificationError('RELEASE_CLEANUP_FOREIGN_REPLACEMENT', 'The original workspace path was recreated after the atomic cleanup claim; all material was preserved.', EXIT_INTERNAL, {
        recoveryPath: claimPath
      });
    }
    try {
      io.rmSync(claimPath, { recursive: true, force: false });
    } catch (error) {
      throw new VerificationError('RELEASE_CLEANUP_REMOVE_FAILED', `Could not remove the identity-verified cleanup claim: ${error.message}`, EXIT_INTERNAL, {
        recoveryPath: claimPath
      });
    }
    if (pathEntryExists(io, claimPath)) {
      throw new VerificationError('RELEASE_CLEANUP_INCOMPLETE', 'The identity-verified cleanup claim remained after cleanup.', EXIT_INTERNAL, {
        recoveryPath: claimPath
      });
    }
    if (pathEntryExists(io, workspace.root)) {
      throw new VerificationError('RELEASE_CLEANUP_FOREIGN_REPLACEMENT', 'Foreign material appeared at the original workspace path during cleanup and was preserved.', EXIT_INTERNAL, {
        recoveryPath: workspace.root
      });
    }
  }

  return Object.freeze({ create, build, compare, validate, scan, cleanup });
}

function artifactFailure(error, context) {
  if (error && (error.preserveReleaseWorkspace || error.cleanupWarning || error.cleanupFailure)) {
    context.state.preserveReleaseWorkspace = true;
  }
  if (error instanceof VerificationError) throw error;
  const code = error && error.code ? error.code : 'ARTIFACT_STAGE_FAILED';
  throw new VerificationError(code, error && error.message || 'Artifact verification failed.', EXIT_VALIDATION, {
    preserveReleaseWorkspace: true
  });
}

function governanceStage(id, label, pattern) {
  return internalStage(id, label, context => invokeFixedCommand(
    context,
    process.execPath,
    ['--test', '--test-name-pattern', pattern, 'tests/release-governance.test.cjs'],
    { id, timeoutMs: 120000, failureCode: `${id.toUpperCase().replaceAll('-', '_')}_FAILED` }
  ));
}

function createReleaseStages() {
  const stages = createPrStages();
  stages.push(internalStage('dependency-audit', 'Production dependency audit', context => {
    if (context.options.offline) {
      return blocked('AUDIT_OFFLINE_BLOCKED', 'verify:release cannot skip dependency audit and pass. Rerun without --offline when registry access is available.');
    }
    return invokeFixedCommand(context, npmExecutable(context.deps.platform), ['audit', '--omit=dev', '--audit-level=high'], {
      id: 'dependency-audit', timeoutMs: 180000, audit: true, failureCode: 'DEPENDENCY_AUDIT_FAILED'
    });
  }));
  stages.push(internalStage('release-public-config', 'Browser-public artifact configuration', async context => {
    context.state.releaseConfig = releaseConfig(context.deps.env);
    context.state.releaseWorkspace = context.deps.releaseOps.create(context.repository.root);
    const relativeWorkspace = path.relative(context.repository.root, context.state.releaseWorkspace.root).split(path.sep).join('/');
    const ignore = await invokeFixedCommand(
      context,
      'git',
      ['check-ignore', '--quiet', '--no-index', '--', `${relativeWorkspace}/`],
      {
        id: 'release-public-config',
        timeoutMs: 30000,
        environmentFailure: true,
        failureCode: 'RELEASE_WORKSPACE_NOT_IGNORED'
      }
    );
    if (ignore.status !== STATUS_PASSED) return ignore;
    return passed('Explicit hosted browser-public artifact configuration was validated; values were not printed. A unique run-owned ignored workspace was created.');
  }));
  for (const slot of RELEASE_SLOT_NAMES) {
    stages.push(internalStage(`artifact-build-${slot}`, `Deterministic Pages artifact build ${slot.toUpperCase()}`, context => {
      try {
        const result = context.deps.releaseOps.build(
          context.state.releaseWorkspace,
          slot,
          context.state.releaseConfig,
          context.repository.root
        );
        context.state[`artifactBuild${slot.toUpperCase()}`] = result;
        return passed(`Built and builder-validated ${result.fileCount} files; manifest ${result.manifestDigest}.`);
      } catch (error) {
        return artifactFailure(error, context);
      }
    }));
  }
  stages.push(internalStage('artifact-determinism', 'Second-build byte and digest comparison', context => {
    try {
      const result = context.deps.releaseOps.compare(context.state.releaseWorkspace);
      context.state.artifactComparison = result;
      return passed(`Both builds are byte-identical across ${result.files} files; digest ${result.digest}.`);
    } catch (error) {
      context.state.preserveReleaseWorkspace = true;
      return artifactFailure(error, context);
    }
  }));
  stages.push(internalStage('artifact-validation', 'Independent Pages artifact validation', context => {
    try {
      const validation = context.deps.releaseOps.validate(
        context.state.releaseWorkspace,
        context.state.releaseConfig,
        context.repository.root
      );
      context.state.artifactValidation = validation;
      return passed(`Both artifacts independently validate (${validation.first.fileCount} files each).`);
    } catch (error) {
      context.state.preserveReleaseWorkspace = true;
      return artifactFailure(error, context);
    }
  }));
  stages.push(npmStage({ id: 'release-migration-governance', label: 'Release migration governance', args: ['run', 'check:migrations'], timeoutMs: 180000 }));
  stages.push(governanceStage('release-governance', 'Release governance structure', 'migration governance|rollback|CODEOWNERS|changelog'));
  stages.push(governanceStage('workflow-structure', 'Workflow structural checks', 'release workflow|quality gates|required status check names'));
  stages.push(internalStage('artifact-content-contract', 'Approved artifact-content contract', context => {
    const validation = context.state.artifactValidation;
    const comparison = context.state.artifactComparison;
    if (!validation || !comparison || validation.first.fileCount !== pages.ARTIFACT_FILES.length || validation.second.fileCount !== pages.ARTIFACT_FILES.length) {
      throw new VerificationError('ARTIFACT_CONTENT_CONTRACT_FAILED', 'Validated artifact metadata does not match the fixed content contract.', EXIT_VALIDATION, { preserveReleaseWorkspace: true });
    }
    return passed(`Fixed ${pages.ARTIFACT_FILES.length}-file artifact contract is satisfied by both builds.`);
  }));
  stages.push(internalStage('artifact-secret-scan', 'Artifact secret-shape scan', context => {
    try {
      const scan = context.deps.releaseOps.scan(context.state.releaseWorkspace);
      return passed(`No elevated credential shape was found across ${scan.filesScanned} artifact files.`);
    } catch (error) {
      context.state.preserveReleaseWorkspace = true;
      return artifactFailure(error, context);
    }
  }));
  return stages;
}

function createStageDefinitions(tier) {
  if (tier === 'fast') return createFastStages();
  if (tier === 'pr') return createPrStages();
  if (tier === 'runtime') return createRuntimeStages();
  if (tier === 'release') return createReleaseStages();
  throw usageError('TIER_INVALID', `Unknown verification tier '${tier}'.`);
}

function notifyStageStart(context, definition) {
  if (typeof context.deps.onStageStart !== 'function') return;
  context.deps.onStageStart(Object.freeze({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    destructive: definition.destructive
  }));
}

async function executeStage(definition, context) {
  const started = nowValue(context.deps);
  let outcome;
  try {
    notifyStageStart(context, definition);
    outcome = context.deps.controller.interrupted
      ? resultFor(STATUS_INTERRUPTED, 'Verification was interrupted before the stage command started.', {
        failureCode: 'INTERRUPTED',
        failureExitCode: EXIT_VALIDATION,
        sensitiveValues: context.deps.sensitiveValues
      })
      : await definition.run(context);
    if (!outcome || ![STATUS_PASSED, STATUS_FAILED, STATUS_BLOCKED, STATUS_SKIPPED, STATUS_INTERRUPTED].includes(outcome.status)) {
      throw new VerificationError('STAGE_RESULT_INVALID', `Stage ${definition.id} returned an invalid result.`);
    }
    if (definition.required && outcome.status === STATUS_SKIPPED) {
      throw new VerificationError('REQUIRED_STAGE_SKIPPED', `Required stage ${definition.id} attempted to skip without an earlier failure.`);
    }
  } catch (error) {
    if (error && error.preserveReleaseWorkspace) context.state.preserveReleaseWorkspace = true;
    const known = error instanceof VerificationError;
    outcome = resultFor(
      known && error.exitCode === EXIT_BLOCKED ? STATUS_BLOCKED : STATUS_FAILED,
      error && error.message || 'Internal orchestration failure.',
      {
        failureCode: known ? error.code : 'INTERNAL_ORCHESTRATION_FAILURE',
        failureExitCode: known ? error.exitCode : EXIT_INTERNAL,
        sensitiveValues: context.deps.sensitiveValues
      }
    );
  }
  const completed = nowValue(context.deps);
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    destructive: definition.destructive,
    status: outcome.status,
    command: outcome.command,
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    details: outcome.details,
    failureCode: outcome.failureCode,
    failureExitCode: outcome.failureExitCode
  });
}

function skippedAfter(definition, failureStage) {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    destructive: definition.destructive,
    status: STATUS_SKIPPED,
    command: null,
    durationMs: 0,
    details: `Skipped because required stage ${failureStage} did not pass.`,
    failureCode: null,
    failureExitCode: null
  });
}

function interruptedBefore(definition) {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    destructive: definition.destructive,
    status: STATUS_INTERRUPTED,
    command: null,
    durationMs: 0,
    details: 'Verification was interrupted before this stage started.',
    failureCode: 'INTERRUPTED',
    failureExitCode: EXIT_VALIDATION
  });
}

async function cleanupReleaseWorkspace(context, stages, primary) {
  const workspace = context.state.releaseWorkspace;
  if (!workspace) return primary;
  if (context.state.preserveReleaseWorkspace) {
    stages.push(Object.freeze({
      id: 'release-workspace-cleanup',
      label: 'Run-owned release workspace cleanup',
      required: true,
      destructive: false,
      status: STATUS_SKIPPED,
      command: null,
      durationMs: 0,
      details: `Recovery material preserved for inspection at ${workspace.root}.`,
      failureCode: null,
      failureExitCode: null
    }));
    return primary;
  }
  let started = null;
  try {
    notifyStageStart(context, {
      id: 'release-workspace-cleanup',
      label: 'Run-owned release workspace cleanup',
      required: true,
      destructive: false
    });
    started = nowValue(context.deps);
    context.deps.releaseOps.cleanup(workspace);
    const completed = nowValue(context.deps);
    stages.push(Object.freeze({
      id: 'release-workspace-cleanup',
      label: 'Run-owned release workspace cleanup',
      required: true,
      destructive: false,
      status: STATUS_PASSED,
      command: null,
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      details: 'The exact identity/token-verified workspace created by this run was removed.',
      failureCode: null,
      failureExitCode: null
    }));
    return primary;
  } catch (error) {
    let durationMs = 0;
    if (started) {
      try { durationMs = Math.max(0, nowValue(context.deps).getTime() - started.getTime()); } catch {}
    }
    const cleanup = Object.freeze({
      id: 'release-workspace-cleanup',
      label: 'Run-owned release workspace cleanup',
      required: true,
      destructive: false,
      status: STATUS_FAILED,
      command: null,
      durationMs,
      details: bounded(`${error.message} Recovery material was preserved at ${error.recoveryPath || workspace.root}.`, 12000, context.deps.sensitiveValues),
      failureCode: error.code || 'RELEASE_CLEANUP_FAILED',
      failureExitCode: EXIT_INTERNAL
    });
    stages.push(cleanup);
    return primary || cleanup;
  }
}

function finalStatus(primary) {
  if (!primary) return STATUS_PASSED;
  if (primary.status === STATUS_BLOCKED) return STATUS_BLOCKED;
  if (primary.status === STATUS_INTERRUPTED) return STATUS_INTERRUPTED;
  return STATUS_FAILED;
}

function finalExitCode(primary) {
  if (!primary) return EXIT_OK;
  return primary.failureExitCode || (primary.status === STATUS_BLOCKED ? EXIT_BLOCKED : EXIT_VALIDATION);
}

async function runVerification(options, overrides = {}) {
  const deps = createDefaultDeps(overrides);
  const started = nowValue(deps);
  let repository;
  let context;
  const stages = [];
  let primary = null;

  try {
    repository = await resolveRepository(deps);
    context = {
      options,
      deps,
      repository,
      startedAt: started.toISOString(),
      state: {}
    };
    const definitions = createStageDefinitions(options.tier);
    for (const definition of definitions) {
      if (primary) {
        stages.push(skippedAfter(definition, primary.id));
        continue;
      }
      if (deps.controller.interrupted) {
        primary = interruptedBefore(definition);
        stages.push(primary);
        continue;
      }
      const stage = await executeStage(definition, context);
      stages.push(stage);
      if ([STATUS_FAILED, STATUS_BLOCKED, STATUS_INTERRUPTED].includes(stage.status)) primary = stage;
    }
    if (options.tier === 'release') primary = await cleanupReleaseWorkspace(context, stages, primary);
  } catch (error) {
    const known = error instanceof VerificationError;
    primary = Object.freeze({
      id: 'repository-context',
      label: 'Repository context',
      required: true,
      destructive: false,
      status: known && error.exitCode === EXIT_BLOCKED ? STATUS_BLOCKED : STATUS_FAILED,
      command: null,
      durationMs: 0,
      details: bounded(error && error.message || 'Internal orchestration failure.', 12000, deps.sensitiveValues),
      failureCode: known ? error.code : 'INTERNAL_ORCHESTRATION_FAILURE',
      failureExitCode: known ? error.exitCode : EXIT_INTERNAL
    });
    stages.push(primary);
  }

  const completed = nowValue(deps);
  const status = finalStatus(primary);
  const result = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    tier: options.tier,
    repository: repository ? repository.root : null,
    branch: repository ? repository.branch : null,
    head: repository ? repository.head : null,
    status,
    destructive: Boolean(options.allowReset),
    offline: Boolean(options.offline),
    stages: Object.freeze(stages),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    failureCode: primary ? primary.failureCode : null,
    failureStage: primary ? primary.id : null
  });
  return Object.freeze({
    exitCode: finalExitCode(primary),
    result: redactDeep(result, sensitiveEnvironmentValues(deps.env))
  });
}

function formatHuman(result) {
  const lines = [
    `Verification tier: ${result.tier}`,
    `Repository: ${result.repository || 'unavailable'}`,
    `Branch: ${result.branch || 'unavailable'}`,
    `HEAD: ${result.head || 'unavailable'}`,
    `Started: ${result.startedAt}`,
    `Destructive: ${result.destructive ? 'yes' : 'no'}`
  ];
  if (result.offline) lines.push('Offline: yes');
  lines.push('');
  for (const stage of result.stages) {
    lines.push(`[${stage.status.toUpperCase()}] ${stage.label} (${stage.durationMs} ms)`);
    if (stage.command) lines.push(`  Command: ${stage.command}`);
    if (stage.details) for (const detail of stage.details.split('\n')) lines.push(`  ${detail}`);
  }
  lines.push('');
  lines.push(`Completed: ${result.completedAt}`);
  lines.push(`Duration: ${result.durationMs} ms`);
  lines.push(`Result: ${result.status}`);
  if (result.failureCode) lines.push(`Failure: ${result.failureCode} at ${result.failureStage}`);
  lines.push(`VERIFY ${result.tier.toUpperCase()} ${result.status === STATUS_PASSED ? 'PASSED' : 'FAILED'}`);
  return redact(lines.join('\n'));
}

function requestInterruption(controller, options = {}) {
  controller.interrupted = true;
  const ownedChild = controller.child;
  if (!ownedChild || typeof ownedChild.kill !== 'function') return null;
  if (controller.terminationPolicy === 'wait') {
    if (options.streams && options.streams.stderr) {
      options.streams.stderr.write('Interruption received during destructive verification; waiting for the owned process tree to finish safely.\n');
    }
    return null;
  }
  try { ownedChild.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    if (controller.child !== ownedChild) return;
    try { ownedChild.kill('SIGKILL'); } catch {}
  }, Number.isFinite(options.killGraceMs) ? Math.max(0, options.killGraceMs) : 2000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const streams = overrides.streams || process;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.stderr.write(`[${error.code || 'USAGE_ERROR'}] ${redact(error.message)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    streams.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  const controller = overrides.controller || { interrupted: false, child: null };
  let interruptForceTimer = null;
  const interrupt = () => {
    if (interruptForceTimer) clearTimeout(interruptForceTimer);
    interruptForceTimer = requestInterruption(controller, {
      killGraceMs: overrides.killGraceMs,
      streams
    });
  };
  const installSignals = overrides.installSignalHandlers !== false;
  if (installSignals) {
    const signalSource = overrides.signalSource || process;
    signalSource.on('SIGINT', interrupt);
    signalSource.on('SIGTERM', interrupt);
  }
  try {
    const onStageStart = overrides.onStageStart || (options.json ? null : stage => {
      streams.stdout.write(`[RUNNING] ${stage.label}\n`);
    });
    const execution = await runVerification(options, { ...overrides, streams, controller, onStageStart });
    if (options.json) streams.stdout.write(`${JSON.stringify(execution.result, null, 2)}\n`);
    else streams.stdout.write(`${formatHuman(execution.result)}\n`);
    return execution.exitCode;
  } finally {
    if (interruptForceTimer) clearTimeout(interruptForceTimer);
    if (installSignals) {
      const signalSource = overrides.signalSource || process;
      signalSource.removeListener('SIGINT', interrupt);
      signalSource.removeListener('SIGTERM', interrupt);
    }
  }
}

module.exports = Object.freeze({
  EXIT_BLOCKED,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VALIDATION,
  PR_STAGE_SPECS,
  PROJECT_ROOT,
  SCHEMA_VERSION,
  USAGE,
  VALID_TIERS,
  VerificationError,
  createDefaultDeps,
  createReleaseOps,
  createStageDefinitions,
  formatHuman,
  main,
  parseArgs,
  redact,
  redactDeep,
  requestInterruption,
  runVerification,
  safeDryRunEnvironment,
  safeResetEnvironment,
  sensitiveEnvironmentValues
});

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`verify failed [INTERNAL_ORCHESTRATION_FAILURE]: ${redact(error && error.stack || error, sensitiveEnvironmentValues(process.env))}\n`);
    process.exitCode = EXIT_INTERNAL;
  });
}

'use strict';

// Read-only local environment diagnostic for the Reactivation Desk dashboard.
//
// Every external effect is injected through `deps` so that each scenario can be
// exercised from fixtures: no test needs Docker, Supabase, a listening socket, or
// a real process table. The command never writes, deletes, resets, provisions, or
// starts anything, and it never prints a key value.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_NAME = 'reactivation-desk-dashboard';
const IDENTITY_PATH = '/__dev-local-identity__';
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const DEFAULT_DASHBOARD_PORT = 3100;
const DOCUMENTED_LEGACY_PORT = 3000;
const MINIMUM_NODE_MAJOR = 22;

const EXIT_READY = 0;
const EXIT_WARNINGS = 1;
const EXIT_BLOCKED = 2;
const EXIT_USAGE = 64;

const STATUS_READY = 'READY';
const STATUS_WARNINGS = 'READY WITH WARNINGS';
const STATUS_BLOCKED = 'BLOCKED';

// Untracked paths that are known, inspected, and deliberately left in place.
const ALLOWED_UNTRACKED_PREFIXES = Object.freeze(['supabase/snippets/']);
const RECOVERY_ARTIFACT_PATTERNS = Object.freeze([
  /^reactivation-desk-recovery-sensitive-.*\.json$/i,
  /^reactivation-desk-migration-snapshot-.*\.json$/i,
  /^migration-user-map\.local\.json$/i
]);
const MUTATING_SQL_PATTERN =
  /\b(insert\s+into|update\s+\w|delete\s+from|drop\s+|truncate\s+|alter\s+|grant\s+|revoke\s+|create\s+|reset\s+|refresh\s+materialized)/i;

// A process holding one of these command-line markers is mid-flight against the
// same local database; starting a second launcher would race it.
const COMPETING_PROCESS_PATTERNS = Object.freeze([
  { pattern: /Invoke-LocalRuntimeSmokeTest\.ps1/i, label: 'local runtime smoke wrapper' },
  { pattern: /Invoke-LocalTeamManagementSmokeTest\.ps1/i, label: 'local team management smoke wrapper' },
  { pattern: /Invoke-RuntimeSmokeTest\.ps1/i, label: 'runtime smoke wrapper' },
  { pattern: /Remove-RuntimeSmokeRun\.ps1/i, label: 'runtime smoke cleanup' },
  { pattern: /Initialize-LocalSmokeUsers\.ps1/i, label: 'smoke user provisioning' },
  { pattern: /provision-local-smoke-users\.cjs/i, label: 'smoke user provisioning' },
  { pattern: /runtime-smoke\.cjs/i, label: 'runtime smoke harness' },
  { pattern: /supabase\b[^\n]*\bdb\s+reset/i, label: 'database reset' }
]);
const AGENT_PROCESS_PATTERN = /(^|[\\/\s"])(claude|claude-code|codex)(\.exe)?($|[\s"])/i;

const EXPECTED_SMOKE_USERS = Object.freeze([
  Object.freeze({ key: 'admin', envName: 'SMOKE_TEST_ADMIN_EMAIL', email: 'smoke_test_admin@local.invalid', username: 'SMOKE_TEST_admin', role: 'admin' }),
  Object.freeze({ key: 'agentA', envName: 'SMOKE_TEST_AGENT_A_EMAIL', email: 'smoke_test_agent_a@local.invalid', username: 'SMOKE_TEST_agent_a', role: 'agent' }),
  Object.freeze({ key: 'agentB', envName: 'SMOKE_TEST_AGENT_B_EMAIL', email: 'smoke_test_agent_b@local.invalid', username: 'SMOKE_TEST_agent_b', role: 'agent' })
]);

const SUPABASE_CONFIG_TEMPLATE = [
  '(function configureSupabase(root) {',
  "  'use strict';",
  '',
  '  root.REACTIVATION_SUPABASE_CONFIG = Object.freeze({',
  `    projectUrl: '${LOCAL_SUPABASE_URL}',`,
  "    publishableKey: '<paste the local publishable key printed by: npx supabase status>'",
  '  });',
  "})(typeof globalThis !== 'undefined' ? globalThis : this);",
  ''
].join('\n');

const DATA_CONFIG_TEMPLATE = [
  '(function configureDataMode(root) {',
  "  'use strict';",
  '',
  '  root.REACTIVATION_DATA_CONFIG = Object.freeze({',
  "    mode: 'supabase'",
  '  });',
  "})(typeof globalThis !== 'undefined' ? globalThis : this);",
  ''
].join('\n');

/* ==================== redaction ==================== */

// Mirrors Protect-SensitiveText in scripts/dev/common.ps1. Applied to every
// string that reaches human output, JSON output, or an error message.
function redact(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/(?<=authorization\s*:\s*bearer\s)[^\s]+/gi, '[REDACTED]');
  text = text.replace(/((?:token|password|secret|api[_-]?key|service[_-]?role[_-]?key|anon[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  text = text.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi, '$1[REDACTED]$2');
  text = text.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  text = text.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[REDACTED]');
  return text;
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactDeep(item);
    return result;
  }
  return value;
}

/* ==================== classification helpers ==================== */

function normalizeText(value) {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function classifyProjectUrl(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return Object.freeze({ kind: 'missing', origin: null, hostname: null });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return Object.freeze({ kind: 'malformed', origin: null, hostname: null, reason: 'not a valid absolute URL' });
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return Object.freeze({ kind: 'malformed', origin: parsed.origin, hostname: parsed.hostname, reason: 'must be an origin with no path, query, fragment, or credentials' });
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  if (loopback && parsed.protocol === 'http:') {
    return Object.freeze({ kind: 'local', origin: parsed.origin, hostname });
  }
  if (parsed.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/i.test(hostname)) {
    return Object.freeze({ kind: 'hosted', origin: parsed.origin, hostname });
  }
  if (/\.supabase\.(co|in|net)$/i.test(hostname)) {
    return Object.freeze({ kind: 'hosted', origin: parsed.origin, hostname });
  }
  return Object.freeze({ kind: 'other', origin: parsed.origin, hostname });
}

// Returns the class of a key only. The key itself is never echoed anywhere.
function classifyKey(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return Object.freeze({ class: 'missing', safeForBrowser: false, length: 0 });
  const result = (name, safe) => Object.freeze({ class: name, safeForBrowser: safe, length: raw.length });
  if (/^sb_secret_[A-Za-z0-9_-]{8,}$/.test(raw)) return result('secret', false);
  if (/service[_-]?role/i.test(raw)) return result('secret', false);
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(raw)) return result('publishable', true);
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(raw)) {
    const payload = decodeJwtPayload(raw);
    const role = payload && typeof payload.role === 'string' ? payload.role.toLowerCase() : '';
    if (role === 'service_role') return result('secret', false);
    if (role === 'anon') return result('legacy-anon-jwt', true);
    return result('unknown-jwt', false);
  }
  if (/^(YOUR_|PLACEHOLDER|CHANGE[_-]?ME|REPLACE[_-]?ME)/i.test(raw)) return result('placeholder', false);
  return result('unknown', false);
}

function decodeJwtPayload(token) {
  try {
    const segment = token.split('.')[1];
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function classifySnippet(source) {
  const text = normalizeText(source);
  const withoutComments = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return MUTATING_SQL_PATTERN.test(withoutComments) ? 'mutating' : 'read-only';
}

// Minimal, tolerant reader for the port values this tool reports. It never
// rewrites supabase/config.toml and ignores anything it does not recognise.
function parseSupabasePorts(tomlText) {
  const lines = normalizeText(tomlText).split('\n');
  const sections = new Map();
  let current = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    if (!sections.has(current)) sections.set(current, new Map());
    sections.get(current).set(assignment[1], assignment[2].trim());
  }
  const number = (section, key) => {
    const value = sections.has(section) ? sections.get(section).get(key) : undefined;
    const parsed = Number.parseInt(String(value === undefined ? '' : value), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
  };
  return Object.freeze({
    api: number('api', 'port'),
    db: number('db', 'port'),
    shadow: number('db', 'shadow_port'),
    pooler: number('db.pooler', 'port'),
    studio: number('studio', 'port'),
    smtp: number('local_smtp', 'port') || number('inbucket', 'port'),
    analytics: number('analytics', 'port')
  });
}

function parseStatusEnv(text) {
  const values = new Map();
  for (const line of normalizeText(text).split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function parseNetstatListeners(text) {
  const listeners = [];
  for (const line of normalizeText(text).split('\n')) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    listeners.push({ address: match[1], port: Number.parseInt(match[2], 10), pid: Number.parseInt(match[3], 10) });
  }
  return listeners;
}

function parseSsListeners(text) {
  const listeners = [];
  for (const line of normalizeText(text).split('\n')) {
    const local = line.match(/LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)/);
    if (!local) continue;
    const pid = line.match(/pid=(\d+)/);
    listeners.push({ address: local[1], port: Number.parseInt(local[2], 10), pid: pid ? Number.parseInt(pid[1], 10) : null });
  }
  return listeners;
}

function parsePsProcesses(text) {
  const processes = [];
  for (const line of normalizeText(text).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    processes.push({ pid: Number.parseInt(match[1], 10), name: match[2], commandLine: match[3] });
  }
  return processes;
}

// Evaluates one of the browser configuration files in an isolated context. The
// files are plain IIFEs that assign onto the global object.
function evaluateBrowserConfig(source, globalName) {
  const context = vm.createContext(Object.create(null));
  try {
    new vm.Script(normalizeText(source), { filename: globalName }).runInContext(context, { timeout: 1000 });
  } catch (error) {
    return { ok: false, reason: `configuration file could not be evaluated: ${redact(error && error.message)}` };
  }
  const value = context[globalName];
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: `configuration file did not define ${globalName}` };
  }
  return { ok: true, value };
}

/* ==================== default dependencies ==================== */

function commandName(name) {
  if (process.platform !== 'win32') return name;
  if (name === 'npm' || name === 'npx') return `${name}.cmd`;
  return name;
}

// Node refuses to spawn a .cmd/.bat shim without a shell, and npm/npx on Windows
// are exactly that. Only fixed literals and repository-relative paths are ever
// passed, and each argument is quoted, so no argument reaches the shell unquoted.
function quoteWindowsArgument(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) {
    throw new Error('Refusing to run a command with a control character in an argument.');
  }
  return /["\s&|<>^()%!,;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function defaultRunCommand(file, args, options = {}) {
  const { spawnSync } = require('node:child_process');
  const resolved = commandName(file);
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  const result = spawnSync(resolved, useShell ? args.map(quoteWindowsArgument) : args, {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs || 60000,
    windowsHide: true,
    env: options.env || process.env,
    shell: useShell,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function defaultListListeners(run) {
  if (process.platform === 'win32') {
    const result = run('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 20000 });
    return parseNetstatListeners(result.stdout);
  }
  const ss = run('ss', ['-ltnp'], { timeoutMs: 20000 });
  if (ss.status === 0 && ss.stdout) return parseSsListeners(ss.stdout);
  return [];
}

function defaultListProcesses(run) {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3';
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 45000 });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map(row => ({
        pid: Number(row.ProcessId),
        name: String(row.Name || ''),
        commandLine: String(row.CommandLine || '')
      }));
    } catch {
      return [];
    }
  }
  const result = run('ps', ['-eo', 'pid=,comm=,args='], { timeoutMs: 20000 });
  return result.status === 0 ? parsePsProcesses(result.stdout) : [];
}

function defaultHttpProbe(url, options = {}) {
  return new Promise(resolve => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, status: null, body: '', error: 'invalid probe URL' });
      return;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname) || parsed.protocol !== 'http:') {
      // A diagnostic never reaches a non-loopback endpoint.
      resolve({ ok: false, status: null, body: '', error: 'probe refused: non-loopback target' });
      return;
    }
    const request = http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      timeout: options.timeoutMs || 3000,
      headers: { accept: 'application/json,text/plain,*/*' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length < 65536) body += chunk;
      });
      response.on('end', () => resolve({ ok: true, status: response.statusCode, body, error: null }));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: null, body: '', error: 'probe timed out' });
    });
    request.on('error', error => resolve({ ok: false, status: null, body: '', error: String(error && error.message || error) }));
  });
}

// Read-only inspection of local Auth users and their profile rows. The service
// key stays in memory and is never returned, logged, or embedded in a result.
async function defaultInspectSmokeUsers({ projectUrl, serviceKey, expected }) {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const listed = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listed.error) throw listed.error;
  const profiles = await client.from('profiles').select('id,username,role');
  if (profiles.error) throw profiles.error;
  const users = listed.data.users.map(user => ({ id: user.id, email: String(user.email || '') }));
  const rows = (profiles.data || []).map(row => ({ id: row.id, username: String(row.username || ''), role: String(row.role || '') }));
  return buildSmokeUserReport(expected, users, rows);
}

// The single definition of "provisioning here would corrupt a profile row",
// used by both the diagnostic and the launcher gate so the two cannot drift.
// A conflicting row counts on its own evidence: deriving it from the account
// state hid the case where a stray row holds a smoke username while its Auth
// user is absent, because that account state is 'user-missing'.
function smokeUserConflicts(inspection) {
  if (!inspection || !Array.isArray(inspection.accounts)) return Object.freeze({ duplicates: [], mismatched: [] });
  const conflicted = inspection.accounts.filter(account => account.conflictingProfileCount > 0);
  const duplicates = [...new Set([
    ...conflicted.map(account => account.expectedUsername),
    ...(inspection.duplicateUsernames || [])
  ])];
  const mismatched = inspection.accounts.filter(account =>
    account.state === 'profile-mismatch' || account.state === 'role-mismatch');
  return Object.freeze({ duplicates, mismatched });
}

// Pure: turns raw Auth users and profile rows into per-account findings.
function buildSmokeUserReport(expected, users, profiles) {
  const byEmail = new Map(users.map(user => [user.email.toLowerCase(), user]));
  const byId = new Map(profiles.map(row => [row.id, row]));
  const usernameCounts = new Map();
  for (const row of profiles) {
    const key = row.username.toLowerCase();
    if (!key) continue;
    usernameCounts.set(key, (usernameCounts.get(key) || 0) + 1);
  }
  const accounts = expected.map(fixture => {
    const user = byEmail.get(fixture.email.toLowerCase()) || null;
    const profile = user ? byId.get(user.id) || null : null;
    const conflicting = profiles.filter(row =>
      row.username.toLowerCase() === fixture.username.toLowerCase() && (!user || row.id !== user.id));
    let state = 'ok';
    if (!user) state = 'user-missing';
    else if (!profile) state = 'profile-missing';
    else if (profile.username.toLowerCase() !== fixture.username.toLowerCase()) state = 'profile-mismatch';
    else if (profile.role !== fixture.role) state = 'role-mismatch';
    if (conflicting.length) state = state === 'ok' ? 'username-conflict' : state;
    return Object.freeze({
      key: fixture.key,
      email: fixture.email,
      expectedUsername: fixture.username,
      expectedRole: fixture.role,
      state,
      conflictingProfileCount: conflicting.length
    });
  });
  const duplicates = [...usernameCounts.entries()]
    .filter(([name, count]) => count > 1 && name.startsWith('smoke_test'))
    .map(([name]) => name);
  return Object.freeze({ accounts: Object.freeze(accounts), duplicateUsernames: Object.freeze(duplicates) });
}

function createDefaultDeps(overrides = {}) {
  const run = overrides.runCommand || defaultRunCommand;
  return {
    cwd: overrides.cwd || PROJECT_ROOT,
    env: overrides.env || process.env,
    selfPid: overrides.selfPid || process.pid,
    platform: overrides.platform || process.platform,
    nodeVersion: overrides.nodeVersion || process.versions.node,
    runCommand: run,
    readFile: overrides.readFile || (target => {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    }),
    listDirectory: overrides.listDirectory || (target => {
      try {
        return fs.readdirSync(target, { withFileTypes: true }).map(entry => ({ name: entry.name, isFile: entry.isFile() }));
      } catch {
        return null;
      }
    }),
    listListeners: overrides.listListeners || (() => defaultListListeners(run)),
    listProcesses: overrides.listProcesses || (() => defaultListProcesses(run)),
    httpProbe: overrides.httpProbe || defaultHttpProbe,
    inspectSmokeUsers: overrides.inspectSmokeUsers || defaultInspectSmokeUsers,
    ...overrides
  };
}

/* ==================== findings ==================== */

function createReport() {
  const findings = [];
  const facts = {};
  return {
    findings,
    facts,
    ok(code, title, detail) {
      findings.push({ code, severity: 'ok', title, detail: redact(detail), remediation: null });
    },
    warn(code, title, detail, remediation) {
      findings.push({ code, severity: 'warning', title, detail: redact(detail), remediation: redact(remediation) });
    },
    block(code, title, detail, remediation) {
      findings.push({ code, severity: 'blocker', title, detail: redact(detail), remediation: redact(remediation) });
    },
    fact(name, value) {
      facts[name] = redactDeep(value);
    }
  };
}

function statusFor(findings) {
  if (findings.some(finding => finding.severity === 'blocker')) return STATUS_BLOCKED;
  if (findings.some(finding => finding.severity === 'warning')) return STATUS_WARNINGS;
  return STATUS_READY;
}

function exitCodeFor(status) {
  if (status === STATUS_BLOCKED) return EXIT_BLOCKED;
  if (status === STATUS_WARNINGS) return EXIT_WARNINGS;
  return EXIT_READY;
}

/* ==================== individual checks ==================== */

function checkRepository(deps, report) {
  const revParse = deps.runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd });
  if (revParse.status !== 0) {
    report.block('REPO_NOT_GIT', 'Repository root', 'The working directory is not inside a Git repository.',
      'Run the command from the dashboard repository root.');
    report.fact('repositoryRoot', null);
    return null;
  }
  const root = path.resolve(revParse.stdout.trim().split('\n')[0].trim());
  report.fact('repositoryRoot', root);

  const packageText = deps.readFile(path.join(root, 'package.json'));
  let packageName = null;
  try {
    packageName = packageText ? JSON.parse(packageText).name : null;
  } catch {
    packageName = null;
  }
  if (packageName !== PACKAGE_NAME) {
    report.block('REPO_NOT_DASHBOARD', 'Repository identity',
      `Repository root ${root} does not contain the ${PACKAGE_NAME} package.`,
      'Change directory to the dashboard repository and rerun.');
    return null;
  }
  report.ok('REPO_ROOT', 'Repository root', root);
  return root;
}

function checkGit(deps, root, report) {
  const git = args => deps.runCommand('git', args, { cwd: root });

  const branch = git(['branch', '--show-current']).stdout.trim() || 'HEAD';
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  report.fact('branch', branch);
  report.fact('head', head);
  report.ok('GIT_HEAD', 'Branch and HEAD', `${branch} @ ${head.slice(0, 12)}`);

  const localMain = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
  const remoteMain = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  if (localMain.status !== 0 || remoteMain.status !== 0) {
    report.warn('GIT_MAIN_REF_MISSING', 'Local main vs origin/main',
      'Either refs/heads/main or refs/remotes/origin/main is unavailable, so the comparison was skipped.',
      'git fetch --no-tags origin main');
    report.fact('mainComparison', { available: false });
  } else {
    const counts = git(['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main']).stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(counts[0], 10) || 0;
    const behind = Number.parseInt(counts[1], 10) || 0;
    report.fact('mainComparison', { available: true, ahead, behind, note: 'reflects the last fetch of origin' });
    if (ahead || behind) {
      report.warn('GIT_MAIN_DIVERGED', 'Local main vs origin/main',
        `Local main is ${ahead} ahead and ${behind} behind origin/main as of the last fetch.`,
        'git fetch --no-tags origin main');
    } else {
      report.ok('GIT_MAIN_SYNCED', 'Local main vs origin/main', 'Equal as of the last fetch of origin.');
    }
  }

  const porcelain = git(['status', '--porcelain=v1', '-z']);
  const entries = porcelain.stdout.split('\0').filter(Boolean);
  const tracked = [];
  const untracked = [];
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const target = entry.slice(3);
    if (code === '??') untracked.push(target);
    else tracked.push({ code, path: target });
  }
  report.fact('trackedChanges', tracked);
  report.fact('untracked', untracked);

  if (tracked.length) {
    report.warn('GIT_TREE_DIRTY', 'Tracked working tree',
      `${tracked.length} tracked path(s) modified: ${tracked.map(item => item.path).join(', ')}.`,
      'Commit or stash the tracked changes before starting a new task: git status');
  } else {
    report.ok('GIT_TREE_CLEAN', 'Tracked working tree', 'Clean.');
  }

  const unexpected = untracked.filter(target =>
    !ALLOWED_UNTRACKED_PREFIXES.some(prefix => target === prefix || target.startsWith(prefix)));
  const allowed = untracked.filter(target => !unexpected.includes(target));
  if (allowed.length) {
    report.ok('GIT_UNTRACKED_ALLOWED', 'Known untracked paths', `Allowed pre-existing untracked path(s): ${allowed.join(', ')}.`);
  }
  if (unexpected.length) {
    report.warn('GIT_UNTRACKED_UNEXPECTED', 'Unexpected untracked paths',
      `Untracked path(s) outside the allowlist: ${unexpected.join(', ')}.`,
      'Inspect each path and decide manually whether to track, ignore, or remove it. This command never deletes files.');
  }
  return { branch, head };
}

function checkSnippets(deps, root, report) {
  const directory = path.join(root, 'supabase', 'snippets');
  const entries = deps.listDirectory(directory);
  if (!entries) {
    report.ok('SNIPPETS_ABSENT', 'Supabase snippets', 'supabase/snippets does not exist.');
    report.fact('snippets', []);
    return;
  }
  const files = entries.filter(entry => entry.isFile).map(entry => {
    const source = deps.readFile(path.join(directory, entry.name));
    return { name: entry.name, classification: source === null ? 'unreadable' : classifySnippet(source) };
  });
  report.fact('snippets', files);
  if (!files.length) {
    report.ok('SNIPPETS_EMPTY', 'Supabase snippets', 'supabase/snippets exists but contains no files.');
    return;
  }
  const mutating = files.filter(file => file.classification === 'mutating');
  const summary = files.map(file => `${file.name} (${file.classification})`).join(', ');
  if (mutating.length) {
    report.warn('SNIPPETS_MUTATING', 'Supabase snippets',
      `supabase/snippets contains ${files.length} untracked Studio file(s), ${mutating.length} classified as mutating: ${summary}.`,
      'Review the mutating snippets before running them. This command never deletes them: remove them yourself if they are obsolete.');
  } else {
    report.warn('SNIPPETS_PRESENT', 'Supabase snippets',
      `supabase/snippets contains ${files.length} untracked read-only Studio file(s): ${summary}. They are a Supabase Studio side effect, not repository content.`,
      'No action required. supabase/.gitignore does not cover snippets, so they will keep appearing as untracked; delete them yourself if unwanted.');
  }
}

function checkRecoveryArtifacts(deps, root, report) {
  const entries = deps.listDirectory(root) || [];
  const artifacts = entries
    .filter(entry => entry.isFile && RECOVERY_ARTIFACT_PATTERNS.some(pattern => pattern.test(entry.name)))
    .map(entry => entry.name);
  report.fact('recoveryArtifacts', artifacts);
  if (artifacts.length) {
    report.warn('RECOVERY_ARTIFACT_PRESENT', 'Recovery artifacts',
      `Sensitive recovery artifact(s) present in the repository root: ${artifacts.join(', ')}.`,
      'These are Git-ignored by design. Inspect and remove them yourself once no longer needed. This command never deletes files.');
  } else {
    report.ok('RECOVERY_ARTIFACTS_ABSENT', 'Recovery artifacts', 'No unexpected recovery artifacts in the repository root.');
  }
}

function checkRuntimeVersions(deps, report) {
  const nodeVersion = String(deps.nodeVersion || '');
  const major = Number.parseInt(nodeVersion.split('.')[0], 10);
  report.fact('nodeVersion', nodeVersion);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    report.block('NODE_VERSION_UNSUPPORTED', 'Node version',
      `Node ${nodeVersion || 'unknown'} is below the required major version ${MINIMUM_NODE_MAJOR}.`,
      `Install Node ${MINIMUM_NODE_MAJOR} or newer (package.json engines.node).`);
  } else {
    report.ok('NODE_VERSION', 'Node version', nodeVersion);
  }

  const npm = deps.runCommand('npm', ['--version'], { timeoutMs: 60000 });
  const npmVersion = npm.status === 0 ? npm.stdout.trim() : null;
  report.fact('npmVersion', npmVersion);
  if (npmVersion) report.ok('NPM_VERSION', 'npm version', npmVersion);
  else report.warn('NPM_MISSING', 'npm version', 'npm did not report a version.', 'Reinstall Node.js so that npm is on PATH.');
}

function checkDocker(deps, report) {
  const version = deps.runCommand('docker', ['--version'], { timeoutMs: 30000 });
  if (version.status !== 0) {
    report.fact('docker', { cliAvailable: false, daemonRunning: false });
    report.block('DOCKER_CLI_MISSING', 'Docker CLI',
      `The docker command is unavailable: ${version.error || version.stderr.trim() || 'not found on PATH'}.`,
      'Install Docker Desktop and reopen the terminal so docker is on PATH.');
    return { cliAvailable: false, daemonRunning: false };
  }
  const info = deps.runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 });
  if (info.status !== 0) {
    report.fact('docker', { cliAvailable: true, daemonRunning: false });
    report.block('DOCKER_DAEMON_STOPPED', 'Docker daemon',
      `The Docker CLI is installed but the daemon is not reachable: ${info.stderr.trim().split('\n')[0] || 'no server version'}.`,
      'Start Docker Desktop and wait until the engine reports running. This command never starts Docker for you.');
    return { cliAvailable: true, daemonRunning: false };
  }
  report.fact('docker', { cliAvailable: true, daemonRunning: true, serverVersion: info.stdout.trim() });
  report.ok('DOCKER_READY', 'Docker daemon', `Server version ${info.stdout.trim()}.`);
  return { cliAvailable: true, daemonRunning: true };
}

function checkSupabaseCli(deps, root, report) {
  const version = deps.runCommand('npx', ['supabase', '--version'], { cwd: root, timeoutMs: 120000 });
  if (version.status !== 0) {
    report.fact('supabaseCli', null);
    report.block('SUPABASE_CLI_MISSING', 'Supabase CLI',
      `The Supabase CLI did not report a version: ${version.error || version.stderr.trim().split('\n')[0] || 'unknown failure'}.`,
      'npm install');
    return null;
  }
  const value = version.stdout.trim().split('\n').pop().trim();
  report.fact('supabaseCli', value);
  report.ok('SUPABASE_CLI', 'Supabase CLI', value);
  return value;
}

function checkSupabaseStatus(deps, root, docker, report) {
  const ports = parseSupabasePorts(deps.readFile(path.join(root, 'supabase', 'config.toml')) || '');
  report.fact('expectedSupabasePorts', ports);
  report.ok('SUPABASE_PORTS_EXPECTED', 'Expected Supabase ports',
    `api ${ports.api}, db ${ports.db}, shadow ${ports.shadow}, studio ${ports.studio}, smtp ${ports.smtp}, analytics ${ports.analytics}.`);

  if (!docker.daemonRunning) {
    report.fact('supabaseRunning', false);
    report.warn('SUPABASE_STATUS_UNKNOWN', 'Local Supabase status',
      'Supabase status was not queried because the Docker daemon is unavailable.',
      'Start Docker Desktop, then rerun: npm run doctor');
    return { running: false, statusEnv: new Map(), ports };
  }

  const status = deps.runCommand('npx', ['supabase', 'status', '-o', 'env'], { cwd: root, timeoutMs: 90000 });
  if (status.status !== 0) {
    report.fact('supabaseRunning', false);
    report.warn('SUPABASE_STOPPED', 'Local Supabase status',
      'Local Supabase is not running.',
      'npm run dev:local  (starts it without any database reset)');
    return { running: false, statusEnv: new Map(), ports };
  }
  const values = parseStatusEnv(status.stdout);
  const apiUrl = values.get('API_URL') || '';
  report.fact('supabaseRunning', true);
  report.fact('supabaseApiUrl', apiUrl);
  report.ok('SUPABASE_RUNNING', 'Local Supabase status', `Running. API ${apiUrl || 'unreported'}.`);
  return { running: true, statusEnv: values, ports };
}

function processesByPid(deps) {
  const map = new Map();
  for (const item of deps.listProcesses() || []) {
    if (Number.isInteger(item.pid)) map.set(item.pid, item);
  }
  return map;
}

async function checkPorts(deps, root, supabase, dashboardPort, report) {
  const listeners = deps.listListeners() || [];
  const processes = processesByPid(deps);
  const relevant = [
    { port: supabase.ports.api, purpose: 'Supabase API' },
    { port: supabase.ports.db, purpose: 'Supabase database' },
    { port: supabase.ports.studio, purpose: 'Supabase Studio' },
    { port: supabase.ports.analytics, purpose: 'Supabase analytics' },
    { port: dashboardPort, purpose: 'Dashboard (selected)' },
    { port: DOCUMENTED_LEGACY_PORT, purpose: 'Dashboard (documented legacy port)' }
  ].filter(entry => Number.isInteger(entry.port));

  const ownership = [];
  for (const entry of relevant) {
    const hit = listeners.find(listener => listener.port === entry.port) || null;
    const owner = hit && processes.has(hit.pid) ? processes.get(hit.pid) : null;
    ownership.push({
      port: entry.port,
      purpose: entry.purpose,
      listening: Boolean(hit),
      pid: hit ? hit.pid : null,
      processName: owner ? owner.name : null
    });
  }
  report.fact('portOwnership', ownership);
  report.ok('PORT_OWNERSHIP', 'Port ownership',
    ownership.map(entry => `${entry.port} ${entry.listening ? `held by pid ${entry.pid}${entry.processName ? ` (${entry.processName})` : ''}` : 'free'}`).join('; '));

  const identityFor = async port => {
    const probe = await deps.httpProbe(`http://127.0.0.1:${port}${IDENTITY_PATH}`, { timeoutMs: 3000 });
    if (!probe.ok || probe.status !== 200) return null;
    try {
      const parsed = JSON.parse(probe.body);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const dashboardEntry = ownership.find(entry => entry.port === dashboardPort);
  let dashboardIdentity = null;
  if (dashboardEntry && dashboardEntry.listening) {
    dashboardIdentity = await identityFor(dashboardPort);
    if (dashboardIdentity && path.resolve(String(dashboardIdentity.repositoryRoot || '')) === path.resolve(root)) {
      report.ok('DASHBOARD_PORT_OWNED', 'Selected dashboard port',
        `Port ${dashboardPort} already serves this repository (pid ${dashboardIdentity.pid}). npm run dev:local will reuse it.`);
    } else {
      report.block('DASHBOARD_PORT_FOREIGN', 'Selected dashboard port',
        `Port ${dashboardPort} is held by a server that does not identify as this repository.`,
        `Stop that server, or select another port: npm run dev:local -- --port <free port>`);
    }
  } else {
    report.ok('DASHBOARD_PORT_FREE', 'Selected dashboard port', `Port ${dashboardPort} is free.`);
  }
  report.fact('dashboardPort', dashboardPort);
  report.fact('dashboardPortIdentity', dashboardIdentity ? { repositoryRoot: dashboardIdentity.repositoryRoot, application: dashboardIdentity.application } : null);

  const legacyEntry = ownership.find(entry => entry.port === DOCUMENTED_LEGACY_PORT);
  if (legacyEntry && legacyEntry.listening && DOCUMENTED_LEGACY_PORT !== dashboardPort) {
    const identity = await identityFor(DOCUMENTED_LEGACY_PORT);
    const mine = identity && path.resolve(String(identity.repositoryRoot || '')) === path.resolve(root);
    report.fact('legacyPortServesThisRepository', Boolean(mine));
    if (mine) {
      report.ok('PORT_3000_OWNED', 'Documented port 3000', 'Port 3000 serves this repository.');
    } else {
      report.warn('PORT_3000_FOREIGN', 'Documented port 3000',
        `Port ${DOCUMENTED_LEGACY_PORT} is served by another project (pid ${legacyEntry.pid}${legacyEntry.processName ? `, ${legacyEntry.processName}` : ''}). README documents 3000 as the canonical dashboard address, so that address is currently misleading.`,
        `Use the unambiguous dashboard port instead: npm run dev:local (serves ${dashboardPort}).`);
    }
  } else {
    report.fact('legacyPortServesThisRepository', false);
  }

  return { ownership, dashboardIdentity };
}

function checkLocalConfiguration(deps, root, report) {
  const result = { projectUrl: null, urlClass: null, keyClass: null, dataMode: null };

  const supabaseConfigPath = path.join(root, 'config', 'supabase-config.local.js');
  const supabaseSource = deps.readFile(supabaseConfigPath);
  if (supabaseSource === null) {
    report.block('CONFIG_SUPABASE_MISSING', 'Supabase local configuration',
      'config/supabase-config.local.js does not exist.',
      `Create it from this template (never guess a key; take the local publishable key from "npx supabase status"):\n${SUPABASE_CONFIG_TEMPLATE}`);
  } else {
    const evaluated = evaluateBrowserConfig(supabaseSource, 'REACTIVATION_SUPABASE_CONFIG');
    if (!evaluated.ok) {
      report.block('CONFIG_SUPABASE_INVALID', 'Supabase local configuration', evaluated.reason,
        `Replace config/supabase-config.local.js with this template:\n${SUPABASE_CONFIG_TEMPLATE}`);
    } else {
      const urlClass = classifyProjectUrl(evaluated.value.projectUrl);
      const keyClass = classifyKey(evaluated.value.publishableKey);
      result.projectUrl = urlClass.origin;
      result.urlClass = urlClass;
      result.keyClass = keyClass;
      report.fact('configuredProjectUrl', urlClass.origin);
      report.fact('projectUrlClass', urlClass.kind);
      report.fact('publishableKeyClass', keyClass.class);

      if (urlClass.kind === 'local') {
        report.ok('CONFIG_URL_LOCAL', 'Configured Supabase URL', `${urlClass.origin} (local).`);
        if (urlClass.origin !== LOCAL_SUPABASE_URL) {
          report.warn('CONFIG_URL_NONCANONICAL_LOCAL', 'Configured Supabase URL',
            `The URL is loopback but not the canonical local API origin ${LOCAL_SUPABASE_URL}.`,
            `Set projectUrl to '${LOCAL_SUPABASE_URL}' in config/supabase-config.local.js.`);
        }
      } else if (urlClass.kind === 'hosted') {
        report.block('CONFIG_URL_HOSTED', 'Configured Supabase URL',
          `The local configuration points at a hosted project (${urlClass.hostname}). A local launcher must never drive a hosted or staging project.`,
          `Set projectUrl to '${LOCAL_SUPABASE_URL}' in config/supabase-config.local.js. Never edit that file automatically; change it deliberately.`);
      } else if (urlClass.kind === 'malformed' || urlClass.kind === 'missing') {
        report.block('CONFIG_URL_MALFORMED', 'Configured Supabase URL',
          `projectUrl is not usable: ${urlClass.reason || 'value is missing'}.`,
          `Set projectUrl to '${LOCAL_SUPABASE_URL}' in config/supabase-config.local.js.`);
      } else {
        report.warn('CONFIG_URL_UNRECOGNISED', 'Configured Supabase URL',
          `projectUrl host ${urlClass.hostname} is neither local nor a recognised Supabase project.`,
          `Set projectUrl to '${LOCAL_SUPABASE_URL}' for local development.`);
      }

      if (keyClass.class === 'secret') {
        report.block('CONFIG_KEY_SECRET', 'Configured key class',
          'The browser configuration holds a secret or service_role class key. A browser-public file must never contain one.',
          'Replace it with the local publishable key from "npx supabase status" (the ANON_KEY / publishable value), then rotate the exposed secret.');
      } else if (keyClass.class === 'publishable' || keyClass.class === 'legacy-anon-jwt') {
        report.ok('CONFIG_KEY_CLASS', 'Configured key class', `${keyClass.class} (${keyClass.length} characters). The value itself is never printed.`);
      } else {
        report.warn('CONFIG_KEY_UNRECOGNISED', 'Configured key class',
          `publishableKey does not match a known browser-public key class (classified as ${keyClass.class}).`,
          'Take the publishable/anon key from "npx supabase status" and paste it into config/supabase-config.local.js.');
      }
    }
  }

  const dataConfigPath = path.join(root, 'config', 'data-config.local.js');
  const dataSource = deps.readFile(dataConfigPath);
  if (dataSource === null) {
    report.warn('CONFIG_DATA_MISSING', 'Data mode',
      'config/data-config.local.js does not exist, so the dashboard falls back to its built-in default.',
      `Create it from this template:\n${DATA_CONFIG_TEMPLATE}`);
  } else {
    const evaluated = evaluateBrowserConfig(dataSource, 'REACTIVATION_DATA_CONFIG');
    if (!evaluated.ok) {
      report.warn('CONFIG_DATA_INVALID', 'Data mode', evaluated.reason,
        `Replace config/data-config.local.js with this template:\n${DATA_CONFIG_TEMPLATE}`);
    } else {
      const mode = String(evaluated.value.mode || '').trim().toLowerCase();
      result.dataMode = mode;
      report.fact('dataMode', mode);
      if (mode === 'supabase' || mode === 'local') {
        report.ok('CONFIG_DATA_MODE', 'Data mode', mode);
      } else {
        report.warn('CONFIG_DATA_MODE_UNKNOWN', 'Data mode', `Unrecognised data mode '${mode}'.`,
          `Set mode to 'supabase' or 'local' in config/data-config.local.js.`);
      }
    }
  }

  // Reported for a loopback origin in every data mode. The previous wording was
  // emitted only with data mode 'supabase' and told the reader to switch to
  // 'local', so following its own advice made the warning disappear while the
  // behaviour it described was unchanged. src/supabase-auth-service.js now
  // accepts a loopback project root, so the honest report is that sign-in works.
  if (result.urlClass && result.urlClass.kind === 'local') {
    report.ok('FRONTEND_LOCAL_AUTH_SUPPORTED', 'Frontend auth against local Supabase',
      'src/supabase-auth-service.js accepts this loopback project root, so dashboard sign-in, session restore, and sign-out work against local Supabase in every data mode.');
  }

  return result;
}

async function checkAuthHealth(deps, configuration, supabase, report) {
  if (!supabase.running) {
    report.warn('AUTH_HEALTH_SKIPPED', 'Auth health', 'Auth health was not probed because local Supabase is not running.',
      'npm run dev:local');
    return;
  }
  const target = configuration.urlClass && configuration.urlClass.kind === 'local'
    ? configuration.urlClass.origin
    : supabase.statusEnv.get('API_URL') || LOCAL_SUPABASE_URL;
  const classified = classifyProjectUrl(target);
  if (classified.kind !== 'local') {
    report.warn('AUTH_HEALTH_SKIPPED', 'Auth health', 'Auth health was not probed because the target is not a loopback endpoint.',
      'A read-only diagnostic never contacts a hosted project.');
    return;
  }
  const probe = await deps.httpProbe(`${classified.origin}/auth/v1/health`, { timeoutMs: 5000 });
  if (probe.ok && probe.status === 200) {
    report.ok('AUTH_HEALTHY', 'Auth health', `${classified.origin}/auth/v1/health responded 200.`);
    return;
  }
  report.warn('AUTH_HEALTH_FAILED', 'Auth health',
    `${classified.origin}/auth/v1/health did not respond 200 (${probe.status || probe.error || 'no response'}).`,
    'Confirm the Auth container is up: npx supabase status');
}

async function checkSmokeUsers(deps, configuration, supabase, report) {
  const expected = EXPECTED_SMOKE_USERS.map(fixture => ({
    ...fixture,
    email: String(deps.env[fixture.envName] || fixture.email)
  }));
  report.fact('expectedSmokeUsers', expected.map(item => ({ email: item.email, username: item.username, role: item.role })));

  if (!supabase.running) {
    report.warn('SMOKE_USERS_UNKNOWN', 'Smoke users',
      'Smoke user presence was not inspected because local Supabase is not running.',
      'npm run dev:local');
    return null;
  }
  const serviceKey = supabase.statusEnv.get('SERVICE_ROLE_KEY') || '';
  const apiUrl = supabase.statusEnv.get('API_URL') || LOCAL_SUPABASE_URL;
  if (!serviceKey) {
    report.warn('SMOKE_USERS_UNKNOWN', 'Smoke users',
      'The local status output did not include a service key, so users could not be inspected.',
      'npx supabase status -o env');
    return null;
  }
  if (classifyProjectUrl(apiUrl).kind !== 'local') {
    report.warn('SMOKE_USERS_UNKNOWN', 'Smoke users',
      'User inspection was skipped because the reported API URL is not a loopback endpoint.',
      'A read-only diagnostic never inspects a hosted project.');
    return null;
  }

  let inspection;
  try {
    inspection = await deps.inspectSmokeUsers({ projectUrl: apiUrl, serviceKey, expected });
  } catch (error) {
    report.warn('SMOKE_USERS_UNKNOWN', 'Smoke users',
      `Local user inspection failed: ${redact(error && error.message || error)}.`,
      'Confirm the local database has the dashboard migrations applied: npx supabase status');
    return null;
  }

  report.fact('smokeUsers', inspection.accounts);
  report.fact('duplicateSmokeUsernames', inspection.duplicateUsernames);

  const missing = inspection.accounts.filter(account => account.state === 'user-missing');
  const profileless = inspection.accounts.filter(account => account.state === 'profile-missing');
  const { duplicates, mismatched } = smokeUserConflicts(inspection);

  if (missing.length) {
    report.warn('SMOKE_USER_MISSING', 'Smoke users',
      `Missing Auth user(s): ${missing.map(account => account.email).join(', ')}.`,
      'npm run dev:local  (provisions through scripts/Initialize-LocalSmokeUsers.ps1 with SMOKE_TEST_* passwords supplied by you)');
  }
  if (profileless.length) {
    report.warn('SMOKE_PROFILE_MISSING', 'Smoke user profiles',
      `Auth user(s) without a linked profile row: ${profileless.map(account => account.email).join(', ')}.`,
      'npm run dev:local  (the sanctioned provisioning path relinks the profile through provision_local_smoke_test_profile)');
  }
  if (mismatched.length) {
    report.warn('SMOKE_PROFILE_MISMATCH', 'Smoke user profiles',
      `Profile linkage differs from the expected fixture for: ${mismatched.map(account => `${account.email} (${account.state})`).join(', ')}.`,
      'Inspect the profiles table before provisioning. The launcher refuses to provision over a mismatch.');
  }
  if (duplicates.length) {
    report.warn('SMOKE_USERNAME_DUPLICATE', 'Smoke usernames',
      `Smoke usernames are bound to unexpected rows: ${duplicates.join(', ')}.`,
      'Resolve the duplicate profile rows manually before provisioning; the launcher refuses to provision into a duplicate username.');
  }
  if (!missing.length && !profileless.length && !mismatched.length && !duplicates.length) {
    report.ok('SMOKE_USERS_READY', 'Smoke users', `${inspection.accounts.length} expected account(s) present with linked profiles.`);
  }
  return inspection;
}

function checkCompetingProcesses(deps, root, report) {
  const processes = deps.listProcesses() || [];
  const self = deps.selfPid;
  const competing = [];
  const agents = [];
  const rootLower = path.resolve(root).toLowerCase();

  for (const item of processes) {
    if (!item || item.pid === self) continue;
    const commandLine = String(item.commandLine || '');
    if (!commandLine) continue;
    const match = COMPETING_PROCESS_PATTERNS.find(entry => entry.pattern.test(commandLine));
    if (match) {
      competing.push({ pid: item.pid, name: item.name, label: match.label });
      continue;
    }
    if (AGENT_PROCESS_PATTERN.test(`${item.name || ''} ${commandLine}`) && commandLine.toLowerCase().includes(rootLower)) {
      agents.push({ pid: item.pid, name: item.name });
    }
  }

  report.fact('competingProcesses', competing);
  report.fact('agentProcesses', agents);

  if (competing.length) {
    report.block('SMOKE_PROCESS_ACTIVE', 'Competing local processes',
      `A smoke, reset, or provisioning process is running: ${competing.map(item => `pid ${item.pid} (${item.label})`).join(', ')}. Starting a launcher now would race it against the same local database.`,
      'Wait for that run to finish, or stop it yourself. This command never terminates a process.');
  } else {
    report.ok('NO_COMPETING_PROCESS', 'Competing local processes', 'No smoke, reset, or provisioning process is running.');
  }

  if (agents.length) {
    report.warn('AGENT_PROCESS_ACTIVE', 'Concurrent agent processes',
      `Agent process(es) reference this repository: ${agents.map(item => `pid ${item.pid} (${item.name})`).join(', ')}. Concurrent edits to the same working tree can conflict.`,
      'Confirm no other agent session is mid-change before starting work. This command never terminates a process.');
  } else {
    report.ok('NO_AGENT_CONFLICT', 'Concurrent agent processes', 'No other agent process references this repository.');
  }
}

/* ==================== orchestration ==================== */

function resolveDashboardPort(options, env) {
  const raw = options.port !== undefined && options.port !== null
    ? options.port
    : env.DASHBOARD_DEV_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_DASHBOARD_PORT;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    const error = new Error(`Dashboard port must be an integer between 1024 and 65535 (received '${raw}').`);
    error.usage = true;
    throw error;
  }
  return parsed;
}

async function runDoctor(options = {}) {
  const deps = createDefaultDeps(options.deps || {});
  const report = createReport();
  const dashboardPort = resolveDashboardPort(options, deps.env);

  report.fact('environment', 'LOCAL');
  report.fact('generatedAt', options.now || new Date().toISOString());

  const root = checkRepository(deps, report);
  if (!root) {
    return finalize(report, dashboardPort);
  }

  checkGit(deps, root, report);
  checkSnippets(deps, root, report);
  checkRecoveryArtifacts(deps, root, report);
  checkRuntimeVersions(deps, report);
  const docker = checkDocker(deps, report);
  checkSupabaseCli(deps, root, report);
  const supabase = checkSupabaseStatus(deps, root, docker, report);
  await checkPorts(deps, root, supabase, dashboardPort, report);
  const configuration = checkLocalConfiguration(deps, root, report);
  await checkAuthHealth(deps, configuration, supabase, report);
  await checkSmokeUsers(deps, configuration, supabase, report);
  checkCompetingProcesses(deps, root, report);

  return finalize(report, dashboardPort, { root, supabase, configuration });
}

function finalize(report, dashboardPort, extra = {}) {
  const findings = report.findings.map(finding => Object.freeze({ ...finding }));
  const status = statusFor(findings);
  return Object.freeze({
    status,
    exitCode: exitCodeFor(status),
    dashboardPort,
    findings: Object.freeze(findings),
    facts: Object.freeze({ ...report.facts }),
    context: Object.freeze({
      repositoryRoot: extra.root || null,
      supabaseRunning: extra.supabase ? extra.supabase.running : false,
      supabaseStatusAvailable: Boolean(extra.supabase && extra.supabase.running),
      configuration: extra.configuration ? Object.freeze({
        projectUrl: extra.configuration.projectUrl,
        projectUrlKind: extra.configuration.urlClass ? extra.configuration.urlClass.kind : null,
        publishableKeyClass: extra.configuration.keyClass ? extra.configuration.keyClass.class : null,
        dataMode: extra.configuration.dataMode
      }) : null
    })
  });
}

/* ==================== presentation ==================== */

function formatHuman(result) {
  const lines = [];
  const label = { ok: 'OK   ', warning: 'WARN ', blocker: 'BLOCK' };
  lines.push('== Dashboard environment doctor (read-only) ==');
  lines.push('');
  for (const finding of result.findings) {
    lines.push(`${label[finding.severity]} ${finding.code}  ${finding.title}`);
    if (finding.detail) {
      for (const line of finding.detail.split('\n')) lines.push(`      ${line}`);
    }
    if (finding.remediation) {
      lines.push('      -> remediation:');
      for (const line of finding.remediation.split('\n')) lines.push(`         ${line}`);
    }
  }
  const warnings = result.findings.filter(finding => finding.severity === 'warning');
  const blockers = result.findings.filter(finding => finding.severity === 'blocker');
  lines.push('');
  lines.push(`Blockers: ${blockers.length}  Warnings: ${warnings.length}  Dashboard port: ${result.dashboardPort}`);
  lines.push('');
  lines.push(result.status);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { json: false, port: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
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

const USAGE = [
  'Usage: npm run doctor [-- --json] [-- --port <number>]',
  '',
  'Read-only diagnostic of the local dashboard development environment.',
  'It never writes, deletes, resets, provisions, starts Docker, or prints a key value.',
  '',
  'Exit codes: 0 READY, 1 READY WITH WARNINGS, 2 BLOCKED, 64 invalid usage.'
].join('\n');

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_READY;
  }
  let result;
  try {
    result = await runDoctor({ port: options.port });
  } catch (error) {
    if (error && error.usage) {
      process.stderr.write(`${redact(error.message)}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (options.json) process.stdout.write(`${JSON.stringify(redactDeep(result), null, 2)}\n`);
  else process.stdout.write(`${formatHuman(result)}\n`);
  return result.exitCode;
}

module.exports = {
  ALLOWED_UNTRACKED_PREFIXES,
  DEFAULT_DASHBOARD_PORT,
  DOCUMENTED_LEGACY_PORT,
  EXIT_BLOCKED,
  EXIT_READY,
  EXIT_USAGE,
  EXIT_WARNINGS,
  EXPECTED_SMOKE_USERS,
  IDENTITY_PATH,
  LOCAL_SUPABASE_URL,
  PACKAGE_NAME,
  STATUS_BLOCKED,
  STATUS_READY,
  STATUS_WARNINGS,
  SUPABASE_CONFIG_TEMPLATE,
  DATA_CONFIG_TEMPLATE,
  buildSmokeUserReport,
  classifyKey,
  classifyProjectUrl,
  classifySnippet,
  createDefaultDeps,
  evaluateBrowserConfig,
  formatHuman,
  main,
  parseArgs,
  parseNetstatListeners,
  parsePsProcesses,
  parseSsListeners,
  parseStatusEnv,
  parseSupabasePorts,
  quoteWindowsArgument,
  redact,
  redactDeep,
  resolveDashboardPort,
  runDoctor,
  smokeUserConflicts
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`doctor failed: ${redact(error && error.stack || error)}\n`);
    process.exitCode = EXIT_BLOCKED;
  });
}

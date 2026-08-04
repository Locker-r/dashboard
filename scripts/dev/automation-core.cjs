'use strict';

// Shared, dependency-free engine for the developer automation commands.
//
// This module owns the safety primitives that every automation command needs:
// fixed-argument command execution, canonical path resolution that refuses
// links and traversal, exclusive tool-ownership markers, an advisory
// shared-runtime lock, and the common output/exit-code contract. Command
// modules stay thin and testable by injecting effects through createDeps.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const doctor = require('./doctor.cjs');

const SCHEMA_VERSION = 1;
const TOOL_VERSION = '2-B1';

const EXIT_OK = 0;
const EXIT_VALIDATION = 1;
const EXIT_BLOCKED = 2;
const EXIT_USAGE = 64;
const EXIT_INTERNAL = 70;

const OWNER_MARKER = '.automation-owner.json';
const LOCK_DIRECTORY = '.automation-locks';
const PROTECTED_BRANCHES = Object.freeze(['main', 'master', 'HEAD']);
const BRANCH_PREFIXES = Object.freeze(['feature/', 'fix/', 'docs/']);
const FULL_SHA = /^[0-9a-f]{40}$/i;
// Deliberately narrow. Every accepted name becomes a directory component and a
// JSON field, so control characters, separators, bidi marks, and leading dots
// are refused rather than escaped.
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

class AutomationError extends Error {
  constructor(code, message, exitCode = EXIT_BLOCKED, options = {}) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.exitCode = exitCode;
    this.recoveryPath = options.recoveryPath || null;
    this.remediation = options.remediation || null;
  }
}

function usageError(code, message) {
  return new AutomationError(code, message, EXIT_USAGE);
}

/* ==================== redaction ==================== */

// Automation output echoes untrusted Git and GitHub text. Reuse the audited
// doctor redactor and add the token shapes the automation itself can surface.
function redact(value) {
  let output = doctor.redact(String(value === undefined || value === null ? '' : value));
  output = output.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  output = output.replace(new RegExp('\\bsb_' + 'secret_[A-Za-z0-9_-]{8,}\\b', 'gi'), '[REDACTED]');
  output = output.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]');
  output = output.replace(/((?:password|token|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  return output;
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

// Untrusted single-line text becomes a JSON string so a branch name or commit
// subject can never introduce a newline, heading, or fence into human output.
function quoteUntrusted(value) {
  return JSON.stringify(redact(value));
}

function bounded(value, maximum = 8000) {
  const safe = redact(value).trim();
  return safe.length <= maximum ? safe : `[output truncated to final ${maximum} characters]\n${safe.slice(-maximum)}`;
}

/* ==================== command execution ==================== */

function defaultRunCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs || 60000,
    windowsHide: true,
    shell: false,
    env: options.env || process.env,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null
  };
}

// Every Git invocation goes through here. Arguments are always an array with
// shell disabled, so no branch name, path, or ref is ever parsed by a shell.
function git(deps, args, options = {}) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new AutomationError('GIT_ARGUMENTS_INVALID', 'Git arguments must be an array of strings.', EXIT_INTERNAL);
  }
  for (const argument of args) {
    if (/[\r\n\u0000]/.test(argument)) {
      throw new AutomationError('GIT_ARGUMENT_UNSAFE', 'Refusing a Git argument containing a control character.', EXIT_BLOCKED);
    }
  }
  return deps.runCommand('git', args, { cwd: options.cwd || deps.repositoryRoot, timeoutMs: options.timeoutMs || 60000 });
}

function gitText(deps, args, code, options = {}) {
  const result = git(deps, args, options);
  if (!result || result.status !== 0) {
    throw new AutomationError(code, bounded(commandOutput(result) || `git ${args[0]} failed.`), EXIT_BLOCKED);
  }
  return String(result.stdout || '').trim();
}

function commandOutput(result) {
  if (!result) return '';
  return [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
}

function splitNull(value) {
  return String(value || '').split('\0').filter(Boolean);
}

/* ==================== path safety ==================== */

function assertNoTraversal(value, code) {
  const text = String(value);
  if (!text.trim()) throw new AutomationError(code, 'Path must not be empty.', EXIT_USAGE);
  if (CONTROL_OR_BIDI.test(text)) {
    throw new AutomationError(code, 'Path contains control or bidirectional characters.', EXIT_USAGE);
  }
  const segments = text.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) throw new AutomationError(code, 'Path traversal is refused.', EXIT_USAGE);
}

function samePath(left, right, platform = process.platform) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function pathIsInside(parent, target, platform = process.platform) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative === '') return false;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

// Walks every existing ancestor and refuses symlinks and Windows junctions
// (which report isSymbolicLink() through lstat). A canonical realpath check
// alone is not enough: it would silently accept a redirected ancestor.
function assertNoLinkAncestor(deps, target, code) {
  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  const chain = [];
  let current = resolved;
  while (current && current !== root) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.reverse();
  for (const entry of chain) {
    let info;
    try {
      info = deps.fs.lstatSync(entry);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw new AutomationError(code, `Cannot inspect path component: ${quoteUntrusted(entry)}.`, EXIT_BLOCKED);
    }
    if (info.isSymbolicLink()) {
      throw new AutomationError(code, `Refusing a path with a symbolic-link or junction ancestor: ${quoteUntrusted(entry)}.`, EXIT_BLOCKED);
    }
  }
}

// UNC and drive-relative forms are refused: they make canonical comparison and
// ownership verification ambiguous on Windows.
function assertOrdinaryAbsolutePath(value, code, platform = process.platform) {
  const text = String(value);
  if (CONTROL_OR_BIDI.test(text)) throw new AutomationError(code, 'Path contains control or bidirectional characters.', EXIT_USAGE);
  if (platform === 'win32') {
    if (/^\\\\/.test(text) || /^\/\//.test(text)) throw new AutomationError(code, 'UNC paths are not supported by automation worktrees.', EXIT_USAGE);
    if (/^[A-Za-z]:[^\\/]/.test(text)) throw new AutomationError(code, 'Drive-relative paths are ambiguous and are refused.', EXIT_USAGE);
    if (!/^[A-Za-z]:[\\/]/.test(text)) throw new AutomationError(code, 'An absolute Windows path is required.', EXIT_USAGE);
    return;
  }
  if (!text.startsWith('/')) throw new AutomationError(code, 'An absolute path is required.', EXIT_USAGE);
}

function canonicalDirectory(deps, target, code) {
  try {
    return deps.fs.realpathSync(target);
  } catch (error) {
    throw new AutomationError(code, `Cannot canonicalize path: ${quoteUntrusted(String(error && error.code || error))}.`, EXIT_BLOCKED);
  }
}

function pathExists(deps, target) {
  try {
    deps.fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function directoryIsEmpty(deps, target) {
  try {
    return deps.fs.readdirSync(target).length === 0;
  } catch {
    return false;
  }
}

/* ==================== ownership markers ==================== */

function ownershipToken(deps) {
  const token = String(deps.randomToken());
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw new AutomationError('OWNER_TOKEN_INVALID', 'Ownership token generation failed.', EXIT_INTERNAL);
  }
  return token;
}

function writeOwnerMarker(deps, directory, payload) {
  const markerPath = path.join(directory, OWNER_MARKER);
  const marker = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'dashboard-automation',
    toolVersion: TOOL_VERSION,
    ...payload
  };
  // Exclusive creation: never adopt or overwrite an existing marker.
  deps.fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return Object.freeze({ markerPath, marker: Object.freeze(marker) });
}

function readOwnerMarker(deps, directory) {
  const markerPath = path.join(directory, OWNER_MARKER);
  let raw;
  try {
    raw = deps.fs.readFileSync(markerPath, 'utf8');
  } catch {
    return { ok: false, code: 'OWNER_MARKER_MISSING', reason: 'Ownership marker is missing.' };
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'OWNER_MARKER_INVALID', reason: 'Ownership marker is not valid JSON.' };
  }
  if (!marker || marker.schemaVersion !== SCHEMA_VERSION || marker.tool !== 'dashboard-automation') {
    return { ok: false, code: 'OWNER_MARKER_INVALID', reason: 'Ownership marker is not a recognised automation marker.' };
  }
  if (typeof marker.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(marker.token)) {
    return { ok: false, code: 'OWNER_TOKEN_INVALID', reason: 'Ownership token is missing or malformed.' };
  }
  return { ok: true, marker: Object.freeze(marker), markerPath };
}

function verifyOwnership(deps, directory, expected) {
  const read = readOwnerMarker(deps, directory);
  if (!read.ok) return read;
  const marker = read.marker;
  if (expected.repositoryIdentity && marker.repositoryIdentity !== expected.repositoryIdentity) {
    return { ok: false, code: 'OWNER_REPOSITORY_MISMATCH', reason: 'Ownership marker belongs to a different repository.' };
  }
  if (expected.path && !samePath(marker.path, directory, deps.platform)) {
    return { ok: false, code: 'OWNER_PATH_MISMATCH', reason: 'Ownership marker records a different path than the one inspected.' };
  }
  if (expected.name && marker.name !== expected.name) {
    return { ok: false, code: 'OWNER_NAME_MISMATCH', reason: 'Ownership marker records a different worktree name.' };
  }
  return { ok: true, marker, markerPath: read.markerPath };
}

// A stable identity for "which repository is this", independent of the checkout
// path, so a marker cannot be moved between clones and still validate.
function repositoryIdentity(deps, root) {
  const firstCommit = git(deps, ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root });
  const seed = firstCommit && firstCommit.status === 0 ? String(firstCommit.stdout).trim().split('\n').sort()[0] : '';
  if (!seed) return 'unknown';
  return crypto.createHash('sha256').update(`${doctor.PACKAGE_NAME}:${seed}`, 'utf8').digest('hex').slice(0, 32);
}

/* ==================== shared runtime lock ==================== */

// Docker, Supabase, and the local ports are shared by every worktree of this
// repository family, so the lock lives beside the worktree parent rather than
// inside any single worktree.
function lockDirectory(deps, familyRoot) {
  return path.join(familyRoot, LOCK_DIRECTORY);
}

function lockPath(deps, familyRoot, operation) {
  return path.join(lockDirectory(deps, familyRoot), `${operation}.lock.json`);
}

function processStartIdentity(deps, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (deps.platform !== 'win32') return null;
  const result = deps.runCommand('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`
  ], { timeoutMs: 15000 });
  if (!result || result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value || null;
}

function processIsAlive(deps, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    deps.processKill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function acquireRuntimeLock(deps, familyRoot, operation, context = {}) {
  if (!SAFE_NAME.test(operation)) throw usageError('LOCK_OPERATION_INVALID', 'Runtime lock operation name is invalid.');
  const directory = lockDirectory(deps, familyRoot);
  deps.fs.mkdirSync(directory, { recursive: true });
  const target = lockPath(deps, familyRoot, operation);
  const pid = deps.processPid();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    operation,
    ownerWorktree: context.ownerWorktree || null,
    pid,
    processStart: processStartIdentity(deps, pid),
    acquiredAt: deps.now().toISOString(),
    token: ownershipToken(deps)
  };
  try {
    deps.fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const held = inspectRuntimeLock(deps, familyRoot, operation);
      throw new AutomationError('RUNTIME_LOCK_HELD',
        `The shared local runtime operation ${quoteUntrusted(operation)} is already claimed${held.live ? ' by a live process' : ''}.`,
        EXIT_BLOCKED,
        { remediation: held.live
          ? `Wait for PID ${held.pid} to finish. Automation never steals a live runtime lock.`
          : `Inspect ${target} and remove it yourself only after confirming no reset is running.` });
    }
    throw error;
  }
  return Object.freeze({ path: target, ...payload });
}

function inspectRuntimeLock(deps, familyRoot, operation) {
  const target = lockPath(deps, familyRoot, operation);
  if (!pathExists(deps, target)) return Object.freeze({ held: false, path: target, live: false, pid: null, stale: false });
  let payload = null;
  try {
    payload = JSON.parse(deps.fs.readFileSync(target, 'utf8'));
  } catch {
    return Object.freeze({ held: true, path: target, live: false, pid: null, stale: false, malformed: true });
  }
  const pid = Number.isInteger(payload && payload.pid) ? payload.pid : null;
  const live = processIsAlive(deps, pid);
  // PID reuse defence: a live PID whose recorded start time no longer matches
  // is a different process, so the lock is reported stale rather than live.
  let reused = false;
  if (live && payload && payload.processStart) {
    const current = processStartIdentity(deps, pid);
    if (current && current !== payload.processStart) reused = true;
  }
  const effectivelyLive = live && !reused;
  return Object.freeze({
    held: true,
    path: target,
    pid,
    live: effectivelyLive,
    stale: !effectivelyLive,
    reused,
    operation: payload && payload.operation || null,
    ownerWorktree: payload && payload.ownerWorktree || null,
    acquiredAt: payload && payload.acquiredAt || null
  });
}

// Only the exact holder may release. A foreign or malformed lock is preserved.
function releaseRuntimeLock(deps, familyRoot, lock) {
  const target = lock && lock.path ? lock.path : null;
  if (!target || !pathExists(deps, target)) return { released: false, reason: 'Lock file is already absent.' };
  let payload;
  try {
    payload = JSON.parse(deps.fs.readFileSync(target, 'utf8'));
  } catch {
    return { released: false, reason: 'Lock file is malformed and was preserved.' };
  }
  if (!payload || payload.token !== lock.token) {
    return { released: false, reason: 'Lock token does not match; the foreign lock was preserved.' };
  }
  deps.fs.rmSync(target, { force: false });
  return { released: true };
}

/* ==================== worktree inventory ==================== */

function parseWorktreePorcelain(text) {
  const entries = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      if (current) entries.push(Object.freeze(current));
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).toLowerCase();
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) entries.push(Object.freeze(current));
  return Object.freeze(entries);
}

function listWorktrees(deps, root) {
  const text = gitText(deps, ['worktree', 'list', '--porcelain'], 'WORKTREE_LIST_UNAVAILABLE', { cwd: root });
  return parseWorktreePorcelain(text);
}

function shortBranch(reference) {
  if (!reference) return null;
  return reference.startsWith('refs/heads/') ? reference.slice('refs/heads/'.length) : reference;
}

/* ==================== branch guards ==================== */

function assertBranchNameSafe(branch) {
  const text = String(branch || '');
  if (!text.trim()) throw usageError('BRANCH_REQUIRED', 'A branch name is required.');
  if (CONTROL_OR_BIDI.test(text)) throw usageError('BRANCH_UNSAFE', 'Branch name contains control or bidirectional characters.');
  // Refuse anything Git itself would treat as an option or a revision operator.
  if (text.startsWith('-')) throw usageError('BRANCH_UNSAFE', 'Branch name must not begin with a dash.');
  if (/[\s~^:?*\[\\]/.test(text) || text.includes('..') || text.includes('@{') || text.endsWith('/') || text.endsWith('.lock')) {
    throw usageError('BRANCH_UNSAFE', 'Branch name contains characters Git does not accept.');
  }
  if (PROTECTED_BRANCHES.includes(text)) {
    throw new AutomationError('BRANCH_PROTECTED', `Refusing to attach automation to the protected branch ${quoteUntrusted(text)}.`, EXIT_BLOCKED);
  }
  return text;
}

function assertImplementationBranch(branch) {
  const text = assertBranchNameSafe(branch);
  if (!BRANCH_PREFIXES.some(prefix => text.startsWith(prefix))) {
    throw new AutomationError('BRANCH_PREFIX_REQUIRED',
      `Implementation worktrees require a ${BRANCH_PREFIXES.join(', ')} branch; received ${quoteUntrusted(text)}.`, EXIT_BLOCKED);
  }
  return text;
}

/* ==================== repository state ==================== */

function readRepositoryState(deps, root) {
  const inProgress = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
  const gitDirectory = gitText(deps, ['rev-parse', '--git-dir'], 'GIT_DIR_UNAVAILABLE', { cwd: root });
  const absoluteGitDirectory = path.isAbsolute(gitDirectory) ? gitDirectory : path.join(root, gitDirectory);
  const operations = inProgress.filter(name => pathExists(deps, path.join(absoluteGitDirectory, name)));
  const indexLocked = pathExists(deps, path.join(absoluteGitDirectory, 'index.lock'));
  const status = git(deps, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: root });
  if (!status || status.status !== 0) {
    throw new AutomationError('GIT_STATUS_UNAVAILABLE', bounded(commandOutput(status)), EXIT_BLOCKED);
  }
  const entries = splitNull(status.stdout);
  const untracked = entries.filter(entry => entry.startsWith('?? ')).map(entry => entry.slice(3));
  const tracked = entries.filter(entry => !entry.startsWith('?? '));
  const head = gitText(deps, ['rev-parse', 'HEAD'], 'GIT_HEAD_UNAVAILABLE', { cwd: root }).toLowerCase();
  const branchResult = git(deps, ['branch', '--show-current'], { cwd: root });
  const branch = branchResult && branchResult.status === 0 ? String(branchResult.stdout).trim() : '';
  return Object.freeze({
    root,
    head: FULL_SHA.test(head) ? head : null,
    branch: branch || 'HEAD',
    detached: !branch,
    trackedChanges: tracked.length,
    untracked: Object.freeze(untracked),
    untrackedCount: untracked.length,
    operationsInProgress: Object.freeze(operations),
    indexLocked,
    gitDirectory: absoluteGitDirectory
  });
}

/* ==================== dependency injection ==================== */

function createDeps(overrides = {}) {
  const deps = {
    fs: overrides.fs || fs,
    platform: overrides.platform || process.platform,
    env: overrides.env || process.env,
    now: overrides.now || (() => new Date()),
    randomToken: overrides.randomToken || (() => crypto.randomBytes(24).toString('hex')),
    processPid: overrides.processPid || (() => process.pid),
    processKill: overrides.processKill || ((pid, signal) => process.kill(pid, signal)),
    streams: overrides.streams || process,
    repositoryRoot: overrides.repositoryRoot || null,
    homedir: overrides.homedir || (() => os.homedir())
  };
  deps.runCommand = overrides.runCommand || defaultRunCommand;
  return deps;
}

/* ==================== output ==================== */

function renderHuman(result) {
  const lines = [];
  for (const [label, value] of result.summary) lines.push(`${label}: ${value}`);
  if (result.details && result.details.length) {
    lines.push('');
    for (const detail of result.details) lines.push(detail);
  }
  if (result.remediation) {
    lines.push('');
    lines.push(`Remediation: ${result.remediation}`);
  }
  lines.push('');
  lines.push(result.statusLine);
  return redact(lines.join('\n'));
}

function emit(deps, result, options) {
  if (options.json) deps.streams.stdout.write(`${JSON.stringify(redactDeep(result.payload), null, 2)}\n`);
  else deps.streams.stdout.write(`${renderHuman(result)}\n`);
  return result.exitCode;
}

module.exports = Object.freeze({
  AutomationError,
  BRANCH_PREFIXES,
  CONTROL_OR_BIDI,
  EXIT_BLOCKED,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VALIDATION,
  FULL_SHA,
  LOCK_DIRECTORY,
  OWNER_MARKER,
  PROTECTED_BRANCHES,
  SAFE_NAME,
  SCHEMA_VERSION,
  TOOL_VERSION,
  acquireRuntimeLock,
  assertBranchNameSafe,
  assertImplementationBranch,
  assertNoLinkAncestor,
  assertNoTraversal,
  assertOrdinaryAbsolutePath,
  bounded,
  canonicalDirectory,
  commandOutput,
  createDeps,
  defaultRunCommand,
  directoryIsEmpty,
  emit,
  git,
  gitText,
  inspectRuntimeLock,
  listWorktrees,
  ownershipToken,
  parseWorktreePorcelain,
  pathExists,
  pathIsInside,
  processIsAlive,
  quoteUntrusted,
  readOwnerMarker,
  readRepositoryState,
  redact,
  redactDeep,
  releaseRuntimeLock,
  renderHuman,
  repositoryIdentity,
  samePath,
  shortBranch,
  splitNull,
  usageError,
  verifyOwnership,
  writeOwnerMarker
});

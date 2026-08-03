'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_FIELDS = Object.freeze([
  'Project',
  'Current milestone',
  'Milestone status',
  'Main SHA',
  'Last merged PR',
  'Current open PR',
  'Active blockers',
  'Approved decisions',
  'Next task',
  'Deferred work',
  'Technical debt references',
  'Last updated'
]);
const FIELD_SET = new Set(REQUIRED_FIELDS);
const MILESTONE_STATUSES = Object.freeze(['planned', 'in-progress', 'blocked', 'complete']);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PR_PATTERN = /^(?:#[1-9][0-9]*|none)$/i;
const PLACEHOLDER_PATTERNS = Object.freeze([
  /{{[^{}\r\n]+}}/,
  /<[^<>\r\n]+>/,
  /\b(?:TBD|TODO|REPLACE_ME|CHANGE_ME)\b/i,
  /\bYOUR_[A-Z0-9_]+\b/
]);
const SECRET_PATTERNS = Object.freeze([
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /authorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/i,
  /\b(?:password|token|credential|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /postgres(?:ql)?:\/\/[^:/\s]+:[^@\s]+@/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:[^@/\s]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
]);

function normalizeDocument(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function issue(code, message) {
  return Object.freeze({ code, message });
}

function parseCanonicalFields(text) {
  const errors = [];
  const fields = {};
  const lines = text.split('\n');
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '## Canonical status') sections.push(index);
  }
  if (!sections.length) {
    return { fields, errors: [issue('STATUS_SECTION_MISSING', 'The Canonical status section is missing.')] };
  }
  if (sections.length > 1) {
    errors.push(issue('STATUS_SECTION_DUPLICATE', 'The Canonical status section appears more than once.'));
  }
  const section = sections[0];
  let end = lines.length;
  for (let index = section + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  for (let index = section + 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(issue('STATUS_LINE_MALFORMED', 'Canonical status contains a malformed field line.'));
      continue;
    }
    const name = match[1].trim();
    const value = match[2].trim();
    if (!FIELD_SET.has(name)) {
      errors.push(issue('STATUS_FIELD_UNKNOWN', 'Canonical status contains an unknown field.'));
      continue;
    }
    if (Object.hasOwn(fields, name)) {
      errors.push(issue('STATUS_FIELD_DUPLICATE', 'Canonical status duplicates field: ' + name + '.'));
      continue;
    }
    fields[name] = value;
  }
  for (const name of REQUIRED_FIELDS) {
    if (!Object.hasOwn(fields, name)) errors.push(issue('STATUS_FIELD_MISSING', 'Required field is missing: ' + name + '.'));
    else if (!fields[name]) errors.push(issue('STATUS_FIELD_EMPTY', 'Required field is empty: ' + name + '.'));
  }
  return { fields, errors };
}

function isValidIsoTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== 'Z' && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateProjectStatus(input, options = {}) {
  const text = normalizeDocument(input);
  const parsed = parseCanonicalFields(text);
  const errors = parsed.errors.slice();
  const fields = parsed.fields;
  let resolvedMainSha = null;
  let commitsBehindMain = null;
  let mainShaStatus = 'unverified';
  if (Object.hasOwn(fields, 'Milestone status') && !MILESTONE_STATUSES.includes(fields['Milestone status'])) {
    errors.push(issue('MILESTONE_STATUS_INVALID', 'Milestone status is not in the documented allowlist.'));
  }
  if (Object.hasOwn(fields, 'Main SHA')) {
    if (!SHA_PATTERN.test(fields['Main SHA'])) {
      mainShaStatus = 'invalid';
      errors.push(issue('MAIN_SHA_INVALID', 'Main SHA must be a full 40-character Git SHA.'));
    } else if (options.expectedMainSha) {
      const recorded = fields['Main SHA'].toLowerCase();
      const tip = String(options.expectedMainSha).toLowerCase();
      resolvedMainSha = tip;
      if (!SHA_PATTERN.test(tip)) {
        throw Object.assign(new Error('Resolved main must be a full 40-character Git SHA.'), { code: 'MAIN_REF_INVALID' });
      }
      if (typeof options.inspectMainSha !== 'function') {
        throw Object.assign(new Error('Main SHA ancestry inspection is unavailable.'), { code: 'MAIN_SHA_INSPECTION_UNAVAILABLE' });
      }
      const inspection = options.inspectMainSha(recorded, tip);
      if (!inspection || typeof inspection !== 'object') {
        throw Object.assign(new Error('Main SHA ancestry inspection returned an invalid result.'), { code: 'MAIN_SHA_INSPECTION_INVALID' });
      }
      mainShaStatus = inspection.status;
      commitsBehindMain = inspection.commitsBehindMain;
      if (['unreachable', 'not-ancestor'].includes(mainShaStatus) && commitsBehindMain !== null) {
        throw Object.assign(new Error('Main SHA ancestry inspection returned inconsistent metadata.'), { code: 'MAIN_SHA_INSPECTION_INVALID' });
      } else if (mainShaStatus === 'unreachable') {
        errors.push(issue('MAIN_SHA_UNREACHABLE', 'Main SHA does not resolve to a reachable Git commit.'));
      } else if (mainShaStatus === 'not-ancestor') {
        errors.push(issue('MAIN_SHA_NOT_ANCESTOR', 'Main SHA must be an ancestor of resolved main.'));
      } else if (!['exact', 'ancestor'].includes(mainShaStatus)
        || !Number.isSafeInteger(commitsBehindMain)
        || commitsBehindMain < 0
        || (mainShaStatus === 'exact' && commitsBehindMain !== 0)
        || (mainShaStatus === 'ancestor' && commitsBehindMain < 1)) {
        throw Object.assign(new Error('Main SHA ancestry inspection returned inconsistent metadata.'), { code: 'MAIN_SHA_INSPECTION_INVALID' });
      }
    }
  }
  if (Object.hasOwn(fields, 'Last merged PR') && !PR_PATTERN.test(fields['Last merged PR'])) {
    errors.push(issue('LAST_MERGED_PR_INVALID', 'Last merged PR must be # followed by a positive integer, or none.'));
  }
  if (Object.hasOwn(fields, 'Current open PR') && !PR_PATTERN.test(fields['Current open PR'])) {
    errors.push(issue('CURRENT_OPEN_PR_INVALID', 'Current open PR must be # followed by a positive integer, or none.'));
  }
  if (Object.hasOwn(fields, 'Last updated') && !isValidIsoTimestamp(fields['Last updated'])) {
    errors.push(issue('LAST_UPDATED_INVALID', 'Last updated must be an ISO-8601 timestamp with a timezone.'));
  }
  if (PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text))) {
    errors.push(issue('STATUS_PLACEHOLDER_UNRESOLVED', 'The status document contains an unresolved template placeholder.'));
  }
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    errors.push(issue('STATUS_SECRET_DETECTED', 'The status document contains a secret-shaped value.'));
  }
  return Object.freeze({
    valid: errors.length === 0,
    fields: Object.freeze({ ...fields }),
    errors: Object.freeze(errors),
    resolvedMainSha,
    commitsBehindMain,
    mainShaStatus
  });
}

function runGitResult(args, cwd, spawn = spawnSync, options = {}) {
  let result;
  try {
    result = spawn('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 10000,
      input: options.input
    });
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
  return {
    status: result && typeof result.status === 'number' ? result.status : null,
    stdout: String(result && result.stdout || ''),
    stderr: String(result && result.stderr || ''),
    error: result && result.error || null
  };
}

function runGit(args, cwd, spawn = spawnSync) {
  const result = runGitResult(args, cwd, spawn);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function resolvesToCommit(root, sha, spawn) {
  const object = runGitResult(
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    root,
    spawn,
    { input: `${sha}\n` }
  );
  if (object.error || object.status !== 0) {
    throw Object.assign(new Error('Git could not inspect a Main SHA object type.'), { code: 'MAIN_SHA_INSPECTION_FAILED' });
  }
  const tokens = object.stdout.trim().toLowerCase().split(/\s+/);
  if (tokens.length === 2 && tokens[0] === sha && tokens[1] === 'missing') return false;
  if (tokens.length !== 2 || tokens[0] !== sha) {
    throw Object.assign(new Error('Git returned an invalid Main SHA object record.'), { code: 'MAIN_SHA_INSPECTION_FAILED' });
  }
  return tokens[1] === 'commit';
}

function shortestAncestryDistance(output, recorded, resolved) {
  const parentsByCommit = new Map();
  for (const line of String(output || '').trim().split(/\r?\n/).filter(Boolean)) {
    const tokens = line.trim().split(/\s+/).map(token => token.toLowerCase());
    if (!tokens.length || !tokens.every(token => SHA_PATTERN.test(token)) || parentsByCommit.has(tokens[0])) {
      throw Object.assign(new Error('Git returned an invalid ancestry graph.'), { code: 'MAIN_SHA_DISTANCE_INVALID' });
    }
    parentsByCommit.set(tokens[0], tokens.slice(1));
  }

  const queue = [{ sha: resolved, distance: 0 }];
  const seen = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.sha === recorded) return current.distance;
    if (seen.has(current.sha)) continue;
    seen.add(current.sha);
    for (const parent of parentsByCommit.get(current.sha) || []) {
      if (!seen.has(parent)) queue.push({ sha: parent, distance: current.distance + 1 });
    }
  }
  throw Object.assign(new Error('Git ancestry output did not connect Main SHA to resolved main.'), { code: 'MAIN_SHA_DISTANCE_UNAVAILABLE' });
}

function inspectMainSha(root, recordedSha, resolvedMainSha, spawn = spawnSync) {
  const recorded = String(recordedSha || '').toLowerCase();
  const resolved = String(resolvedMainSha || '').toLowerCase();
  if (!SHA_PATTERN.test(recorded) || !SHA_PATTERN.test(resolved)) {
    throw Object.assign(new Error('Main SHA ancestry inspection requires full Git SHAs.'), { code: 'MAIN_SHA_INSPECTION_INVALID' });
  }

  if (!resolvesToCommit(root, recorded, spawn)) {
    return Object.freeze({ status: 'unreachable', commitsBehindMain: null });
  }
  if (!resolvesToCommit(root, resolved, spawn)) {
    throw Object.assign(new Error('Resolved main does not identify a reachable Git commit.'), { code: 'MAIN_REF_UNAVAILABLE' });
  }

  if (recorded === resolved) {
    return Object.freeze({ status: 'exact', commitsBehindMain: 0 });
  }

  const ancestry = runGitResult(['merge-base', '--is-ancestor', recorded, resolved], root, spawn);
  if (!ancestry.error && ancestry.status === 1) {
    return Object.freeze({ status: 'not-ancestor', commitsBehindMain: null });
  }
  if (ancestry.error || ancestry.status !== 0) {
    throw Object.assign(new Error('Git could not determine the Main SHA ancestry relationship.'), { code: 'MAIN_SHA_INSPECTION_FAILED' });
  }

  const graph = runGitResult(['rev-list', '--parents', '--ancestry-path', `${recorded}..${resolved}`], root, spawn);
  if (graph.error || graph.status !== 0) {
    throw Object.assign(new Error('Git could not determine commitsBehindMain.'), { code: 'MAIN_SHA_DISTANCE_UNAVAILABLE' });
  }
  const commitsBehindMain = shortestAncestryDistance(graph.stdout, recorded, resolved);
  if (!Number.isSafeInteger(commitsBehindMain) || commitsBehindMain < 1) {
    throw Object.assign(new Error('Git returned an invalid commitsBehindMain value.'), { code: 'MAIN_SHA_DISTANCE_INVALID' });
  }
  return Object.freeze({ status: 'ancestor', commitsBehindMain });
}

function resolveRepositoryRoot(cwd, spawn) {
  const root = runGit(['rev-parse', '--show-toplevel'], cwd, spawn);
  if (!root) throw Object.assign(new Error('Cannot resolve the Git repository root.'), { code: 'GIT_ROOT_UNAVAILABLE' });
  return path.resolve(root);
}

function commitParents(root, revision, spawn) {
  return String(runGit(['show', '-s', '--format=%P', revision], root, spawn) || '')
    .split(/\s+/).filter(Boolean);
}

function firstParentOf(root, revision, spawn) {
  const parents = commitParents(root, revision, spawn);
  if (!parents.length) return null;
  return SHA_PATTERN.test(parents[0]) ? parents[0].toLowerCase() : null;
}

// A detached checkout carries no main ref, so the base can only be accepted when
// the CI runner itself vouches for it. The runner-written event payload supplies
// the declared base SHA; that value is trusted only after it is proven to be the
// first parent of the exact two-parent merge commit that is checked out. Commit
// messages, branch names, and pull-request titles are never consulted.
function resolveTrustedCiBase(root, spawn, env, readFile) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  if (env.GITHUB_BASE_REF !== 'main') return null;
  if (!env.GITHUB_EVENT_PATH) return null;
  let payload;
  try {
    payload = JSON.parse(readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return null;
  }
  const declared = payload && payload.pull_request && payload.pull_request.base && payload.pull_request.base.sha;
  if (typeof declared !== 'string' || !SHA_PATTERN.test(declared)) return null;
  if (runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, spawn)) return null;
  const parents = commitParents(root, 'HEAD', spawn);
  if (parents.length !== 2 || !parents.every(parent => SHA_PATTERN.test(parent))) return null;
  if (parents[0].toLowerCase() !== declared.toLowerCase()) return null;
  return declared.toLowerCase();
}

function resolveMainContext(root, spawn = spawnSync, env = process.env, readFile = fs.readFileSync) {
  const localMain = runGit(['rev-parse', '--verify', 'refs/heads/main'], root, spawn);
  const originMain = runGit(['rev-parse', '--verify', 'refs/remotes/origin/main'], root, spawn);
  const validLocal = localMain && SHA_PATTERN.test(localMain) ? localMain.toLowerCase() : null;
  const validOrigin = originMain && SHA_PATTERN.test(originMain) ? originMain.toLowerCase() : null;
  if (validLocal && validOrigin && validLocal !== validOrigin) {
    throw Object.assign(new Error('Local main and origin/main differ; synchronize them before validating project status.'), { code: 'MAIN_REFS_DIVERGED' });
  }
  const resolved = validLocal || validOrigin;
  if (resolved) {
    return Object.freeze({ sha: resolved, firstParent: firstParentOf(root, resolved, spawn), source: 'ref' });
  }
  const base = resolveTrustedCiBase(root, spawn, env || {}, readFile);
  if (base) {
    return Object.freeze({ sha: base, firstParent: firstParentOf(root, base, spawn), source: 'ci-merge-parent' });
  }
  throw Object.assign(
    new Error('Neither local main nor origin/main can be resolved, and no verifiable CI merge provenance is available. Fetch origin/main before validating project status.'),
    { code: 'MAIN_REF_UNAVAILABLE' }
  );
}

function resolveMainSha(root, spawn, env, readFile) {
  return resolveMainContext(root, spawn, env, readFile).sha;
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const streams = dependencies.streams || { stdout: process.stdout, stderr: process.stderr };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    streams.stdout.write('Usage: npm run check:project-status\n');
    return 0;
  }
  if (argv.length) {
    streams.stderr.write('PROJECT STATUS INVALID\n[ARGUMENT_INVALID] This command accepts no arguments.\n');
    return 2;
  }
  try {
    const cwd = dependencies.cwd || process.cwd();
    const spawn = dependencies.spawnSync || spawnSync;
    const env = dependencies.env || process.env;
    const readFile = dependencies.readFileSync || fs.readFileSync;
    const root = dependencies.root || resolveRepositoryRoot(cwd, spawn);
    const context = dependencies.mainSha
      ? { sha: dependencies.mainSha, firstParent: dependencies.mainFirstParentSha || null }
      : resolveMainContext(root, spawn, env, fs.readFileSync);
    const statusPath = path.join(root, 'docs', 'project-status.md');
    const inspect = dependencies.inspectMainSha
      || ((recordedSha, resolvedMainSha) => inspectMainSha(root, recordedSha, resolvedMainSha, spawn));
    const result = validateProjectStatus(readFile(statusPath), {
      expectedMainSha: context.sha,
      inspectMainSha: inspect
    });
    if (result.valid) {
      streams.stdout.write('PROJECT STATUS VALID\n');
      streams.stdout.write(`Main SHA relation: ${result.mainShaStatus}; commitsBehindMain=${result.commitsBehindMain}\n`);
      return 0;
    }
    streams.stderr.write('PROJECT STATUS INVALID\n');
    for (const error of result.errors) streams.stderr.write('[' + error.code + '] ' + error.message + '\n');
    return 1;
  } catch (error) {
    const code = error && error.code || 'STATUS_CHECK_FAILED';
    streams.stderr.write('PROJECT STATUS INVALID\n[' + code + '] ' + String(error && error.message || error) + '\n');
    return 2;
  }
}

module.exports = {
  MILESTONE_STATUSES,
  REQUIRED_FIELDS,
  inspectMainSha,
  isValidIsoTimestamp,
  normalizeDocument,
  parseCanonicalFields,
  resolveMainContext,
  resolveMainSha,
  resolveRepositoryRoot,
  validateProjectStatus,
  main
};

if (require.main === module) process.exitCode = main();

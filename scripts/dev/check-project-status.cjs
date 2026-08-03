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
  if (Object.hasOwn(fields, 'Milestone status') && !MILESTONE_STATUSES.includes(fields['Milestone status'])) {
    errors.push(issue('MILESTONE_STATUS_INVALID', 'Milestone status is not in the documented allowlist.'));
  }
  if (Object.hasOwn(fields, 'Main SHA')) {
    if (!SHA_PATTERN.test(fields['Main SHA'])) {
      errors.push(issue('MAIN_SHA_INVALID', 'Main SHA must be a full 40-character Git SHA.'));
    } else if (options.expectedMainSha && fields['Main SHA'].toLowerCase() !== options.expectedMainSha.toLowerCase()) {
      errors.push(issue('MAIN_SHA_STALE', 'Main SHA does not match the repository main ref.'));
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
  return Object.freeze({ valid: errors.length === 0, fields: Object.freeze({ ...fields }), errors: Object.freeze(errors) });
}

function runGit(args, cwd, spawn = spawnSync) {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10000
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function resolveRepositoryRoot(cwd, spawn) {
  const root = runGit(['rev-parse', '--show-toplevel'], cwd, spawn);
  if (!root) throw Object.assign(new Error('Cannot resolve the Git repository root.'), { code: 'GIT_ROOT_UNAVAILABLE' });
  return path.resolve(root);
}

function resolveMainSha(root, spawn) {
  const localMain = runGit(['rev-parse', '--verify', 'refs/heads/main'], root, spawn);
  const originMain = runGit(['rev-parse', '--verify', 'refs/remotes/origin/main'], root, spawn);
  const validLocal = localMain && SHA_PATTERN.test(localMain) ? localMain : null;
  const validOrigin = originMain && SHA_PATTERN.test(originMain) ? originMain : null;
  if (validLocal && validOrigin && validLocal.toLowerCase() !== validOrigin.toLowerCase()) {
    throw Object.assign(new Error('Local main and origin/main differ; synchronize them before validating project status.'), { code: 'MAIN_REFS_DIVERGED' });
  }
  if (validLocal || validOrigin) return validLocal || validOrigin;
  throw Object.assign(new Error('Neither local main nor origin/main can be resolved.'), { code: 'MAIN_REF_UNAVAILABLE' });
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
    const root = dependencies.root || resolveRepositoryRoot(cwd, spawn);
    const mainSha = dependencies.mainSha || resolveMainSha(root, spawn);
    const readFile = dependencies.readFileSync || fs.readFileSync;
    const statusPath = path.join(root, 'docs', 'project-status.md');
    const result = validateProjectStatus(readFile(statusPath), { expectedMainSha: mainSha });
    if (result.valid) {
      streams.stdout.write('PROJECT STATUS VALID\n');
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
  isValidIsoTimestamp,
  normalizeDocument,
  parseCanonicalFields,
  resolveMainSha,
  resolveRepositoryRoot,
  validateProjectStatus,
  main
};

if (require.main === module) process.exitCode = main();

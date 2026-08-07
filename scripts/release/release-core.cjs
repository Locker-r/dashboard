'use strict';

// Dependency-free engine for the autonomous release harness.
//
// The harness answers two questions and refuses everything else:
//   1. Which backlog task is next, and why that one rather than the others?
//   2. How far may an autonomous agent walk the release ladder on its own?
//
// The second answer is fixed at build time, not at run time: this module owns
// no code path that performs a production action. Production steps exist here
// only as classified, printable text. The run therefore always terminates at
// the production gate with HALTED_AT_PRODUCTION_GATE, and the operator, not
// the harness, performs whatever comes after it.
//
// Effects are injected through createDeps so the whole ladder is testable
// without a repository, a clock, or a child process.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA_VERSION = 1;
const HARNESS_VERSION = 'R1';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_NAME = 'reactivation-desk-dashboard';

const EXIT_OK = 0;
const EXIT_VALIDATION = 1;
const EXIT_BLOCKED = 2;
// Not a failure. The run reached the human decision boundary and stopped.
const EXIT_HALTED = 3;
const EXIT_USAGE = 64;
const EXIT_INTERNAL = 70;

const MODES = Object.freeze(['simulate', 'verify']);

const STATUS_PASSED = 'passed';
const STATUS_PLANNED = 'planned';
const STATUS_BLOCKED = 'blocked';
const STATUS_FAILED = 'failed';
const STATUS_HALTED = 'halted';

const READ_ONLY = 'read-only';
const LOCAL_WRITE = 'local-write';
const PRODUCTION = 'production';
const DESTRUCTIVE = 'destructive';
const UNKNOWN = 'unknown';
const CLASSIFICATIONS = Object.freeze([READ_ONLY, LOCAL_WRITE, PRODUCTION, DESTRUCTIVE, UNKNOWN]);

const SEVERITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
// `accepted` sits between `in-review` and `done`: a human recorded a G6
// approval and accepted the task, but its productionActions are still
// outstanding. It is deliberately NOT `done` — nothing has shipped — and
// nothing derives it automatically from an approval file. A person sets it,
// the same way a person writes the approval, because it asserts human
// acceptance and an agent that could set it would be self-approving by
// another name. Its only mechanical effect is that the planner stops
// re-selecting the task, so goal mode can advance to the remaining
// non-production work while gate G7 still halts.
const TASK_STATUSES = Object.freeze(['open', 'in-review', 'accepted', 'done']);
const TASK_DECISIONS = Object.freeze(['approved', 'pending', 'rejected']);
const TASK_ACTIONABILITY = Object.freeze(['internal', 'external']);
const TASK_ID = /^[A-Z][A-Z0-9-]{0,15}$/;

const BACKLOG_RELATIVE = 'release/backlog.json';
const APPROVAL_RELATIVE = 'release/approvals';
// Evidence is not authority. An agent may write evidence, because evidence is
// a falsifiable record of commands that actually ran and can be re-run against
// the same commit. An agent may never write an approval, because an approval
// is a person accepting consequences.
const VERIFICATION_RELATIVE = 'release/verification';

// Documents the harness refuses to run without. Each one is load-bearing for a
// gate: no document, no evidence, no run.
const REQUIRED_DOCUMENTS = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'docs/release-harness.md',
  'docs/release-plan.md',
  'docs/release-gates.md',
  'docs/release-backlog.md',
  'docs/release-governance.md',
  'docs/project-status.md',
  'docs/decisions.md',
  'release/backlog.json'
]);

class ReleaseError extends Error {
  constructor(code, message, exitCode = EXIT_BLOCKED) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageError(code, message) {
  return new ReleaseError(code, message, EXIT_USAGE);
}

/* ==================== redaction ==================== */

// The report echoes Git text and file content. Keep the same shapes the rest of
// the repository redacts so a release report can never become an exfil channel.
function redact(value) {
  let output = String(value === undefined || value === null ? '' : value);
  output = output.replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  output = output.replace(new RegExp('\\bsb_' + 'secret_[A-Za-z0-9_-]{8,}\\b', 'gi'), '[REDACTED]');
  output = output.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
  output = output.replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '[REDACTED]');
  output = output.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]');
  output = output.replace(/((?:password|token|secret|service[_-]?role[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  output = output.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/gi, '$1[REDACTED]$2');
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

function bounded(value, maximum = 4000) {
  const safe = redact(value).trim();
  return safe.length <= maximum ? safe : `[output truncated to final ${maximum} characters]\n${safe.slice(-maximum)}`;
}

/* ==================== command classification ==================== */

// A minimal shell-aware tokenizer. It exists so a wrapped command
// (powershell -Command "git push", cmd /c "npm publish") is classified by what
// it actually runs rather than by the wrapper that hides it.
function tokenize(text) {
  const tokens = [];
  let current = '';
  let hasCurrent = false;
  let quote = null;
  const flush = () => {
    if (hasCurrent) tokens.push(current);
    current = '';
    hasCurrent = false;
  };
  const source = String(text === undefined || text === null ? '' : text);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      else { current += character; hasCurrent = true; }
      continue;
    }
    if (character === '"' || character === '\'') { quote = character; hasCurrent = true; continue; }
    if (character === '`') { hasCurrent = true; continue; }
    if (/\s/.test(character)) { flush(); continue; }
    if (character === ';' || character === '\n') { flush(); tokens.push({ operator: ';' }); continue; }
    if (character === '|') { flush(); if (source[index + 1] === '|') index += 1; tokens.push({ operator: '|' }); continue; }
    if (character === '&') { flush(); if (source[index + 1] === '&') index += 1; tokens.push({ operator: '&' }); continue; }
    current += character;
    hasCurrent = true;
  }
  flush();
  return tokens;
}

function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token && typeof token === 'object' && token.operator) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(String(token));
  }
  if (current.length) segments.push(current);
  return segments;
}

const SHELL_WRAPPERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash']);
const TRANSPARENT_WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nice', 'time', 'npx', 'pnpx', 'bunx', 'winpty', 'stdbuf', 'xargs']);
const POWERSHELL_VALUE_FLAGS = new Set(['-executionpolicy', '-inputformat', '-outputformat', '-windowstyle', '-version', '-configurationname']);
// Flags that consume the following token, so skipping the flag alone would
// leave its value looking like the command (`sudo -u root git push`).
const TRANSPARENT_VALUE_FLAGS = Object.freeze({
  sudo: new Set(['-u', '-g', '-p', '-h', '-c', '-r', '-t', '--user', '--group', '--host', '--prompt']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-s', '-c', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  xargs: new Set(['-n', '-i', '-i{}', '-l', '-p', '-s', '-d', '-e', '-a'])
});

function baseCommand(token) {
  const raw = String(token || '').replace(/\\/g, '/');
  const name = raw.slice(raw.lastIndexOf('/') + 1).toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

// Peels wrappers until the tokens describe the commands that will really run.
//
// Returns an ARRAY of segments, never one. A wrapper payload can hold a whole
// pipeline (`bash -c "npm test && git push"`), and classifying only its first
// command is how a production action gets in wearing a read-only coat. Every
// segment of an expanded payload is classified, and the caller takes the worst.
//
// Depth-limited: a pathological nest is reported rather than followed forever.
function expandSegment(tokens, depth = 0) {
  const list = tokens.map(String).map(token => token.replace(/^[{(]+/, '').replace(/[})]+$/, '')).filter(Boolean);
  if (depth > 4) return [list];
  let index = 0;
  while (index < list.length) {
    const token = list[index];
    if (token === '&' || token === '.' && list[index + 1]) { index += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    const name = baseCommand(token);
    if (TRANSPARENT_WRAPPERS.has(name)) {
      const valueFlags = TRANSPARENT_VALUE_FLAGS[name];
      index += 1;
      while (index < list.length) {
        const flag = String(list[index]).toLowerCase();
        if (valueFlags && valueFlags.has(flag)) { index += 2; continue; }
        if (flag.startsWith('-')) { index += 1; continue; }
        break;
      }
      continue;
    }
    if (SHELL_WRAPPERS.has(name)) {
      index += 1;
      while (index < list.length) {
        const flag = String(list[index]).toLowerCase();
        if (flag === '/c' || flag === '/k' || flag === '/s' || flag === '/q') { index += 1; continue; }
        if (POWERSHELL_VALUE_FLAGS.has(flag)) { index += 2; continue; }
        if (flag.startsWith('-') || flag.startsWith('/')) { index += 1; continue; }
        break;
      }
      continue;
    }
    break;
  }
  const remaining = list.slice(index);
  if (remaining.length === 1 && /[\s;|&]/.test(remaining[0])) {
    const inner = splitSegments(tokenize(remaining[0]));
    return inner.flatMap(segment => expandSegment(segment, depth + 1));
  }
  return [remaining];
}

// Git global options carry a value or are inert; drop them so `git -C x push`
// classifies as a push rather than as an unrecognised command.
function stripGitGlobals(tokens) {
  const output = [tokens[0]];
  let index = 1;
  while (index < tokens.length) {
    // `-c` and `-C` differ in meaning and must stay case-sensitive here.
    const token = String(tokens[index]);
    const lower = token.toLowerCase();
    if (token === '-c' || token === '-C' || ['--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(lower)) {
      index += 2;
      continue;
    }
    if (/^--(?:config-env|git-dir|work-tree|namespace|exec-path)=/.test(lower)) { index += 1; continue; }
    if (['--no-pager', '-p', '--paginate', '--no-replace-objects', '--literal-pathspecs', '--bare'].includes(lower)) { index += 1; continue; }
    break;
  }
  return output.concat(tokens.slice(index));
}

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'for-each-ref', 'merge-base', 'check-ignore', 'check-attr', 'describe',
  'blame', 'shortlog', 'symbolic-ref', 'var', 'help', 'count-objects', 'verify-commit',
  'name-rev', 'grep', 'whatchanged', 'annotate', 'show-ref', 'ls-remote', 'fsck'
]);
const GIT_LOCAL_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase',
  'cherry-pick', 'revert', 'apply', 'am', 'fetch', 'pull', 'worktree', 'gc', 'prune',
  'mv', 'rm', 'notes', 'update-index', 'update-ref', 'init', 'clone'
]);

// Flags that take the following token as a value, so it is never mistaken for
// the remote or a refspec (`git push --push-option ci-skip origin feat/x`).
const GIT_PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const GIT_PUSH_PROTECTED_REFS = new Set(['main', 'master', 'head']);

// Explicit, narrow authorization: creating and linking exactly one named
// staging project in exactly one named organization. Nothing else about
// `supabase projects`/`link` is widened by this — a different name, a
// different org, or any flag outside this allow-list still refuses. Extending
// this to a second project or organization requires a new, equally explicit
// scoped authorization, not a loosened pattern.
const SUPABASE_STAGING_PROJECT_NAME = 'dashboard-latam-staging';
const SUPABASE_STAGING_ORG_ID = 'iivhkhxodnoypvfeucob';
// The existing, already-provisioned project. Never a valid `link` target under
// this authorization, named explicitly rather than inferred, so removing it
// from Supabase does not silently reopen this path for some other project.
const SUPABASE_EXISTING_PROJECT_REF = 'hywpwutykwrxkddnofrh';
// Every flag `projects create` may carry under this authorization: naming the
// org, the database password (by reference, never a literal value — see
// scripts/release/provision-staging-project.cjs), and the region a free
// project still requires. Anything else — size, plan, add-ons, a custom
// domain — is refused by not being on this list, not by trying to name every
// paid flag Supabase might ever add.
const SUPABASE_PROJECTS_CREATE_ALLOWED_FLAGS = new Set([
  '--org-id', '--db-password', '--region', '--output', '-o'
]);

function classifySupabaseProjectsCreate(rest, words) {
  // `words` still carries original case for the name comparison; Supabase
  // project names are not case-normalized the way flags and org ids are.
  const flags = rest.filter(argument => argument.startsWith('-'));
  for (const flag of flags) {
    const bare = flag.split('=')[0];
    if (!SUPABASE_PROJECTS_CREATE_ALLOWED_FLAGS.has(bare)) {
      return { classification: PRODUCTION, rule: 'SUPABASE_PROJECT_CREATE_DISALLOWED_FLAG' };
    }
  }
  const nameIndex = words.findIndex(word => word.toLowerCase() === 'create') + 1;
  const name = nameIndex > 0 ? String(words[nameIndex] || '') : '';
  if (name !== SUPABASE_STAGING_PROJECT_NAME) {
    return { classification: PRODUCTION, rule: 'SUPABASE_PROJECT_CREATE_NAME_MISMATCH' };
  }
  const orgInline = rest.find(argument => argument.startsWith('--org-id='));
  const orgFlagIndex = rest.findIndex(argument => argument === '--org-id');
  const org = orgInline ? orgInline.slice('--org-id='.length) : (orgFlagIndex >= 0 ? String(rest[orgFlagIndex + 1] || '') : '');
  if (org !== SUPABASE_STAGING_ORG_ID) {
    return { classification: PRODUCTION, rule: 'SUPABASE_PROJECT_CREATE_ORG_MISMATCH' };
  }
  return { classification: LOCAL_WRITE, rule: 'SUPABASE_STAGING_PROJECT_CREATE' };
}

function classifySupabaseLink(rest) {
  const refInline = rest.find(argument => argument.startsWith('--project-ref='));
  const refFlagIndex = rest.findIndex(argument => argument === '--project-ref' || argument === '-p');
  const ref = refInline ? refInline.slice('--project-ref='.length) : (refFlagIndex >= 0 ? String(rest[refFlagIndex + 1] || '') : '');
  if (!ref) return { classification: PRODUCTION, rule: 'SUPABASE_LINK_AMBIGUOUS_TARGET' };
  if (ref === SUPABASE_EXISTING_PROJECT_REF) {
    return { classification: PRODUCTION, rule: 'SUPABASE_LINK_EXISTING_PROJECT_BLOCKED' };
  }
  // The classifier cannot see which ref Supabase actually assigned the new
  // project — refs are opaque, not derivable from the name. Confirming the
  // linked project's name and organization before running this is a
  // procedural step the operator/agent performs, the same limitation
  // documented for `gh pr merge` and live CI state.
  return { classification: LOCAL_WRITE, rule: 'SUPABASE_LINK_UNVERIFIED_TARGET' };
}

// `git push` is not one action; it ranges from "update my feature branch" to
// "force-rewrite main". Only an explicit, unambiguous push of one ordinary
// branch to `origin` is allowed. Everything else — no target, a URL or remote
// other than `origin`, `--force*`, `--all`/`--mirror`/`--prune`, `--tags`,
// `--follow-tags` (can push a tag as a side effect), `--no-verify`, a leading
// `+` or `:` refspec (force / delete), a `refs/tags/…` or version-shaped
// destination, or `main`/`master`/`HEAD` itself — stays blocked. Fail-closed:
// an unrecognised flag does not widen what is allowed, it is simply ignored
// while the destination is still checked.
function classifyGitPush(args) {
  let forced = false;
  let pushesTags = false;
  let pushesEverything = false;
  let bypassesHooks = false;
  let deletesRef = false;
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--force' || argument === '-f' || argument === '--force-with-lease'
      || argument.startsWith('--force-with-lease=') || argument === '--force-if-includes'
      || argument.startsWith('--force-if-includes=')) { forced = true; continue; }
    if (argument === '--tags' || argument === '--follow-tags') { pushesTags = true; continue; }
    if (argument === '--all' || argument === '--mirror' || argument === '--prune') { pushesEverything = true; continue; }
    if (argument === '--no-verify') { bypassesHooks = true; continue; }
    // `--delete`/`-d` deletes the named ref; it does not "push a branch" in the
    // allowed sense, and the positional after it would otherwise read as an
    // ordinary destination.
    if (argument === '--delete' || argument === '-d') { deletesRef = true; continue; }
    if (GIT_PUSH_VALUE_FLAGS.has(argument)) { index += 1; continue; }
    if (argument.startsWith('-')) continue;
    positionals.push(argument);
  }
  if (forced) return { classification: PRODUCTION, rule: 'GIT_PUSH_FORCE' };
  if (pushesEverything) return { classification: PRODUCTION, rule: 'GIT_PUSH_ALL_OR_MIRROR' };
  if (pushesTags) return { classification: PRODUCTION, rule: 'GIT_PUSH_TAGS' };
  if (bypassesHooks) return { classification: PRODUCTION, rule: 'GIT_PUSH_NO_VERIFY' };
  if (deletesRef) return { classification: PRODUCTION, rule: 'GIT_PUSH_DELETE_REF' };

  const [remote, ...refspecs] = positionals;
  // No remote, no refspec, or a remote other than the one real origin: the
  // destination cannot be verified safe, so it is not verified allowed.
  if (remote !== 'origin' || !refspecs.length) {
    return { classification: PRODUCTION, rule: 'GIT_PUSH_AMBIGUOUS_TARGET' };
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) return { classification: PRODUCTION, rule: 'GIT_PUSH_FORCE' };
    if (refspec.startsWith(':')) return { classification: PRODUCTION, rule: 'GIT_PUSH_DELETE_REF' };
    const colonIndex = refspec.indexOf(':');
    const destination = (colonIndex >= 0 ? refspec.slice(colonIndex + 1) : refspec).replace(/^refs\/heads\//, '');
    if (!destination) return { classification: PRODUCTION, rule: 'GIT_PUSH_DELETE_REF' };
    if (destination.startsWith('refs/tags/') || /^v?\d+(?:\.\d+){1,2}/.test(destination)) {
      return { classification: PRODUCTION, rule: 'GIT_PUSH_TAGS' };
    }
    if (GIT_PUSH_PROTECTED_REFS.has(destination)) {
      return { classification: PRODUCTION, rule: 'GIT_PUSH_PROTECTED_BRANCH' };
    }
  }
  return { classification: LOCAL_WRITE, rule: 'GIT_PUSH_FEATURE_BRANCH' };
}

// npm scripts are classified by what the script does, not by the word `run`.
const NPM_READ_ONLY_SCRIPTS = new Set([
  'test', 'check:js', 'check:secrets', 'check:migrations', 'check:project-status',
  'doctor', 'verify:fast', 'verify:pr'
]);
const NPM_LOCAL_WRITE_SCRIPTS = new Set([
  'build:pages', 'build:vendor', 'verify:release', 'prompt', 'preflight',
  'preflight:runtime', 'review', 'agent:worktree', 'dev:local'
]);

const PRODUCTION_CLI = new Set([
  'vercel', 'netlify', 'netlify-cli', 'wrangler', 'firebase', 'flyctl', 'fly',
  'gcloud', 'aws', 'az', 'heroku', 'kubectl', 'helm', 'eb', 'surge', 'now', 'railway',
  'render', 'pulumi', 'serverless', 'sls'
]);

function classifySegment(unwrapped) {
  if (!unwrapped.length) return { classification: READ_ONLY, rule: 'EMPTY_SEGMENT' };
  const words = unwrapped.map(String);
  const name = baseCommand(words[0]);
  const lower = words.map(word => String(word).toLowerCase());
  const rest = lower.slice(1);
  const has = flag => rest.includes(flag);

  // A PowerShell script is classified by which script it is: the repository's
  // structural checks read, and its smoke wrappers reset a database.
  const scriptPath = String(words[0]).replace(/\\/g, '/').toLowerCase();
  if (scriptPath.endsWith('.ps1')) {
    if (/(?:^|\/)scripts\/check-[a-z0-9-]+\.ps1$/.test(scriptPath)) return { classification: READ_ONLY, rule: 'PS_STRUCTURAL_CHECK' };
    if (/(?:^|\/)scripts\/release\/invoke-releaseorchestrator\.ps1$/.test(scriptPath)) return { classification: READ_ONLY, rule: 'PS_RELEASE_ORCHESTRATOR' };
    if (/smoke|reset|remove-|initialize-/.test(scriptPath)) return { classification: DESTRUCTIVE, rule: 'PS_RUNTIME_SMOKE' };
    if (/(?:^|\/)scripts\/dev\/(?:preflight|review|pr)\.ps1$/.test(scriptPath)) return { classification: LOCAL_WRITE, rule: 'PS_DEV_TOOLING' };
    return { classification: UNKNOWN, rule: 'PS_UNCLASSIFIED_SCRIPT' };
  }

  if (name === 'git') {
    const git = stripGitGlobals(words).map(word => String(word).toLowerCase());
    const subcommand = git[1] || '';
    const args = git.slice(2);
    if (subcommand === 'push') return classifyGitPush(args);
    if (subcommand === 'tag') {
      const listing = args.some(argument => ['-l', '--list', '-n', '--contains', '--points-at', '--merged', '--no-merged'].includes(argument));
      return listing && !args.includes('-d') && !args.includes('--delete')
        ? { classification: READ_ONLY, rule: 'GIT_TAG_LIST' }
        : { classification: PRODUCTION, rule: 'GIT_TAG_WRITE' };
    }
    if (subcommand === 'remote') {
      const mutating = ['add', 'set-url', 'remove', 'rm', 'rename', 'set-head', 'prune'].includes(args[0] || '');
      return mutating ? { classification: PRODUCTION, rule: 'GIT_REMOTE_MUTATION' } : { classification: READ_ONLY, rule: 'GIT_REMOTE_READ' };
    }
    if (subcommand === 'reset' && args.includes('--hard')) return { classification: DESTRUCTIVE, rule: 'GIT_RESET_HARD' };
    if (subcommand === 'clean') return { classification: DESTRUCTIVE, rule: 'GIT_CLEAN' };
    if (subcommand === 'filter-branch' || subcommand === 'filter-repo') return { classification: DESTRUCTIVE, rule: 'GIT_HISTORY_REWRITE' };
    if (subcommand === 'branch') {
      const mutating = args.some(argument => ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--force'].includes(argument));
      return mutating ? { classification: LOCAL_WRITE, rule: 'GIT_BRANCH_MUTATION' } : { classification: READ_ONLY, rule: 'GIT_BRANCH_READ' };
    }
    if (subcommand === 'config') {
      const reading = args.some(argument => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(argument));
      return reading ? { classification: READ_ONLY, rule: 'GIT_CONFIG_READ' } : { classification: LOCAL_WRITE, rule: 'GIT_CONFIG_WRITE' };
    }
    if (subcommand === 'worktree') {
      return (args[0] || '') === 'list'
        ? { classification: READ_ONLY, rule: 'GIT_WORKTREE_LIST' }
        : { classification: LOCAL_WRITE, rule: 'GIT_WORKTREE_MUTATION' };
    }
    if (GIT_READ_SUBCOMMANDS.has(subcommand)) return { classification: READ_ONLY, rule: 'GIT_READ' };
    if (GIT_LOCAL_WRITE_SUBCOMMANDS.has(subcommand)) return { classification: LOCAL_WRITE, rule: 'GIT_LOCAL_WRITE' };
    return { classification: UNKNOWN, rule: 'GIT_UNCLASSIFIED' };
  }

  // Positional words only: a global flag and its value must not be mistaken for
  // the subcommand (`supabase --workdir . db push`, `npm --prefix . publish`).
  const words_ = rest.filter(argument => !argument.startsWith('-'));
  const positional = words_.join(' ');
  const mentions = (...sequence) => positional.split(' ').some((_, index) => sequence.every((word, offset) => words_[index + offset] === word));

  if (name === 'gh') {
    const subcommand = words_[0] || '';
    if (['release', 'workflow', 'secret', 'variable', 'ssh-key', 'gpg-key'].includes(subcommand)) {
      const reading = ['list', 'view', 'download'].includes(words_[1] || '');
      return reading ? { classification: READ_ONLY, rule: 'GH_READ' } : { classification: PRODUCTION, rule: 'GH_MUTATION' };
    }
    if (subcommand === 'auth' && ['login', 'logout', 'refresh', 'setup-git'].includes(words_[1] || '')) {
      // Grants durable credentials, exactly like supabase login.
      return { classification: PRODUCTION, rule: 'GH_AUTH_MUTATION' };
    }
    if (subcommand === 'pr' && words_[1] === 'create') {
      // Opens a request for review; touches no branch and merges nothing.
      return { classification: LOCAL_WRITE, rule: 'GH_PR_CREATE' };
    }
    if (subcommand === 'pr' && words_[1] === 'merge') {
      // `--admin` is GitHub's own explicit branch-protection bypass — refused
      // regardless of anything else on the line.
      if (has('--admin')) return { classification: PRODUCTION, rule: 'GH_PR_MERGE_ADMIN_BYPASS' };
      if (has('--force') || has('-f')) return { classification: PRODUCTION, rule: 'GH_PR_MERGE_FORCE' };
      // Required method, and it must be squash: docs/release-governance.md
      // states "Squash merge. One pull request becomes one commit on main."
      // Whether required checks have actually passed is enforced by GitHub's
      // branch protection on the server side, not by this text classifier —
      // it has no way to observe live CI state, and does not pretend to.
      if (!has('--squash') || has('--merge') || has('--rebase')) {
        return { classification: PRODUCTION, rule: 'GH_PR_MERGE_METHOD_REQUIRED' };
      }
      return { classification: LOCAL_WRITE, rule: 'GH_PR_MERGE_SQUASH' };
    }
    if (subcommand === 'pr' && ['close', 'ready', 'edit', 'comment', 'review'].includes(words_[1] || '')) {
      return { classification: PRODUCTION, rule: 'GH_PR_MUTATION' };
    }
    if (subcommand === 'run' && ['cancel', 'rerun', 'delete'].includes(words_[1] || '')) {
      // Re-running or cancelling a workflow can re-trigger whatever that
      // workflow does, including a deploy job; reading run state does not.
      return { classification: PRODUCTION, rule: 'GH_RUN_MUTATION' };
    }
    if (subcommand === 'repo' && ['delete', 'edit', 'archive', 'rename', 'sync', 'create', 'fork', 'clone'].includes(words_[1] || '')) {
      return { classification: PRODUCTION, rule: 'GH_REPO_MUTATION' };
    }
    if (subcommand === 'gist' && ['create', 'delete', 'edit', 'rename'].includes(words_[1] || '')) {
      return { classification: PRODUCTION, rule: 'GH_GIST_MUTATION' };
    }
    if (subcommand === 'issue' && ['create', 'close', 'edit', 'comment', 'delete'].includes(words_[1] || '')) {
      return { classification: PRODUCTION, rule: 'GH_ISSUE_MUTATION' };
    }
    if (subcommand === 'api') {
      // Both `-X DELETE` and `--method=DELETE` have to be seen.
      const flagIndex = rest.findIndex(argument => argument === '-x' || argument === '--method');
      const inline = rest.find(argument => argument.startsWith('--method='));
      const method = inline
        ? inline.slice('--method='.length).toUpperCase()
        : (flagIndex >= 0 ? String(rest[flagIndex + 1] || '').toUpperCase() : 'GET');
      const mutating = method !== 'GET' || has('-f') || has('--field') || has('--input') || has('--raw-field')
        || rest.some(argument => argument.startsWith('-f') || argument.startsWith('--field=') || argument.startsWith('--raw-field='));
      return mutating ? { classification: PRODUCTION, rule: 'GH_API_MUTATION' } : { classification: READ_ONLY, rule: 'GH_API_READ' };
    }
    return { classification: READ_ONLY, rule: 'GH_READ' };
  }

  if (name === 'supabase') {
    // Never destructive, never a mutation, never worth refusing: printing
    // usage is how this scoped policy itself gets verified without guessing
    // at CLI syntax.
    if (has('--help') || has('-h')) return { classification: READ_ONLY, rule: 'SUPABASE_HELP' };
    if (mentions('db', 'push')) return { classification: PRODUCTION, rule: 'SUPABASE_DB_PUSH' };
    if (mentions('db', 'reset')) return { classification: DESTRUCTIVE, rule: 'SUPABASE_DB_RESET' };
    if (mentions('functions', 'deploy')) return { classification: PRODUCTION, rule: 'SUPABASE_FUNCTIONS_DEPLOY' };
    if (mentions('secrets', 'set') || mentions('secrets', 'unset')) return { classification: PRODUCTION, rule: 'SUPABASE_SECRETS_MUTATION' };
    if (mentions('login')) return { classification: PRODUCTION, rule: 'SUPABASE_PROJECT_AUTHORITY' };
    if (mentions('link')) return classifySupabaseLink(rest);
    if (mentions('projects', 'create')) return classifySupabaseProjectsCreate(rest, words);
    if (mentions('projects', 'delete') || mentions('projects', 'pause') || mentions('projects', 'restore')
      || mentions('projects', 'transfer') || mentions('branches')) {
      return { classification: PRODUCTION, rule: 'SUPABASE_PROJECT_MUTATION' };
    }
    if (mentions('status') || mentions('projects', 'list') || mentions('migration', 'list')) {
      return { classification: READ_ONLY, rule: 'SUPABASE_READ' };
    }
    return { classification: LOCAL_WRITE, rule: 'SUPABASE_LOCAL' };
  }

  if (name === 'npm') {
    const subcommand = words_[0] || '';
    if (['publish', 'deploy', 'unpublish', 'dist-tag', 'owner', 'access', 'token'].some(word => mentions(word))) {
      return { classification: PRODUCTION, rule: 'NPM_REGISTRY_MUTATION' };
    }
    if (subcommand === 'test') return { classification: READ_ONLY, rule: 'NPM_TEST' };
    if (subcommand === 'run' || subcommand === 'run-script') {
      const script = words_[1] || '';
      if (script === 'verify:runtime') {
        return rest.includes('--allow-reset')
          ? { classification: DESTRUCTIVE, rule: 'NPM_VERIFY_RUNTIME_RESET' }
          : { classification: READ_ONLY, rule: 'NPM_VERIFY_RUNTIME' };
      }
      if (script === 'smoke') return { classification: DESTRUCTIVE, rule: 'NPM_SMOKE' };
      if (NPM_READ_ONLY_SCRIPTS.has(script)) return { classification: READ_ONLY, rule: 'NPM_READ_ONLY_SCRIPT' };
      if (NPM_LOCAL_WRITE_SCRIPTS.has(script)) return { classification: LOCAL_WRITE, rule: 'NPM_LOCAL_WRITE_SCRIPT' };
      return { classification: UNKNOWN, rule: 'NPM_UNCLASSIFIED_SCRIPT' };
    }
    if (['ls', 'list', 'view', 'audit', 'outdated', 'why', 'explain', 'config'].includes(subcommand)) {
      return { classification: READ_ONLY, rule: 'NPM_READ' };
    }
    if (['install', 'ci', 'i', 'update', 'uninstall', 'prune', 'dedupe', 'link'].includes(subcommand)) {
      return { classification: LOCAL_WRITE, rule: 'NPM_INSTALL' };
    }
    return { classification: UNKNOWN, rule: 'NPM_UNCLASSIFIED' };
  }

  if (name === 'node') {
    if (rest[0] === '--test' || rest.includes('--test')) return { classification: READ_ONLY, rule: 'NODE_TEST' };
    const script = (rest.find(argument => !argument.startsWith('-')) || '').replace(/\\/g, '/');
    if (script.startsWith('scripts/release/release.cjs') || script.startsWith('scripts/dev/check-project-status.cjs') || script.startsWith('scripts/dev/doctor.cjs')) {
      return { classification: READ_ONLY, rule: 'NODE_READ_ONLY_SCRIPT' };
    }
    // The staging migration wrapper reaches a hosted database. Seeing it at
    // segment level means it arrived wrapped, piped, env-prefixed, or with
    // arguments this policy does not authorize — the exact-shape check in
    // classifyCommand never reaches here. Refuse; the narrow allowance is
    // granted there and nowhere else.
    if (script === STAGING_DB_MIGRATE_SCRIPT) {
      return { classification: PRODUCTION, rule: 'STAGING_DB_MIGRATION_UNAUTHORIZED_FORM' };
    }
    // Same reasoning, for the staging Edge Function deployment wrapper.
    if (script === STAGING_FUNCTIONS_DEPLOY_SCRIPT) {
      return { classification: PRODUCTION, rule: 'STAGING_FUNCTIONS_DEPLOY_UNAUTHORIZED_FORM' };
    }
    // Same reasoning, for the staging Auth URL configuration wrapper.
    if (script === STAGING_AUTH_CONFIG_SCRIPT) {
      return { classification: PRODUCTION, rule: 'STAGING_AUTH_CONFIG_UNAUTHORIZED_FORM' };
    }
    // Same reasoning, for the staging team-management CORS origin secret wrapper.
    if (script === STAGING_TEAM_ORIGIN_CONFIG_SCRIPT) {
      return { classification: PRODUCTION, rule: 'STAGING_TEAM_ORIGIN_CONFIG_UNAUTHORIZED_FORM' };
    }
    // The runtime suites sign in, create synthetic rows, and clean up after
    // themselves against the local stack. Read-only they are not.
    if (/^scripts\/[a-z0-9-]*smoke[a-z0-9-]*\.cjs$/.test(script) || /^scripts\/(?:contact-reveal-race|provision-local-smoke-users)\.cjs$/.test(script)) {
      return { classification: LOCAL_WRITE, rule: 'NODE_RUNTIME_SUITE' };
    }
    if (rest[0] === '--version' || rest[0] === '-v' || rest[0] === '--check') return { classification: READ_ONLY, rule: 'NODE_READ' };
    return { classification: UNKNOWN, rule: 'NODE_UNCLASSIFIED_SCRIPT' };
  }

  if (name === 'docker') {
    if (mentions('push') || mentions('image', 'push') || mentions('compose', 'push')) return { classification: PRODUCTION, rule: 'DOCKER_PUSH' };
    if (['ps', 'version', 'info', 'images', 'inspect', 'logs'].includes(words_[0] || '')) return { classification: READ_ONLY, rule: 'DOCKER_READ' };
    return { classification: LOCAL_WRITE, rule: 'DOCKER_LOCAL' };
  }

  if (name === 'terraform' || name === 'tofu') {
    return ['apply', 'destroy', 'import', 'taint'].includes(words_[0] || '')
      ? { classification: PRODUCTION, rule: 'IAC_MUTATION' }
      : { classification: READ_ONLY, rule: 'IAC_READ' };
  }

  if (PRODUCTION_CLI.has(name)) return { classification: PRODUCTION, rule: 'HOSTING_CLI' };

  if (name === 'rm' || name === 'remove-item' || name === 'del' || name === 'rd' || name === 'rmdir') {
    // A sweep is categorically different from deleting one named file. Blocking
    // both drives people to disable the guard, so only the sweep is refused:
    // recursion, wildcards, directory targets, and the bare-directory removers.
    if (name === 'rd' || name === 'rmdir') return { classification: DESTRUCTIVE, rule: 'FILESYSTEM_REMOVAL' };
    const targets = rest.filter(argument => !argument.startsWith('-') && !argument.startsWith('/'));
    const recursive = rest.some(argument => /^-[a-z]*r/i.test(argument) || argument === '--recursive' || argument === '-recurse' || argument === '/s');
    const wildcard = targets.some(target => /[*?]/.test(target));
    const directoryish = targets.some(target => target === '.' || target === '..' || target === '/' || target.endsWith('/') || target.endsWith('\\'));
    if (recursive || wildcard || directoryish || !targets.length) {
      return { classification: DESTRUCTIVE, rule: 'FILESYSTEM_REMOVAL' };
    }
    return { classification: LOCAL_WRITE, rule: 'FILESYSTEM_REMOVE_FILE' };
  }

  if (['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'findstr', 'wc', 'echo', 'pwd', 'which', 'where', 'sort', 'uniq', 'diff', 'stat', 'file', 'sed'].includes(name)) {
    // sed is listed for its stream form only; the in-place flag rewrites files.
    if (name === 'sed' && (has('-i') || rest.some(argument => argument.startsWith('-i')))) {
      return { classification: LOCAL_WRITE, rule: 'SED_IN_PLACE' };
    }
    return { classification: READ_ONLY, rule: 'SHELL_READ' };
  }

  return { classification: UNKNOWN, rule: 'UNCLASSIFIED' };
}

const CLASSIFICATION_SEVERITY = Object.freeze({
  [READ_ONLY]: 0,
  [LOCAL_WRITE]: 1,
  [UNKNOWN]: 2,
  [PRODUCTION]: 3,
  [DESTRUCTIVE]: 3
});

// The scoped staging database migration exception.
//
// `supabase db push` stays `production` in every form. What is authorized here
// is one wrapper, in one shape, in one place: `scripts/release/staging-db-migrate.cjs`
// with exactly one of `--dry-run` or `--apply`, running inside GitHub Actions
// with RELEASE_ENVIRONMENT=staging. The wrapper re-checks all of this at run
// time against its own pinned project ref, host, port and database; this
// function is the outer half of that pair, not a substitute for it.
//
// The shape is matched against the raw tokens rather than an expanded segment
// on purpose. Anything that had to be unwrapped to get here — `cmd /c`,
// `npx --yes`, a pipeline, a shell, an environment-variable prefix — is not
// this exact command, so it falls through to classifySegment and is refused
// as STAGING_DB_MIGRATION_UNAUTHORIZED_FORM. Extending this to a second
// project, host, or environment needs its own reviewed authorization.
const STAGING_DB_MIGRATE_SCRIPT = 'scripts/release/staging-db-migrate.cjs';
const STAGING_DB_MIGRATE_MODES = Object.freeze(['--dry-run', '--apply']);

function classifyStagingDbMigrate(command, env) {
  const tokens = tokenize(command).map(String);
  if (tokens.length !== 3) return null;
  if (baseCommand(tokens[0]) !== 'node') return null;
  const script = tokens[1].replace(/\\/g, '/').replace(/^\.\//, '');
  if (script !== STAGING_DB_MIGRATE_SCRIPT) return null;
  if (!STAGING_DB_MIGRATE_MODES.includes(tokens[2])) {
    return { classification: PRODUCTION, rule: 'STAGING_DB_MIGRATION_UNAUTHORIZED_FORM' };
  }
  // Local execution is not a weaker case of CI execution; it is a different
  // actor reaching the same database with no run record. It stays refused.
  if (env.GITHUB_ACTIONS !== 'true') {
    return { classification: PRODUCTION, rule: 'STAGING_DB_MIGRATION_LOCAL_EXECUTION_BLOCKED' };
  }
  if (env.RELEASE_ENVIRONMENT !== 'staging') {
    return { classification: PRODUCTION, rule: 'STAGING_DB_MIGRATION_ENVIRONMENT_MISMATCH' };
  }
  return { classification: LOCAL_WRITE, rule: 'STAGING_DB_MIGRATION_AUTHORIZED' };
}

// The scoped staging Edge Function deployment exception.
//
// `supabase functions deploy` stays `production` in every form. What is
// authorized here is one wrapper, in one shape: `scripts/release/staging-functions-deploy.cjs`
// with exactly `--function <name>`, where `<name>` is one the wrapper itself
// allowlists against the functions the running app actually calls — running
// inside GitHub Actions with RELEASE_ENVIRONMENT=staging. The wrapper
// re-checks all of this at run time against its own pinned project ref and
// function allowlist; this function is the outer half of that pair.
//
// Matched against raw tokens for the same reason as the migration exception:
// anything unwrapped from `cmd /c`, `npx --yes`, a pipeline, a shell, or an
// environment-variable prefix is not this exact command and falls through to
// classifySegment, refused as STAGING_FUNCTIONS_DEPLOY_UNAUTHORIZED_FORM.
// Extending this to a second project or a function outside the wrapper's own
// allowlist needs its own reviewed authorization.
const STAGING_FUNCTIONS_DEPLOY_SCRIPT = 'scripts/release/staging-functions-deploy.cjs';

function classifyStagingFunctionsDeploy(command, env) {
  const tokens = tokenize(command).map(String);
  if (tokens.length !== 4) return null;
  if (baseCommand(tokens[0]) !== 'node') return null;
  const script = tokens[1].replace(/\\/g, '/').replace(/^\.\//, '');
  if (script !== STAGING_FUNCTIONS_DEPLOY_SCRIPT) return null;
  if (tokens[2] !== '--function') {
    return { classification: PRODUCTION, rule: 'STAGING_FUNCTIONS_DEPLOY_UNAUTHORIZED_FORM' };
  }
  // The function allowlist itself lives in the wrapper (TARGET.functions), not
  // duplicated here — the classifier authorizes the invocation shape, and the
  // wrapper is the one source of truth for which functions that shape may name.
  if (env.GITHUB_ACTIONS !== 'true') {
    return { classification: PRODUCTION, rule: 'STAGING_FUNCTIONS_DEPLOY_LOCAL_EXECUTION_BLOCKED' };
  }
  if (env.RELEASE_ENVIRONMENT !== 'staging') {
    return { classification: PRODUCTION, rule: 'STAGING_FUNCTIONS_DEPLOY_ENVIRONMENT_MISMATCH' };
  }
  return { classification: LOCAL_WRITE, rule: 'STAGING_FUNCTIONS_DEPLOY_AUTHORIZED' };
}

// The scoped staging Auth URL configuration exception.
//
// There is no `supabase` CLI subcommand for Auth Site URL or redirect
// configuration; the wrapper calls the Supabase Management API directly, so
// there is no separate `SUPABASE_*` command family to keep `production` the
// way `db push` and `functions deploy` are — the wrapper itself is the only
// path capable of this mutation at all. What is authorized is one wrapper,
// `scripts/release/staging-auth-config.cjs`, invoked as exactly `--dry-run` or
// `--apply`, only when `GITHUB_ACTIONS=true` and `RELEASE_ENVIRONMENT=staging`.
// The wrapper pins the project ref, the exact Site URL, and the exact
// redirect allowlist itself (`TARGET`); the classifier authorizes the
// invocation shape, and the wrapper is the one source of truth for what that
// shape may configure — no project ref, URL, or redirect entry is accepted
// as an argument.
const STAGING_AUTH_CONFIG_SCRIPT = 'scripts/release/staging-auth-config.cjs';
const STAGING_AUTH_CONFIG_MODES = Object.freeze(['--dry-run', '--apply']);

function classifyStagingAuthConfig(command, env) {
  const tokens = tokenize(command).map(String);
  if (tokens.length !== 3) return null;
  if (baseCommand(tokens[0]) !== 'node') return null;
  const script = tokens[1].replace(/\\/g, '/').replace(/^\.\//, '');
  if (script !== STAGING_AUTH_CONFIG_SCRIPT) return null;
  if (!STAGING_AUTH_CONFIG_MODES.includes(tokens[2])) {
    return { classification: PRODUCTION, rule: 'STAGING_AUTH_CONFIG_UNAUTHORIZED_FORM' };
  }
  if (env.GITHUB_ACTIONS !== 'true') {
    return { classification: PRODUCTION, rule: 'STAGING_AUTH_CONFIG_LOCAL_EXECUTION_BLOCKED' };
  }
  if (env.RELEASE_ENVIRONMENT !== 'staging') {
    return { classification: PRODUCTION, rule: 'STAGING_AUTH_CONFIG_ENVIRONMENT_MISMATCH' };
  }
  return { classification: LOCAL_WRITE, rule: 'STAGING_AUTH_CONFIG_AUTHORIZED' };
}

// The scoped staging team-management CORS origin secret exception.
//
// `supabase secrets set`/`unset` stay `production` in every other form.
// What is authorized here is one wrapper,
// `scripts/release/staging-team-origin-config.cjs`, invoked as exactly
// `--dry-run` or `--apply`, only when `GITHUB_ACTIONS=true` and
// `RELEASE_ENVIRONMENT=staging`. The wrapper pins the project ref, the exact
// secret name (`TEAM_ALLOWED_ORIGIN`), and its exact value (the approved
// staging Pages URL) itself; no secret name or value is accepted as an
// argument, so this cannot be repurposed to set any other secret.
const STAGING_TEAM_ORIGIN_CONFIG_SCRIPT = 'scripts/release/staging-team-origin-config.cjs';
const STAGING_TEAM_ORIGIN_CONFIG_MODES = Object.freeze(['--dry-run', '--apply']);

function classifyStagingTeamOriginConfig(command, env) {
  const tokens = tokenize(command).map(String);
  if (tokens.length !== 3) return null;
  if (baseCommand(tokens[0]) !== 'node') return null;
  const script = tokens[1].replace(/\\/g, '/').replace(/^\.\//, '');
  if (script !== STAGING_TEAM_ORIGIN_CONFIG_SCRIPT) return null;
  if (!STAGING_TEAM_ORIGIN_CONFIG_MODES.includes(tokens[2])) {
    return { classification: PRODUCTION, rule: 'STAGING_TEAM_ORIGIN_CONFIG_UNAUTHORIZED_FORM' };
  }
  if (env.GITHUB_ACTIONS !== 'true') {
    return { classification: PRODUCTION, rule: 'STAGING_TEAM_ORIGIN_CONFIG_LOCAL_EXECUTION_BLOCKED' };
  }
  if (env.RELEASE_ENVIRONMENT !== 'staging') {
    return { classification: PRODUCTION, rule: 'STAGING_TEAM_ORIGIN_CONFIG_ENVIRONMENT_MISMATCH' };
  }
  return { classification: LOCAL_WRITE, rule: 'STAGING_TEAM_ORIGIN_CONFIG_AUTHORIZED' };
}

// A pipeline is only as safe as its least safe member.
function classifyCommand(command, env = process.env) {
  const scoped = classifyStagingDbMigrate(command, env)
    || classifyStagingFunctionsDeploy(command, env)
    || classifyStagingAuthConfig(command, env)
    || classifyStagingTeamOriginConfig(command, env);
  if (scoped) {
    return Object.freeze({
      classification: scoped.classification,
      rule: scoped.rule,
      segments: Object.freeze([Object.freeze({ classification: scoped.classification, rule: scoped.rule })])
    });
  }
  const segments = splitSegments(tokenize(command)).flatMap(segment => expandSegment(segment));
  if (!segments.length) return Object.freeze({ classification: READ_ONLY, rule: 'EMPTY_COMMAND', segments: Object.freeze([]) });
  const results = segments.map(segment => {
    const outcome = classifySegment(segment);
    return Object.freeze({ classification: outcome.classification, rule: outcome.rule });
  });
  const worst = results.reduce((left, right) => (
    CLASSIFICATION_SEVERITY[right.classification] > CLASSIFICATION_SEVERITY[left.classification] ? right : left
  ));
  return Object.freeze({ classification: worst.classification, rule: worst.rule, segments: Object.freeze(results) });
}

function isReadOnlyCommand(command) {
  return classifyCommand(command).classification === READ_ONLY;
}

/* ==================== path classification ==================== */

const PRODUCT_CODE_PREFIXES = Object.freeze(['src/', 'supabase/', 'config/', 'vendor/', 'legacy/', 'frontend/', 'prisma/']);
const PRODUCT_CODE_FILES = Object.freeze(['index.html', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml']);
const HARNESS_PREFIXES = Object.freeze(['.claude/', 'scripts/release/', '.github/']);
const HARNESS_FILES = Object.freeze(['release/backlog.json', 'AGENTS.md', 'CLAUDE.md']);

// Paths whose content has no bearing on what a recorded acceptance criterion
// actually exercised: documentation, canonical status, release governance and
// harness tooling, and the evidence/approval directories themselves. A commit
// that touches only these — a status update, a harness fix, a backlog note —
// does not invalidate acceptance evidence for otherwise-unchanged product code.
// This is deliberately an allow-list, not a deny-list: anything not named here
// (src/, supabase/, tests/, scripts/ other than scripts/release/, and so on)
// is product-relevant by default and DOES invalidate evidence. Distinct from
// classifyPath, which serves the write-protection guard rather than evidence
// staleness — the two ask different questions about the same paths.
const EVIDENCE_DRIFT_ALLOWED_PREFIXES = Object.freeze(['docs/', '.claude/', 'scripts/release/', '.github/', 'release/']);
// tests/release-harness.test.cjs is the harness's own self-test: no backlog
// criterion runs it, so its content is as irrelevant to B1/B2 evidence as
// scripts/release/ is. The rest of tests/ stays product-relevant by default,
// since criteria do run specific files there (tests/lead-proof.test.cjs and
// friends) and a change to one of those must invalidate evidence.
const EVIDENCE_DRIFT_ALLOWED_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', 'tests/release-harness.test.cjs']);

function isEvidenceDriftAllowed(relative) {
  const text = String(relative || '').replace(/\\/g, '/');
  return EVIDENCE_DRIFT_ALLOWED_FILES.includes(text) || EVIDENCE_DRIFT_ALLOWED_PREFIXES.some(prefix => text.startsWith(prefix));
}

function normalizeRepositoryPath(target, root = PROJECT_ROOT) {
  const text = String(target || '');
  if (!text.trim()) return null;
  const absolute = path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
  const relative = path.relative(path.resolve(root), absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) return null;
  return relative;
}

// Which protection applies to a write target. `approval` is absolute: an agent
// may never author its own production authorization, in any mode.
function classifyPath(target, options = {}) {
  const relative = normalizeRepositoryPath(target, options.root || PROJECT_ROOT);
  if (relative === null) return Object.freeze({ relative: null, kind: 'outside-repository' });
  // The protected object is the approval record, not the folder that explains
  // it. Its README is ordinary documentation and must stay editable, or the
  // directory can never be created or described in the first place.
  if (relative === `${APPROVAL_RELATIVE}/README.md`) {
    return Object.freeze({ relative, kind: 'documentation' });
  }
  if (relative === APPROVAL_RELATIVE || relative.startsWith(`${APPROVAL_RELATIVE}/`)) {
    return Object.freeze({ relative, kind: 'approval' });
  }
  if (PRODUCT_CODE_FILES.includes(relative) || PRODUCT_CODE_PREFIXES.some(prefix => relative.startsWith(prefix))) {
    return Object.freeze({ relative, kind: 'product-code' });
  }
  if (HARNESS_FILES.includes(relative) || HARNESS_PREFIXES.some(prefix => relative.startsWith(prefix))) {
    return Object.freeze({ relative, kind: 'harness' });
  }
  if (relative.startsWith('docs/')) return Object.freeze({ relative, kind: 'documentation' });
  if (relative.startsWith('artifacts/')) return Object.freeze({ relative, kind: 'artifact' });
  if (relative.startsWith('tests/') || relative.startsWith('scripts/')) return Object.freeze({ relative, kind: 'tooling' });
  return Object.freeze({ relative, kind: 'other' });
}

/* ==================== security content rules ==================== */

// Some destructive changes are not commands at all — they are two words inside
// a migration or a config value. These rules read proposed file content and
// refuse the small number of edits that would dismantle the security posture
// the project already verified: row-level security, the private proof bucket,
// and the service-role key staying out of anything a browser loads.
const SECURITY_CONTENT_RULES = Object.freeze([
  Object.freeze({
    code: 'RLS_DISABLED',
    scope: 'sql',
    pattern: /\b(?:disable|no\s+force)\s+row\s+level\s+security\b/i,
    reason: 'This turns row-level security off. Every access-control guarantee the project verified at runtime rests on it staying on.'
  }),
  Object.freeze({
    code: 'STORAGE_POLICY_DROPPED_WITHOUT_REPLACEMENT',
    scope: 'sql',
    pattern: /drop\s+policy\s+(?:if\s+exists\s+)?[a-z0-9_"]+\s+on\s+storage\.objects\s*;(?![\s\S]{0,400}create\s+policy)/i,
    reason: 'This drops a storage object policy without creating a replacement, leaving proof bytes governed by nothing.'
  }),
  Object.freeze({
    code: 'PUBLIC_PROOF_BUCKET',
    scope: 'sql',
    pattern: /storage\.buckets[\s\S]{0,600}?\bpublic\s*=\s*true\b|insert\s+into\s+storage\.buckets\s*\([^)]*\bpublic\b[^)]*\)\s*values\s*\([^)]*\btrue\b|createbucket\s*\([^)]*public\s*:\s*true/i,
    reason: 'This makes a storage bucket public. The proof bucket must stay private so no unsigned URL can ever resolve a customer document.'
  }),
  Object.freeze({
    code: 'SERVICE_ROLE_KEY_IN_BROWSER_CODE',
    scope: 'browser',
    pattern: /\bsb_secret_[A-Za-z0-9_-]{8,}|(?:service[_-]?role[_-]?key)\s*[:=]\s*['"][^'"\s]{16,}['"]|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i,
    reason: 'This puts an elevated key value into code the browser loads. The service-role key belongs only in the Edge Function, where Supabase injects it server-side.'
  })
]);

const BROWSER_DELIVERED = Object.freeze(['src/', 'config/', 'vendor/']);

function isBrowserDelivered(relative) {
  if (!relative) return false;
  return relative === 'index.html' || BROWSER_DELIVERED.some(prefix => relative.startsWith(prefix));
}

// Where a rule can actually take effect. Prose and fixtures quoting these
// patterns — in docs/, tests/, or the harness that defines them — change no
// database and ship to no browser, so scoping is what keeps the rule credible
// instead of merely loud.
function ruleApplies(rule, relative) {
  if (rule.scope === 'browser') return isBrowserDelivered(relative);
  // Inline SQL in a command line is passed in as `inline-command.sql`, which
  // resolves inside the repository. A path outside the repository is not a
  // migration for this project and is left alone.
  if (rule.scope === 'sql') return Boolean(relative) && (relative.startsWith('supabase/') || relative.endsWith('.sql'));
  return true;
}

// Returns every rule the proposed content trips. Empty means nothing matched;
// it is not a claim that the content is correct, only that it is not one of
// the known ways to undo the security posture.
function classifySecurityContent(target, content, options = {}) {
  const relative = normalizeRepositoryPath(target, options.root || PROJECT_ROOT);
  const text = String(content === undefined || content === null ? '' : content);
  if (!text.trim()) return Object.freeze([]);
  const findings = SECURITY_CONTENT_RULES
    .filter(rule => ruleApplies(rule, relative))
    .filter(rule => rule.pattern.test(text))
    .map(rule => Object.freeze({ code: rule.code, reason: rule.reason, path: relative }));
  return Object.freeze(findings);
}

/* ==================== backlog ==================== */

function fail(code, message) {
  throw new ReleaseError(code, message, EXIT_BLOCKED);
}

function validateTask(raw, index, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('BACKLOG_TASK_INVALID', `Task at index ${index} is not an object.`);
  const id = String(raw.id || '');
  if (!TASK_ID.test(id)) fail('BACKLOG_TASK_ID_INVALID', `Task at index ${index} has an unusable id.`);
  if (seen.has(id)) fail('BACKLOG_TASK_DUPLICATE', `Task id ${id} appears more than once.`);
  seen.add(id);
  if (!Number.isInteger(raw.rank) || raw.rank < 1) fail('BACKLOG_TASK_RANK_INVALID', `Task ${id} must carry a positive integer rank.`);
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, raw.severity)) fail('BACKLOG_TASK_SEVERITY_INVALID', `Task ${id} has an unknown severity.`);
  if (!TASK_STATUSES.includes(raw.status)) fail('BACKLOG_TASK_STATUS_INVALID', `Task ${id} has an unknown status.`);
  if (!TASK_DECISIONS.includes(raw.decision)) fail('BACKLOG_TASK_DECISION_INVALID', `Task ${id} has an unknown decision state.`);
  if (!TASK_ACTIONABILITY.includes(raw.actionability)) fail('BACKLOG_TASK_ACTIONABILITY_INVALID', `Task ${id} has an unknown actionability.`);
  if (!String(raw.title || '').trim()) fail('BACKLOG_TASK_TITLE_MISSING', `Task ${id} has no title.`);
  const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [];
  if (dependsOn.includes(id)) fail('BACKLOG_TASK_SELF_DEPENDENCY', `Task ${id} depends on itself.`);
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(String) : [];
  if (!evidence.length) fail('BACKLOG_TASK_EVIDENCE_MISSING', `Task ${id} carries no evidence reference.`);

  const implementationCommits = raw.implementation && Array.isArray(raw.implementation.commits)
    ? raw.implementation.commits.map(String)
    : [];
  for (const commit of implementationCommits) {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) fail('BACKLOG_TASK_COMMIT_INVALID', `Task ${id} records an unusable commit id.`);
  }
  const criteria = Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [];
  const criterionIds = new Set();
  const acceptanceCriteria = criteria.map(criterion => {
    if (!criterion || typeof criterion !== 'object') fail('BACKLOG_CRITERION_INVALID', `Task ${id} has a malformed acceptance criterion.`);
    const criterionId = String(criterion.id || '');
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(criterionId)) fail('BACKLOG_CRITERION_ID_INVALID', `Task ${id} has an unusable acceptance criterion id.`);
    if (criterionIds.has(criterionId)) fail('BACKLOG_CRITERION_DUPLICATE', `Task ${id} repeats acceptance criterion ${criterionId}.`);
    criterionIds.add(criterionId);
    if (!String(criterion.statement || '').trim()) fail('BACKLOG_CRITERION_STATEMENT_MISSING', `Criterion ${criterionId} of task ${id} states nothing.`);
    if (!String(criterion.command || '').trim()) fail('BACKLOG_CRITERION_COMMAND_MISSING', `Criterion ${criterionId} of task ${id} names no command that could prove it.`);
    return Object.freeze({
      id: criterionId,
      statement: String(criterion.statement),
      command: String(criterion.command),
      classification: classifyCommand(String(criterion.command)).classification
    });
  });
  // `in-review` means "implemented, not proven". It must not be reachable
  // without both halves of that claim being recorded.
  if (raw.status === 'in-review' && !implementationCommits.length) {
    fail('BACKLOG_TASK_REVIEW_WITHOUT_IMPLEMENTATION', `Task ${id} is in review but records no implementation commit.`);
  }
  if (raw.status === 'in-review' && !acceptanceCriteria.length) {
    fail('BACKLOG_TASK_REVIEW_WITHOUT_CRITERIA', `Task ${id} is in review but states no acceptance criteria to prove.`);
  }

  return Object.freeze({
    id,
    rank: raw.rank,
    title: String(raw.title),
    severity: raw.severity,
    kind: String(raw.kind || 'task'),
    actionability: raw.actionability,
    status: raw.status,
    decision: raw.decision,
    decisionEvidence: String(raw.decisionEvidence || ''),
    releaseBlocking: Boolean(raw.releaseBlocking),
    workaround: raw.workaround === null || raw.workaround === undefined ? null : String(raw.workaround),
    implementation: Object.freeze({
      commits: Object.freeze(implementationCommits),
      branch: String(raw.implementation && raw.implementation.branch || ''),
      merged: Boolean(raw.implementation && raw.implementation.merged)
    }),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    dependsOn: Object.freeze(dependsOn),
    blocks: Object.freeze(Array.isArray(raw.blocks) ? raw.blocks.map(String) : []),
    evidence: Object.freeze(evidence),
    productionActions: Object.freeze(Array.isArray(raw.productionActions) ? raw.productionActions.map(String) : [])
  });
}

function detectDependencyCycles(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const state = new Map();
  const walk = (task, trail) => {
    const current = state.get(task.id);
    if (current === 'done') return;
    if (current === 'active') fail('BACKLOG_DEPENDENCY_CYCLE', `Dependency cycle: ${[...trail, task.id].join(' -> ')}.`);
    state.set(task.id, 'active');
    for (const dependency of task.dependsOn) walk(byId.get(dependency), [...trail, task.id]);
    state.set(task.id, 'done');
  };
  for (const task of tasks) walk(task, []);
}

function validateBacklog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('BACKLOG_INVALID', 'The backlog is not an object.');
  if (raw.schemaVersion !== SCHEMA_VERSION) fail('BACKLOG_SCHEMA_UNSUPPORTED', `Backlog schemaVersion must be ${SCHEMA_VERSION}.`);
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) fail('BACKLOG_EMPTY', 'The backlog contains no tasks.');
  const seen = new Set();
  const tasks = raw.tasks.map((task, index) => validateTask(task, index, seen));
  const ranks = new Set();
  for (const task of tasks) {
    if (ranks.has(task.rank)) fail('BACKLOG_RANK_DUPLICATE', `Rank ${task.rank} is used by more than one task.`);
    ranks.add(task.rank);
    for (const dependency of task.dependsOn) {
      if (!seen.has(dependency)) fail('BACKLOG_DEPENDENCY_UNKNOWN', `Task ${task.id} depends on unknown task ${dependency}.`);
    }
  }
  detectDependencyCycles(tasks);
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    title: String(raw.title || 'Release backlog'),
    updatedAt: String(raw.updatedAt || ''),
    orderingRules: Object.freeze(Array.isArray(raw.orderingRules) ? raw.orderingRules.map(String) : []),
    sources: Object.freeze(Array.isArray(raw.sources) ? raw.sources.map(String) : []),
    // Paths that exist in the working tree but are explicitly not release work.
    // Recording them is what stops an autonomous run from inventing a task out
    // of whatever `git status` happens to show.
    nonTasks: Object.freeze((Array.isArray(raw.nonTasks) ? raw.nonTasks : []).map(entry => Object.freeze({
      path: String(entry && entry.path || ''),
      reason: String(entry && entry.reason || '')
    }))),
    tasks: Object.freeze(tasks)
  });
}

function loadBacklog(deps, backlogPath) {
  const target = backlogPath || path.join(deps.repositoryRoot || PROJECT_ROOT, BACKLOG_RELATIVE);
  let raw;
  try {
    raw = deps.fs.readFileSync(target, 'utf8');
  } catch {
    fail('BACKLOG_UNREADABLE', `The release backlog is missing or unreadable at ${BACKLOG_RELATIVE}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail('BACKLOG_MALFORMED', `The release backlog is not valid JSON: ${error.message}`);
  }
  return validateBacklog(parsed);
}

// Every exclusion is recorded with its reason. A selection nobody can audit is
// not a selection, it is an assertion.
function excludeReason(task, byId) {
  if (task.status === 'done') return { code: 'ALREADY_DONE', detail: 'The task is recorded as done.' };
  // Accepted, not shipped. The task needs no further agent work, but its
  // production actions are still outstanding and only an operator can perform
  // them — so it is excluded from selection without being called done.
  if (task.status === 'accepted') {
    return { code: 'AWAITING_PRODUCTION', detail: 'A human accepted the task; its production actions remain outstanding and only an operator can perform them.' };
  }
  if (task.decision === 'rejected') return { code: 'DECISION_REJECTED', detail: 'The recorded decision rejects this task.' };
  if (task.decision !== 'approved') {
    return { code: 'DECISION_PENDING', detail: 'No approved decision is recorded, so an agent may not start it.' };
  }
  if (task.actionability !== 'internal') {
    return { code: 'EXTERNAL_DEPENDENCY', detail: 'The task needs an account, credential, or approval that no agent can obtain.' };
  }
  const unmet = task.dependsOn.filter(dependency => {
    const parent = byId.get(dependency);
    return !parent || parent.status !== 'done';
  });
  if (unmet.length) {
    return { code: 'DEPENDENCY_NOT_DONE', detail: `Blocked by ${unmet.join(', ')}.` };
  }
  return null;
}

// What an agent is being asked to do with the selected task. Derived from the
// existing status rather than from a new one: `in-review` already means the
// code exists and the claim does not, and that is exactly the difference
// between verifying and implementing.
function nextOperation(task) {
  if (!task) return null;
  if (task.status === 'in-review') return 'verify';
  if (task.status === 'open') return task.implementation.commits.length ? 'reconcile-state' : 'implement';
  // `accepted` and `done` both fall through: there is no agent operation left
  // on either. What remains for `accepted` is an operator's production work.
  return 'none';
}

function compareTasks(left, right) {
  const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (bySeverity !== 0) return bySeverity;
  const leftWorkaround = left.workaround ? 1 : 0;
  const rightWorkaround = right.workaround ? 1 : 0;
  if (leftWorkaround !== rightWorkaround) return leftWorkaround - rightWorkaround;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
}

function selectNextTask(backlog) {
  const byId = new Map(backlog.tasks.map(task => [task.id, task]));
  const eligible = [];
  const excluded = [];
  for (const task of backlog.tasks) {
    const reason = excludeReason(task, byId);
    if (reason) excluded.push(Object.freeze({ id: task.id, title: task.title, code: reason.code, detail: reason.detail }));
    else eligible.push(task);
  }
  // Sort a copy: the ordering must not depend on the order the file happened to
  // list the tasks in, and callers keep the validated backlog untouched.
  const ordered = eligible.slice().sort(compareTasks);
  const rankedIds = ordered.map(task => task.id);
  if (!ordered.length) {
    return Object.freeze({
      selected: null,
      selectionCode: 'NO_ELIGIBLE_TASK',
      operation: null,
      ordered: Object.freeze([]),
      rankedIds: Object.freeze([]),
      excluded: Object.freeze(excluded)
    });
  }
  const selected = ordered[0];
  const runnerUp = ordered[1] || null;
  return Object.freeze({
    selected,
    selectionCode: 'SELECTED',
    operation: nextOperation(selected),
    reason: Object.freeze({
      severity: `${selected.severity} is the highest open severity among eligible tasks.`,
      workaround: selected.workaround ? 'A workaround is documented.' : 'No workaround is documented, so the task blocks the release outright.',
      overRunnerUp: runnerUp
        ? `Ordered before ${runnerUp.id} by ${SEVERITY_ORDER[selected.severity] === SEVERITY_ORDER[runnerUp.severity] ? (selected.workaround === runnerUp.workaround ? 'rank' : 'the workaround rule') : 'severity'}.`
        : 'It is the only eligible task.'
    }),
    ordered: Object.freeze(ordered),
    rankedIds: Object.freeze(rankedIds),
    excluded: Object.freeze(excluded)
  });
}

/* ==================== approval records ==================== */

// The production gate opens only for a record the harness cannot write. This
// reader is deliberately strict and never creates, repairs, or defaults one.
function readApproval(deps, taskId, root) {
  const directory = path.join(root || deps.repositoryRoot || PROJECT_ROOT, APPROVAL_RELATIVE);
  const target = path.join(directory, `${taskId}.approval.json`);
  const relative = `${APPROVAL_RELATIVE}/${taskId}.approval.json`;
  let raw;
  try {
    raw = deps.fs.readFileSync(target, 'utf8');
  } catch {
    return Object.freeze({ present: false, valid: false, code: 'APPROVAL_ABSENT', path: relative });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ present: true, valid: false, code: 'APPROVAL_MALFORMED', path: relative });
  }
  const requiredFields = ['schemaVersion', 'taskId', 'approvedBy', 'approvedAt', 'scope', 'headSha'];
  const missing = requiredFields.filter(field => !String(parsed && parsed[field] || '').trim());
  if (parsed && parsed.schemaVersion !== SCHEMA_VERSION) {
    return Object.freeze({ present: true, valid: false, code: 'APPROVAL_SCHEMA_UNSUPPORTED', path: relative });
  }
  if (missing.length) {
    return Object.freeze({ present: true, valid: false, code: 'APPROVAL_INCOMPLETE', path: relative, missing: Object.freeze(missing) });
  }
  if (parsed.taskId !== taskId) {
    return Object.freeze({ present: true, valid: false, code: 'APPROVAL_TASK_MISMATCH', path: relative });
  }
  return Object.freeze({
    present: true,
    valid: true,
    code: 'APPROVAL_PRESENT',
    path: relative,
    approvedBy: String(parsed.approvedBy),
    approvedAt: String(parsed.approvedAt),
    headSha: String(parsed.headSha).toLowerCase()
  });
}

/* ==================== acceptance evidence ==================== */

// Evidence records what ran, against which commit, with which exit code. It is
// accepted only when it covers every stated criterion and names the HEAD that
// is actually checked out: a record written for another commit proves nothing
// about this one.
function readVerificationEvidence(deps, task, head, root, options = {}) {
  const relative = `${VERIFICATION_RELATIVE}/${task.id}.evidence.json`;
  const target = path.join(root || deps.repositoryRoot || PROJECT_ROOT, VERIFICATION_RELATIVE, `${task.id}.evidence.json`);
  let raw;
  try {
    raw = deps.fs.readFileSync(target, 'utf8');
  } catch {
    return Object.freeze({ present: false, verified: false, code: 'ACCEPTANCE_EVIDENCE_ABSENT', path: relative, unproven: task.acceptanceCriteria.map(criterion => criterion.id) });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ present: true, verified: false, code: 'ACCEPTANCE_EVIDENCE_MALFORMED', path: relative, unproven: Object.freeze([]) });
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || parsed.taskId !== task.id) {
    return Object.freeze({ present: true, verified: false, code: 'ACCEPTANCE_EVIDENCE_INVALID', path: relative, unproven: Object.freeze([]) });
  }
  const recordedHead = String(parsed.headSha || '').toLowerCase();
  if (head && recordedHead !== head) {
    // Evidence attests to product-relevant code, not to a commit id. Committing
    // the evidence itself moves HEAD, and refusing it for that reason alone
    // would make the record impossible to store. It stays valid while only
    // documentation, status, or release-governance paths changed since —
    // anything product-relevant makes it stale (isEvidenceDriftAllowed).
    const equivalent = typeof options.isCodeUnchangedSince === 'function' && options.isCodeUnchangedSince(recordedHead);
    if (!equivalent) {
      return Object.freeze({ present: true, verified: false, code: 'ACCEPTANCE_EVIDENCE_STALE', path: relative, headSha: recordedHead, unproven: Object.freeze([]) });
    }
  }
  const recorded = new Map((Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => [String(entry.id), entry]));
  const unproven = [];
  for (const criterion of task.acceptanceCriteria) {
    const entry = recorded.get(criterion.id);
    if (!entry || entry.status !== 'passed' || entry.exitCode !== 0) { unproven.push(criterion.id); continue; }
    // Bind the record to the criterion it claims to prove. Nothing here can
    // stop a determined fabrication — only a re-run can — but a bare
    // `{status: "passed"}` is an omission, and this makes it a statement.
    const command = String(entry.command || '').trim();
    const expected = criterion.command.trim();
    const sameCommand = command === expected
      || command.startsWith(expected.split(' <')[0])
      || expected.startsWith(command.split(' <')[0]);
    if (!command || !sameCommand || !String(entry.detail || '').trim()) unproven.push(criterion.id);
  }
  if (unproven.length) {
    return Object.freeze({ present: true, verified: false, code: 'ACCEPTANCE_CRITERIA_UNPROVEN', path: relative, unproven: Object.freeze(unproven) });
  }
  return Object.freeze({
    present: true,
    verified: true,
    code: 'ACCEPTANCE_VERIFIED',
    path: relative,
    headSha: recordedHead,
    recordedAt: String(parsed.recordedAt || ''),
    proven: Object.freeze(task.acceptanceCriteria.map(criterion => criterion.id)),
    unproven: Object.freeze([])
  });
}

/* ==================== dependency injection ==================== */

function defaultRunCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs || 30000,
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function createDeps(overrides = {}) {
  const deps = {
    fs: overrides.fs || fs,
    platform: overrides.platform || process.platform,
    env: overrides.env || process.env,
    now: overrides.now || (() => new Date()),
    streams: overrides.streams || process,
    repositoryRoot: overrides.repositoryRoot || PROJECT_ROOT
  };
  deps.runCommand = overrides.runCommand || defaultRunCommand;
  return deps;
}

/* ==================== execution ledger ==================== */

// Every command the harness itself runs is classified before it runs and
// recorded after. The ledger is what makes "no production action was executed"
// a checked claim rather than a promise.
function createLedger(deps) {
  const entries = [];
  return {
    entries,
    run(file, args, options = {}) {
      const display = [file, ...args].join(' ');
      const classification = classifyCommand(display);
      if (classification.classification !== READ_ONLY) {
        throw new ReleaseError(
          'PRODUCTION_ACTION_ATTEMPTED',
          `The harness refused to execute a non read-only command (${classification.classification} via ${classification.rule}): ${display}`,
          EXIT_INTERNAL
        );
      }
      const result = deps.runCommand(file, args, {
        cwd: options.cwd || deps.repositoryRoot,
        timeoutMs: options.timeoutMs || 30000
      });
      entries.push(Object.freeze({
        command: display,
        classification: classification.classification,
        rule: classification.rule,
        exitCode: result && typeof result.status === 'number' ? result.status : null
      }));
      return result;
    }
  };
}

/* ==================== gate ladder ==================== */

// The ladder is data. Its shape — read-only rungs first, one production rung
// last that nothing in this file can execute — is the whole safety argument.
function createGateLadder() {
  return Object.freeze([
    Object.freeze({
      id: 'G0-context',
      name: 'Repository context',
      classification: READ_ONLY,
      executor: 'harness',
      purpose: 'Confirm repository identity, branch, HEAD, and working-tree state before anything reads policy from it.',
      delegatedCommands: Object.freeze([])
    }),
    Object.freeze({
      id: 'G1-backlog',
      name: 'Backlog validation and task selection',
      classification: READ_ONLY,
      executor: 'harness',
      purpose: 'Validate release/backlog.json and select exactly one next task with a recorded reason for every exclusion.',
      delegatedCommands: Object.freeze([])
    }),
    Object.freeze({
      id: 'G2-documents',
      name: 'Governance documents',
      classification: READ_ONLY,
      executor: 'harness',
      purpose: 'Refuse to plan a release while any required governance document is missing or empty.',
      delegatedCommands: Object.freeze([])
    }),
    Object.freeze({
      id: 'G3-static',
      name: 'Static and unit gates',
      classification: READ_ONLY,
      executor: 'orchestrator',
      purpose: 'The repository-owned pull-request gate ladder: tests, syntax, secrets, migrations, project status.',
      delegatedCommands: Object.freeze([
        'npm test',
        'npm run check:js',
        'npm run check:secrets',
        'npm run check:migrations',
        'npm run check:project-status'
      ])
    }),
    Object.freeze({
      id: 'G4-artifact',
      name: 'Deterministic artifact verification',
      classification: LOCAL_WRITE,
      executor: 'operator',
      purpose: 'Two independent Pages builds, byte comparison, independent validation, and an artifact secret-shape scan. It writes into artifacts/, so the orchestrator never runs it.',
      delegatedCommands: Object.freeze(['npm run verify:release'])
    }),
    Object.freeze({
      id: 'G5-runtime',
      name: 'Local runtime verification',
      classification: READ_ONLY,
      executor: 'operator',
      purpose: 'Non-destructive local runtime checks against a running local Supabase stack. It needs Docker and a started stack, and the harness never starts either.',
      delegatedCommands: Object.freeze(['npm run verify:runtime'])
    }),
    Object.freeze({
      id: 'G5b-acceptance',
      name: 'Acceptance evidence for the selected task',
      classification: READ_ONLY,
      executor: 'harness',
      purpose: 'Read the recorded verification evidence and refuse to call the selected task verified unless every stated acceptance criterion passed against this exact HEAD.',
      delegatedCommands: Object.freeze([])
    }),
    Object.freeze({
      id: 'G6-approval',
      name: 'Human production approval',
      classification: READ_ONLY,
      executor: 'harness',
      purpose: 'Read — never write — a signed approval record for the selected task. Absence is the expected steady state.',
      delegatedCommands: Object.freeze([])
    }),
    Object.freeze({
      id: 'G7-production',
      name: 'Production gate',
      classification: PRODUCTION,
      executor: 'operator',
      purpose: 'The boundary. Everything beyond it is performed by an operator following docs/release-plan.md.',
      delegatedCommands: Object.freeze([
        'npx supabase db push',
        'npx supabase functions deploy team-management',
        'publish artifacts/pages-site/ to the chosen host',
        'git tag -a <version> -m <version>',
        'git push origin <version>'
      ])
    })
  ]);
}

/* ==================== gate evaluation ==================== */

function gateResult(gate, status, summary, extra = {}) {
  return Object.freeze({
    id: gate.id,
    name: gate.name,
    classification: gate.classification,
    status,
    summary: bounded(summary),
    ...extra
  });
}

function evaluateContext(gate, context) {
  const { ledger, deps } = context;
  const root = deps.repositoryRoot;
  let packageName = null;
  try {
    packageName = JSON.parse(deps.fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  } catch {
    return gateResult(gate, STATUS_BLOCKED, 'package.json is missing or unreadable, so repository identity cannot be established.', { failureCode: 'REPOSITORY_IDENTITY_INVALID' });
  }
  if (packageName !== PACKAGE_NAME) {
    return gateResult(gate, STATUS_BLOCKED, `Expected package ${PACKAGE_NAME}.`, { failureCode: 'REPOSITORY_IDENTITY_INVALID' });
  }
  const branchResult = ledger.run('git', ['branch', '--show-current']);
  const headResult = ledger.run('git', ['rev-parse', 'HEAD']);
  const statusResult = ledger.run('git', ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (!headResult || headResult.status !== 0) {
    return gateResult(gate, STATUS_BLOCKED, 'Git HEAD is unavailable.', { failureCode: 'GIT_HEAD_UNAVAILABLE' });
  }
  const branch = String(branchResult && branchResult.stdout || '').trim() || 'HEAD';
  const head = String(headResult.stdout || '').trim().toLowerCase();
  const changes = String(statusResult && statusResult.stdout || '').split(/\r?\n/).filter(Boolean);
  const untracked = changes.filter(line => line.startsWith('??'));
  context.state.repository = Object.freeze({
    root,
    branch,
    head,
    trackedChanges: changes.length - untracked.length,
    untrackedChanges: untracked.length
  });
  return gateResult(gate, STATUS_PASSED, `${branch} @ ${head}. Tracked changes: ${changes.length - untracked.length}. Untracked paths: ${untracked.length}.`, {
    facts: context.state.repository
  });
}

function evaluateBacklog(gate, context) {
  let backlog;
  try {
    backlog = loadBacklog(context.deps, context.options.backlogPath);
  } catch (error) {
    return gateResult(gate, STATUS_BLOCKED, error.message, { failureCode: error.code || 'BACKLOG_INVALID' });
  }
  const selection = selectNextTask(backlog);
  context.state.backlog = backlog;
  context.state.selection = selection;
  if (!selection.selected) {
    return gateResult(gate, STATUS_BLOCKED, 'No backlog task is eligible for an autonomous agent.', {
      failureCode: 'NO_ELIGIBLE_TASK',
      excluded: selection.excluded
    });
  }

  // Guard against the failure this harness is most likely to cause on its own:
  // re-implementing work that already exists because the backlog was not
  // updated when the commits landed. Recorded commits are checked against the
  // repository, and a task claiming to be unstarted while its implementation is
  // present stops the run.
  const stale = [];
  const missing = [];
  for (const task of backlog.tasks) {
    if (!task.implementation.commits.length) continue;
    const resolved = task.implementation.commits.every(commit => {
      const result = context.ledger.run('git', ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
      return Boolean(result && result.status === 0);
    });
    if (resolved && task.status === 'open') stale.push(task.id);
    if (!resolved && task.status === 'in-review') missing.push(task.id);
  }
  if (stale.length) {
    return gateResult(gate, STATUS_BLOCKED, `Stale task state: ${stale.join(', ')} record implementation commits that exist in this repository but are still marked open. Reconcile the backlog before selecting work, or the harness will schedule a re-implementation.`, {
      failureCode: 'TASK_STATE_STALE',
      staleTaskIds: Object.freeze(stale)
    });
  }
  if (missing.length) {
    return gateResult(gate, STATUS_BLOCKED, `Tasks ${missing.join(', ')} are in review but their recorded implementation commits are not reachable here.`, {
      failureCode: 'TASK_IMPLEMENTATION_MISSING',
      missingTaskIds: Object.freeze(missing)
    });
  }

  const selected = selection.selected;
  const operation = selection.operation;
  const detail = operation === 'verify'
    ? `Implementation exists at ${selected.implementation.commits.join(', ')}; ${selected.acceptanceCriteria.length} acceptance criteria are unproven. The next operation is verification, not implementation.`
    : 'The next operation is implementation.';
  return gateResult(gate, STATUS_PASSED, `Selected ${selected.id} — ${selected.title}. Operation: ${operation}. ${detail}`, {
    selectedTaskId: selected.id,
    operation,
    rankedIds: selection.rankedIds,
    excluded: selection.excluded
  });
}

function evaluateAcceptance(gate, context) {
  const selection = context.state.selection;
  if (!selection || !selection.selected) {
    return gateResult(gate, STATUS_BLOCKED, 'No task was selected, so no acceptance evidence applies.', { failureCode: 'NO_SELECTED_TASK' });
  }
  const task = selection.selected;
  if (!task.acceptanceCriteria.length) {
    return gateResult(gate, STATUS_PLANNED, `${task.id} states no acceptance criteria; there is nothing for this gate to prove.`, {});
  }
  const head = context.state.repository ? context.state.repository.head : null;
  // Evidence is pinned to the product-relevant code tree, not to the literal
  // commit id. Every path that differs between the recorded commit and the one
  // being judged must be drift-allowed (documentation, status, harness,
  // evidence storage) — any product-relevant path makes it stale.
  const isCodeUnchangedSince = recordedHead => {
    if (!/^[0-9a-f]{7,40}$/.test(recordedHead)) return false;
    const diff = context.ledger.run('git', ['diff', '--name-only', recordedHead, head]);
    if (!diff || diff.status !== 0) return false;
    const changed = String(diff.stdout || '').split(/\r?\n/).filter(Boolean);
    return changed.every(file => isEvidenceDriftAllowed(file));
  };

  // Commits are not the whole story: an uncommitted edit is code the evidence
  // never saw. A tracked modification to a product-relevant path invalidates it
  // just as a differing commit does; a drift-allowed path does not.
  const dirty = context.ledger.run('git', ['status', '--porcelain=v1', '--untracked-files=no']);
  const dirtyPaths = String(dirty && dirty.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(3).replace(/\\/g, '/').split(' -> ').pop())
    .filter(file => !isEvidenceDriftAllowed(file));
  if (dirtyPaths.length) {
    return gateResult(gate, STATUS_BLOCKED, `${task.id} cannot be called verified while tracked files are modified but uncommitted: ${dirtyPaths.slice(0, 10).join(', ')}. The evidence attests to committed code.`, {
      failureCode: 'ACCEPTANCE_WORKTREE_DIRTY',
      dirtyPaths: Object.freeze(dirtyPaths)
    });
  }
  const evidence = readVerificationEvidence(context.deps, task, head, context.deps.repositoryRoot, { isCodeUnchangedSince });
  context.state.acceptance = evidence;
  const commands = task.acceptanceCriteria.map(criterion => Object.freeze({
    command: criterion.command,
    classification: criterion.classification,
    executor: 'verifier'
  }));
  if (!evidence.verified) {
    return gateResult(gate, STATUS_BLOCKED, `${task.id} is not verified (${evidence.code} at ${evidence.path}). Unproven criteria: ${evidence.unproven.length ? evidence.unproven.join(', ') : 'all'}.`, {
      failureCode: evidence.code,
      evidencePath: evidence.path,
      unproven: evidence.unproven,
      commands: Object.freeze(commands)
    });
  }
  const provenance = evidence.headSha === head
    ? `against ${head}`
    : `against ${evidence.headSha}, still current at ${head} because only documentation, status, or release-governance paths changed since`;
  return gateResult(gate, STATUS_PASSED, `${task.id} is verified ${provenance}: ${evidence.proven.length} acceptance criteria proven, recorded ${evidence.recordedAt}.`, {
    evidencePath: evidence.path,
    commands: Object.freeze(commands)
  });
}

function evaluateDocuments(gate, context) {
  const { deps } = context;
  const missing = [];
  const present = [];
  for (const relative of REQUIRED_DOCUMENTS) {
    const target = path.join(deps.repositoryRoot, relative.split('/').join(path.sep));
    let content = '';
    try {
      content = deps.fs.readFileSync(target, 'utf8');
    } catch {
      missing.push(relative);
      continue;
    }
    if (!content.trim()) missing.push(relative);
    else present.push(relative);
  }
  if (missing.length) {
    return gateResult(gate, STATUS_BLOCKED, `Missing or empty governance documents: ${missing.join(', ')}.`, {
      failureCode: 'GOVERNANCE_DOCUMENT_MISSING',
      missing: Object.freeze(missing)
    });
  }
  return gateResult(gate, STATUS_PASSED, `All ${present.length} required governance documents are present and non-empty.`, {
    documents: Object.freeze(present)
  });
}

// A delegated gate is owned by an existing repository command. This module
// never spawns one: it publishes the exact command with its classification and
// names the executor. Keeping execution out of the planner is what lets the
// planner stay unconditionally read-only.
function delegatedGate(gate, context) {
  const commands = gate.delegatedCommands.map(command => {
    const classification = classifyCommand(command).classification;
    const authorized = gate.executor === 'orchestrator' && classification === READ_ONLY && context.options.mode === 'verify';
    return Object.freeze({ command, classification, executor: authorized ? 'orchestrator' : 'operator' });
  });
  const authorized = commands.filter(entry => entry.executor === 'orchestrator');
  context.state.executionPlan = (context.state.executionPlan || []).concat(
    authorized.map(entry => Object.freeze({ gate: gate.id, command: entry.command, classification: entry.classification }))
  );
  const summary = context.options.mode === 'verify' && authorized.length
    ? `${authorized.length} read-only command(s) authorized for the orchestrator; the planner executes none of them.`
    : `Not executed. ${commands.length} command(s) recorded for the operator.`;
  return gateResult(gate, STATUS_PLANNED, summary, { commands: Object.freeze(commands) });
}

function evaluateApproval(gate, context) {
  const selection = context.state.selection;
  if (!selection || !selection.selected) {
    return gateResult(gate, STATUS_BLOCKED, 'No task was selected, so no approval can apply.', { failureCode: 'NO_SELECTED_TASK' });
  }
  const approval = readApproval(context.deps, selection.selected.id, context.deps.repositoryRoot);
  context.state.approval = approval;
  if (!approval.valid) {
    return gateResult(gate, STATUS_BLOCKED, `No valid production approval for ${selection.selected.id} (${approval.code} at ${approval.path}). The harness never writes this record.`, {
      failureCode: approval.code,
      approvalPath: approval.path
    });
  }
  const head = context.state.repository ? context.state.repository.head : null;
  if (head && approval.headSha !== head) {
    return gateResult(gate, STATUS_BLOCKED, `The approval for ${selection.selected.id} names a different HEAD than the one verified.`, {
      failureCode: 'APPROVAL_HEAD_MISMATCH',
      approvalPath: approval.path
    });
  }
  return gateResult(gate, STATUS_PASSED, `A valid approval for ${selection.selected.id} is recorded at ${approval.path}.`, {
    approvalPath: approval.path
  });
}

function evaluateProduction(gate, context) {
  const selection = context.state.selection;
  const approval = context.state.approval;
  const taskActions = selection && selection.selected ? selection.selected.productionActions : [];
  // Membership in the production gate is itself the classification: everything
  // listed here is a production action whether or not it is a runnable command
  // line. The classifier's own reading is kept beside it for auditing.
  const refused = [...gate.delegatedCommands, ...taskActions].map(action => Object.freeze({
    action,
    classification: PRODUCTION,
    recognizedAs: classifyCommand(action).classification,
    executed: false
  }));
  const reasons = [
    'The harness contains no code path that performs a production action; the ladder ends here by construction.'
  ];
  if (!approval || !approval.valid) {
    reasons.push(`No valid human approval record exists for ${selection && selection.selected ? selection.selected.id : 'the selected task'}.`);
  } else {
    reasons.push('An approval record exists, and executing it is still an operator action performed outside this harness.');
  }
  return gateResult(gate, STATUS_HALTED, 'HALTED AT PRODUCTION GATE. No production action was executed.', {
    failureCode: 'HALTED_AT_PRODUCTION_GATE',
    reasons: Object.freeze(reasons),
    refusedActions: Object.freeze(refused)
  });
}

const GATE_EVALUATORS = Object.freeze({
  'G0-context': evaluateContext,
  'G1-backlog': evaluateBacklog,
  'G2-documents': evaluateDocuments,
  'G3-static': delegatedGate,
  'G4-artifact': delegatedGate,
  'G5-runtime': delegatedGate,
  'G5b-acceptance': evaluateAcceptance,
  'G6-approval': evaluateApproval,
  'G7-production': evaluateProduction
});

function skippedGate(gate, blockingGateId) {
  return gateResult(gate, STATUS_BLOCKED, `Not evaluated because ${blockingGateId} did not pass.`, { failureCode: 'UPSTREAM_GATE_BLOCKED' });
}

/* ==================== run ==================== */

function runRelease(options, overrides = {}) {
  const deps = createDeps(overrides);
  const mode = MODES.includes(options && options.mode) ? options.mode : 'simulate';
  const startedAt = deps.now();
  const ledger = createLedger(deps);
  const context = { options: { ...options, mode }, deps, ledger, state: {} };
  const ladder = createGateLadder();
  const gates = [];
  let blocking = null;
  let internalError = null;

  for (const gate of ladder) {
    if (blocking && gate.id !== 'G7-production') {
      gates.push(skippedGate(gate, blocking.id));
      continue;
    }
    const evaluator = GATE_EVALUATORS[gate.id];
    let outcome;
    try {
      outcome = evaluator(gate, context);
    } catch (error) {
      if (error instanceof ReleaseError && error.code === 'PRODUCTION_ACTION_ATTEMPTED') internalError = error;
      outcome = gateResult(gate, STATUS_FAILED, error && error.message || 'Gate evaluation failed.', {
        failureCode: error instanceof ReleaseError ? error.code : 'GATE_INTERNAL_ERROR'
      });
    }
    gates.push(outcome);
    // G6 reports; it never decides the run status. A missing approval is the
    // normal steady state, and the terminal event of every run is the halt at
    // G7 rather than the absence of a record the harness may not write.
    if (gate.id === 'G6-approval') continue;
    if ([STATUS_BLOCKED, STATUS_FAILED].includes(outcome.status) && !blocking) blocking = outcome;
  }

  const completedAt = deps.now();
  const selection = context.state.selection || null;
  const approvalGate = gates.find(gate => gate.id === 'G6-approval');
  const production = gates.find(gate => gate.id === 'G7-production');
  const executed = Object.freeze(ledger.entries.slice());
  const nonReadOnly = executed.filter(entry => entry.classification !== READ_ONLY);

  let status = STATUS_HALTED;
  let exitCode = EXIT_HALTED;
  let failureCode = 'HALTED_AT_PRODUCTION_GATE';
  if (internalError) {
    status = STATUS_FAILED;
    exitCode = EXIT_INTERNAL;
    failureCode = internalError.code;
  } else if (nonReadOnly.length) {
    status = STATUS_FAILED;
    exitCode = EXIT_INTERNAL;
    failureCode = 'PRODUCTION_ACTION_ATTEMPTED';
  } else if (blocking) {
    status = blocking.status === STATUS_FAILED ? STATUS_FAILED : STATUS_BLOCKED;
    exitCode = blocking.status === STATUS_FAILED ? EXIT_VALIDATION : EXIT_BLOCKED;
    failureCode = blocking.failureCode || 'GATE_BLOCKED';
  }

  const result = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    harnessVersion: HARNESS_VERSION,
    mode,
    status,
    repository: context.state.repository || null,
    selectedTask: selection && selection.selected ? Object.freeze({
      id: selection.selected.id,
      title: selection.selected.title,
      severity: selection.selected.severity,
      status: selection.selected.status,
      operation: selection.operation,
      implementation: selection.selected.implementation,
      acceptanceCriteria: selection.selected.acceptanceCriteria,
      releaseBlocking: selection.selected.releaseBlocking,
      evidence: selection.selected.evidence,
      productionActions: selection.selected.productionActions,
      reason: selection.reason || null
    }) : null,
    acceptance: Object.freeze({
      code: context.state.acceptance ? context.state.acceptance.code : null,
      verified: Boolean(context.state.acceptance && context.state.acceptance.verified),
      path: context.state.acceptance ? context.state.acceptance.path : null,
      unproven: context.state.acceptance ? context.state.acceptance.unproven : Object.freeze([])
    }),
    rankedIds: selection ? selection.rankedIds : Object.freeze([]),
    excluded: selection ? selection.excluded : Object.freeze([]),
    approval: Object.freeze({
      status: approvalGate ? approvalGate.status : null,
      code: context.state.approval ? context.state.approval.code : null,
      path: context.state.approval ? context.state.approval.path : null,
      valid: Boolean(context.state.approval && context.state.approval.valid)
    }),
    gates: Object.freeze(gates),
    executionPlan: Object.freeze(context.state.executionPlan || []),
    executedCommands: executed,
    // Derived from the ledger, never asserted: this is the number the
    // orchestrator cross-checks, so a literal 0 would make the check vacuous.
    productionActionsExecuted: executed.filter(entry => entry.classification !== READ_ONLY).length,
    refusedProductionActions: production && production.refusedActions ? production.refusedActions : Object.freeze([]),
    haltedAtGate: production ? production.id : null,
    failureCode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime())
  });

  return Object.freeze({ exitCode, result: redactDeep(result) });
}

/* ==================== human output ==================== */

function formatHuman(result) {
  const lines = [
    'Autonomous release harness',
    `Harness version: ${result.harnessVersion} (schema ${result.schemaVersion})`,
    `Mode: ${result.mode}`,
    `Repository: ${result.repository ? `${result.repository.branch} @ ${result.repository.head}` : 'unavailable'}`,
    `Started: ${result.startedAt}`,
    ''
  ];

  lines.push('== Task selection ==');
  if (result.selectedTask) {
    lines.push(`NEXT TASK: ${result.selectedTask.id} — ${result.selectedTask.title}`);
    lines.push(`NEXT OPERATION: ${String(result.selectedTask.operation || 'unknown').toUpperCase()}`);
    lines.push(`  Status: ${result.selectedTask.status}${result.selectedTask.implementation.commits.length ? `; implemented at ${result.selectedTask.implementation.commits.join(', ')}` : ''}`);
    lines.push(`  Severity: ${result.selectedTask.severity}${result.selectedTask.releaseBlocking ? ' (release blocking)' : ''}`);
    if (result.selectedTask.reason) {
      lines.push(`  Why: ${result.selectedTask.reason.severity}`);
      lines.push(`       ${result.selectedTask.reason.workaround}`);
      lines.push(`       ${result.selectedTask.reason.overRunnerUp}`);
    }
    lines.push(`  Eligible order: ${result.rankedIds.join(' > ')}`);
  } else {
    lines.push('NEXT TASK: none selected.');
  }
  if (result.excluded.length) {
    lines.push('  Excluded:');
    for (const entry of result.excluded) lines.push(`    ${entry.id}: ${entry.code} — ${entry.detail}`);
  }
  lines.push('');

  lines.push('== Gate ladder ==');
  for (const gate of result.gates) {
    lines.push(`[${gate.status.toUpperCase()}] ${gate.id} ${gate.name} (${gate.classification})`);
    for (const line of String(gate.summary || '').split('\n')) lines.push(`    ${line}`);
    if (Array.isArray(gate.commands)) {
      for (const entry of gate.commands) {
        lines.push(`    - ${entry.command}${entry.classification ? ` [${entry.classification}]` : ''}${entry.exitCode === undefined ? '' : ` exit ${entry.exitCode}`}`);
      }
    }
    if (Array.isArray(gate.reasons)) for (const reason of gate.reasons) lines.push(`    * ${reason}`);
  }
  lines.push('');

  if (result.executionPlan && result.executionPlan.length) {
    lines.push('== Read-only commands authorized for the orchestrator ==');
    for (const entry of result.executionPlan) lines.push(`    ${entry.gate}: ${entry.command} [${entry.classification}]`);
    lines.push('');
  }

  lines.push('== Commands executed by the planner ==');
  if (!result.executedCommands.length) lines.push('    none');
  for (const entry of result.executedCommands) {
    lines.push(`    [${entry.classification}] ${entry.command} (exit ${entry.exitCode})`);
  }
  lines.push('');

  lines.push('== Production actions refused ==');
  if (!result.refusedProductionActions.length) lines.push('    none recorded');
  for (const entry of result.refusedProductionActions) {
    lines.push(`    NOT EXECUTED ${entry.action}`);
  }
  lines.push('');
  lines.push(`Acceptance: ${result.acceptance.verified ? `verified at ${result.acceptance.path}` : `${result.acceptance.code || 'not evaluated'}${result.acceptance.unproven.length ? ` — unproven: ${result.acceptance.unproven.join(', ')}` : ''}`}`);
  lines.push(`Approval: ${result.approval.valid ? `present at ${result.approval.path}` : `${result.approval.code || 'unavailable'} (expected; the harness never writes it)`}`);
  lines.push(`Production actions executed: ${result.productionActionsExecuted}`);
  lines.push(`Completed: ${result.completedAt} (${result.durationMs} ms)`);
  lines.push(`Result: ${result.status.toUpperCase()} — ${result.failureCode}`);
  return redact(lines.join('\n'));
}

module.exports = Object.freeze({
  APPROVAL_RELATIVE,
  BACKLOG_RELATIVE,
  VERIFICATION_RELATIVE,
  nextOperation,
  readVerificationEvidence,
  CLASSIFICATIONS,
  DESTRUCTIVE,
  EXIT_BLOCKED,
  EXIT_HALTED,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VALIDATION,
  HARNESS_VERSION,
  LOCAL_WRITE,
  MODES,
  PACKAGE_NAME,
  PRODUCTION,
  PROJECT_ROOT,
  READ_ONLY,
  REQUIRED_DOCUMENTS,
  ReleaseError,
  SCHEMA_VERSION,
  SEVERITY_ORDER,
  STATUS_BLOCKED,
  STATUS_FAILED,
  STATUS_HALTED,
  STATUS_PASSED,
  STATUS_PLANNED,
  UNKNOWN,
  SECURITY_CONTENT_RULES,
  EVIDENCE_DRIFT_ALLOWED_PREFIXES,
  EVIDENCE_DRIFT_ALLOWED_FILES,
  classifyCommand,
  classifyPath,
  classifySecurityContent,
  isBrowserDelivered,
  isEvidenceDriftAllowed,
  compareTasks,
  createDeps,
  createGateLadder,
  createLedger,
  formatHuman,
  isReadOnlyCommand,
  loadBacklog,
  normalizeRepositoryPath,
  readApproval,
  redact,
  redactDeep,
  runRelease,
  selectNextTask,
  usageError,
  validateBacklog
});

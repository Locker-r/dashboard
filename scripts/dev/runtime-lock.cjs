'use strict';

// M-2B2b: a thin CLI bridge so a PowerShell entry point can acquire/release
// the same shared advisory runtime lock verify.cjs's runtime-smoke-reset
// stage uses (M-2B2a) — for the destructive entry points that stage does not
// itself wrap: `npm run smoke` (scripts/dev/smoke.ps1), invoked directly
// rather than through `verify:runtime`.
//
// Not a new lock implementation: this requires verify.cjs and
// automation-core.cjs and calls their unchanged acquireRuntimeLock,
// releaseRuntimeLock, and resolveRuntimeLockFamilyRoot exactly as they
// already exist. See docs/decisions.md ADR-012.

const automationCore = require('./automation-core.cjs');
const verify = require('./verify.cjs');

const USAGE = [
  'Usage: node scripts/dev/runtime-lock.cjs <acquire|release> --operation <name> [options]',
  '',
  'Commands:',
  '  acquire   Acquire the named shared runtime lock. Prints {path, token} as JSON on success.',
  '  release   Release a lock previously acquired by this tool.',
  '',
  'Options:',
  '  --operation <name>   database-reset | runtime-smoke | smoke-provisioning.',
  '  --owner <text>        Free-text owner label recorded on the lock (acquire only).',
  '  --path <path>         The lock file path acquire printed (release only).',
  '  --token <token>       The token acquire printed (release only).',
  '  --json                 (acquire) same as the default; kept for symmetry with other tools.',
  '  --help, -h             Show this help.',
  '',
  'Exit codes: 0 ok, 2 refused (collision, stale claim, or a missing/invalid argument',
  'to release), 64 usage.',
  '',
  'Never steals a live lock, never waits, never retries, and never auto-clears',
  'a stale or malformed claim — the same fail-closed behaviour verify.cjs uses.'
].join('\n');

function parseArgs(argv) {
  const input = Array.from(argv || []);
  if (input[0] === '--help' || input[0] === '-h') return { help: true, command: null };
  const command = input.shift();
  if (!['acquire', 'release'].includes(command)) {
    throw automationCore.usageError('COMMAND_INVALID', `Unknown command ${automationCore.quoteUntrusted(String(command))}.`);
  }
  const options = { help: false, command, operation: null, owner: null, path: null, token: null };
  while (input.length) {
    const argument = input.shift();
    if (argument === '--operation') options.operation = input.shift();
    else if (argument === '--owner') options.owner = input.shift();
    else if (argument === '--path') options.path = input.shift();
    else if (argument === '--token') options.token = input.shift();
    else if (argument === '--json') { /* accepted for symmetry; output is already JSON */ }
    else throw automationCore.usageError('OPTION_INVALID', `Unknown option ${automationCore.quoteUntrusted(String(argument))}.`);
  }
  if (!options.operation) throw automationCore.usageError('OPERATION_REQUIRED', '--operation is required.');
  return options;
}

async function runAcquire(options, deps, streams) {
  const context = { repository: { root: process.cwd() }, deps };
  const familyRoot = await verify.resolveRuntimeLockFamilyRoot(context);
  const lock = automationCore.acquireRuntimeLock(deps, familyRoot, options.operation, {
    ownerWorktree: options.owner || process.cwd()
  });
  streams.stdout.write(`${JSON.stringify({ path: lock.path, token: lock.token, operation: lock.operation }, null, 2)}\n`);
  return automationCore.EXIT_OK;
}

async function runRelease(options, deps, streams) {
  if (!options.path || !options.token) {
    throw automationCore.usageError('RELEASE_ARGUMENTS_REQUIRED', '--path and --token are both required for release.');
  }
  const result = automationCore.releaseRuntimeLock(deps, null, { path: options.path, token: options.token });
  streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // A lock this tool cannot verify ownership of (foreign or malformed) is
  // preserved, not an error: refusing to release something you may not own
  // is the fail-closed choice, but it must still be visible to the caller.
  return automationCore.EXIT_OK;
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const streams = overrides.streams || process;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.stderr.write(`[${error.code || 'USAGE_ERROR'}] ${automationCore.redact(error.message)}\n\n${USAGE}\n`);
    return automationCore.EXIT_USAGE;
  }
  if (options.help) {
    streams.stdout.write(`${USAGE}\n`);
    return automationCore.EXIT_OK;
  }
  const deps = overrides.deps || automationCore.createDeps({ repositoryRoot: process.cwd() });
  try {
    if (options.command === 'acquire') return await runAcquire(options, deps, streams);
    return await runRelease(options, deps, streams);
  } catch (error) {
    const known = error instanceof automationCore.AutomationError;
    streams.stderr.write(`[${known ? error.code : 'INTERNAL_ORCHESTRATION_FAILURE'}] ${automationCore.redact(error.message)}\n`);
    if (error.remediation) streams.stderr.write(`Remediation: ${automationCore.redact(error.remediation)}\n`);
    return known ? error.exitCode : automationCore.EXIT_INTERNAL;
  }
}

module.exports = { USAGE, parseArgs, runAcquire, runRelease, main };

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`runtime-lock failed [INTERNAL_ORCHESTRATION_FAILURE]: ${automationCore.redact(error && error.stack || error)}\n`);
    process.exitCode = automationCore.EXIT_INTERNAL;
  });
}

#!/usr/bin/env node
'use strict';

// Scoped staging Edge Function secret wrapper.
//
// This is the ONLY authorized path to `supabase secrets set` in this
// repository, and it is authorized for exactly one project and exactly one
// secret name and value: `TEAM_ALLOWED_ORIGIN`, pinned to the approved
// staging Pages URL. See docs/release-gates.md, "The scoped exception:
// staging team-management CORS origin".
//
// Why this exists: supabase/functions/team-management/index.ts refuses
// every browser call whose Origin header does not exactly equal
// TEAM_ALLOWED_ORIGIN (returning 403 ORIGIN_FORBIDDEN on the CORS
// preflight). Confirmed against the live staging function on 2026-08-07:
// `curl -X OPTIONS https://cjdxtakgmnzwixrajjry.supabase.co/functions/v1/team-management
// -H "Origin: https://locker-r.github.io"` returned 403 ORIGIN_FORBIDDEN,
// meaning the secret is unset or set to something else. Until it is set to
// the exact staging Pages URL, the admin cashier-management flow cannot
// work from the deployed staging site at all — this is a configuration gap,
// not a code defect; the function's origin check is correct.
//
// Every constant here is pinned on purpose. A different project ref, secret
// name, or value is not a configuration change — it is a different
// authorization, and it needs its own reviewed change.

const { spawnSync } = require('node:child_process');

const TARGET = Object.freeze({
  projectRef: 'cjdxtakgmnzwixrajjry',
  environment: 'staging',
  secretName: 'TEAM_ALLOWED_ORIGIN',
  secretValue: 'https://locker-r.github.io'
});

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });

const USAGE = 'usage: node scripts/release/staging-team-origin-config.cjs (--dry-run | --apply)';

function parseMode(argv) {
  const flags = argv.filter(argument => argument.startsWith('-'));
  const positional = argv.filter(argument => !argument.startsWith('-'));
  if (positional.length) return { error: `unexpected argument: ${positional[0]}` };
  if (flags.length !== 1) return { error: 'exactly one of --dry-run or --apply is required' };
  if (flags[0] === '--dry-run') return { mode: 'dry-run' };
  if (flags[0] === '--apply') return { mode: 'apply' };
  return { error: `unsupported flag: ${flags[0]}` };
}

function checkEnvironment(env) {
  const problems = [];
  if (env.GITHUB_ACTIONS !== 'true') {
    problems.push('GITHUB_ACTIONS is not "true": this wrapper runs in CI only, never on a workstation');
  }
  if (env.RELEASE_ENVIRONMENT !== TARGET.environment) {
    problems.push(`RELEASE_ENVIRONMENT is not "${TARGET.environment}"`);
  }
  if (!env.SUPABASE_ACCESS_TOKEN) {
    problems.push('SUPABASE_ACCESS_TOKEN is not set in the environment');
  }
  return problems;
}

function createDeps(overrides = {}) {
  return Object.freeze({
    env: process.env,
    log: line => process.stderr.write(`${line}\n`),
    run: (command, args, options) => spawnSync(command, args, options),
    ...overrides
  });
}

function main(argv, overrides = {}) {
  const deps = createDeps(overrides);
  const { mode, error } = parseMode(argv);
  if (error) {
    deps.log(`${error}\n${USAGE}`);
    return EXIT.USAGE;
  }

  const problems = checkEnvironment(deps.env);
  if (problems.length) {
    deps.log('Refused: staging team-management origin configuration preconditions are not met.');
    for (const problem of problems) deps.log(`  - ${problem}`);
    return EXIT.BLOCKED;
  }

  deps.log(`Target: ${TARGET.projectRef} (${TARGET.environment})`);
  deps.log(`Secret: ${TARGET.secretName}=${TARGET.secretValue}`);
  deps.log(`Mode: ${mode}`);

  // `supabase secrets list` prints names only, never values — safe to run
  // and log in either mode. It is how --dry-run reports state without
  // writing anything.
  const list = deps.run('supabase', ['secrets', 'list', '--project-ref', TARGET.projectRef], { stdio: ['ignore', 'pipe', 'inherit'], env: deps.env });
  if (list.error) {
    deps.log(`Refused: could not start the Supabase CLI (${list.error.code || 'spawn failure'}).`);
    return EXIT.INTERNAL;
  }
  if (list.status !== 0) {
    deps.log(`supabase secrets list exited ${list.status}.`);
    return EXIT.VALIDATION;
  }
  const alreadySet = String(list.stdout || '').includes(TARGET.secretName);
  deps.log(alreadySet ? `${TARGET.secretName} is already present (value not shown by the CLI; this does not confirm it matches).` : `${TARGET.secretName} is not present.`);

  if (mode === 'dry-run') {
    return EXIT.OK;
  }

  const set = deps.run('supabase', ['secrets', 'set', `${TARGET.secretName}=${TARGET.secretValue}`, '--project-ref', TARGET.projectRef], { stdio: 'inherit', env: deps.env });
  if (set.error) {
    deps.log(`Refused: could not start the Supabase CLI (${set.error.code || 'spawn failure'}).`);
    return EXIT.INTERNAL;
  }
  if (set.status !== 0) {
    deps.log(`supabase secrets set exited ${set.status}.`);
    return EXIT.VALIDATION;
  }
  deps.log('Staging team-management origin secret applied.');
  return EXIT.OK;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = Object.freeze({ main, parseMode, checkEnvironment, TARGET, EXIT, USAGE });

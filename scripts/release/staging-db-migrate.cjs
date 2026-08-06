#!/usr/bin/env node
'use strict';

// Scoped staging database migration wrapper.
//
// This is the ONLY authorized path to `supabase db push` in this repository,
// and it is authorized for exactly one database: the staging project named
// below. Generic `supabase db push` remains `production` in
// `classifyCommand` and is refused everywhere, as it was before this file
// existed. See docs/release-gates.md, "The scoped exception: staging database
// migration".
//
// Every constant here is pinned on purpose. A different project ref, host,
// port, database, or release environment is not a configuration change — it is
// a different authorization, and it needs its own reviewed change.

const { spawnSync } = require('node:child_process');

const TARGET = Object.freeze({
  projectRef: 'cjdxtakgmnzwixrajjry',
  host: 'aws-1-eu-west-3.pooler.supabase.com',
  port: '5432',
  database: 'postgres',
  environment: 'staging'
});

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });

const USAGE = 'usage: node scripts/release/staging-db-migrate.cjs (--dry-run | --apply)';

// The pooler username carries the project ref, so the whole userinfo component
// is encoded, not just the password.
function buildConnectionUrl(password, target = TARGET) {
  const user = encodeURIComponent(`postgres.${target.projectRef}`);
  const secret = encodeURIComponent(String(password));
  return `postgresql://${user}:${secret}@${target.host}:${target.port}/${target.database}`;
}

// Registering a mask before any subprocess starts is what keeps a secret out
// of the log if the CLI echoes its own arguments back on failure.
function maskValues(values, emit) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) emit(`::add-mask::${value}`);
  }
}

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
  if (!env.SUPABASE_DB_PASSWORD) {
    problems.push('SUPABASE_DB_PASSWORD is not set in the environment');
  }
  return problems;
}

function createDeps(overrides = {}) {
  return Object.freeze({
    env: process.env,
    emit: line => process.stdout.write(`${line}\n`),
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
    deps.log('Refused: staging migration preconditions are not met.');
    for (const problem of problems) deps.log(`  - ${problem}`);
    return EXIT.BLOCKED;
  }

  // Built here, held in a local, never written to disk and never logged.
  const url = buildConnectionUrl(deps.env.SUPABASE_DB_PASSWORD);
  maskValues([deps.env.SUPABASE_DB_PASSWORD, encodeURIComponent(deps.env.SUPABASE_DB_PASSWORD), url], deps.emit);

  deps.log(`Target: ${TARGET.projectRef} at ${TARGET.host}:${TARGET.port}/${TARGET.database} (${TARGET.environment})`);
  deps.log(`Mode: ${mode}`);

  const args = ['db', 'push', '--db-url', url];
  if (mode === 'dry-run') args.push('--dry-run');

  const result = deps.run('supabase', args, { stdio: 'inherit', env: deps.env });
  if (result.error) {
    deps.log(`Refused: could not start the Supabase CLI (${result.error.code || 'spawn failure'}).`);
    return EXIT.INTERNAL;
  }
  if (result.status !== 0) {
    deps.log(`supabase db push exited ${result.status}.`);
    return EXIT.VALIDATION;
  }
  deps.log(mode === 'dry-run' ? 'Dry run passed.' : 'Staging migrations applied.');
  return EXIT.OK;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = Object.freeze({ main, buildConnectionUrl, parseMode, checkEnvironment, TARGET, EXIT, USAGE });

#!/usr/bin/env node
'use strict';

// Scoped staging Edge Function deployment wrapper.
//
// This is the ONLY authorized path to `supabase functions deploy` in this
// repository, and it is authorized for exactly one project and exactly the
// functions the running app actually calls. Generic `supabase functions
// deploy` remains `production` in `classifyCommand` and is refused
// everywhere, as it was before this file existed. See docs/release-gates.md,
// "The scoped exception: staging Edge Function deployment".
//
// Every constant here is pinned on purpose. A different project ref, a
// different function, or a different release environment is not a
// configuration change — it is a different authorization, and it needs its
// own reviewed change.

const { spawnSync } = require('node:child_process');

const TARGET = Object.freeze({
  projectRef: 'cjdxtakgmnzwixrajjry',
  environment: 'staging',
  // Only functions the app actually calls (src/team-admin.js -> `${functionsUrl}/team-management`).
  // Adding a function here is a policy change, not a deploy-time flag.
  functions: Object.freeze(['team-management'])
});

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });

const USAGE = 'usage: node scripts/release/staging-functions-deploy.cjs --function <name>';

function maskValues(values, emit) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) emit(`::add-mask::${value}`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--function') {
    return { error: 'exactly --function <name> is required' };
  }
  const name = argv[1];
  if (!TARGET.functions.includes(name)) {
    return { error: `unknown or unauthorized function: ${name}` };
  }
  return { name };
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
    emit: line => process.stdout.write(`${line}\n`),
    log: line => process.stderr.write(`${line}\n`),
    run: (command, args, options) => spawnSync(command, args, options),
    ...overrides
  });
}

function main(argv, overrides = {}) {
  const deps = createDeps(overrides);
  const { name, error } = parseArgs(argv);
  if (error) {
    deps.log(`${error}\n${USAGE}`);
    return EXIT.USAGE;
  }

  const problems = checkEnvironment(deps.env);
  if (problems.length) {
    deps.log('Refused: staging Edge Function deployment preconditions are not met.');
    for (const problem of problems) deps.log(`  - ${problem}`);
    return EXIT.BLOCKED;
  }

  maskValues([deps.env.SUPABASE_ACCESS_TOKEN], deps.emit);
  deps.log(`Target: ${TARGET.projectRef} (${TARGET.environment})`);
  deps.log(`Function: ${name}`);

  const args = ['functions', 'deploy', name, '--project-ref', TARGET.projectRef];
  const result = deps.run('supabase', args, { stdio: 'inherit', env: deps.env });
  if (result.error) {
    deps.log(`Refused: could not start the Supabase CLI (${result.error.code || 'spawn failure'}).`);
    return EXIT.INTERNAL;
  }
  if (result.status !== 0) {
    deps.log(`supabase functions deploy exited ${result.status}.`);
    return EXIT.VALIDATION;
  }
  deps.log(`Deployed ${name} to staging.`);
  return EXIT.OK;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = Object.freeze({ main, parseArgs, checkEnvironment, TARGET, EXIT, USAGE });

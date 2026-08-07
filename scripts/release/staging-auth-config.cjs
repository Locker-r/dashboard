#!/usr/bin/env node
'use strict';

// Scoped staging Supabase Auth URL configuration wrapper.
//
// This is the ONLY authorized path to mutating Supabase Auth's Site URL or
// redirect allowlist in this repository, and it is authorized for exactly
// one project, one Site URL, and one redirect allowlist. See
// docs/release-gates.md, "The scoped exception: staging Auth URL
// configuration".
//
// Every constant here is pinned on purpose. A different project ref, a
// different Site URL, or an additional redirect entry is not a
// configuration change — it is a different authorization, and it needs its
// own reviewed change. There is no wildcard support: the app has no
// OAuth/magic-link/password-reset redirect flow today (verified against
// src/supabase-auth-service.js, which only calls signInWithPassword), so a
// single exact URL is what "required" means here.

const { request } = require('node:https');

const TARGET = Object.freeze({
  projectRef: 'cjdxtakgmnzwixrajjry',
  environment: 'staging',
  siteUrl: 'https://locker-r.github.io/dashboard/',
  redirectUrls: Object.freeze(['https://locker-r.github.io/dashboard/'])
});

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });

const USAGE = 'usage: node scripts/release/staging-auth-config.cjs (--dry-run | --apply)';

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
  if (!env.SUPABASE_ACCESS_TOKEN) {
    problems.push('SUPABASE_ACCESS_TOKEN is not set in the environment');
  }
  return problems;
}

// The Supabase Management API, not the CLI: there is no `supabase` CLI
// subcommand for Auth Site URL / redirect configuration.
function managementRequest({ method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        hostname: 'api.supabase.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createDeps(overrides = {}) {
  return Object.freeze({
    env: process.env,
    emit: line => process.stdout.write(`${line}\n`),
    log: line => process.stderr.write(`${line}\n`),
    request: managementRequest,
    ...overrides
  });
}

async function main(argv, overrides = {}) {
  const deps = createDeps(overrides);
  const { mode, error } = parseMode(argv);
  if (error) {
    deps.log(`${error}\n${USAGE}`);
    return EXIT.USAGE;
  }

  const problems = checkEnvironment(deps.env);
  if (problems.length) {
    deps.log('Refused: staging Auth configuration preconditions are not met.');
    for (const problem of problems) deps.log(`  - ${problem}`);
    return EXIT.BLOCKED;
  }

  const token = deps.env.SUPABASE_ACCESS_TOKEN;
  maskValues([token], deps.emit);
  deps.log(`Target: ${TARGET.projectRef} (${TARGET.environment})`);
  deps.log(`Site URL: ${TARGET.siteUrl}`);
  deps.log(`Redirect allowlist: ${TARGET.redirectUrls.join(', ')}`);
  deps.log(`Mode: ${mode}`);

  const path = `/v1/projects/${TARGET.projectRef}/config/auth`;
  const current = await deps.request({ method: 'GET', path, token });
  if (current.status !== 200) {
    deps.log(`Refused: could not read current Auth configuration (HTTP ${current.status}).`);
    return EXIT.VALIDATION;
  }

  const desired = { site_url: TARGET.siteUrl, uri_allow_list: TARGET.redirectUrls.join(',') };
  const matches = current.body
    && current.body.site_url === desired.site_url
    && current.body.uri_allow_list === desired.uri_allow_list;

  if (mode === 'dry-run') {
    deps.log(matches ? 'Already matches the pinned staging configuration.' : 'Would change: site_url and/or uri_allow_list differ from the pinned staging configuration.');
    return EXIT.OK;
  }

  if (matches) {
    deps.log('Already matches the pinned staging configuration; nothing to apply.');
    return EXIT.OK;
  }

  const result = await deps.request({ method: 'PATCH', path, token, body: desired });
  if (result.status < 200 || result.status >= 300) {
    deps.log(`Refused: Auth configuration update failed (HTTP ${result.status}).`);
    return EXIT.VALIDATION;
  }
  deps.log('Staging Auth configuration applied.');
  return EXIT.OK;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = Object.freeze({ main, parseMode, checkEnvironment, TARGET, EXIT, USAGE });

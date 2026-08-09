'use strict';

// The staging demo-prep workflow writes real rows and creates real
// (disposable) Auth accounts on a hosted staging project. These tests
// assert: manual dispatch only, main-only, a confirmed target, the existing
// staging admin secret names (no new secret), no production target, and no
// secret ever echoed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-demo-prep.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger this workflow`);
  }
});

test('the job runs only from main', () => {
  assert.match(WORKFLOW, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test('the job declares the staging environment', () => {
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
});

test('a required input must name the exact staging project ref, checked before any credential is read', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  assert.match(WORKFLOW, /STAGING_PROJECT_REF: cjdxtakgmnzwixrajjry$/m);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref');
  const cleanupIndex = WORKFLOW.indexOf('staging-demo-cleanup.cjs');
  assert.ok(confirmIndex >= 0 && confirmIndex < cleanupIndex);
});

test('the unknown/production project ref never appears anywhere in this workflow', () => {
  assert.ok(!WORKFLOW.includes('hywpwutykwrxkddnofrh'));
});

test('only the existing staging admin secret names are used — no new secret is introduced', () => {
  const secretRefs = [...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
  const unique = [...new Set(secretRefs)];
  assert.deepEqual(unique.sort(), ['STAGING_SMOKE_ADMIN_EMAIL', 'STAGING_SMOKE_ADMIN_PASSWORD']);
});

test('no secret value is ever echoed, and no forbidden secret family appears', () => {
  assert.ok(!/echo.*\$\{\{\s*secrets\./.test(WORKFLOW));
  for (const forbidden of ['SERVICE_ROLE', 'SUPABASE_DB_PASSWORD', 'SUPABASE_ACCESS_TOKEN', 'CLOUDFLARE_']) {
    assert.ok(!WORKFLOW.includes(forbidden), `${forbidden} must never appear in the staging demo-prep workflow`);
  }
});

test('the three phases run in order: cleanup, then seed, then flow verification', () => {
  const cleanupIndex = WORKFLOW.indexOf('run: node scripts/staging-demo-cleanup.cjs');
  const seedIndex = WORKFLOW.indexOf('run: node scripts/staging-demo-seed.cjs');
  const verifyIndex = WORKFLOW.indexOf('run: node scripts/staging-demo-flow-verify.cjs');
  assert.ok(cleanupIndex >= 0 && seedIndex >= 0 && verifyIndex >= 0);
  assert.ok(cleanupIndex < seedIndex, 'cleanup must run before seeding');
  assert.ok(seedIndex < verifyIndex, 'seeding must run before flow verification');
});

test('no wrangler, Cloudflare, git tag, git push, or supabase CLI command appears', () => {
  for (const forbidden of ['wrangler', 'git tag', 'git push', 'supabase db', 'supabase functions deploy', 'supabase projects', 'supabase link']) {
    assert.ok(!WORKFLOW.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} must not appear`);
  }
});

test('the workflow never sets workflow_dispatch to run automatically — dispatch remains a human action', () => {
  // Sanity check that the only trigger key present is workflow_dispatch
  // itself, already asserted above; this asserts no scheduling wrapper
  // (e.g. a cron-based auto-dispatch action) is layered on top of it.
  assert.ok(!/schedule:/.test(WORKFLOW));
  assert.ok(!WORKFLOW.includes('repository_dispatch'));
});

test('top-level permissions stay least-privilege', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
});

test('concurrency prevents two demo-prep runs from racing', () => {
  assert.match(WORKFLOW, /^concurrency:\n {2}group: staging-demo-prep\n {2}cancel-in-progress: false$/m);
});

test('every scripts/staging-demo-*.cjs file referenced by the workflow actually exists', () => {
  for (const match of WORKFLOW.matchAll(/node (scripts\/staging-demo-[\w.-]+\.cjs)/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, match[1])), `missing script: ${match[1]}`);
  }
});

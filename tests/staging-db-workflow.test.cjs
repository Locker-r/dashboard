'use strict';

// The staging migration workflow reaches a hosted database. These tests assert
// the properties that make that acceptable: manual dispatch only, a confirmed
// target, the reviewed wrapper rather than a raw CLI call, and no path by which
// the password or the connection URL reaches a log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-db-migrate.yml');
// A checkout with core.autocrlf=true rewrites LF to CRLF; the line-anchored
// assertions below only need line content, not the checkout's line-ending style.
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
const PROJECT_REF = 'cjdxtakgmnzwixrajjry';

// Step names in the order the file declares them.
const steps = WORKFLOW.split('\n')
  .filter(line => /^\s{6}- (?:name|uses):/.test(line))
  .map(line => line.replace(/^\s*- (?:name|uses):\s*/, '').trim());

const wrapperInvocations = WORKFLOW.split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('run: node scripts/release/staging-db-migrate.cjs'))
  .map(line => line.replace('run: ', ''));

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m, 'workflow_dispatch must be the only trigger');
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger a database migration`);
  }
});

test('the job declares the staging environment and the staging release environment', () => {
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
  assert.match(WORKFLOW, /^ {6}RELEASE_ENVIRONMENT: staging$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_PROJECT_REF: cjdxtakgmnzwixrajjry$/m);
});

test('a required input must name the exact project ref, and it is checked first', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  assert.equal(steps[0], 'Confirm the target project ref', 'the confirmation must run before anything else');
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref');
  const secretIndex = WORKFLOW.indexOf('secrets.SUPABASE_DB_PASSWORD');
  assert.ok(confirmIndex < secretIndex, 'the ref is confirmed before any secret is read');
});

test('the password comes only from environment secrets', () => {
  const references = WORKFLOW.match(/SUPABASE_DB_PASSWORD: [^\n]+/g) || [];
  assert.ok(references.length >= 3, 'each wrapper step supplies the password');
  for (const reference of references) {
    assert.equal(reference, 'SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}');
  }
});

test('the workflow never calls supabase db push directly', () => {
  assert.ok(!/supabase db push/.test(WORKFLOW.replace(/^\s*#.*$/gm, '')), 'only the reviewed wrapper may push');
  assert.ok(!/--db-url/.test(WORKFLOW.replace(/^\s*#.*$/gm, '')), 'the workflow must not build a connection URL');
});

test('the workflow runs dry-run, then apply, then a proving dry-run', () => {
  assert.deepEqual(wrapperInvocations, [
    'node scripts/release/staging-db-migrate.cjs --dry-run',
    'node scripts/release/staging-db-migrate.cjs --apply',
    'node scripts/release/staging-db-migrate.cjs --dry-run'
  ]);
  // No `continue-on-error` anywhere: apply must be unreachable if the dry run
  // fails, and the final check must be able to fail the job.
  assert.ok(!/continue-on-error/.test(WORKFLOW));
  assert.ok(!/if: \$\{\{ (?:always|success\(\) \|\|)/.test(WORKFLOW.split('Summary')[0]));
});

test('no step can print the password or the connection URL', () => {
  const forbidden = [/echo[^\n]*SUPABASE_DB_PASSWORD/, /echo[^\n]*postgresql:/, /set -x/, /ACTIONS_STEP_DEBUG/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(WORKFLOW), `workflow must not match ${pattern}`);
  }
  assert.ok(!/\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/.test(WORKFLOW.replace(/SUPABASE_DB_PASSWORD: \$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/g, '')),
    'the secret is referenced only as a step env value');
});

test('the workflow holds least privilege and serialises runs', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
  assert.match(WORKFLOW, /^ {2}group: staging-db-migrate$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/, 'a migration in flight is never cancelled');
});

test('the wrapper the workflow calls exists and pins the same target', () => {
  const wrapper = require('../scripts/release/staging-db-migrate.cjs');
  assert.equal(wrapper.TARGET.projectRef, PROJECT_REF);
  assert.equal(wrapper.TARGET.environment, 'staging');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'release', 'staging-db-migrate.cjs')));
});

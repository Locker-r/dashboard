'use strict';

// The staging Edge Function deployment workflow reaches a hosted service.
// These tests assert the properties that make that acceptable: manual
// dispatch only, main-only, a confirmed target and function, the reviewed
// wrapper rather than a raw CLI call, and no path by which the token reaches
// a log. Mirrors tests/staging-db-workflow.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-functions-deploy.yml');
// A checkout with core.autocrlf=true rewrites LF to CRLF; the line-anchored
// assertions below only need line content, not the checkout's line-ending style.
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const wrapperInvocations = WORKFLOW.split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('run: node scripts/release/staging-functions-deploy.cjs'));

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m, 'workflow_dispatch must be the only trigger');
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger a deployment`);
  }
});

test('the job runs only from main', () => {
  assert.match(WORKFLOW, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test('the job declares the staging environment and the staging release environment', () => {
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
  assert.match(WORKFLOW, /^ {6}RELEASE_ENVIRONMENT: staging$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_PROJECT_REF: cjdxtakgmnzwixrajjry$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_FUNCTION: team-management$/m);
});

test('required inputs must name the exact project ref and function, checked first', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /function_name:/);
  assert.match(WORKFLOW, /required: true[\s\S]*required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  assert.match(WORKFLOW, /\$SUPPLIED_FUNCTION" != "\$STAGING_FUNCTION/);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref and function');
  const secretIndex = WORKFLOW.indexOf('secrets.SUPABASE_ACCESS_TOKEN');
  assert.ok(confirmIndex >= 0 && confirmIndex < secretIndex, 'both are confirmed before any secret is read');
});

test('the function input is constrained to a fixed choice list', () => {
  assert.match(WORKFLOW, /type: choice/);
  assert.match(WORKFLOW, /options:\n\s+- team-management/);
});

test('the access token comes only from environment secrets', () => {
  const references = WORKFLOW.match(/SUPABASE_ACCESS_TOKEN: [^\n]+/g) || [];
  assert.ok(references.length >= 1, 'the deploy step supplies the token');
  for (const reference of references) {
    assert.equal(reference, 'SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  }
});

test('the workflow never calls supabase functions deploy directly', () => {
  const withoutComments = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.ok(!/supabase functions deploy/.test(withoutComments), 'only the reviewed wrapper may deploy');
});

test('the workflow runs the wrapper exactly once, naming the pinned function', () => {
  assert.deepEqual(wrapperInvocations, [
    'run: node scripts/release/staging-functions-deploy.cjs --function "$STAGING_FUNCTION"'
  ]);
  assert.ok(!/continue-on-error/.test(WORKFLOW));
});

test('no step can print the token', () => {
  const forbidden = [/echo[^\n]*SUPABASE_ACCESS_TOKEN/, /set -x/, /ACTIONS_STEP_DEBUG/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(WORKFLOW), `workflow must not match ${pattern}`);
  }
});

test('the workflow holds least privilege and serialises runs', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
  assert.match(WORKFLOW, /^ {2}group: staging-functions-deploy$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/, 'a deployment in flight is never cancelled');
});

test('the wrapper the workflow calls exists and pins the same target', () => {
  const wrapper = require('../scripts/release/staging-functions-deploy.cjs');
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.environment, 'staging');
  assert.deepEqual(wrapper.TARGET.functions, ['team-management']);
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'release', 'staging-functions-deploy.cjs')));
});

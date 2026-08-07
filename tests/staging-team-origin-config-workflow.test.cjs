'use strict';

// The staging team-management CORS origin configuration workflow reaches a
// hosted Supabase project's Edge Function secrets. These tests assert:
// manual dispatch only, main-only, both confirmations, the reviewed wrapper
// only (no direct `supabase secrets set`), dry-run/apply/verify ordering,
// and no path by which the token is printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-team-origin-config.yml');
// A checkout with core.autocrlf=true rewrites LF to CRLF; the line-anchored
// assertions below only need line content, not the checkout's line-ending style.
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const wrapperInvocations = WORKFLOW.split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('run: node scripts/release/staging-team-origin-config.cjs'));

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger a mutation`);
  }
});

test('the job runs only from main and declares the staging environment', () => {
  assert.match(WORKFLOW, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
  assert.match(WORKFLOW, /^ {6}RELEASE_ENVIRONMENT: staging$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_PROJECT_REF: cjdxtakgmnzwixrajjry$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_ALLOWED_ORIGIN: https:\/\/locker-r\.github\.io$/m);
});

test('required inputs must name the exact project ref and origin, checked before any secret is read', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /allowed_origin:/);
  assert.match(WORKFLOW, /required: true[\s\S]*required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  assert.match(WORKFLOW, /\$SUPPLIED_ORIGIN" != "\$STAGING_ALLOWED_ORIGIN/);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref and allowed origin');
  const secretIndex = WORKFLOW.indexOf('secrets.SUPABASE_ACCESS_TOKEN');
  assert.ok(confirmIndex >= 0 && confirmIndex < secretIndex);
});

test('the access token comes only from the existing environment secret', () => {
  const references = WORKFLOW.match(/SUPABASE_ACCESS_TOKEN: [^\n]+/g) || [];
  assert.ok(references.length >= 3, 'dry run, apply, and verify each supply the token');
  for (const reference of references) {
    assert.equal(reference, 'SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  }
});

test('the workflow never calls supabase secrets set directly', () => {
  const withoutComments = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.ok(!/supabase secrets set/.test(withoutComments), 'only the reviewed wrapper may set the secret');
});

test('the workflow runs dry-run, then apply, then a proving dry-run', () => {
  assert.deepEqual(wrapperInvocations, [
    'run: node scripts/release/staging-team-origin-config.cjs --dry-run',
    'run: node scripts/release/staging-team-origin-config.cjs --apply',
    'run: node scripts/release/staging-team-origin-config.cjs --dry-run'
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
  assert.match(WORKFLOW, /^ {2}group: staging-team-origin-config$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test('the wrapper the workflow calls exists and pins the same target', () => {
  const wrapper = require('../scripts/release/staging-team-origin-config.cjs');
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.secretName, 'TEAM_ALLOWED_ORIGIN');
  assert.equal(wrapper.TARGET.secretValue, 'https://locker-r.github.io');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'release', 'staging-team-origin-config.cjs')));
});

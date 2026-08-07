'use strict';

// The staging Auth URL configuration workflow reaches a hosted Supabase
// project. These tests assert: manual dispatch only, main-only, both
// confirmations, the reviewed wrapper only (no generic Management API call),
// dry-run/apply/verify ordering, and no path by which the token is printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-auth-config.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const wrapperInvocations = WORKFLOW.split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('run: node scripts/release/staging-auth-config.cjs'));

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
  assert.match(WORKFLOW, /^ {6}STAGING_SITE_URL: https:\/\/locker-r\.github\.io\/dashboard\/$/m);
});

test('required inputs must name the exact project ref and Site URL, checked before any secret is read', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /site_url:/);
  assert.match(WORKFLOW, /required: true[\s\S]*required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  assert.match(WORKFLOW, /\$SUPPLIED_SITE_URL" != "\$STAGING_SITE_URL/);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref and Site URL');
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

test('the workflow never calls the Management API directly', () => {
  const withoutComments = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.ok(!/api\.supabase\.com/.test(withoutComments), 'only the reviewed wrapper may reach the Management API');
  assert.ok(!/curl[^\n]*supabase/i.test(withoutComments));
});

test('the workflow runs dry-run, then apply, then a proving dry-run', () => {
  assert.deepEqual(wrapperInvocations, [
    'run: node scripts/release/staging-auth-config.cjs --dry-run',
    'run: node scripts/release/staging-auth-config.cjs --apply',
    'run: node scripts/release/staging-auth-config.cjs --dry-run'
  ]);
  assert.ok(!/continue-on-error/.test(WORKFLOW));
});

test('no wildcard redirect appears anywhere in the workflow', () => {
  assert.ok(!WORKFLOW.includes('*'), 'no wildcard redirect URL is authorized');
});

test('no step can print the token', () => {
  const forbidden = [/echo[^\n]*SUPABASE_ACCESS_TOKEN/, /set -x/, /ACTIONS_STEP_DEBUG/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(WORKFLOW), `workflow must not match ${pattern}`);
  }
});

test('the workflow holds least privilege and serialises runs', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
  assert.match(WORKFLOW, /^ {2}group: staging-auth-config$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test('the wrapper the workflow calls exists and pins the same target', () => {
  const wrapper = require('../scripts/release/staging-auth-config.cjs');
  assert.equal(wrapper.TARGET.projectRef, 'cjdxtakgmnzwixrajjry');
  assert.equal(wrapper.TARGET.siteUrl, 'https://locker-r.github.io/dashboard/');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'release', 'staging-auth-config.cjs')));
});

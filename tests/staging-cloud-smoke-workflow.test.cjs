'use strict';

// The staging cloud smoke workflow writes real rows and creates real
// disposable accounts on a hosted project. These tests assert: manual
// dispatch only, main-only, a confirmed target checked before any secret is
// read, admin credentials scoped to environment secrets, the reviewed
// runtime-smoke harness runs unmodified, cashier deprovisioning always runs,
// and no path by which a generated password reaches a log unmasked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-cloud-smoke.yml');
// A checkout with core.autocrlf=true rewrites LF to CRLF; the line-anchored
// assertions below only need line content, not the checkout's line-ending style.
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger a staging write`);
  }
});

test('the job runs only from main and declares the staging environment', () => {
  assert.match(WORKFLOW, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
  assert.match(WORKFLOW, /^ {6}STAGING_PROJECT_REF: cjdxtakgmnzwixrajjry$/m);
  assert.match(WORKFLOW, /^ {6}SMOKE_TEST_PROJECT_URL: https:\/\/cjdxtakgmnzwixrajjry\.supabase\.co$/m);
  assert.match(WORKFLOW, /^ {6}SMOKE_TEST_MODE: staging$/m);
});

test('a required input must name the exact project ref, checked before any secret is read', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref');
  const secretIndex = WORKFLOW.indexOf('secrets.STAGING_SMOKE_ADMIN');
  assert.ok(confirmIndex >= 0 && confirmIndex < secretIndex);
});

test('admin secrets are scoped to the steps that need them, not the whole job', () => {
  const jobEnvBlock = WORKFLOW.slice(WORKFLOW.indexOf('    env:'), WORKFLOW.indexOf('    steps:'));
  assert.ok(!jobEnvBlock.includes('secrets.STAGING_SMOKE_ADMIN'), 'admin secrets must not be bound for every step in the job');
});

test('admin credentials come only from the named environment secrets', () => {
  assert.match(WORKFLOW, /SMOKE_TEST_ADMIN_EMAIL: \$\{\{ secrets\.STAGING_SMOKE_ADMIN_EMAIL \}\}/);
  assert.match(WORKFLOW, /SMOKE_TEST_ADMIN_PASSWORD: \$\{\{ secrets\.STAGING_SMOKE_ADMIN_PASSWORD \}\}/);
});

test('generated cashier passwords are masked before they reach GITHUB_OUTPUT', () => {
  const provisionStep = WORKFLOW.slice(WORKFLOW.indexOf('Provision disposable staging cashiers'), WORKFLOW.indexOf('Run the staging smoke harness'));
  const maskLineIndex = provisionStep.indexOf('::add-mask::$A_PASSWORD');
  const outputIndex = provisionStep.indexOf('a_password=$A_PASSWORD');
  assert.ok(maskLineIndex >= 0 && outputIndex >= 0 && maskLineIndex < outputIndex, 'both generated passwords must be masked before they are written to GITHUB_OUTPUT');
  assert.match(provisionStep, /::add-mask::\$B_PASSWORD/);
});

test('cashiers are provisioned through the reviewed script, not an inline API call', () => {
  const withoutComments = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.match(withoutComments, /node scripts\/staging-smoke-provision-cashiers\.cjs/);
  assert.match(withoutComments, /run: node scripts\/staging-smoke-deprovision-cashiers\.cjs/);
  assert.ok(!/functions\/v1\/team-management|curl[^\n]*team-management/.test(withoutComments), 'no inline Edge Function call — only the reviewed scripts may reach it');
});

test('the smoke run calls the existing, unmodified runtime-smoke harness', () => {
  assert.match(WORKFLOW, /run: node scripts\/runtime-smoke\.cjs$/m);
  assert.match(WORKFLOW, /^ {6}SMOKE_TEST_STAGING_CONFIRMATION: STAGING_ONLY_NOT_PRODUCTION$/m);
  assert.match(WORKFLOW, /^ {6}SMOKE_TEST_WRITE_CONFIRMATION: I_UNDERSTAND_SMOKE_TEST_WRITES$/m);
});

test('deprovisioning always runs, even if the smoke step fails', () => {
  const deprovisionIndex = WORKFLOW.indexOf('Deprovision disposable staging cashiers');
  const block = WORKFLOW.slice(deprovisionIndex, deprovisionIndex + 200);
  assert.match(block, /if: always\(\)/);
});

test('no step can print a cashier password', () => {
  const forbidden = [/echo[^\n]*A_PASSWORD[^\n]*\$/m, /echo[^\n]*B_PASSWORD[^\n]*\$/m, /set -x/, /ACTIONS_STEP_DEBUG/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(WORKFLOW), `workflow must not match ${pattern}`);
  }
});

test('the workflow holds least privilege and serialises runs', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
  assert.match(WORKFLOW, /^ {2}group: staging-cloud-smoke$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test('the referenced scripts exist', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'runtime-smoke.cjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'staging-smoke-provision-cashiers.cjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'staging-smoke-deprovision-cashiers.cjs')));
});

'use strict';

// The staging Pages deployment workflow publishes to a real public URL.
// These tests assert: manual dispatch only, main-only, a confirmed target,
// only public config reaching the build, no service-role/DB/token exposure,
// and a post-deploy check that the live URL matches the pinned one exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'staging-pages-deploy.yml');
// A checkout with core.autocrlf=true rewrites LF to CRLF; the line-anchored
// assertions below only need line content, not the checkout's line-ending style.
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

test('the workflow is manual only', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_dispatch:/m);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:']) {
    assert.ok(!new RegExp(`^ {2}${trigger}`, 'm').test(WORKFLOW), `${trigger} must not trigger a deployment`);
  }
});

test('both jobs run only from main', () => {
  const occurrences = WORKFLOW.match(/^ {4}if: github\.ref == 'refs\/heads\/main'$/gm) || [];
  assert.equal(occurrences.length, 2, 'build and deploy must each check the ref');
});

test('the build job declares the staging environment', () => {
  assert.match(WORKFLOW, /^ {4}environment: staging$/m);
});

test('a required input must name the exact project ref, checked before any build step', () => {
  assert.match(WORKFLOW, /project_ref:/);
  assert.match(WORKFLOW, /required: true/);
  assert.match(WORKFLOW, /\$SUPPLIED_REF" != "\$STAGING_PROJECT_REF/);
  const confirmIndex = WORKFLOW.indexOf('Confirm the target project ref');
  const buildStepIndex = WORKFLOW.indexOf('run: npm run build:pages');
  assert.ok(confirmIndex >= 0 && confirmIndex < buildStepIndex);
});

test('only public Supabase config reaches the build, and the project URL is pinned not guessed', () => {
  assert.match(WORKFLOW, /DASHBOARD_SUPABASE_PROJECT_URL: https:\/\/cjdxtakgmnzwixrajjry\.supabase\.co$/m);
  assert.match(WORKFLOW, /DASHBOARD_SUPABASE_PUBLISHABLE_KEY: \$\{\{ vars\.STAGING_SUPABASE_PUBLISHABLE_KEY \}\}$/m);
  for (const forbidden of ['SERVICE_ROLE', 'SUPABASE_DB_PASSWORD', 'SUPABASE_ACCESS_TOKEN']) {
    assert.ok(!WORKFLOW.includes(forbidden), `${forbidden} must never appear in the Pages deploy workflow`);
  }
});

test('the publishable key comes from a variable, never a secret', () => {
  assert.ok(!/DASHBOARD_SUPABASE_PUBLISHABLE_KEY: \$\{\{ secrets\./.test(WORKFLOW));
});

test('the artifact is built with the existing builder and validated before publishing', () => {
  assert.match(WORKFLOW, /run: npm run build:pages/);
  assert.match(WORKFLOW, /run: node scripts\/build-pages-artifact\.cjs --validate-only/);
  const buildIndex = WORKFLOW.indexOf('run: npm run build:pages');
  const validateIndex = WORKFLOW.indexOf('--validate-only');
  const uploadIndex = WORKFLOW.indexOf('upload-pages-artifact');
  assert.ok(buildIndex < validateIndex && validateIndex < uploadIndex);
});

test('publishing uses only the official GitHub Pages actions', () => {
  assert.match(WORKFLOW, /uses: actions\/configure-pages@v5/);
  assert.match(WORKFLOW, /uses: actions\/upload-pages-artifact@v3/);
  assert.match(WORKFLOW, /uses: actions\/deploy-pages@v4/);
});

test('the deploy job holds pages:write and id-token:write, scoped to that job only', () => {
  const deployJob = WORKFLOW.slice(WORKFLOW.indexOf('\n  deploy:'));
  assert.match(deployJob, /^ {4}permissions:\n {6}pages: write\n {6}id-token: write$/m);
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m, 'top-level permissions stay least-privilege');
});

test('the deployed URL is verified against the exact pinned staging URL', () => {
  assert.match(WORKFLOW, /DEPLOYED_URL" != "https:\/\/locker-r\.github\.io\/dashboard\/"/);
  assert.match(WORKFLOW, /exit 1/);
});

test('the workflow holds least privilege and serialises runs', () => {
  assert.match(WORKFLOW, /^ {2}group: staging-pages-deploy$/m);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

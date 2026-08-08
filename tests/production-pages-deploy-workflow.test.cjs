'use strict';

// The production Pages deployment workflow publishes to the real production
// domain. These tests assert: tag-only trigger (no branch/dispatch path can
// reach it), an authoritative in-job tag/ancestry/annotation check, the
// `production` environment gate, the pinned project name, only the two
// approved Cloudflare secret names, no secret interpolation into logs, no
// forbidden Supabase secrets, no tag/branch mutation, and that every
// pre-deploy gate runs before Wrangler is ever invoked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'production-pages-deploy.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const TAG_REGEX = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

test('the workflow file exists and is the only production Pages workflow', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test('the workflow triggers only on a semantic version tag push', () => {
  assert.match(WORKFLOW, /^on:\n {2}push:\n {4}tags:\n {6}- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'$/m);
  for (const trigger of ['branches:', 'pull_request:', 'schedule:', 'workflow_call:', 'workflow_run:', 'repository_dispatch:', 'workflow_dispatch:']) {
    assert.ok(!WORKFLOW.includes(trigger), `${trigger} must not appear — it would open a non-tag trigger path`);
  }
});

test('the in-job tag regex rejects non-conforming refs and accepts a valid one', () => {
  const rejected = ['v1.2', 'v1.2.3-rc.1', 'latest', 'refs/heads/main', 'v1.2.3.4', 'V1.2.3', ''];
  for (const candidate of rejected) {
    assert.ok(!TAG_REGEX.test(candidate), `${JSON.stringify(candidate)} must be rejected`);
  }
  assert.ok(TAG_REGEX.test('v1.2.3'));
  assert.match(WORKFLOW, /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);
});

test('the in-job check requires tag ref type, annotation, and ancestry before anything else', () => {
  assert.match(WORKFLOW, /GITHUB_REF_TYPE:-}" != "tag"/);
  assert.match(WORKFLOW, /git cat-file -t "\$GITHUB_REF_NAME"\)" != "tag"/);
  assert.match(WORKFLOW, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(WORKFLOW, /rev-parse "\$GITHUB_REF_NAME\^\{commit\}"/);
  const verifyIndex = WORKFLOW.indexOf('Verify the tag is well-formed');
  const buildIndex = WORKFLOW.indexOf('Build the Pages artifact from the tagged commit');
  assert.ok(verifyIndex >= 0 && verifyIndex < buildIndex);
});

test('checkout uses full history and no ref override', () => {
  const checkoutBlock = WORKFLOW.slice(WORKFLOW.indexOf('uses: actions/checkout'), WORKFLOW.indexOf('uses: actions/checkout') + 120);
  assert.match(checkoutBlock, /fetch-depth: 0/);
  assert.ok(!/\n\s*ref:/.test(checkoutBlock), 'checkout must not override ref — the tag push default is required');
});

test('the deploying job declares the production environment', () => {
  assert.match(WORKFLOW, /^ {4}environment: production$/m);
});

test('production Supabase config is required from variables, never created, and fails closed before build', () => {
  assert.match(WORKFLOW, /DASHBOARD_SUPABASE_PROJECT_URL: \$\{\{ vars\.PRODUCTION_SUPABASE_PROJECT_URL \}\}$/m);
  assert.match(WORKFLOW, /DASHBOARD_SUPABASE_PUBLISHABLE_KEY: \$\{\{ vars\.PRODUCTION_SUPABASE_PUBLISHABLE_KEY \}\}$/m);
  const confirmIndex = WORKFLOW.indexOf('Confirm production Supabase config variables are set');
  const buildIndex = WORKFLOW.indexOf('Build the Pages artifact from the tagged commit');
  assert.ok(confirmIndex >= 0 && confirmIndex < buildIndex);
  for (const forbidden of ['SERVICE_ROLE', 'SUPABASE_DB_PASSWORD', 'SUPABASE_ACCESS_TOKEN']) {
    assert.ok(!WORKFLOW.includes(forbidden), `${forbidden} must never appear in the production Pages deploy workflow`);
  }
});

test('only the two approved Cloudflare secret names are referenced', () => {
  const secretRefs = [...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
  const unique = [...new Set(secretRefs)];
  assert.deepEqual(unique.sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
});

test('Cloudflare credential presence is checked by name only, before build, values never echoed', () => {
  const presenceIndex = WORKFLOW.indexOf('Confirm Cloudflare credentials are present');
  const buildIndex = WORKFLOW.indexOf('Build the Pages artifact from the tagged commit');
  assert.ok(presenceIndex >= 0 && presenceIndex < buildIndex);
  assert.ok(!/echo.*\$\{\{\s*secrets\.CLOUDFLARE/.test(WORKFLOW));
  assert.ok(!/echo\s+"\$CLOUDFLARE_(ACCOUNT_ID|API_TOKEN)"/.test(WORKFLOW));
});

test('no step writes a secret value into the job summary', () => {
  const summaryBlock = WORKFLOW.slice(WORKFLOW.indexOf('name: Summary'));
  assert.ok(!/secrets\.CLOUDFLARE/.test(summaryBlock));
  assert.ok(!summaryBlock.includes('CLOUDFLARE_API_TOKEN'));
  assert.ok(!summaryBlock.includes('CLOUDFLARE_ACCOUNT_ID'));
});

test('the artifact is built and validated with the existing, unmodified builder', () => {
  assert.match(WORKFLOW, /run: npm run build:pages/);
  assert.match(WORKFLOW, /run: node scripts\/build-pages-artifact\.cjs --validate-only/);
  const buildIndex = WORKFLOW.indexOf('run: npm run build:pages');
  const validateIndex = WORKFLOW.indexOf('--validate-only');
  const deployIndex = WORKFLOW.indexOf('Deploy to Cloudflare Pages');
  assert.ok(buildIndex < validateIndex && validateIndex < deployIndex);
});

test('no artifact is downloaded from another workflow or run', () => {
  assert.ok(!WORKFLOW.includes('download-artifact'));
  assert.ok(!WORKFLOW.includes('actions/github-script'));
});

test('the manifest version is checked against the tag before deployment', () => {
  const manifestCheckIndex = WORKFLOW.indexOf('Verify the manifest version matches the tag');
  const deployIndex = WORKFLOW.indexOf('Deploy to Cloudflare Pages');
  assert.ok(manifestCheckIndex >= 0 && manifestCheckIndex < deployIndex);
  assert.match(WORKFLOW, /expected_version="\$\{GITHUB_REF_NAME#v\}"/);
});

test('the deployment targets exactly the dashboard-latam project and the main branch, with no preview flag', () => {
  assert.match(WORKFLOW, /PRODUCTION_PAGES_PROJECT: dashboard-latam$/m);
  assert.match(WORKFLOW, /--project-name "\$PRODUCTION_PAGES_PROJECT"/);
  assert.match(WORKFLOW, /--branch main/);
  assert.match(WORKFLOW, /--commit-hash "\$GITHUB_SHA"/);
  assert.ok(!/--preview/.test(WORKFLOW));
});

test('the deployed host is verified against the exact production domain, not a preview alias', () => {
  assert.match(WORKFLOW, /"\$host" != "dashboard-latam\.pages\.dev"/);
});

test('no Cloudflare project creation, DNS, custom-domain, or Git-integration command appears', () => {
  const commandLines = WORKFLOW.split('\n').filter(line => !/^\s*#/.test(line));
  const commandText = commandLines.join('\n').toLowerCase();
  for (const forbidden of ['pages project create', 'pages domain', 'pages deployment tail', 'zone id', 'dns record', '--preview']) {
    assert.ok(!commandText.includes(forbidden), `${forbidden} must not appear`);
  }
});

test('the workflow never creates, pushes, or mutates a tag or branch', () => {
  assert.ok(!/git\s+tag\b/.test(WORKFLOW));
  assert.ok(!/git\s+push\b/.test(WORKFLOW));
  assert.ok(!/--force\b/.test(WORKFLOW));
  assert.ok(!/--delete\b/.test(WORKFLOW));
  assert.ok(!/gh release/.test(WORKFLOW));
});

test('no supabase CLI command appears', () => {
  assert.ok(!/\bsupabase\s+(db|functions|projects|link|login|secrets)\b/.test(WORKFLOW));
});

test('Wrangler version is pinned exactly, not floating', () => {
  const versionRefs = [...WORKFLOW.matchAll(/wrangler@([^\s]+)/g)].map(m => m[1]);
  assert.ok(versionRefs.length >= 2, 'both project-list and deploy invocations must pin a version');
  for (const version of versionRefs) {
    assert.match(version, /^\d+\.\d+\.\d+$/, 'wrangler version must be an exact semver, not latest/floating');
  }
  const unique = new Set(versionRefs);
  assert.equal(unique.size, 1, 'all wrangler invocations must pin the same version');
});

test('every pre-deploy gate precedes the Wrangler deploy step, and the deploy step is the only wrangler pages deploy invocation', () => {
  const gateMarkers = [
    'Verify the tag is well-formed',
    'Confirm production Supabase config variables are set',
    'Confirm Cloudflare credentials are present',
    'run: npm test',
    'run: npm run check:js',
    'run: npm run check:secrets',
    'run: npm run check:migrations',
    'run: npm run build:pages',
    "run: node scripts/build-pages-artifact.cjs --validate-only",
    'Verify the manifest version matches the tag',
    'Confirm the target Cloudflare Pages project exists'
  ];
  const deployIndex = WORKFLOW.indexOf('wrangler@3.114.14 pages deploy');
  assert.ok(deployIndex > 0);
  for (const marker of gateMarkers) {
    const idx = WORKFLOW.indexOf(marker);
    assert.ok(idx >= 0, `missing gate marker: ${marker}`);
    assert.ok(idx < deployIndex, `gate "${marker}" must precede the Wrangler deploy step`);
  }
  const deployOccurrences = (WORKFLOW.match(/pages deploy /g) || []).length;
  assert.equal(deployOccurrences, 1, 'there must be exactly one wrangler pages deploy invocation');
});

test('every pre-deploy multi-line run step uses errexit so a failure cannot silently fall through to deployment', () => {
  const deployIndex = WORKFLOW.indexOf('name: Deploy to Cloudflare Pages');
  const preDeployWorkflow = WORKFLOW.slice(0, deployIndex);
  const runBlocks = [...preDeployWorkflow.matchAll(/run: \|\n([\s\S]*?)(?=\n {6}- name:|\n {6}- uses:|$)/g)];
  assert.ok(runBlocks.length > 0);
  for (const [, body] of runBlocks) {
    assert.match(body, /set -euo pipefail/, `multi-line run block missing 'set -euo pipefail':\n${body}`);
  }
});

test('reads and Cloudflare project existence checks are the only non-deploy wrangler invocations', () => {
  const wranglerLines = WORKFLOW.split('\n').filter(line => line.includes('wrangler@'));
  for (const line of wranglerLines) {
    assert.ok(
      line.includes('pages project list') || line.includes('pages deploy'),
      `unexpected wrangler invocation: ${line}`
    );
  }
});

test('no other workflow file references a CLOUDFLARE_ secret or variable', () => {
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  const others = fs.readdirSync(workflowsDir).filter(name => name !== 'production-pages-deploy.yml' && name.endsWith('.yml'));
  for (const name of others) {
    const content = fs.readFileSync(path.join(workflowsDir, name), 'utf8');
    assert.ok(!/CLOUDFLARE_/.test(content), `${name} must not reference CLOUDFLARE_* — only production-pages-deploy.yml may`);
  }
});

test('top-level permissions stay least-privilege', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
});

test('concurrency prevents two production deploys from racing', () => {
  assert.match(WORKFLOW, /^concurrency:\n {2}group: production-pages-deploy\n {2}cancel-in-progress: false$/m);
});

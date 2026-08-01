const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'check-migration-governance.cjs');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const releaseWorkflow = read('.github', 'workflows', 'release.yml');
const normalizedWorkflow = releaseWorkflow.replace(/\r\n/g, '\n');

// Called with no target the script scans this repository and additionally
// verifies exemption hygiene; with a target it scans a fixture directory.
function runCheck(target) {
  return spawnSync(process.execPath, target ? [script, target] : [script], { encoding: 'utf8' });
}

function withFixture(callback) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-governance-'));
  try {
    const migrations = path.join(base, 'supabase', 'migrations');
    const rollback = path.join(base, 'supabase', 'rollback');
    fs.mkdirSync(migrations, { recursive: true });
    fs.mkdirSync(rollback, { recursive: true });
    return callback({ base, migrations, rollback });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function assertReleaseWorkflowStructure(workflow) {
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /^permissions:\n\s+contents: read/m, 'default permissions must be read-only');
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(workflow, /npm run check:migrations/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/, 'privileged workflow must pin actions by SHA');
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/, 'privileged workflow must pin actions by SHA');
  assert.doesNotMatch(workflow, /secrets\./, 'the release must need no secret beyond the workflow token');
}

const VALID_SQL = 'begin;\ncreate table if not exists public.example(id uuid primary key);\ncommit;\n';

test('migration governance check passes on the repository', () => {
  const result = runCheck();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migration governance check passed \(8 migrations, 4 with rollback scripts, 4 legacy exemptions\)/);
});

test('a new migration without a rollback script fails', () => {
  withFixture(({ base, migrations }) => {
    fs.writeFileSync(path.join(migrations, '20260901000100_new_feature.sql'), VALID_SQL);
    const result = runCheck(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing supabase\/rollback\/20260901000100_new_feature_rollback\.sql/);
  });
});

test('a new migration with a rollback script passes', () => {
  withFixture(({ base, migrations, rollback }) => {
    fs.writeFileSync(path.join(migrations, '20260901000100_new_feature.sql'), VALID_SQL);
    fs.writeFileSync(path.join(rollback, '20260901000100_new_feature_rollback.sql'), 'begin;\ncommit;\n');
    const result = runCheck(base);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('a malformed migration name fails', () => {
  withFixture(({ base, migrations }) => {
    fs.writeFileSync(path.join(migrations, 'add-Feature.sql'), VALID_SQL);
    const result = runCheck(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /name must be <14-digit timestamp>/);
  });
});

test('a duplicate migration timestamp fails', () => {
  withFixture(({ base, migrations, rollback }) => {
    for (const name of ['20260901000100_first', '20260901000100_second']) {
      fs.writeFileSync(path.join(migrations, `${name}.sql`), VALID_SQL);
      fs.writeFileSync(path.join(rollback, `${name}_rollback.sql`), VALID_SQL);
    }
    const result = runCheck(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate migration timestamp 20260901000100/);
  });
});

test('a migration without explicit transaction boundaries fails', () => {
  withFixture(({ base, migrations, rollback }) => {
    fs.writeFileSync(path.join(migrations, '20260901000100_new_feature.sql'), 'create table public.example();\n');
    fs.writeFileSync(path.join(rollback, '20260901000100_new_feature_rollback.sql'), VALID_SQL);
    const result = runCheck(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing an explicit "begin;"/);
    assert.match(result.stderr, /missing an explicit "commit;"/);
  });
});

test('an orphan rollback script fails', () => {
  withFixture(({ base, rollback }) => {
    fs.writeFileSync(path.join(rollback, '20260901000100_ghost_rollback.sql'), VALID_SQL);
    const result = runCheck(base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no matching migration 20260901000100_ghost\.sql/);
  });
});

test('the rollback exemption list is a ratchet that only shrinks', () => {
  const source = read('scripts', 'check-migration-governance.cjs');
  assert.match(source, /ROLLBACK_EXEMPT lists/);
  assert.match(source, /remove "\$\{base\}" from ROLLBACK_EXEMPT|remove "\$\{base\}"/);
  const exemptions = source.match(/^\s{2}'\d{14}_[a-z0-9_]+'/gm) || [];
  assert.equal(exemptions.length, 4, 'the exemption list must not grow beyond the four legacy migrations');
});

test('the release workflow only publishes reviewed, gated tags', () => {
  assertReleaseWorkflowStructure(normalizedWorkflow);
});

test('release workflow assertions pass with LF and CRLF text', () => {
  const lfWorkflow = normalizedWorkflow;
  const crlfWorkflow = lfWorkflow.replace(/\n/g, '\r\n');

  for (const workflow of [lfWorkflow, crlfWorkflow]) {
    assertReleaseWorkflowStructure(workflow.replace(/\r\n/g, '\n'));
  }
});

test('quality gates enforce dependency and migration governance', () => {
  const workflow = read('.github', 'workflows', 'quality-gates.yml');
  assert.match(workflow, /npm run check:migrations/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /dependency-review-action/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
});

test('CODEOWNERS is present and documented as advisory', () => {
  const owners = read('.github', 'CODEOWNERS');
  assert.match(owners, /Advisory only/i);
  assert.match(owners, /^\/supabase\/\s+@/m);
  assert.match(owners, /^\/\.github\/\s+@/m);
});

test('the changelog keeps an Unreleased section and states what a tag means', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /^## \[Unreleased\]/m);
  assert.match(changelog, /does \*\*not\*\* mean the\s+snapshot has been deployed/);
});

test('required status check names match the workflow job names', () => {
  const workflow = read('.github', 'workflows', 'quality-gates.yml');
  const governance = read('docs', 'release-governance.md');
  const settings = read('docs', 'github-settings.md');
  for (const name of ['Tests, syntax, diff, and secrets', 'SQL and server PowerShell checks', 'Dependency review']) {
    assert.ok(workflow.includes(`name: ${name}`), `workflow is missing job name: ${name}`);
    assert.ok(governance.includes(name), `release-governance.md is missing check: ${name}`);
    assert.ok(settings.includes(name), `github-settings.md is missing check: ${name}`);
  }
});

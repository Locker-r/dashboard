'use strict';

// Static migration governance check.
//
// Verifies migration naming, ordering, transaction boundaries, and rollback
// coverage without executing any SQL. It therefore proves that the migration
// set is well-formed and reversible on paper; it proves nothing about whether
// the SQL applies successfully or about runtime authorization behaviour.
// Executable migration verification against a real database is deferred to D3.
//
// Destructive-statement detection is intentionally absent: it is already
// covered by scripts/check-atomic-writes.ps1 and scripts/dev/review.ps1.

const fs = require('node:fs');
const path = require('node:path');

// An explicit root is used by tests against fixture directories. The exemption
// list below describes this repository only, so exemption hygiene is checked
// solely when scanning the repository itself.
const scanningRepository = process.argv[2] === undefined;
const root = scanningRepository ? path.join(__dirname, '..') : path.resolve(process.argv[2]);
const migrationsDir = path.join(root, 'supabase', 'migrations');
const rollbackDir = path.join(root, 'supabase', 'rollback');

// Migrations merged before a rollback script was mandatory. This list is a
// ratchet, not a permission: it may only shrink. Writing the four missing
// rollback scripts is D3 work, tracked in docs/tech-debt.md.
const ROLLBACK_EXEMPT = new Set([
  '20260729000100_dashboard_foundation',
  '20260729000200_atomic_writes',
  '20260729000300_smoke_test_harness',
  '20260729000400_team_management'
]);

const MIGRATION_NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const failures = [];

function listSql(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
}

const migrations = listSql(migrationsDir);
const rollbacks = new Set(listSql(rollbackDir));
const seenTimestamps = new Map();

for (const file of migrations) {
  const match = MIGRATION_NAME.exec(file);
  if (!match) {
    failures.push(`${file}: name must be <14-digit timestamp>_<lower_snake_case>.sql`);
    continue;
  }

  const [, timestamp] = match;
  const base = file.slice(0, -'.sql'.length);

  if (seenTimestamps.has(timestamp)) {
    failures.push(`${file}: duplicate migration timestamp ${timestamp} (also ${seenTimestamps.get(timestamp)})`);
  } else {
    seenTimestamps.set(timestamp, file);
  }

  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  if (!/^\s*begin;\s*$/im.test(sql)) failures.push(`${file}: missing an explicit "begin;" transaction boundary`);
  if (!/^\s*commit;\s*$/im.test(sql)) failures.push(`${file}: missing an explicit "commit;" transaction boundary`);

  const rollbackFile = `${base}_rollback.sql`;
  const hasRollback = rollbacks.has(rollbackFile);
  if (!hasRollback && !ROLLBACK_EXEMPT.has(base)) {
    failures.push(`${file}: missing supabase/rollback/${rollbackFile}`);
  }
  if (hasRollback && ROLLBACK_EXEMPT.has(base)) {
    failures.push(`${file}: rollback script now exists; remove "${base}" from ROLLBACK_EXEMPT`);
  }
}

// A stale exemption silently weakens the ratchet, so it is a failure too.
const migrationBases = new Set(migrations.map(file => file.slice(0, -'.sql'.length)));
if (scanningRepository) {
  for (const exempt of ROLLBACK_EXEMPT) {
    if (!migrationBases.has(exempt)) failures.push(`ROLLBACK_EXEMPT lists "${exempt}", which is not a migration`);
  }
}

for (const rollback of rollbacks) {
  const base = rollback.replace(/_rollback\.sql$/, '');
  if (!rollback.endsWith('_rollback.sql')) {
    failures.push(`supabase/rollback/${rollback}: name must end with _rollback.sql`);
  } else if (!migrationBases.has(base)) {
    failures.push(`supabase/rollback/${rollback}: no matching migration ${base}.sql`);
  }
}

if (failures.length) {
  console.error('Migration governance check failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

const exempt = migrations.filter(file => ROLLBACK_EXEMPT.has(file.slice(0, -'.sql'.length))).length;
console.log(`Migration governance check passed (${migrations.length} migrations, ${migrations.length - exempt} with rollback scripts, ${exempt} legacy exemptions).`);

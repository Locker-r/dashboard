const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sqlPath = path.join(__dirname, '..', 'supabase', 'verify-storage-foundation.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

function stripCommentsAndStrings(source) {
  return source
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:''|[^'])*'/g, "''");
}

test('verification SQL is one strictly read-only statement', () => {
  const executableSql = stripCommentsAndStrings(sql);
  const statements = executableSql.split(';').filter((statement) => statement.trim());

  assert.equal(statements.length, 1);
  assert.match(statements[0], /^\s*with\b/i);
  assert.doesNotMatch(
    executableSql,
    /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i,
  );
});

test('verification SQL returns the required result shape and checks', () => {
  assert.match(sql, /select\s+check_name,\s+case when passed then 'PASS' else 'FAIL' end as status,\s+details/is);

  for (const checkName of [
    'required_tables',
    'rls_enabled',
    'select_policies',
    'anon_table_access',
    'is_admin_function',
    'security_definer_search_path',
    'required_indexes',
    'required_foreign_keys',
    'authenticated_direct_writes',
  ]) {
    assert.match(sql, new RegExp(`'${checkName}'`));
  }
});

test('verification SQL encodes the complete expected foundation', () => {
  assert.match(sql, /found_count = 4/);
  assert.match(sql, /enabled_count = 4/);
  assert.match(sql, /found_count = 13/);
  assert.match(sql, /found_count = 7/);
  assert.match(sql, /values \('INSERT'\), \('UPDATE'\), \('DELETE'\)/);
  assert.match(sql, /pg_get_function_identity_arguments/);
  assert.match(sql, /has_table_privilege/);
});

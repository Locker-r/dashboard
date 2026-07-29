const test = require('node:test');
const assert = require('node:assert/strict');
const factory = require('../src/data/data-service-factory.js');

test('uses local mode by default without Supabase configuration', () => {
  let localCalls = 0, supabaseCalls = 0;
  const result = factory.createConfiguredDataService({
    createLocal() { localCalls += 1; return 'local-service'; },
    createSupabase() { supabaseCalls += 1; return 'supabase-service'; }
  });
  assert.equal(result, 'local-service');
  assert.equal(localCalls, 1);
  assert.equal(supabaseCalls, 0);
});

test('creates Supabase service only for explicit supabase mode', () => {
  const result = factory.createConfiguredDataService({ mode: 'supabase', createLocal() { return 'local'; }, createSupabase() { return 'supabase'; } });
  assert.equal(result, 'supabase');
  assert.equal(factory.normalizeDataMode('unexpected'), 'local');
});

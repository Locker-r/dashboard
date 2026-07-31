const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../src/migration-preflight.js');

const profileId = '11111111-1111-4111-8111-111111111111';
const profile = { id: profileId, username: 'agent.one' };
const user = { id: 'local-agent', username: 'agent.one', name: 'Synthetic Agent', role: 'agent', salt: 'test-salt', passwordHash: 'test-hash', securitySalt: 'test-security-salt', securityAnswerHash: 'test-answer-hash' };
const mapping = { 'local-agent': { profileId, confirmed: true } };
const player = {
  id: 'p-local-1', phone: '+000 000 000', email: 'synthetic@example.invalid', messenger: '@synthetic',
  status: 'in_work', agentId: 'local-agent', importedAt: 1000, updatedAt: 2000, followUpAt: '2026-08-01T10:00:00Z',
  comments: [{ id: 'c-local-1', text: 'Synthetic comment', createdAt: 3000, authorId: 'local-agent', authorName: 'Synthetic Agent', authorRole: 'agent' }],
  statusHistory: [{ id: 'h-local-1', fromStatus: 'assigned', toStatus: 'in_work', changedAt: 2500, userId: 'local-agent', userName: 'Synthetic Agent', userRole: 'agent' }]
};

test('transforms local fields to the exact Supabase column shape', () => {
  const result = migration.dryRun({ players: [player], users: [user], profiles: [profile], userMapping: mapping });
  assert.equal(result.summary.validPlayers, 1);
  assert.deepEqual(result.transformed.players[0].row, {
    id: 'p-local-1', phone: '+000 000 000', email: 'synthetic@example.invalid', messenger: '@synthetic', status: 'in_work',
    agent_id: profileId, imported_at: new Date(1000).toISOString(), updated_at: new Date(2000).toISOString(),
    follow_up_at: '2026-08-01T10:00:00.000Z', created_by: null
  });
  assert.equal(result.transformed.comments[0].row.author_id, profileId);
  assert.equal(result.transformed.history[0].row.user_id, profileId);
  assert.equal(result.summary.schemaCreatedByNullable, true);
});

test('invalid records are counted and never reported as valid', () => {
  const result = migration.dryRun({ players: [{ id: '', status: 'unknown', importedAt: 'bad', updatedAt: null }], users: [] });
  assert.equal(result.summary.invalidPlayers, 1);
  assert.equal(result.issueCounts.id_missing, 1);
  assert.equal(result.issueCounts.contact_missing, 1);
  assert.equal(result.issueCounts.status_invalid, 1);
});

test('requires an explicit confirmed local user to profile mapping', () => {
  const unconfirmed = migration.dryRun({ players: [player], users: [user], profiles: [profile], userMapping: { 'local-agent': { profileId, confirmed: false } } });
  assert.equal(unconfirmed.summary.confirmedMappings, 0);
  assert.equal(unconfirmed.summary.unmappedUsers, 1);
  assert.equal(unconfirmed.summary.suggestedMappings, 1);
  assert.equal(unconfirmed.summary.blockedPlayers, 1);
  assert.equal(unconfirmed.migrationBlocked, true);
});

test('classifies exact id, remote contact, local contact duplicates and clean records separately', () => {
  const base = id => ({ ...player, id, agentId: null, comments: [], statusHistory: [] });
  const result = migration.dryRun({
    players: [base('already'), { ...base('contact'), phone: '222' }, { ...base('local-copy'), phone: '222' }, { ...base('clean'), phone: '333', email: '', messenger: '' }],
    // Stored contacts are no longer readable in the browser; remote contact matches arrive as
    // metadata from public.check_player_duplicates, keyed by the submitted row index.
    remotePlayers: [{ id: 'already' }, { id: 'remote-other' }],
    remoteDuplicates: [
      { row_index: 1, duplicate: true, matched_player_id: 'remote-other', matched_fields: ['phone'] },
      { row_index: 2, duplicate: true, matched_player_id: 'remote-other', matched_fields: ['phone'] }
    ]
  });
  assert.equal(result.summary.exact_id_duplicate, 1);
  assert.equal(result.summary.contact_duplicate, 2);
  assert.equal(result.summary.duplicate_inside_local, 0);
  assert.equal(result.summary.clean_record, 1);

  const localOnly = migration.dryRun({ players: [{ ...base('a'), phone: '444' }, { ...base('b'), phone: '444' }] });
  assert.equal(localOnly.summary.duplicate_inside_local, 1);
});

test('generic messenger channel labels do not create local duplicates', () => {
  const labels = ['WhatsApp', 'whatsapp', 'Telegram', 'TELEGRAM', 'Whats App', 'WA', 'tg', ''];
  const players = labels.map((messenger, index) => ({
    id: `channel-${index}`, phone: String(700000 + index), email: '', messenger,
    status: 'new', importedAt: 1000, updatedAt: 1000
  }));
  const result = migration.dryRun({ players });
  assert.equal(result.summary.duplicate_inside_local, 0);
  assert.equal(result.summary.clean_record, labels.length);
});

test('the same concrete messenger handle is a local duplicate', () => {
  const players = ['first', 'second'].map(id => ({
    id, phone: '', email: '', messenger: '@specific-user', status: 'new', importedAt: 1000, updatedAt: 1000
  }));
  const result = migration.dryRun({ players });
  assert.equal(result.summary.duplicate_inside_local, 1);
  assert.equal(result.summary.clean_record, 1);
});

test('different concrete messenger contacts are not local duplicates', () => {
  const players = ['@first-user', 'https://t.me/second-user', '+000000001'].map((messenger, index) => ({
    id: `specific-${index}`, phone: '', email: '', messenger, status: 'new', importedAt: 1000, updatedAt: 1000
  }));
  const result = migration.dryRun({ players });
  assert.equal(result.summary.duplicate_inside_local, 0);
  assert.equal(result.summary.clean_record, players.length);
});

test('a repeated run detects preserved source ids without changing input', () => {
  const input = { players: [player], users: [user], profiles: [profile], userMapping: mapping };
  const before = JSON.stringify(input);
  const first = migration.dryRun(input);
  const second = migration.dryRun({ ...input, remotePlayers: first.transformed.players.map(item => item.row) });
  assert.equal(second.summary.exact_id_duplicate, 1);
  assert.equal(JSON.stringify(input), before);
});

test('empty storage produces a safe zero-only report', () => {
  const result = migration.dryRun({});
  assert.equal(result.summary.players, 0);
  assert.equal(result.summary.localUsers, 0);
  assert.equal(result.summary.comments, 0);
  assert.equal(result.summary.history, 0);
  assert.equal(result.migrationBlocked, false);
});

test('creates separate recovery and sanitized exports without Supabase secrets', () => {
  const recovery = migration.createRecoveryBackup([player], [user], 1000);
  const sanitized = migration.createSanitizedSnapshot([player], [user], 1000);
  assert.equal(recovery.sensitive, true);
  assert.equal(recovery.storage['crm-users'][0].passwordHash, 'test-hash');
  assert.equal(sanitized.users[0].passwordHash, undefined);
  assert.equal(sanitized.users[0].salt, undefined);
  assert.equal(sanitized.users[0].securitySalt, undefined);
  assert.equal(sanitized.users[0].securityAnswerHash, undefined);
  for (const output of [recovery, sanitized]) {
    const raw = JSON.stringify(output);
    assert.equal(raw.includes('sb_publishable_'), false);
    assert.equal(raw.includes('access_token'), false);
    assert.equal(raw.includes('refresh_token'), false);
  }
});

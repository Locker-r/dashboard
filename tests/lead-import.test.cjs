const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/lead-import.js');
const sandbox = { module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
const leadImport = sandbox.module.exports;

const ids = rows => JSON.parse(JSON.stringify(rows.valid.map(row => [row.phone, row.email, row.contact])));

test('imports CSV with recognized headers', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n1001,user@example.test,@user', []);
  assert.equal(result.ok, true);
  assert.deepEqual(ids(result), [['1001', 'user@example.test', '@user']]);
});

test('imports headerless CSV as phone, email, contact', () => {
  assert.deepEqual(ids(leadImport.prepareCsvImport('1002,second@example.test,@second', [])), [['1002', 'second@example.test', '@second']]);
});

test('supports semicolon delimiter and Russian headers', () => {
  const result = leadImport.prepareCsvImport('телефон;почта;telegram\n1003;third@example.test;@third', []);
  assert.deepEqual(ids(result), [['1003', 'third@example.test', '@third']]);
});

test('removes UTF-8 BOM from the first header', () => {
  assert.equal(leadImport.prepareCsvImport('\uFEFFphone,email,contact\n1004,bom@example.test,@bom', []).hasHeader, true);
});

test('parses quoted values and escaped quotes', () => {
  const rows = leadImport.parseCsv('phone,email,contact\n"1005","quoted@example.test","name ""quoted"""');
  assert.equal(rows[1][2], 'name "quoted"');
});

test('does not split commas inside quoted values', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n1006,user6@example.test,"Doe, Jane"', []);
  assert.equal(result.valid[0].contact, 'Doe, Jane');
});

test('skips blank lines', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n\n1007,user7@example.test,@seven\n  \n', []);
  assert.equal(result.total, 1);
});

test('reports invalid email as a row error', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n1008,not-an-email,@eight', []);
  assert.equal(result.errors[0].reason, 'invalid_email');
});

test('skips duplicate phone against existing players', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n+1 (009),new@example.test,@new', [{ phone: '1009' }]);
  assert.equal(result.duplicates.length, 1);
});

test('skips duplicate email case-insensitively', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n,USER10@EXAMPLE.TEST,@new', [{ email: 'user10@example.test' }]);
  assert.equal(result.duplicates.length, 1);
});

test('skips duplicates inside the same file', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n1011,one@example.test,@one\n1011,two@example.test,@two', []);
  assert.equal(result.valid.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test('append preserves existing players', () => {
  const existing = [{ id: 'existing', phone: 'old' }];
  const preview = leadImport.prepareCsvImport('1012,new@example.test,@new', existing);
  const combined = leadImport.appendPrepared(existing, preview, row => ({ id: 'new', ...row }));
  assert.equal(combined[0], existing[0]);
  assert.equal(combined.length, 2);
});

test('preview does not mutate data before confirmation', () => {
  const existing = [{ id: 'existing' }];
  leadImport.prepareCsvImport('1013,preview@example.test,@preview', existing);
  assert.deepEqual(existing, [{ id: 'existing' }]);
});

test('cancellation can discard preview without changing data', () => {
  const existing = [{ id: 'existing' }];
  const preview = leadImport.prepareCsvImport('1014,cancel@example.test,@cancel', existing);
  assert.equal(preview.valid.length, 1);
  assert.deepEqual(existing, [{ id: 'existing' }]);
});

test('lead import never modifies users', () => {
  const users = [{ id: 'admin', role: 'admin' }];
  leadImport.prepareCsvImport('1015,safe@example.test,@safe', []);
  assert.deepEqual(users, [{ id: 'admin', role: 'admin' }]);
});

test('rejects unsupported and unavailable formats', () => {
  assert.equal(leadImport.validateFile({ name: 'leads.txt', size: 1 }).reason, 'unsupported_format');
  assert.equal(leadImport.validateFile({ name: 'leads.xlsx', size: 1 }).reason, 'xlsx_unavailable');
});

test('rejects an empty file', () => {
  assert.equal(leadImport.prepareCsvImport('', []).reason, 'empty_file');
});

test('rejects file size and row count limits', () => {
  assert.equal(leadImport.validateFile({ name: 'large.csv', size: leadImport.MAX_FILE_BYTES + 1 }).reason, 'file_too_large');
  const tooMany = Array.from({ length: leadImport.MAX_ROWS + 1 }, (_, i) => `${i},row${i}@example.test,@${i}`).join('\n');
  assert.equal(leadImport.prepareCsvImport(tooMany, []).reason, 'too_many_rows');
});

test('formula-like values remain inert text', () => {
  const result = leadImport.prepareCsvImport('phone,email,contact\n1019,formula@example.test,"=2+2"', []);
  assert.equal(result.valid[0].contact, '=2+2');
});

test('manual bulk import input remains supported by the shared parser', () => {
  const result = leadImport.prepareCsvImport('1020,manual@example.test,@manual\n1021;;whatsapp-user', []);
  assert.equal(result.valid.length, 2);
});

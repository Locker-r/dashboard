'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const statusPath = path.join(root, 'docs', 'project-status.md');
const checker = require(path.join(root, 'scripts', 'dev', 'check-project-status.cjs'));
const repositoryMainSha = execFileSync(
  'git',
  ['rev-parse', '--verify', 'refs/heads/main'],
  { cwd: root, encoding: 'utf8' }
).trim();
const repositoryStatus = fs.readFileSync(statusPath, 'utf8');
const lfStatus = repositoryStatus.replace(/\r\n?/g, '\n');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceField(name, value, input = lfStatus) {
  const pattern = new RegExp(`^${escapeRegExp(name)}:.*$`, 'm');
  assert.match(input, pattern, `fixture is missing ${name}`);
  return input.replace(pattern, `${name}: ${value}`);
}

function removeField(name, input = lfStatus) {
  const pattern = new RegExp(`^${escapeRegExp(name)}:.*\n?`, 'm');
  assert.match(input, pattern, `fixture is missing ${name}`);
  return input.replace(pattern, '');
}

function appendCanonicalLine(line, input = lfStatus) {
  const marker = '\n## Update contract';
  assert.ok(input.includes(marker), 'fixture is missing the end of the canonical section');
  return input.replace(marker, `\n${line}${marker}`);
}

function validate(input, expectedMainSha = repositoryMainSha) {
  return checker.validateProjectStatus(input, { expectedMainSha });
}

function errorCodes(result) {
  return result.errors.map(error => error.code);
}

function assertOnlyExpectedError(input, code, expectedMainSha = repositoryMainSha) {
  const result = validate(input, expectedMainSha);
  assert.equal(result.valid, false);
  assert.deepEqual(errorCodes(result), [code]);
  return result;
}

function createStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write: value => { stdout += String(value); } },
      stderr: { write: value => { stderr += String(value); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function runMain(input, options = {}) {
  const capture = createStreams();
  const code = checker.main(options.argv || [], {
    root,
    mainSha: options.mainSha || repositoryMainSha,
    readFileSync: () => input,
    streams: capture.streams
  });
  return { code, stdout: capture.stdout(), stderr: capture.stderr() };
}

test('the repository project status is valid for the local main ref', () => {
  assert.match(repositoryMainSha, /^[0-9a-f]{40}$/);
  const result = validate(repositoryStatus);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.equal(result.fields['Main SHA'], repositoryMainSha);
});

test('required-field structure failures have specific codes', async t => {
  const cases = [
    ['missing field', removeField('Next task'), 'STATUS_FIELD_MISSING'],
    ['duplicate field', appendCanonicalLine('Project: Duplicate'), 'STATUS_FIELD_DUPLICATE'],
    ['unknown field', appendCanonicalLine('Unknown status fact: value'), 'STATUS_FIELD_UNKNOWN'],
    ['empty field', replaceField('Active blockers', ''), 'STATUS_FIELD_EMPTY'],
    ['malformed line', appendCanonicalLine('this line has no field delimiter'), 'STATUS_LINE_MALFORMED']
  ];

  for (const [name, input, code] of cases) {
    await t.test(name, () => assertOnlyExpectedError(input, code));
  }
});

test('a second canonical status section is rejected', () => {
  const duplicate = `${lfStatus}\n## Canonical status\nProject: Conflicting project\n`;
  assert.equal(validate(duplicate).valid, false);
  assert.ok(errorCodes(validate(duplicate)).includes('STATUS_SECTION_DUPLICATE'));
});

test('a malformed SHA and a stale full SHA are distinguished', () => {
  assertOnlyExpectedError(replaceField('Main SHA', 'abc123'), 'MAIN_SHA_INVALID');

  const staleSha = `${repositoryMainSha[0] === '0' ? '1' : '0'}${repositoryMainSha.slice(1)}`;
  assert.match(staleSha, /^[0-9a-f]{40}$/);
  assert.notEqual(staleSha, repositoryMainSha, 'the stale fixture must differ from expected main');
  const result = assertOnlyExpectedError(replaceField('Main SHA', staleSha), 'MAIN_SHA_STALE');
  assert.equal(result.fields['Main SHA'], staleSha);
});

test('milestone status is restricted to the documented allowlist', async t => {
  for (const status of checker.MILESTONE_STATUSES) {
    await t.test(`accepts ${status}`, () => {
      assert.equal(validate(replaceField('Milestone status', status)).valid, true);
    });
  }
  await t.test('rejects an unknown status', () => {
    assertOnlyExpectedError(replaceField('Milestone status', 'under-review'), 'MILESTONE_STATUS_INVALID');
  });
});

test('pull-request fields and the update timestamp are validated', async t => {
  const cases = [
    ['bad last merged PR', replaceField('Last merged PR', '23'), 'LAST_MERGED_PR_INVALID'],
    ['zero current PR', replaceField('Current open PR', '#0'), 'CURRENT_OPEN_PR_INVALID'],
    ['timestamp without timezone', replaceField('Last updated', '2026-08-03T22:05:08'), 'LAST_UPDATED_INVALID'],
    ['impossible timestamp', replaceField('Last updated', '2026-13-40T25:61:61Z'), 'LAST_UPDATED_INVALID'],
    ['calendar-invalid timestamp', replaceField('Last updated', '2026-02-30T22:05:08Z'), 'LAST_UPDATED_INVALID']
  ];
  for (const [name, input, code] of cases) {
    await t.test(name, () => assertOnlyExpectedError(input, code));
  }
});

test('unresolved placeholder forms are rejected', async t => {
  const placeholders = [
    '{{NEXT_TASK}}',
    '<replace-this>',
    'TBD',
    'YOUR_PROJECT_VALUE'
  ];
  for (const placeholder of placeholders) {
    await t.test(placeholder, () => {
      assertOnlyExpectedError(
        replaceField('Next task', `Implement project status ${placeholder}`),
        'STATUS_PLACEHOLDER_UNRESOLVED'
      );
    });
  }
});

test('secret-shaped values fail without being echoed by the CLI', async t => {
  const secretShapes = [
    ['Supabase secret key', ['sb', 'secret', 'A'.repeat(24)].join('_')],
    ['JWT', ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(12)].join('.')],
    ['GitHub token', ['ghp', 'D'.repeat(24)].join('_')],
    ['GitHub fine-grained token', ['github', 'pat', 'E'.repeat(32)].join('_')],
    ['Basic authorization', ['Authorization: Basic ', 'QmFzaWN', 'SyntheticCredential'].join('')],
    ['credential assignment', ['credential', 'synthetic-sensitive-value'].join('=')],
    ['Postgres URI', ['postgresql', '://fixture:', 'p'.repeat(12), '@127.0.0.1:5432/example'].join('')],
    ['HTTPS userinfo', ['https', '://fixture:', 'u'.repeat(12), '@example.invalid/repository'].join('')],
    ['private key header', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')]
  ];

  for (const [name, secret] of secretShapes) {
    await t.test(name, () => {
      const input = replaceField('Active blockers', `blocked by ${secret}`);
      assertOnlyExpectedError(input, 'STATUS_SECRET_DETECTED');
      const cli = runMain(input);
      assert.equal(cli.code, 1);
      assert.match(cli.stderr, /^PROJECT STATUS INVALID\n\[STATUS_SECRET_DETECTED\]/);
      assert.equal(cli.stderr.includes(secret), false, 'diagnostics must not echo secret-shaped input');
      assert.equal(cli.stdout, '');
    });
  }
});

test('secret-shaped unknown field names are never echoed', () => {
  const secret = ['github', 'pat', 'F'.repeat(32)].join('_');
  const input = appendCanonicalLine(`${secret}: injected`);
  const cli = runMain(input);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /\[STATUS_FIELD_UNKNOWN\]/);
  assert.match(cli.stderr, /\[STATUS_SECRET_DETECTED\]/);
  assert.equal(cli.stderr.includes(secret), false);
});

test('main ref resolution rejects local and origin divergence', () => {
  const local = '1'.repeat(40);
  const origin = '2'.repeat(40);
  const spawn = (_file, args) => ({
    status: 0,
    stdout: args.at(-1) === 'refs/heads/main' ? `${local}\n` : `${origin}\n`,
    stderr: ''
  });
  assert.throws(
    () => checker.resolveMainSha(root, spawn),
    error => error.code === 'MAIN_REFS_DIVERGED'
  );
});

test('LF, CRLF, and UTF-8 BOM documents are accepted', async t => {
  const formats = [
    ['LF', lfStatus],
    ['CRLF', lfStatus.replace(/\n/g, '\r\n')],
    ['UTF-8 BOM string', `\uFEFF${lfStatus}`],
    ['UTF-8 BOM buffer', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lfStatus, 'utf8')])]
  ];
  for (const [name, input] of formats) {
    await t.test(name, () => {
      const result = validate(input);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });
  }
});

test('CLI success, validation failure, help, and invalid usage are deterministic', async t => {
  await t.test('success', () => {
    const result = runMain(lfStatus);
    assert.deepEqual(result, { code: 0, stdout: 'PROJECT STATUS VALID\n', stderr: '' });
  });

  await t.test('validation failure', () => {
    const result = runMain(removeField('Project'));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^PROJECT STATUS INVALID\n\[STATUS_FIELD_MISSING\]/);
  });

  await t.test('help does not inspect the repository', () => {
    const capture = createStreams();
    const code = checker.main(['--help'], {
      readFileSync: () => { throw new Error('help must not read'); },
      streams: capture.streams
    });
    assert.equal(code, 0);
    assert.match(capture.stdout(), /^Usage: npm run check:project-status\n$/);
    assert.equal(capture.stderr(), '');
  });

  await t.test('unknown argument', () => {
    const result = runMain(lfStatus, { argv: ['--write'] });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^PROJECT STATUS INVALID\n\[ARGUMENT_INVALID\]/);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const statusPath = path.join(root, 'docs', 'project-status.md');
const checker = require(path.join(root, 'scripts', 'dev', 'check-project-status.cjs'));
const repositoryMainContext = checker.resolveMainContext(root);
const repositoryMainSha = repositoryMainContext.sha;
const repositoryStatus = fs.readFileSync(statusPath, 'utf8');
const lfStatus = repositoryStatus.replace(/\r\n?/g, '\n');

// Real Git fixtures. Ancestry rules and detached-checkout provenance cannot be
// proven with mocked command output alone, so these build throwaway
// repositories outside the working tree and delete them afterwards.
const fixtureRoots = [];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function createFixtureRepository() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-status-fixture-')));
  fixtureRoots.push(directory);
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.email', 'fixture@example.invalid');
  git(directory, 'config', 'user.name', 'Status Fixture');
  git(directory, 'config', 'commit.gpgsign', 'false');
  return directory;
}

function fixtureCommit(directory, label) {
  fs.writeFileSync(path.join(directory, `${label}.txt`), `${label}\n`);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-q', '-m', label);
  return git(directory, 'rev-parse', 'HEAD');
}

function writeFixtureStatus(directory, mainSha) {
  fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'docs', 'project-status.md'), replaceField('Main SHA', mainSha));
}

function eventPayload(directory, baseSha) {
  const file = path.join(directory, 'event.json');
  fs.writeFileSync(file, JSON.stringify({ pull_request: { base: { sha: baseSha, ref: 'main' } } }));
  return file;
}

function pullRequestEnv(eventPath) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_BASE_REF: 'main',
    GITHUB_EVENT_PATH: eventPath
  };
}

test.after(() => {
  for (const directory of fixtureRoots) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

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

function validate(input, expectedMainSha = repositoryMainSha, mainFirstParentSha = repositoryMainContext.firstParent) {
  return checker.validateProjectStatus(input, { expectedMainSha, mainFirstParentSha });
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
    mainFirstParentSha: options.mainFirstParentSha || repositoryMainContext.firstParent,
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
  assert.ok(
    [repositoryMainSha, repositoryMainContext.firstParent].includes(result.fields['Main SHA']),
    'recorded Main SHA must be the main tip or its direct first parent'
  );
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

test('an unverified detached two-parent merge no longer resolves main', () => {
  const base = '3'.repeat(40);
  const feature = '4'.repeat(40);
  const detachedSpawn = (_file, args) => {
    if (args[0] === 'rev-parse' || args[0] === 'symbolic-ref') return { status: 1, stdout: '', stderr: '' };
    if (args.join(' ') === 'show -s --format=%P HEAD') return { status: 0, stdout: `${base} ${feature}\n`, stderr: '' };
    return { status: 127, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => checker.resolveMainSha(root, detachedSpawn, {}, () => { throw new Error('no payload'); }),
    error => error.code === 'MAIN_REF_UNAVAILABLE',
    'the first parent alone is not proof of main'
  );

  const namedBranchSpawn = (_file, args) => {
    if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'feature/example\n', stderr: '' };
    throw new Error('named branches must not use the merge-parent fallback');
  };
  assert.throws(
    () => checker.resolveMainSha(root, namedBranchSpawn, {}, () => { throw new Error('no payload'); }),
    error => error.code === 'MAIN_REF_UNAVAILABLE'
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

test('Main SHA accepts the main tip and its direct first parent only', async t => {
  const repository = createFixtureRepository();
  const first = fixtureCommit(repository, 'first');
  const second = fixtureCommit(repository, 'second');
  git(repository, 'checkout', '-q', '-b', 'feature', second);
  const featureCommit = fixtureCommit(repository, 'feature-work');
  git(repository, 'checkout', '-q', 'main');
  const third = fixtureCommit(repository, 'third');
  const fourth = fixtureCommit(repository, 'fourth');
  const context = checker.resolveMainContext(repository);

  assert.equal(context.sha, fourth);
  assert.equal(context.firstParent, third);

  const check = sha => checker.validateProjectStatus(
    replaceField('Main SHA', sha),
    { expectedMainSha: context.sha, mainFirstParentSha: context.firstParent }
  );

  await t.test('recorded SHA equals main', () => {
    assert.equal(check(fourth).valid, true);
  });

  await t.test('recorded SHA is the direct first parent of main', () => {
    assert.equal(check(third).valid, true);
  });

  await t.test('recorded SHA two commits behind is stale', () => {
    assert.deepEqual(errorCodes(check(second)), ['MAIN_SHA_STALE']);
  });

  await t.test('an older unrelated ancestor is stale', () => {
    assert.deepEqual(errorCodes(check(first)), ['MAIN_SHA_STALE']);
  });

  await t.test('a commit from an unrelated branch is stale', () => {
    assert.deepEqual(errorCodes(check(featureCommit)), ['MAIN_SHA_STALE']);
  });
});

test('a feature merge first parent is never accepted as main', () => {
  const repository = createFixtureRepository();
  fixtureCommit(repository, 'base');
  git(repository, 'checkout', '-q', '-b', 'feature');
  const featureCommit = fixtureCommit(repository, 'feature-work');
  git(repository, 'checkout', '-q', 'main');
  const mainCommit = fixtureCommit(repository, 'main-work');
  git(repository, 'checkout', '-q', 'feature');
  git(repository, 'merge', '-q', '--no-ff', 'main', '-m', 'Merge main into feature');
  const featureMerge = git(repository, 'rev-parse', 'HEAD');
  const parents = git(repository, 'show', '-s', '--format=%P', featureMerge).split(/\s+/);

  assert.equal(parents.length, 2);
  assert.equal(parents[0], featureCommit, 'the fixture must place the feature commit first');
  assert.notEqual(parents[0], mainCommit);

  git(repository, 'checkout', '-q', '--detach', featureMerge);
  git(repository, 'branch', '-q', '-D', 'main');
  git(repository, 'branch', '-q', '-D', 'feature');

  assert.throws(
    () => checker.resolveMainContext(repository, undefined, {}, () => { throw new Error('no event payload'); }),
    error => error.code === 'MAIN_REF_UNAVAILABLE',
    'a detached feature merge must not resolve its first parent as main'
  );
});

test('detached checkouts resolve main only with verifiable CI provenance', async t => {
  const repository = createFixtureRepository();
  const base = fixtureCommit(repository, 'base');
  git(repository, 'checkout', '-q', '-b', 'feature');
  fixtureCommit(repository, 'feature-work');
  git(repository, 'checkout', '-q', 'main');
  const mainTip = fixtureCommit(repository, 'main-work');
  git(repository, 'checkout', '-q', '-b', 'ci-merge', mainTip);
  git(repository, 'merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request');
  const mergeCommit = git(repository, 'rev-parse', 'HEAD');
  const mergeParents = git(repository, 'show', '-s', '--format=%P', mergeCommit).split(/\s+/);
  assert.equal(mergeParents[0], mainTip, 'the fixture must model a base-first merge ref');

  git(repository, 'checkout', '-q', '--detach', mergeCommit);
  git(repository, 'branch', '-q', '-D', 'main');
  git(repository, 'branch', '-q', '-D', 'feature');
  git(repository, 'branch', '-q', '-D', 'ci-merge');

  const readEvent = target => fs.readFileSync(target, 'utf8');

  await t.test('an ordinary detached commit fails closed', () => {
    const plain = createFixtureRepository();
    fixtureCommit(plain, 'only');
    const single = fixtureCommit(plain, 'second');
    git(plain, 'checkout', '-q', '--detach', single);
    git(plain, 'branch', '-q', '-D', 'main');
    assert.throws(
      () => checker.resolveMainContext(plain, undefined, pullRequestEnv(eventPayload(plain, single)), readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('a two-parent merge without CI metadata fails closed', () => {
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, {}, readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('a verified pull-request merge context resolves the base', () => {
    const env = pullRequestEnv(eventPayload(repository, mainTip));
    const context = checker.resolveMainContext(repository, undefined, env, readEvent);
    assert.equal(context.sha, mainTip);
    assert.equal(context.firstParent, base);
    assert.equal(context.source, 'ci-merge-parent');
  });

  await t.test('a payload base that does not match the first parent fails closed', () => {
    const env = pullRequestEnv(eventPayload(repository, base));
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, env, readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('a non pull-request event fails closed', () => {
    const env = { ...pullRequestEnv(eventPayload(repository, mainTip)), GITHUB_EVENT_NAME: 'push' };
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, env, readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('a base ref other than main fails closed', () => {
    const env = { ...pullRequestEnv(eventPayload(repository, mainTip)), GITHUB_BASE_REF: 'release' };
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, env, readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('an unreadable payload fails closed instead of guessing', () => {
    const env = pullRequestEnv(path.join(repository, 'missing-event.json'));
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, env, readEvent),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });
});

test('octopus merges and truncated history fail closed', async t => {
  await t.test('octopus merge', () => {
    const repository = createFixtureRepository();
    fixtureCommit(repository, 'base');
    git(repository, 'checkout', '-q', '-b', 'one');
    fixtureCommit(repository, 'one-work');
    git(repository, 'checkout', '-q', 'main');
    git(repository, 'checkout', '-q', '-b', 'two');
    fixtureCommit(repository, 'two-work');
    git(repository, 'checkout', '-q', 'main');
    fixtureCommit(repository, 'main-work');
    git(repository, 'merge', '-q', '--no-ff', 'one', 'two', '-m', 'Octopus');
    const octopus = git(repository, 'rev-parse', 'HEAD');
    assert.equal(git(repository, 'show', '-s', '--format=%P', octopus).split(/\s+/).length, 3);
    git(repository, 'checkout', '-q', '--detach', octopus);
    git(repository, 'branch', '-q', '-D', 'main', 'one', 'two');
    const env = pullRequestEnv(eventPayload(repository, octopus));
    assert.throws(
      () => checker.resolveMainContext(repository, undefined, env, target => fs.readFileSync(target, 'utf8')),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });

  await t.test('shallow history with unreachable parents', () => {
    const origin = createFixtureRepository();
    fixtureCommit(origin, 'base');
    git(origin, 'checkout', '-q', '-b', 'feature');
    fixtureCommit(origin, 'feature-work');
    git(origin, 'checkout', '-q', 'main');
    fixtureCommit(origin, 'main-work');
    git(origin, 'merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request');
    const mergeCommit = git(origin, 'rev-parse', 'HEAD');

    const shallow = path.join(fs.realpathSync(os.tmpdir()), `project-status-shallow-${process.pid}-${fixtureRoots.length}`);
    fixtureRoots.push(shallow);
    git(path.dirname(shallow), 'clone', '-q', '--depth', '1', '--no-local', `file://${origin.replace(/\\/g, '/')}`, shallow);
    try { git(shallow, 'remote', 'remove', 'origin'); } catch { /* already absent */ }
    const shallowHead = git(shallow, 'rev-parse', 'HEAD');
    git(shallow, 'checkout', '-q', '--detach', shallowHead);
    try { git(shallow, 'branch', '-q', '-D', 'main'); } catch { /* already detached */ }
    assert.equal(git(shallow, 'show', '-s', '--format=%P', 'HEAD'), '', 'the shallow boundary must hide parents');

    const env = pullRequestEnv(eventPayload(shallow, mergeCommit));
    assert.throws(
      () => checker.resolveMainContext(shallow, undefined, env, target => fs.readFileSync(target, 'utf8')),
      error => error.code === 'MAIN_REF_UNAVAILABLE'
    );
  });
});

test('local main and origin/main divergence fails closed before any comparison', () => {
  const repository = createFixtureRepository();
  fixtureCommit(repository, 'base');
  const localTip = fixtureCommit(repository, 'local-work');
  git(repository, 'update-ref', 'refs/remotes/origin/main', git(repository, 'rev-parse', 'HEAD~1'));
  assert.notEqual(localTip, git(repository, 'rev-parse', 'refs/remotes/origin/main'));
  assert.throws(
    () => checker.resolveMainContext(repository),
    error => error.code === 'MAIN_REFS_DIVERGED'
  );
});

test('resolved main refs expose the first parent for the parent rule', () => {
  const repository = createFixtureRepository();
  const base = fixtureCommit(repository, 'base');
  const tip = fixtureCommit(repository, 'tip');
  const context = checker.resolveMainContext(repository);
  assert.equal(context.sha, tip);
  assert.equal(context.firstParent, base);
  assert.equal(context.source, 'ref');
});

test('a root commit without a parent still validates by exact equality', () => {
  const repository = createFixtureRepository();
  const only = fixtureCommit(repository, 'only');
  const context = checker.resolveMainContext(repository);
  assert.equal(context.sha, only);
  assert.equal(context.firstParent, null);
  assert.equal(checker.validateProjectStatus(replaceField('Main SHA', only), {
    expectedMainSha: context.sha,
    mainFirstParentSha: context.firstParent
  }).valid, true);
});

test('post-merge main validation passes end to end in a synthetic repository', () => {
  const repository = createFixtureRepository();
  fixtureCommit(repository, 'earlier');
  const beforeMerge = fixtureCommit(repository, 'feature-merge');

  // Model the real cycle: the status commit records the SHA that was main when
  // it was written, then becomes the new main tip itself.
  writeFixtureStatus(repository, beforeMerge);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-q', '-m', 'docs: sync canonical status');
  const afterMerge = git(repository, 'rev-parse', 'HEAD');
  assert.notEqual(afterMerge, beforeMerge);

  const capture = createStreams();
  const code = checker.main([], { root: repository, cwd: repository, streams: capture.streams });
  assert.equal(code, 0, capture.stderr());
  assert.equal(capture.stdout(), 'PROJECT STATUS VALID\n');
  assert.equal(capture.stderr(), '');

  // One further main commit without a status update must go stale again.
  fixtureCommit(repository, 'later');
  const stale = createStreams();
  assert.equal(checker.main([], { root: repository, cwd: repository, streams: stale.streams }), 1);
  assert.match(stale.stderr(), /\[MAIN_SHA_STALE\]/);
});

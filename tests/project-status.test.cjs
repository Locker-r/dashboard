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
const repositoryRecordedSha = checker.parseCanonicalFields(checker.normalizeDocument(repositoryStatus)).fields['Main SHA'];
const repositoryBaselineInspection = checker.inspectMainSha(root, repositoryRecordedSha, repositoryMainSha);

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

function validate(input, expectedMainSha = repositoryMainSha, repository = root) {
  return checker.validateProjectStatus(input, {
    expectedMainSha,
    inspectMainSha: (recordedSha, resolvedMainSha) => repository === root
      && recordedSha === repositoryRecordedSha
      && resolvedMainSha === repositoryMainSha
      ? repositoryBaselineInspection
      : checker.inspectMainSha(repository, recordedSha, resolvedMainSha)
  });
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
    inspectMainSha: options.inspectMainSha || ((recordedSha, resolvedMainSha) => recordedSha === repositoryRecordedSha
      && resolvedMainSha === repositoryMainSha
      ? repositoryBaselineInspection
      : checker.inspectMainSha(root, recordedSha, resolvedMainSha)),
    streams: capture.streams
  });
  return { code, stdout: capture.stdout(), stderr: capture.stderr() };
}

test('the repository project status is a valid baseline ancestor of local main', () => {
  assert.match(repositoryMainSha, /^[0-9a-f]{40}$/);
  const result = validate(repositoryStatus);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.equal(result.fields['Main SHA'], repositoryRecordedSha);
  assert.equal(result.resolvedMainSha, repositoryMainSha);
  assert.equal(result.mainShaStatus, repositoryBaselineInspection.status);
  assert.equal(result.commitsBehindMain, repositoryBaselineInspection.commitsBehindMain);
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

test('a malformed SHA and an unreachable full SHA are distinguished', () => {
  assertOnlyExpectedError(replaceField('Main SHA', 'abc123'), 'MAIN_SHA_INVALID');

  const unreachableSha = `${repositoryMainSha[0] === '0' ? '1' : '0'}${repositoryMainSha.slice(1)}`;
  assert.match(unreachableSha, /^[0-9a-f]{40}$/);
  assert.notEqual(unreachableSha, repositoryMainSha, 'the unreachable fixture must differ from expected main');
  const result = assertOnlyExpectedError(replaceField('Main SHA', unreachableSha), 'MAIN_SHA_UNREACHABLE');
  assert.equal(result.fields['Main SHA'], unreachableSha);
  assert.equal(result.mainShaStatus, 'unreachable');
  assert.equal(result.commitsBehindMain, null);
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

test('ancestry inspection distinguishes document failures from Git failures', async t => {
  const recorded = 'a'.repeat(40);
  const resolved = 'b'.repeat(40);
  const processResult = (status, stdout = '', error = null) => ({ status, stdout, stderr: '', error });
  const spawnFor = overrides => (_file, args, options = {}) => {
    if (args[0] === 'cat-file') {
      const sha = String(options.input || '').trim();
      if (sha === recorded && overrides.recordedMissing) return processResult(0, `${sha} missing\n`);
      if (sha === recorded && Object.hasOwn(overrides, 'recordedStatus')) {
        return processResult(overrides.recordedStatus, overrides.recordedStdout || '', overrides.recordedError || null);
      }
      return processResult(0, `${sha} commit\n`);
    }
    if (args[0] === 'merge-base') return processResult(overrides.mergeBaseStatus ?? 0, '', overrides.mergeBaseError || null);
    if (args[0] === 'rev-list') return processResult(0, `${resolved} ${recorded}\n`);
    return processResult(127, '', new Error(`unexpected command: ${args.join(' ')}`));
  };

  await t.test('missing recorded commit is a validation failure', () => {
    assert.deepEqual(
      checker.inspectMainSha(root, recorded, resolved, spawnFor({ recordedMissing: true })),
      { status: 'unreachable', commitsBehindMain: null }
    );
  });

  await t.test('operational recorded-object failure is not mislabeled unreachable', () => {
    for (const recordedStatus of [1, 128]) {
      assert.throws(
        () => checker.inspectMainSha(root, recorded, resolved, spawnFor({ recordedStatus })),
        error => error.code === 'MAIN_SHA_INSPECTION_FAILED'
      );
    }
    assert.throws(
      () => checker.inspectMainSha(root, recorded, resolved, spawnFor({
        recordedStatus: null,
        recordedError: new Error('synthetic spawn failure')
      })),
      error => error.code === 'MAIN_SHA_INSPECTION_FAILED'
    );
  });

  await t.test('merge-base exit one means non-ancestor; higher exits are operational', () => {
    assert.deepEqual(
      checker.inspectMainSha(root, recorded, resolved, spawnFor({ mergeBaseStatus: 1 })),
      { status: 'not-ancestor', commitsBehindMain: null }
    );
    assert.throws(
      () => checker.inspectMainSha(root, recorded, resolved, spawnFor({ mergeBaseStatus: 2 })),
      error => error.code === 'MAIN_SHA_INSPECTION_FAILED'
    );
  });

  await t.test('negative relations cannot carry a false distance', () => {
    assert.throws(
      () => checker.validateProjectStatus(replaceField('Main SHA', recorded), {
        expectedMainSha: resolved,
        inspectMainSha: () => ({ status: 'not-ancestor', commitsBehindMain: 42 })
      }),
      error => error.code === 'MAIN_SHA_INSPECTION_INVALID'
    );
  });
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
    assert.deepEqual(result, {
      code: 0,
      stdout: `PROJECT STATUS VALID\nMain SHA relation: ${repositoryBaselineInspection.status}; commitsBehindMain=${repositoryBaselineInspection.commitsBehindMain}\n`,
      stderr: ''
    });
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

test('Main SHA accepts any reachable main ancestor and reports commit distance', async t => {
  const repository = createFixtureRepository();
  const first = fixtureCommit(repository, 'first');
  const second = fixtureCommit(repository, 'second');
  git(repository, 'checkout', '-q', '-b', 'feature', second);
  const featureCommit = fixtureCommit(repository, 'feature-work');
  git(repository, 'checkout', '-q', 'main');
  const third = fixtureCommit(repository, 'third');
  const fourth = fixtureCommit(repository, 'fourth');
  git(repository, 'checkout', '-q', '-b', 'future', fourth);
  const descendantCommit = fixtureCommit(repository, 'future-work');
  git(repository, 'checkout', '-q', 'main');
  git(repository, 'tag', '-a', 'annotated-baseline', fourth, '-m', 'Annotated baseline');
  const annotatedTagObject = git(repository, 'rev-parse', 'refs/tags/annotated-baseline');
  assert.notEqual(annotatedTagObject, fourth, 'the fixture must use the tag object SHA, not its peeled commit');
  const context = checker.resolveMainContext(repository);

  assert.equal(context.sha, fourth);
  assert.equal(context.firstParent, third);

  const check = sha => checker.validateProjectStatus(
    replaceField('Main SHA', sha),
    {
      expectedMainSha: context.sha,
      inspectMainSha: (recordedSha, resolvedMainSha) => checker.inspectMainSha(
        repository,
        recordedSha,
        resolvedMainSha
      )
    }
  );

  await t.test('recorded SHA equals main', () => {
    const result = check(fourth);
    assert.equal(result.valid, true);
    assert.equal(result.mainShaStatus, 'exact');
    assert.equal(result.commitsBehindMain, 0);
  });

  await t.test('recorded SHA is the direct first parent of main', () => {
    const result = check(third);
    assert.equal(result.valid, true);
    assert.equal(result.mainShaStatus, 'ancestor');
    assert.equal(result.commitsBehindMain, 1);
  });

  await t.test('recorded SHA two commits behind remains valid', () => {
    const result = check(second);
    assert.equal(result.valid, true);
    assert.equal(result.mainShaStatus, 'ancestor');
    assert.equal(result.commitsBehindMain, 2);
  });

  await t.test('an older ancestor remains valid at the correct distance', () => {
    const result = check(first);
    assert.equal(result.valid, true);
    assert.equal(result.mainShaStatus, 'ancestor');
    assert.equal(result.commitsBehindMain, 3);
  });

  await t.test('a commit from an unrelated branch is blocking', () => {
    const result = check(featureCommit);
    assert.deepEqual(errorCodes(result), ['MAIN_SHA_NOT_ANCESTOR']);
    assert.equal(result.mainShaStatus, 'not-ancestor');
    assert.equal(result.commitsBehindMain, null);
  });

  await t.test('a descendant of resolved main is blocking', () => {
    const result = check(descendantCommit);
    assert.deepEqual(errorCodes(result), ['MAIN_SHA_NOT_ANCESTOR']);
    assert.equal(result.mainShaStatus, 'not-ancestor');
    assert.equal(result.commitsBehindMain, null);
  });

  await t.test('a missing commit is unreachable and blocking', () => {
    const missing = 'f'.repeat(40);
    assert.notEqual(missing, fourth);
    const result = check(missing);
    assert.deepEqual(errorCodes(result), ['MAIN_SHA_UNREACHABLE']);
    assert.equal(result.mainShaStatus, 'unreachable');
    assert.equal(result.commitsBehindMain, null);
  });

  await t.test('an annotated tag object that peels to an ancestor is not a commit SHA', () => {
    const result = check(annotatedTagObject);
    assert.deepEqual(errorCodes(result), ['MAIN_SHA_UNREACHABLE']);
    assert.equal(result.mainShaStatus, 'unreachable');
    assert.equal(result.commitsBehindMain, null);
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

test('resolved main refs retain first-parent metadata for secure CI provenance', () => {
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
  const result = checker.validateProjectStatus(replaceField('Main SHA', only), {
    expectedMainSha: context.sha,
    inspectMainSha: (recordedSha, resolvedMainSha) => checker.inspectMainSha(
      repository,
      recordedSha,
      resolvedMainSha
    )
  });
  assert.equal(result.valid, true);
  assert.equal(result.mainShaStatus, 'exact');
  assert.equal(result.commitsBehindMain, 0);
});

test('three normal merges remain valid until the milestone baseline is refreshed', () => {
  const repository = createFixtureRepository();
  fixtureCommit(repository, 'earlier');
  const baseline = fixtureCommit(repository, 'milestone-merge');

  writeFixtureStatus(repository, baseline);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-q', '-m', 'docs: sync canonical status');
  const mergedFeatureCommits = [];
  for (const name of ['one', 'two', 'three']) {
    git(repository, 'checkout', '-q', '-b', `feature-${name}`);
    mergedFeatureCommits.push(fixtureCommit(repository, `feature-${name}-work`));
    git(repository, 'checkout', '-q', 'main');
    git(repository, 'merge', '-q', '--no-ff', `feature-${name}`, '-m', `Merge feature ${name}`);
  }
  const tip = git(repository, 'rev-parse', 'main');
  const baselineInspection = checker.inspectMainSha(repository, baseline, tip);
  assert.deepEqual(baselineInspection, { status: 'ancestor', commitsBehindMain: 4 });

  const secondParent = mergedFeatureCommits.at(-1);
  const secondParentResult = checker.validateProjectStatus(replaceField('Main SHA', secondParent), {
    expectedMainSha: tip,
    inspectMainSha: (recordedSha, resolvedMainSha) => checker.inspectMainSha(
      repository,
      recordedSha,
      resolvedMainSha
    )
  });
  assert.equal(secondParentResult.valid, true, JSON.stringify(secondParentResult.errors));
  assert.equal(secondParentResult.mainShaStatus, 'ancestor');
  assert.equal(secondParentResult.commitsBehindMain, 1, 'a direct second parent must be one edge behind');

  const capture = createStreams();
  const code = checker.main([], { root: repository, cwd: repository, streams: capture.streams });
  assert.equal(code, 0, capture.stderr());
  assert.match(capture.stdout(), /^PROJECT STATUS VALID\n/);
  assert.match(capture.stdout(), /commitsBehindMain=4/);
  assert.equal(capture.stderr(), '');

  const beforeRefresh = git(repository, 'rev-parse', 'HEAD');
  writeFixtureStatus(repository, beforeRefresh);
  const exact = checker.validateProjectStatus(fs.readFileSync(path.join(repository, 'docs', 'project-status.md')), {
    expectedMainSha: beforeRefresh,
    inspectMainSha: (recordedSha, resolvedMainSha) => checker.inspectMainSha(
      repository,
      recordedSha,
      resolvedMainSha
    )
  });
  assert.equal(exact.valid, true);
  assert.equal(exact.mainShaStatus, 'exact');
  assert.equal(exact.commitsBehindMain, 0);

  git(repository, 'add', '-A');
  git(repository, 'commit', '-q', '-m', 'docs: refresh milestone baseline');
  const refreshed = createStreams();
  assert.equal(checker.main([], { root: repository, cwd: repository, streams: refreshed.streams }), 0);
  assert.match(refreshed.stdout(), /commitsBehindMain=1/);
  assert.equal(refreshed.stderr(), '');
});

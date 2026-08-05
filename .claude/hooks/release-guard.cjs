'use strict';

// PreToolUse guard for the autonomous release harness.
//
// Reads a Claude Code hook event on stdin and answers with a permission
// decision. Three rules, in order of strength:
//
//   1. Never write a production approval. Unconditional, no mode, no override.
//   2. Never run a production or destructive command. Wrappers do not help:
//      the shared classifier unwraps them.
//   3. While a release run is active, never modify product code or the harness
//      itself.
//
// The guard fails closed. An event it cannot parse, a tool input it cannot
// read, or an internal error all produce a denial rather than a shrug. It is a
// second line of defence behind the `deny` rules in settings.json, not a
// sandbox: an operator working outside Claude Code is governed by AGENTS.md.

const path = require('node:path');
const core = require(path.resolve(__dirname, '..', '..', 'scripts', 'release', 'release-core.cjs'));

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = Object.freeze(['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath']);
// Matches a reference to an approval record, or to the directory as a whole,
// but not to the README that documents it.
const APPROVAL_HINT = /release[\\/]+approvals(?![\\/]+README\.md\b)/i;
// Shell forms that create or replace a file without ever being a "command"
// the classifier would flag on its own. The redirect pattern excludes `=>`,
// `->`, `>=`, and `>>=` so ordinary code in a command line is not mistaken for
// one — a guard that cries wolf gets worked around.
const REDIRECT = /(?<![-=<>!])>{1,2}(?!=)/;
const COPY_OR_CREATE = /\|\s*tee\b|\b(?:cp|copy|mv|move|touch|new-item|set-content|add-content|out-file|copy-item|move-item)\b/i;

function releaseRunActive(env) {
  const mode = String((env && env.RELEASE_HARNESS_MODE) || '').trim().toLowerCase();
  const runId = String((env && env.RELEASE_RUN_ID) || '').trim();
  return Boolean(mode || runId);
}

function deny(reason) {
  return Object.freeze({ decision: 'deny', reason });
}

function defer() {
  return Object.freeze({ decision: 'defer', reason: null });
}

function evaluateBash(command, env) {
  if (typeof command !== 'string' || !command.trim()) {
    return deny('The release guard could not read a command from the tool input, so it refused the call.');
  }
  if (APPROVAL_HINT.test(command) && (REDIRECT.test(command) || COPY_OR_CREATE.test(command) || !core.isReadOnlyCommand(command))) {
    return deny('release/approvals/ is human-only. An agent may never create, edit, or delete a production approval record. See docs/release-gates.md, gate G6.');
  }
  // SQL passed to a client is a command line as far as this guard is concerned.
  const sqlFindings = core.classifySecurityContent('inline-command.sql', command);
  if (sqlFindings.length) {
    return deny(`Refused (${sqlFindings[0].code}): ${sqlFindings[0].reason}`);
  }
  const outcome = core.classifyCommand(command);
  if (outcome.classification === core.PRODUCTION) {
    return deny(`Refused: this is a production action (${outcome.rule}). The release harness halts at gate G7 and hands production steps to an operator. See docs/release-plan.md section R7.`);
  }
  if (outcome.classification === core.DESTRUCTIVE) {
    return deny(`Refused: this is a destructive action (${outcome.rule}). It discards local state that is not trivially recoverable, and needs explicit per-run authorization from the operator.`);
  }
  return defer();
}

function evaluateWrite(toolInput, env) {
  const target = PATH_FIELDS.map(field => toolInput && toolInput[field]).find(value => typeof value === 'string' && value.trim());
  if (!target) {
    return deny('The release guard could not read a target path from the tool input, so it refused the write.');
  }
  const classified = core.classifyPath(target);
  if (classified.kind === 'approval') {
    return deny('release/approvals/ is human-only. An agent may never create, edit, or delete a production approval record. See docs/release-gates.md, gate G6.');
  }
  // Content rules apply in every mode. Disabling RLS, publishing the proof
  // bucket, or embedding an elevated key is never in scope for an agent,
  // release run or not.
  const proposed = [toolInput.content, toolInput.new_string, toolInput.newString, toolInput.new_source]
    .filter(value => typeof value === 'string')
    .join('\n');
  const findings = core.classifySecurityContent(target, proposed);
  if (findings.length) {
    return deny(`Refused (${findings[0].code}) for ${classified.relative}: ${findings[0].reason}`);
  }
  if (!releaseRunActive(env)) return defer();
  if (classified.kind === 'product-code') {
    return deny(`Refused while a release run is active: ${classified.relative} is product code. A release run verifies and reports; it does not change what it is releasing.`);
  }
  if (classified.kind === 'harness') {
    return deny(`Refused while a release run is active: ${classified.relative} is part of the release harness. A run may not rewrite the rules it is being judged by.`);
  }
  return defer();
}

function evaluate(event, env) {
  if (!event || typeof event !== 'object') {
    return deny('The release guard received an unreadable hook event and refused the call.');
  }
  const toolName = String(event.tool_name || event.toolName || '');
  const toolInput = event.tool_input || event.toolInput || {};
  if (toolName === 'Bash' || toolName === 'BashOutput') {
    return evaluateBash(toolInput && toolInput.command, env);
  }
  if (WRITE_TOOLS.has(toolName)) {
    return evaluateWrite(toolInput, env);
  }
  return defer();
}

// Synchronous, because a hook decision cannot be asynchronous. A pipe that is
// not ready yet reports EAGAIN; that is a timing artefact, not a verdict, so it
// is retried briefly instead of being treated as an empty event.
function readStdin() {
  const fs = require('node:fs');
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch (error) {
      if (!error || error.code !== 'EAGAIN') throw error;
      Atomics.wait(idle, 0, 0, 20);
    }
  }
  throw new Error('stdin did not become readable.');
}

function main(streams = process, env = process.env) {
  let outcome;
  try {
    const raw = readStdin();
    outcome = evaluate(raw.trim() ? JSON.parse(raw) : null, env);
  } catch (error) {
    outcome = deny(`The release guard failed to evaluate this call and refused it: ${core.redact(error && error.message || error)}`);
  }
  if (outcome.decision === 'deny') {
    streams.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: core.redact(outcome.reason)
      }
    })}\n`);
  }
  return 0;
}

module.exports = Object.freeze({ evaluate, evaluateBash, evaluateWrite, main, releaseRunActive });

if (require.main === module) {
  process.exitCode = main();
}

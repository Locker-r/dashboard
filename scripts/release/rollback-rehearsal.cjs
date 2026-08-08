#!/usr/bin/env node
'use strict';

// Rollback rehearsal. Proves a candidate rollback target is usable and
// prints the exact human sequence a rollback would take — and executes none
// of it. See docs/decisions.md ADR-016.
//
// Rollback policy in this repository is roll-forward only: revert the bad
// change through the normal PR flow, cut a higher vX.Y.Z, and let it
// redeploy through the same tag-triggered, production-environment-gated
// workflow every other release uses. This script never invokes Wrangler,
// never calls the Cloudflare API, never creates, moves, or pushes a tag, and
// never dispatches a workflow — a rollback gets no lighter a gate than a
// forward deploy.

const { spawnSync } = require('node:child_process');
const verifier = require('../verify-production-deployment.cjs');
const artifact = require('../build-pages-artifact.cjs');

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });
const USAGE = 'usage: node scripts/release/rollback-rehearsal.cjs --target vX.Y.Z [--json]';

function createDeps(overrides = {}) {
  return Object.freeze({
    run: (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options }),
    fetchUrl: verifier.httpsGetBuffer,
    log: line => process.stderr.write(`${line}\n`),
    emit: line => process.stdout.write(`${line}\n`),
    ...overrides
  });
}

function parseArgs(argv) {
  let target = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--target') {
      if (!argv[index + 1]) return { error: '--target requires a value' };
      target = argv[index + 1];
      index += 1;
    } else if (value === '--json') {
      json = true;
    } else {
      return { error: `unsupported argument: ${value}` };
    }
  }
  if (!target) return { error: '--target is required' };
  return { target, json };
}

function isAncestorOfMain(deps, sha) {
  const result = deps.run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  return result.status === 0;
}

function humanRollbackSequence(target) {
  return [
    `1. Identify the bad commit and open a revert: git revert <bad-commit-sha> (a normal, reviewed pull request).`,
    `2. Merge the revert PR to main once required checks pass (docs/release-governance.md "Merge policy").`,
    `3. Open a release pull request: bump "version" in package.json to a new vX.Y.Z higher than ${target}, and close the "## [Unreleased]" section in CHANGELOG.md (docs/release-governance.md "Release flow").`,
    `4. Merge the release pull request once required checks pass.`,
    `5. Tag the merge commit and push it: git tag -a v<newVersion> -m "v<newVersion>" && git push origin v<newVersion>.`,
    `6. .github/workflows/production-pages-deploy.yml runs automatically for that tag and waits on the "production" GitHub environment's own approval gate — a human approves it there, exactly as for any other release.`,
    `7. Once the run completes, verify the redeploy: node scripts/verify-production-deployment.cjs --tag v<newVersion>.`,
    ``,
    `Break-glass (only if production is broken and there is no time for the sequence above): a human may roll back directly from the Cloudflare dashboard. This repository contains no automation for that path. It must be reconciled afterward by the sequence above, so the live bytes correspond to a tag again.`
  ];
}

function report(deps, json, ok, code, detail, extra = {}) {
  if (json) {
    deps.emit(JSON.stringify({ schemaVersion: 1, ok, code, detail, ...extra }));
  } else {
    deps.log(`${ok ? 'Rehearsal proved usable' : 'Refused'} [${code}]: ${detail}`);
    for (const line of extra.lines || []) deps.log(`  - ${line}`);
  }
}

async function main(argv, overrides = {}) {
  const deps = createDeps(overrides);
  try {
    const parsed = parseArgs(argv);
    if (parsed.error) {
      deps.log(`${parsed.error}\n${USAGE}`);
      return EXIT.USAGE;
    }
    const { target, json } = parsed;
    if (!verifier.TAG_PATTERN.test(target)) {
      report(deps, json, false, 'TARGET_FORMAT_INVALID', `--target must match vMAJOR.MINOR.PATCH (got ${target}).`);
      return EXIT.VALIDATION;
    }
    const targetVersion = target.slice(1);

    const targetSha = verifier.resolveTagCommit(deps, target);
    if (!targetSha) {
      report(deps, json, false, 'TARGET_UNRESOLVABLE', `${target} does not resolve to a commit in this checkout.`);
      return EXIT.BLOCKED;
    }
    if (!verifier.isAnnotatedTag(deps, target)) {
      report(deps, json, false, 'TARGET_NOT_ANNOTATED', `${target} is not an annotated tag.`);
      return EXIT.BLOCKED;
    }
    if (!isAncestorOfMain(deps, targetSha)) {
      report(deps, json, false, 'TARGET_NOT_ANCESTOR_OF_MAIN', `${target} (${targetSha}) is not an ancestor of origin/main.`);
      return EXIT.BLOCKED;
    }

    const runs = await verifier.fetchProductionRuns(deps);
    const { run, attempts } = verifier.findQualifyingRun(runs, target, targetSha);
    if (!run) {
      report(deps, json, false, 'TARGET_HAS_NO_SUCCESSFUL_DEPLOY', `No successful production-pages-deploy.yml run found for ${target}. Only a tag that has itself been deployed can be a rollback target.`, {
        lines: attempts.slice(0, 10).map(attempt => `run ${attempt.runId} (${attempt.sha}): ${attempt.reason}`)
      });
      return EXIT.BLOCKED;
    }

    const metadata = verifier.readTaggedPackageMetadata(deps, target);
    if (metadata.version !== targetVersion) {
      report(deps, json, false, 'TARGET_VERSION_MISMATCH', `package.json at ${target} records version ${metadata.version}, not ${targetVersion}.`);
      return EXIT.BLOCKED;
    }
    const expectedHashes = verifier.rebuildExpectedHashes(deps, target);
    const manifest = {
      schemaVersion: 1,
      application: metadata.application,
      version: targetVersion,
      files: [...expectedHashes.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
    };
    const expectedDigest = artifact.sha256(Buffer.from(artifact.canonicalJson(manifest), 'utf8'));

    // Best-effort only: the live site may already be broken, which is
    // exactly when a rollback is being rehearsed, so an unreachable or
    // mismatched live manifest never blocks the rehearsal — it is reported,
    // not enforced.
    let liveComparison = 'not attempted';
    try {
      const { manifest: liveManifest, status } = await verifier.fetchLiveManifest(deps);
      if (!liveManifest) {
        liveComparison = `live manifest unreachable (HTTP ${status})`;
      } else {
        const byteResult = verifier.verifyByteProvenance(liveManifest, targetVersion, metadata.application, expectedHashes);
        liveComparison = byteResult.ok
          ? `live deployment already matches ${target}`
          : `live deployment differs from ${target}: ${byteResult.mismatches.join('; ')}`;
      }
    } catch (error) {
      liveComparison = `live comparison failed: ${String(error && error.message || error)}`;
    }

    const sequence = humanRollbackSequence(target);
    report(deps, json, true, 'REHEARSAL_PROVED_USABLE', `${target} (run ${run.id}) is a usable rollback target.`, {
      target, runId: run.id, expectedDigest, liveComparison, sequence
    });
    if (!json) {
      deps.log(`Source-derived digest (excludes environment-specific runtime configuration): ${expectedDigest}`);
      deps.log(`Live comparison: ${liveComparison}`);
      deps.log('');
      deps.log('Human rollback sequence (nothing below is executed by this script):');
      for (const line of sequence) deps.log(line);
    }
    return EXIT.OK;
  } catch (error) {
    deps.log(`Refused: ${String(error && error.message || error)}`);
    return EXIT.INTERNAL;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = Object.freeze({ main, parseArgs, isAncestorOfMain, humanRollbackSequence, report, EXIT, USAGE });

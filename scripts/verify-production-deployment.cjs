#!/usr/bin/env node
'use strict';

// Read-only production deployment verifier. Proves three independent facts
// about a released tag, all without holding any Cloudflare or Supabase
// credential:
//
//   A. Run provenance — a `production-pages-deploy.yml` run for the exact
//      tag completed successfully (read via `gh api`, an unambiguous GET).
//   B. Byte provenance — the manifest served by the live production domain
//      names the tag's version, and every file whose content is fully
//      determined by tracked source (index.html and the runtime source
//      files, not the environment-specific runtime-config.js) hashes to
//      exactly what the tagged commit would produce.
//   C. Liveness — every file the live manifest lists is actually served,
//      with bytes matching the manifest's own stated hash.
//
// With no production deployment ever recorded, this fails closed with
// NO_PRODUCTION_DEPLOYMENT_YET rather than passing vacuously — there is
// nothing yet to have verified.
//
// See docs/decisions.md ADR-016 and docs/release-gates.md.

const { spawnSync } = require('node:child_process');
const { request } = require('node:https');
const artifact = require('./build-pages-artifact.cjs');

const OWNER = 'Locker-r';
const REPO = 'dashboard';
const WORKFLOW_FILE = 'production-pages-deploy.yml';
const PRODUCTION_HOST = 'dashboard-latam.pages.dev';
const RUNS_PER_PAGE = 30;
const TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const EXIT = Object.freeze({ OK: 0, VALIDATION: 1, BLOCKED: 2, USAGE: 64, INTERNAL: 70 });
const USAGE = 'usage: node scripts/verify-production-deployment.cjs --tag vX.Y.Z [--json]';

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function createDeps(overrides = {}) {
  return Object.freeze({
    run: (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options }),
    fetchUrl: httpsGetBuffer,
    log: line => process.stderr.write(`${line}\n`),
    emit: line => process.stdout.write(`${line}\n`),
    ...overrides
  });
}

function parseArgs(argv) {
  let tag = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--tag') {
      if (!argv[index + 1]) return { error: '--tag requires a value' };
      tag = argv[index + 1];
      index += 1;
    } else if (value === '--json') {
      json = true;
    } else {
      return { error: `unsupported argument: ${value}` };
    }
  }
  if (!tag) return { error: '--tag is required' };
  return { tag, json };
}

function resolveTagCommit(deps, tag) {
  const result = deps.run('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim().toLowerCase();
}

function isAnnotatedTag(deps, tag) {
  const result = deps.run('git', ['cat-file', '-t', tag]);
  return result.status === 0 && String(result.stdout || '').trim() === 'tag';
}

// `gh api` fields build a request body and force a mutating method even on a
// listing endpoint — the exact opposite of what this script may ever do. A
// literal query string keeps every request an unambiguous GET.
async function fetchProductionRuns(deps) {
  const result = deps.run('gh', [
    'api', `repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${RUNS_PER_PAGE}&event=push`
  ]);
  if (result.status !== 0) {
    throw new Error(`GH_API_FAILED:${String(result.stderr || result.error || '').trim().slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('GH_API_RESPONSE_INVALID'); }
  if (!parsed || !Array.isArray(parsed.workflow_runs)) throw new Error('GH_API_RESPONSE_INVALID');
  return parsed.workflow_runs;
}

function findQualifyingRun(runs, tag, tagSha) {
  const attempts = [];
  for (const run of runs) {
    const sha = String(run && run.head_sha || '').toLowerCase();
    const branch = String(run && run.head_branch || '');
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      attempts.push({ runId: run && run.id, sha, reason: `status=${run && run.status} conclusion=${run && run.conclusion}` });
      continue;
    }
    if (run.event !== 'push' || branch !== tag) {
      attempts.push({ runId: run.id, sha, reason: `not a push of ${tag} (event=${run.event} head_branch=${branch})` });
      continue;
    }
    if (sha !== tagSha) {
      attempts.push({ runId: run.id, sha, reason: `head_sha does not match ${tag}'s commit (${tagSha})` });
      continue;
    }
    return { run, attempts };
  }
  return { run: null, attempts };
}

function readTaggedFile(deps, tag, relativePath) {
  const result = deps.run('git', ['show', `${tag}:${relativePath}`], { encoding: null });
  if (result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout || ''), 'binary');
}

function readTaggedPackageMetadata(deps, tag) {
  const buffer = readTaggedFile(deps, tag, 'package.json');
  if (!buffer) throw new Error('TAGGED_PACKAGE_JSON_MISSING');
  let parsed;
  try {
    parsed = JSON.parse(artifact.normalizeText(buffer, 'package.json'));
  } catch {
    throw new Error('TAGGED_PACKAGE_JSON_INVALID');
  }
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('TAGGED_PACKAGE_JSON_INVALID');
  }
  return { application: parsed.name, version: parsed.version };
}

// Rebuilds the exact bytes the tagged commit would produce for every file
// whose content does not depend on a secret, reusing build-pages-artifact.cjs's
// own normalization/transform/hash functions so this is the same pipeline,
// not a parallel reimplementation of it.
function rebuildExpectedHashes(deps, tag) {
  // artifact.SOURCE_FILES is index.html plus the tracked runtime source
  // files; it never includes config/runtime-config.js (generated from
  // environment secrets, not tracked) or .nojekyll (synthetic, not read from
  // source) — exactly the files this function can honestly reproduce.
  const hashes = new Map();
  for (const relativePath of artifact.SOURCE_FILES) {
    const buffer = readTaggedFile(deps, tag, relativePath);
    if (!buffer) throw new Error(`TAGGED_SOURCE_MISSING:${relativePath}`);
    const normalized = artifact.normalizeText(buffer, relativePath);
    const content = relativePath === 'index.html' ? artifact.transformIndex(normalized) : normalized;
    const bytes = Buffer.from(content, 'utf8');
    hashes.set(relativePath, { path: relativePath, size: bytes.length, sha256: artifact.sha256(bytes) });
  }
  return hashes;
}

async function fetchLiveManifest(deps) {
  const response = await deps.fetchUrl(`https://${PRODUCTION_HOST}/${artifact.MANIFEST_PATH}`);
  if (response.status !== 200) return { manifest: null, status: response.status };
  let manifest;
  try {
    manifest = JSON.parse(response.body.toString('utf8'));
  } catch {
    return { manifest: null, status: response.status };
  }
  return { manifest, status: response.status };
}

function verifyByteProvenance(manifest, tagVersion, expectedApplication, expectedHashes) {
  const mismatches = [];
  if (manifest.application !== expectedApplication) {
    mismatches.push(`application: live=${manifest.application} expected=${expectedApplication}`);
  }
  if (manifest.version !== tagVersion) {
    mismatches.push(`version: live=${manifest.version} expected=${tagVersion}`);
  }
  if (!Array.isArray(manifest.files)) {
    mismatches.push('files: manifest.files is not an array');
    return { ok: false, mismatches };
  }
  const byPath = new Map(manifest.files.map(entry => [entry && entry.path, entry]));
  const expectedPathSet = new Set([...artifact.PAYLOAD_FILES]);
  const livePathSet = new Set(manifest.files.map(entry => entry && entry.path));
  for (const expected of expectedPathSet) {
    if (!livePathSet.has(expected)) mismatches.push(`files: live manifest is missing ${expected}`);
  }
  for (const live of livePathSet) {
    if (!expectedPathSet.has(live)) mismatches.push(`files: live manifest lists unexpected path ${live}`);
  }
  for (const [relativePath, expected] of expectedHashes) {
    const live = byPath.get(relativePath);
    if (!live) continue; // already reported above
    if (live.sha256 !== expected.sha256 || live.size !== expected.size) {
      mismatches.push(`${relativePath}: live sha256=${live.sha256} size=${live.size}, expected sha256=${expected.sha256} size=${expected.size}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

async function verifyLiveness(deps, manifest) {
  const mismatches = [];
  for (const entry of manifest.files) {
    const relativePath = entry && entry.path;
    if (typeof relativePath !== 'string' || !relativePath) {
      mismatches.push('files: manifest entry has no path');
      continue;
    }
    let response;
    try {
      response = await deps.fetchUrl(`https://${PRODUCTION_HOST}/${relativePath}`);
    } catch (error) {
      mismatches.push(`${relativePath}: fetch failed (${String(error && error.message || error)})`);
      continue;
    }
    if (response.status !== 200) {
      mismatches.push(`${relativePath}: HTTP ${response.status}`);
      continue;
    }
    const sha256 = artifact.sha256(response.body);
    if (sha256 !== entry.sha256 || response.body.length !== entry.size) {
      mismatches.push(`${relativePath}: served sha256=${sha256} size=${response.body.length}, manifest claims sha256=${entry.sha256} size=${entry.size}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function report(deps, json, ok, code, detail, extra = {}) {
  if (json) {
    deps.emit(JSON.stringify({ schemaVersion: 1, ok, code, detail, ...extra }));
  } else {
    deps.log(`${ok ? 'Verified' : 'Refused'} [${code}]: ${detail}`);
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
    const { tag, json } = parsed;
    if (!TAG_PATTERN.test(tag)) {
      report(deps, json, false, 'TAG_FORMAT_INVALID', `--tag must match vMAJOR.MINOR.PATCH (got ${tag}).`);
      return EXIT.VALIDATION;
    }
    const tagVersion = tag.slice(1);

    const runs = await fetchProductionRuns(deps);
    if (!runs.length) {
      report(deps, json, false, 'NO_PRODUCTION_DEPLOYMENT_YET', 'No production-pages-deploy.yml runs exist. No production deployment has ever occurred.');
      return EXIT.BLOCKED;
    }

    const tagSha = resolveTagCommit(deps, tag);
    if (!tagSha) {
      report(deps, json, false, 'TAG_UNRESOLVABLE', `${tag} does not resolve to a commit in this checkout.`);
      return EXIT.BLOCKED;
    }
    if (!isAnnotatedTag(deps, tag)) {
      report(deps, json, false, 'TAG_NOT_ANNOTATED', `${tag} is not an annotated tag.`);
      return EXIT.BLOCKED;
    }

    const { run, attempts } = findQualifyingRun(runs, tag, tagSha);
    if (!run) {
      report(deps, json, false, 'NO_QUALIFYING_RUN', `No successful production-pages-deploy.yml run found for ${tag}.`, {
        lines: attempts.slice(0, 10).map(attempt => `run ${attempt.runId} (${attempt.sha}): ${attempt.reason}`)
      });
      return EXIT.BLOCKED;
    }

    const { manifest, status } = await fetchLiveManifest(deps);
    if (!manifest) {
      report(deps, json, false, 'LIVE_MANIFEST_UNREACHABLE', `Could not read https://${PRODUCTION_HOST}/${artifact.MANIFEST_PATH} (HTTP ${status}).`);
      return EXIT.BLOCKED;
    }

    const metadata = readTaggedPackageMetadata(deps, tag);
    if (metadata.version !== tagVersion) {
      report(deps, json, false, 'TAG_VERSION_MISMATCH', `package.json at ${tag} records version ${metadata.version}, not ${tagVersion}.`);
      return EXIT.BLOCKED;
    }
    const expectedHashes = rebuildExpectedHashes(deps, tag);
    const byteResult = verifyByteProvenance(manifest, tagVersion, metadata.application, expectedHashes);
    if (!byteResult.ok) {
      report(deps, json, false, 'BYTE_PROVENANCE_MISMATCH', 'The live manifest does not match the tagged commit.', { lines: byteResult.mismatches });
      return EXIT.BLOCKED;
    }

    const livenessResult = await verifyLiveness(deps, manifest);
    if (!livenessResult.ok) {
      report(deps, json, false, 'LIVENESS_MISMATCH', 'A file the manifest lists did not serve as claimed.', { lines: livenessResult.mismatches });
      return EXIT.BLOCKED;
    }

    report(deps, json, true, 'VERIFIED', `${tag} is live at https://${PRODUCTION_HOST}/, run ${run.id}.`, { runId: run.id, tag, version: tagVersion });
    return EXIT.OK;
  } catch (error) {
    deps.log(`Refused: ${String(error && error.message || error)}`);
    return EXIT.INTERNAL;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = Object.freeze({
  main, createDeps, parseArgs, resolveTagCommit, isAnnotatedTag, fetchProductionRuns, findQualifyingRun,
  readTaggedFile, readTaggedPackageMetadata, rebuildExpectedHashes, fetchLiveManifest,
  verifyByteProvenance, verifyLiveness, report, httpsGetBuffer,
  OWNER, REPO, WORKFLOW_FILE, PRODUCTION_HOST, TAG_PATTERN, EXIT, USAGE
});

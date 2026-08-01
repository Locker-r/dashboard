'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder } = require('node:util');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIRECTORY = path.join(PROJECT_ROOT, 'artifacts', 'pages-site');
const MANIFEST_PATH = 'deployment-manifest.json';
const RUNTIME_CONFIG_PATH = 'config/runtime-config.js';

const RUNTIME_SOURCE_FILES = Object.freeze([
  'vendor/supabase.js',
  'src/supabase-auth-service.js',
  'src/migration-preflight.js',
  'src/test-data-cleanup.js',
  'src/domain.js',
  'src/auth.js',
  'src/analytics.js',
  'src/lead-import.js',
  'src/data/data-service.js',
  'src/data/local-storage-data-service.js',
  'src/data/supabase-data-service.js',
  'src/data/data-service-factory.js',
  'src/contact-reveal.js'
]);

const SOURCE_FILES = Object.freeze(['index.html', ...RUNTIME_SOURCE_FILES]);
const PAYLOAD_FILES = Object.freeze([
  '.nojekyll',
  RUNTIME_CONFIG_PATH,
  'index.html',
  ...RUNTIME_SOURCE_FILES
].sort());
const ARTIFACT_FILES = Object.freeze([...PAYLOAD_FILES, MANIFEST_PATH].sort());
const ARTIFACT_DIRECTORIES = Object.freeze(['config', 'src', 'src/data', 'vendor'].sort());

const LOCAL_SUPABASE_TAG = '<script src="./config/supabase-config.local.js"></script>';
const LOCAL_DATA_TAG = '<script src="./config/data-config.local.js"></script>';
const LOCAL_CONFIG_BLOCK = `${LOCAL_SUPABASE_TAG}\n${LOCAL_DATA_TAG}`;
const RUNTIME_CONFIG_TAG = '<script src="./config/runtime-config.js"></script>';

const EXPECTED_SCRIPT_REFERENCES = Object.freeze([
  './config/runtime-config.js',
  ...RUNTIME_SOURCE_FILES.map(file => `./${file}`)
]);
const EXPECTED_EXTERNAL_LINKS = Object.freeze([
  'https://fonts.googleapis.com',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap'
].sort());
const FORBIDDEN_RESOURCE_TAGS = Object.freeze([
  'audio', 'base', 'embed', 'frame', 'iframe', 'img', 'object', 'portal',
  'source', 'track', 'video'
]);
const URL_ATTRIBUTE_NAMES = Object.freeze([
  'action', 'background', 'cite', 'data', 'formaction', 'href', 'manifest',
  'poster', 'src', 'srcset', 'xlink:href'
]);

const CONFIG_ENV = Object.freeze({
  projectUrl: 'DASHBOARD_SUPABASE_PROJECT_URL',
  publishableKey: 'DASHBOARD_SUPABASE_PUBLISHABLE_KEY'
});
const PLACEHOLDER_PATTERN = /(?:YOUR_|PLACEHOLDER|CHANGE[ _-]?ME|REPLACE[ _-]?ME|EXAMPLE)/i;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SECRET_KEY_PATTERN = new RegExp('sb_' + 'secret_[A-Za-z0-9_-]{16,}', 'gi');
const GITHUB_TOKEN_PATTERN = new RegExp('gh' + '[opsu]_[A-Za-z0-9]{20,}', 'g');
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const decoder = new TextDecoder('utf-8', { fatal: true });

class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArtifactError(code, message);
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function normalizeText(buffer, label = 'text input') {
  let value;
  try {
    value = decoder.decode(buffer);
  } catch {
    fail('INVALID_UTF8', `${label} is not valid UTF-8.`);
  }
  if (value.startsWith('\uFEFF')) value = value.slice(1);
  return value.replace(/\r\n?/g, '\n');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function assertRegularSource(sourceRoot, relativePath) {
  const candidate = path.resolve(sourceRoot, ...relativePath.split('/'));
  if (!isInside(sourceRoot, candidate) || samePath(sourceRoot, candidate)) {
    fail('SOURCE_PATH_ESCAPE', `Approved source path escapes the source root: ${relativePath}.`);
  }

  let info;
  try {
    info = fs.lstatSync(candidate);
  } catch {
    fail('SOURCE_MISSING', `Approved source file is missing: ${relativePath}.`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('SOURCE_NOT_REGULAR', `Approved source is not a regular file: ${relativePath}.`);
  }
  if (info.nlink !== 1) {
    fail('SOURCE_HARDLINK', `Approved source has multiple hard links: ${relativePath}.`);
  }

  const resolved = fs.realpathSync(candidate);
  if (!isInside(sourceRoot, resolved)) {
    fail('SOURCE_PATH_ESCAPE', `Approved source resolves outside the source root: ${relativePath}.`);
  }
  return candidate;
}

function resolveSourceRoot(sourceRoot) {
  const requested = path.resolve(sourceRoot || PROJECT_ROOT);
  let info;
  try {
    info = fs.lstatSync(requested);
  } catch {
    fail('SOURCE_ROOT_MISSING', 'Source root does not exist.');
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('SOURCE_ROOT_INVALID', 'Source root must be a real directory.');
  }
  return fs.realpathSync(requested);
}

function readSourceText(sourceRoot, relativePath) {
  const source = assertRegularSource(sourceRoot, relativePath);
  return normalizeText(fs.readFileSync(source), relativePath);
}

function readApplicationMetadata(sourceRoot) {
  const text = readSourceText(sourceRoot, 'package.json');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('PACKAGE_INVALID', 'package.json is not valid JSON.');
  }
  if (
    !parsed ||
    typeof parsed.name !== 'string' ||
    parsed.name.length === 0 ||
    parsed.name.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(parsed.name) ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0 ||
    parsed.version.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(parsed.version)
  ) {
    fail('PACKAGE_INVALID', 'package.json must contain bounded, control-free name and version strings.');
  }
  return Object.freeze({ application: parsed.name, version: parsed.version });
}

function validateRuntimeInputs(input = {}) {
  const projectUrl = input.projectUrl;
  const publishableKey = input.publishableKey;

  if (typeof projectUrl !== 'string' || projectUrl.length === 0) {
    fail('CONFIG_URL_MISSING', 'Supabase project URL is required.');
  }
  if (typeof publishableKey !== 'string' || publishableKey.length === 0) {
    fail('CONFIG_KEY_MISSING', 'Supabase publishable key is required.');
  }
  if (projectUrl.trim() !== projectUrl || /[\u0000-\u001f\u007f]/.test(projectUrl)) {
    fail('CONFIG_URL_INVALID', 'Supabase project URL has invalid whitespace or control characters.');
  }
  if (publishableKey.trim() !== publishableKey || /[\u0000-\u001f\u007f]/.test(publishableKey)) {
    fail('CONFIG_KEY_INVALID', 'Supabase publishable key has invalid whitespace or control characters.');
  }
  if (PLACEHOLDER_PATTERN.test(projectUrl) || PLACEHOLDER_PATTERN.test(publishableKey)) {
    fail('CONFIG_PLACEHOLDER', 'Runtime configuration contains a placeholder.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(projectUrl);
  } catch {
    fail('CONFIG_URL_INVALID', 'Supabase project URL is invalid.');
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.port !== '' ||
    (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== '' ||
    !/^[a-z0-9]+\.supabase\.co$/i.test(parsedUrl.hostname)
  ) {
    fail('CONFIG_URL_INVALID', 'Supabase project URL must be an HTTPS Supabase project root.');
  }
  if (projectUrl !== parsedUrl.origin && projectUrl !== `${parsedUrl.origin}/`) {
    fail('CONFIG_URL_INVALID', 'Supabase project URL must contain only the canonical project origin.');
  }

  JWT_PATTERN.lastIndex = 0;
  SECRET_KEY_PATTERN.lastIndex = 0;
  if (
    JWT_PATTERN.test(publishableKey) ||
    SECRET_KEY_PATTERN.test(publishableKey) ||
    /service[ _-]?role/i.test(publishableKey) ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(publishableKey)
  ) {
    fail('CONFIG_KEY_INVALID', 'Supabase key must use the approved publishable-key class.');
  }

  return Object.freeze({
    projectUrl: parsedUrl.origin,
    publishableKey
  });
}

function generateRuntimeConfig(input) {
  const config = validateRuntimeInputs(input);
  const url = JSON.stringify(config.projectUrl).replace(/[\u2028\u2029]/g, character => character === '\u2028' ? '\\u2028' : '\\u2029');
  const key = JSON.stringify(config.publishableKey).replace(/[\u2028\u2029]/g, character => character === '\u2028' ? '\\u2028' : '\\u2029');
  return [
    '(function configureRuntime(root) {',
    "  'use strict';",
    '',
    '  root.REACTIVATION_SUPABASE_CONFIG = Object.freeze({',
    `    projectUrl: ${url},`,
    `    publishableKey: ${key}`,
    '  });',
    "  root.REACTIVATION_DATA_CONFIG = Object.freeze({ mode: 'supabase' });",
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
  ].join('\n');
}

function parseCanonicalRuntimeConfig(source) {
  const match = source.match(/^\(function configureRuntime\(root\) \{\n  'use strict';\n\n  root\.REACTIVATION_SUPABASE_CONFIG = Object\.freeze\(\{\n    projectUrl: ("https:\/\/[A-Za-z0-9.]+"),\n    publishableKey: ("sb_publishable_[A-Za-z0-9_-]+")\n  \}\);\n  root\.REACTIVATION_DATA_CONFIG = Object\.freeze\(\{ mode: 'supabase' \}\);\n\}\)\(typeof globalThis !== 'undefined' \? globalThis : this\);\n$/);
  if (!match) {
    fail('RUNTIME_CONFIG_FORMAT_INVALID', 'Runtime configuration is not in the canonical generated format.');
  }

  let parsed;
  try {
    parsed = validateRuntimeInputs({
      projectUrl: JSON.parse(match[1]),
      publishableKey: JSON.parse(match[2])
    });
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    fail('RUNTIME_CONFIG_FORMAT_INVALID', 'Runtime configuration values are not canonical JSON strings.');
  }
  if (generateRuntimeConfig(parsed) !== source) {
    fail('RUNTIME_CONFIG_FORMAT_INVALID', 'Runtime configuration bytes are not canonical.');
  }
  return parsed;
}

function transformIndex(sourceIndex) {
  const normalized = typeof sourceIndex === 'string'
    ? sourceIndex.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    : normalizeText(sourceIndex, 'index.html');

  if (
    countOccurrences(normalized, LOCAL_CONFIG_BLOCK) !== 1 ||
    countOccurrences(normalized, LOCAL_SUPABASE_TAG) !== 1 ||
    countOccurrences(normalized, LOCAL_DATA_TAG) !== 1 ||
    countOccurrences(normalized, RUNTIME_CONFIG_TAG) !== 0
  ) {
    fail('INDEX_CONFIG_ANCHOR_INVALID', 'index.html does not contain exactly one approved local configuration block.');
  }

  const transformed = normalized.replace(LOCAL_CONFIG_BLOCK, RUNTIME_CONFIG_TAG);
  if (countOccurrences(transformed, RUNTIME_CONFIG_TAG) !== 1 || transformed.includes('.local.js')) {
    fail('INDEX_TRANSFORM_INVALID', 'index.html configuration transformation was not exact.');
  }
  return transformed;
}

function writeArtifactFile(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function createManifest(artifactRoot, metadata) {
  const files = PAYLOAD_FILES.map(relativePath => {
    const buffer = fs.readFileSync(path.join(artifactRoot, ...relativePath.split('/')));
    return Object.freeze({ path: relativePath, size: buffer.length, sha256: sha256(buffer) });
  });
  return Object.freeze({
    schemaVersion: 1,
    application: metadata.application,
    version: metadata.version,
    files
  });
}

function inspectTree(root) {
  let rootInfo;
  try {
    rootInfo = fs.lstatSync(root);
  } catch {
    fail('ARTIFACT_MISSING', 'Artifact directory does not exist.');
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    fail('ARTIFACT_ROOT_INVALID', 'Artifact root must be a real directory.');
  }

  const canonicalRoot = fs.realpathSync(root);
  const files = [];
  const directories = [];

  function visit(directory, relativeDirectory = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const info = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        fail('ARTIFACT_LINK', `Artifact contains a symbolic link or junction: ${relative}.`);
      }
      const resolved = fs.realpathSync(absolute);
      if (!isInside(canonicalRoot, resolved)) {
        fail('ARTIFACT_PATH_ESCAPE', `Artifact entry resolves outside the root: ${relative}.`);
      }
      if (info.isDirectory()) {
        directories.push(relative);
        visit(absolute, relative);
      } else if (info.isFile()) {
        if (info.nlink !== 1) fail('ARTIFACT_HARDLINK', `Artifact contains a hard link: ${relative}.`);
        files.push(relative);
      } else {
        fail('ARTIFACT_SPECIAL_FILE', `Artifact contains a non-regular entry: ${relative}.`);
      }
    }
  }

  visit(canonicalRoot);
  return Object.freeze({ files: files.sort(), directories: directories.sort() });
}

function assertExactList(actual, expected, code, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(code, `${label} does not match the approved contract.`);
  }
}

function parseJavaScript(relativePath, source) {
  try {
    new vm.Script(source, { filename: relativePath });
  } catch {
    fail('ARTIFACT_JS_INVALID', `Artifact JavaScript does not parse: ${relativePath}.`);
  }
}

function validateRuntimeConfigExecution(source, expected) {
  const context = vm.createContext(Object.create(null));
  try {
    new vm.Script(source, { filename: RUNTIME_CONFIG_PATH }).runInContext(context, { timeout: 1000 });
  } catch {
    fail('RUNTIME_CONFIG_EXECUTION_INVALID', 'Generated runtime configuration cannot be evaluated safely.');
  }
  const supabase = context.REACTIVATION_SUPABASE_CONFIG;
  const data = context.REACTIVATION_DATA_CONFIG;
  if (
    Object.keys(context).sort().join(',') !== 'REACTIVATION_DATA_CONFIG,REACTIVATION_SUPABASE_CONFIG' ||
    !supabase || typeof supabase !== 'object' ||
    !data || typeof data !== 'object' ||
    Object.keys(supabase).join(',') !== 'projectUrl,publishableKey' ||
    Object.keys(data).join(',') !== 'mode' ||
    supabase.projectUrl !== expected.projectUrl ||
    supabase.publishableKey !== expected.publishableKey ||
    data.mode !== 'supabase' ||
    !Object.isFrozen(supabase) ||
    !Object.isFrozen(data)
  ) {
    fail('RUNTIME_CONFIG_SHAPE_INVALID', 'Generated runtime configuration has an unexpected shape.');
  }
}

function extractOpeningTags(html) {
  const tags = [];
  for (let start = 0; start < html.length; start += 1) {
    if (html[start] !== '<' || !/[a-z]/i.test(html[start + 1] || '')) continue;
    let quote = null;
    let end = -1;
    for (let offset = start + 1; offset < html.length; offset += 1) {
      const character = html[offset];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        end = offset;
        break;
      }
    }
    if (end === -1) fail('HTML_TAG_INVALID', 'HTML contains an unterminated opening tag.');
    const tag = html.slice(start, end + 1);
    const name = tag.match(/^<([a-z][a-z0-9:-]*)\b/i);
    if (name) tags.push(Object.freeze({ tagName: name[1].toLowerCase(), tag, start, end }));
  }
  return tags;
}

function inspectHtmlAttributes(html) {
  const references = [];
  for (const openingTag of extractOpeningTags(html)) {
    const { tagName, tag } = openingTag;
    if (FORBIDDEN_RESOURCE_TAGS.includes(tagName)) {
      fail('HTML_RESOURCE_TAG_INVALID', `HTML contains a forbidden resource tag: ${tagName}.`);
    }
    if (tagName === 'meta' && /\bhttp-equiv\s*=\s*["']?refresh\b/i.test(tag)) {
      fail('HTML_META_REFRESH_INVALID', 'HTML may not contain a meta refresh.');
    }
    if (/url\s*\(|@import\b/i.test(tag)) {
      fail('HTML_STYLE_REFERENCE_INVALID', 'HTML tag styles may not contain resource references.');
    }

    for (const attributeName of URL_ATTRIBUTE_NAMES) {
      const escapedName = attributeName.replace(':', '\\:');
      const assignmentPattern = new RegExp(`\\b${escapedName}\\s*=`, 'gi');
      const assignments = [...tag.matchAll(assignmentPattern)];
      if (assignments.length === 0) continue;

      const quotedPattern = new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([^"']*)\\1`, 'gi');
      const quoted = [...tag.matchAll(quotedPattern)];
      if (assignments.length !== 1 || quoted.length !== 1 || quoted[0][2] === '') {
        fail('HTML_ATTRIBUTE_INVALID', `HTML ${attributeName} attributes must be unique, non-empty, and quoted.`);
      }
      if (
        (attributeName === 'src' && tagName !== 'script') ||
        (attributeName === 'href' && tagName !== 'link') ||
        (attributeName !== 'src' && attributeName !== 'href')
      ) {
        fail('HTML_RESOURCE_REFERENCE_INVALID', `HTML contains an unapproved ${attributeName} resource reference.`);
      }
      references.push(Object.freeze({ tagName, attributeName, value: quoted[0][2] }));
    }

    if (tagName === 'style') {
      const closingOffset = html.toLowerCase().indexOf('</style', openingTag.end + 1);
      if (closingOffset === -1) fail('HTML_TAG_INVALID', 'HTML contains an unterminated style element.');
      const styleContent = html.slice(openingTag.end + 1, closingOffset);
      if (/url\s*\(|@import\b/i.test(styleContent)) {
        fail('HTML_STYLE_REFERENCE_INVALID', 'HTML styles may not contain resource references.');
      }
    }
  }
  return references;
}

function validateHtmlReferences(html) {
  const references = inspectHtmlAttributes(html);
  const scripts = references
    .filter(reference => reference.tagName === 'script' && reference.attributeName === 'src')
    .map(reference => reference.value);
  assertExactList(scripts, EXPECTED_SCRIPT_REFERENCES, 'HTML_SCRIPT_REFERENCES_INVALID', 'HTML script reference order');

  const links = references
    .filter(reference => reference.tagName === 'link' && reference.attributeName === 'href')
    .map(reference => reference.value);
  assertExactList(
    [...links].sort(),
    EXPECTED_EXTERNAL_LINKS,
    'HTML_EXTERNAL_REFERENCES_INVALID',
    'HTML link reference set'
  );

  const literalHttpsReferences = [...html.matchAll(/https:\/\/[^\s"'`<>\\)\]}]+/gi)]
    .map(match => match[0])
    .sort();
  assertExactList(
    literalHttpsReferences,
    EXPECTED_EXTERNAL_LINKS,
    'HTML_EXTERNAL_REFERENCES_INVALID',
    'HTML literal HTTPS reference set'
  );

  for (const reference of [...scripts, ...links]) {
    if (/^https:\/\//i.test(reference)) continue;
    if (!reference.startsWith('./')) fail('HTML_LOCAL_REFERENCE_INVALID', 'HTML contains an unapproved local reference.');
    const relative = path.posix.normalize(reference.slice(2));
    if (relative.startsWith('../') || !PAYLOAD_FILES.includes(relative)) {
      fail('HTML_LOCAL_REFERENCE_INVALID', 'HTML contains a local reference outside the artifact contract.');
    }
  }
}

function scanArtifactContent(artifactDirectory, config) {
  let keyOccurrences = 0;
  for (const relativePath of ARTIFACT_FILES) {
    const target = path.join(artifactDirectory, ...relativePath.split('/'));
    const text = normalizeText(fs.readFileSync(target), relativePath);
    keyOccurrences += countOccurrences(text, config.publishableKey);

    for (const [code, pattern] of [
      ['ARTIFACT_JWT', JWT_PATTERN],
      ['ARTIFACT_SECRET_KEY', SECRET_KEY_PATTERN],
      ['ARTIFACT_GITHUB_TOKEN', GITHUB_TOKEN_PATTERN],
      ['ARTIFACT_PRIVATE_KEY', PRIVATE_KEY_PATTERN]
    ]) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) fail(code, `Artifact contains forbidden credential-shaped content in ${relativePath}.`);
    }
  }
  if (keyOccurrences !== 1) {
    fail('ARTIFACT_KEY_LOCATION_INVALID', 'Publishable key must occur exactly once in the generated runtime configuration.');
  }
}

function validateManifest(artifactDirectory, metadata) {
  const manifestFile = path.join(artifactDirectory, MANIFEST_PATH);
  const manifestText = normalizeText(fs.readFileSync(manifestFile), MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail('MANIFEST_JSON_INVALID', 'Deployment manifest is not valid JSON.');
  }

  assertExactList(Object.keys(manifest), ['schemaVersion', 'application', 'version', 'files'], 'MANIFEST_SHAPE_INVALID', 'Manifest fields');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.application !== metadata.application ||
    manifest.version !== metadata.version ||
    !Array.isArray(manifest.files)
  ) {
    fail('MANIFEST_METADATA_INVALID', 'Deployment manifest metadata is invalid.');
  }

  const expectedManifest = createManifest(artifactDirectory, metadata);
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest) || manifestText !== canonicalJson(expectedManifest)) {
    fail('MANIFEST_CONTENT_INVALID', 'Deployment manifest does not match the artifact bytes.');
  }
  return Object.freeze({ manifest, digest: sha256(Buffer.from(manifestText, 'utf8')) });
}

function validateArtifactStructure(artifactDirectory) {
  const tree = inspectTree(artifactDirectory);
  assertExactList(tree.files, ARTIFACT_FILES, 'ARTIFACT_FILE_SET_INVALID', 'Artifact file set');
  assertExactList(tree.directories, ARTIFACT_DIRECTORIES, 'ARTIFACT_DIRECTORY_SET_INVALID', 'Artifact directory set');
  if (tree.files.length !== 17) fail('ARTIFACT_FILE_COUNT_INVALID', 'Artifact must contain exactly 17 files.');

  for (const relativePath of ARTIFACT_FILES) {
    const buffer = fs.readFileSync(path.join(artifactDirectory, ...relativePath.split('/')));
    const text = normalizeText(buffer, relativePath);
    if (Buffer.from(text, 'utf8').length !== buffer.length || buffer.includes(13)) {
      fail('ARTIFACT_TEXT_NOT_CANONICAL', `Artifact text is not canonical UTF-8/LF: ${relativePath}.`);
    }
    if (relativePath.endsWith('.js')) parseJavaScript(relativePath, text);
  }

  if (fs.readFileSync(path.join(artifactDirectory, '.nojekyll')).length !== 0) {
    fail('NOJEKYLL_INVALID', '.nojekyll must be empty.');
  }
  return tree;
}

function validateOwnedExistingArtifact(options = {}) {
  const artifactDirectory = path.resolve(options.artifactDirectory);
  const application = options.application;
  try {
    if (typeof application !== 'string' || !application) {
      fail('OUTPUT_EXISTING_UNOWNED', 'Expected application ownership marker is missing.');
    }
    const tree = validateArtifactStructure(artifactDirectory);
    const index = fs.readFileSync(path.join(artifactDirectory, 'index.html'), 'utf8');
    validateHtmlReferences(index);

    const runtimeConfig = fs.readFileSync(
      path.join(artifactDirectory, ...RUNTIME_CONFIG_PATH.split('/')),
      'utf8'
    );
    const config = parseCanonicalRuntimeConfig(runtimeConfig);
    validateRuntimeConfigExecution(runtimeConfig, config);

    const manifestText = fs.readFileSync(path.join(artifactDirectory, MANIFEST_PATH), 'utf8');
    const manifest = JSON.parse(manifestText);
    if (
      !manifest ||
      manifest.application !== application ||
      typeof manifest.version !== 'string' ||
      manifest.version.length === 0 ||
      manifest.version.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(manifest.version)
    ) {
      fail('OUTPUT_EXISTING_UNOWNED', 'Existing output ownership metadata is invalid.');
    }
    scanArtifactContent(artifactDirectory, config);
    const manifestResult = validateManifest(artifactDirectory, {
      application,
      version: manifest.version
    });
    return Object.freeze({
      artifactDirectory,
      fileCount: tree.files.length,
      manifestDigest: manifestResult.digest
    });
  } catch {
    fail('OUTPUT_EXISTING_UNOWNED', 'Existing output is not a valid builder-owned Pages artifact; it was left untouched.');
  }
}

function validatePagesArtifact(options = {}) {
  const sourceRoot = resolveSourceRoot(options.sourceRoot || PROJECT_ROOT);
  const artifactDirectory = path.resolve(options.artifactDirectory || options.outputDirectory || DEFAULT_OUTPUT_DIRECTORY);
  const config = validateRuntimeInputs(options);
  const metadata = readApplicationMetadata(sourceRoot);
  const tree = validateArtifactStructure(artifactDirectory);

  for (const relativePath of RUNTIME_SOURCE_FILES) {
    const expected = readSourceText(sourceRoot, relativePath);
    const actual = fs.readFileSync(path.join(artifactDirectory, ...relativePath.split('/')), 'utf8');
    if (actual !== expected) fail('COPIED_SOURCE_MISMATCH', `Artifact source differs from its approved input: ${relativePath}.`);
  }

  const sourceIndex = readSourceText(sourceRoot, 'index.html');
  const expectedIndex = transformIndex(sourceIndex);
  const artifactIndex = fs.readFileSync(path.join(artifactDirectory, 'index.html'), 'utf8');
  if (artifactIndex !== expectedIndex) fail('INDEX_ARTIFACT_MISMATCH', 'Artifact index.html differs outside the approved transformation.');
  validateHtmlReferences(artifactIndex);

  const expectedRuntimeConfig = generateRuntimeConfig(config);
  const actualRuntimeConfig = fs.readFileSync(path.join(artifactDirectory, ...RUNTIME_CONFIG_PATH.split('/')), 'utf8');
  if (actualRuntimeConfig !== expectedRuntimeConfig) {
    fail('RUNTIME_CONFIG_MISMATCH', 'Generated runtime configuration is not canonical.');
  }
  validateRuntimeConfigExecution(actualRuntimeConfig, config);
  scanArtifactContent(artifactDirectory, config);

  const manifestResult = validateManifest(artifactDirectory, metadata);
  return Object.freeze({
    artifactDirectory,
    fileCount: tree.files.length,
    manifestDigest: manifestResult.digest
  });
}

function assertSafeTreeForRemoval(root) {
  const info = fs.lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('OUTPUT_EXISTING_UNSAFE', 'Existing output must be a real directory.');
  }
  const canonicalRoot = fs.realpathSync(root);
  const pending = [canonicalRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const child = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || child.isSymbolicLink()) {
        fail('OUTPUT_EXISTING_UNSAFE', 'Existing output contains a symbolic link or junction.');
      }
      const resolved = fs.realpathSync(absolute);
      if (!isInside(canonicalRoot, resolved)) {
        fail('OUTPUT_EXISTING_UNSAFE', 'Existing output contains an escaping path.');
      }
      if (child.isDirectory()) pending.push(absolute);
      else if (!child.isFile() || child.nlink !== 1) {
        fail('OUTPUT_EXISTING_UNSAFE', 'Existing output contains a linked or special file.');
      }
    }
  }
}

function resolveOutputDirectory(outputDirectory) {
  const requested = path.resolve(outputDirectory || DEFAULT_OUTPUT_DIRECTORY);
  if (path.basename(requested) !== 'pages-site') {
    fail('OUTPUT_NAME_INVALID', 'Output directory must be named pages-site.');
  }
  const parent = path.dirname(requested);
  if (!fs.existsSync(parent)) {
    const defaultParent = path.dirname(DEFAULT_OUTPUT_DIRECTORY);
    if (!samePath(requested, DEFAULT_OUTPUT_DIRECTORY) || !samePath(path.dirname(parent), PROJECT_ROOT)) {
      fail('OUTPUT_PARENT_MISSING', 'A non-default output parent must already exist.');
    }
    const canonicalProjectRoot = fs.realpathSync(PROJECT_ROOT);
    if (!samePath(PROJECT_ROOT, canonicalProjectRoot) || !samePath(parent, defaultParent)) {
      fail('OUTPUT_PARENT_UNSAFE', 'Default output parent may not traverse a symbolic link or junction.');
    }
    fs.mkdirSync(parent);
  }
  const parentInfo = fs.lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    fail('OUTPUT_PARENT_UNSAFE', 'Output parent must be a real directory.');
  }
  const canonicalParent = fs.realpathSync(parent);
  if (!samePath(parent, canonicalParent)) {
    fail('OUTPUT_PARENT_UNSAFE', 'Output parent may not resolve through a symbolic link or junction.');
  }
  const resolved = path.join(canonicalParent, 'pages-site');
  if (fs.existsSync(resolved)) assertSafeTreeForRemoval(resolved);
  return resolved;
}

function removeOwnedDirectory(target, parent, prefix) {
  if (!fs.existsSync(target)) return;
  if (!samePath(path.dirname(target), parent) || !path.basename(target).startsWith(prefix)) {
    fail('CLEANUP_TARGET_UNSAFE', 'Refusing to remove a directory not owned by this build transaction.');
  }
  assertSafeTreeForRemoval(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function createTransactionRecoveryError(message, paths) {
  const details = [
    `output=${paths.outputDirectory}`,
    `staging=${paths.stagingDirectory}`,
    paths.backupDirectory ? `backup=${paths.backupDirectory}` : null,
    `lock=${path.join(path.dirname(paths.outputDirectory), '.pages-site.build.lock')}`
  ].filter(Boolean).join('; ');
  const error = new ArtifactError(
    'OUTPUT_TRANSACTION_RECOVERY_FAILED',
    `${message} Preserve these paths for operator recovery: ${details}.`
  );
  error.preserveTransaction = true;
  return error;
}

function transactionalReplaceDirectory(stagingDirectory, outputDirectory, options = {}) {
  const renameSync = options.renameSync || fs.renameSync;
  const removeDirectory = options.removeDirectory || removeOwnedDirectory;
  const validateExisting = options.validateExisting || (() => {
    fail('OUTPUT_EXISTING_UNOWNED', 'Existing output ownership was not established.');
  });
  const validatePromoted = options.validatePromoted || (() => undefined);
  const parent = path.dirname(outputDirectory);
  if (!samePath(path.dirname(stagingDirectory), parent)) {
    fail('OUTPUT_TRANSACTION_INVALID', 'Staging and output directories must be siblings.');
  }

  const hadExistingOutput = fs.existsSync(outputDirectory);
  const backupDirectory = path.join(parent, `pages-site.backup-${crypto.randomUUID()}`);
  if (hadExistingOutput) {
    assertSafeTreeForRemoval(outputDirectory);
    validateExisting(outputDirectory);
    renameSync(outputDirectory, backupDirectory);
  }

  try {
    renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    if (hadExistingOutput && fs.existsSync(backupDirectory) && !fs.existsSync(outputDirectory)) {
      try {
        renameSync(backupDirectory, outputDirectory);
      } catch {
        throw createTransactionRecoveryError(
          'Artifact promotion failed and the previous output could not be restored automatically.',
          { outputDirectory, stagingDirectory, backupDirectory }
        );
      }
    }
    throw error;
  }

  let validationResult;
  try {
    validationResult = validatePromoted(outputDirectory);
  } catch (error) {
    if (hadExistingOutput) {
      if (fs.existsSync(stagingDirectory)) {
        throw createTransactionRecoveryError(
          'Promoted artifact validation failed and the staging recovery path was unexpectedly occupied.',
          { outputDirectory, stagingDirectory, backupDirectory }
        );
      }
      try {
        renameSync(outputDirectory, stagingDirectory);
      } catch {
        throw createTransactionRecoveryError(
          'Promoted artifact validation failed and the failed artifact could not be moved aside.',
          { outputDirectory, stagingDirectory, backupDirectory }
        );
      }
      try {
        renameSync(backupDirectory, outputDirectory);
      } catch {
        throw createTransactionRecoveryError(
          'Promoted artifact validation failed and the previous output could not be restored automatically.',
          { outputDirectory, stagingDirectory, backupDirectory }
        );
      }
    } else {
      try {
        renameSync(outputDirectory, stagingDirectory);
      } catch {
        throw createTransactionRecoveryError(
          'First artifact validation failed and the failed output could not be moved aside.',
          { outputDirectory, stagingDirectory }
        );
      }
    }
    throw error;
  }

  let cleanupWarning = null;
  if (hadExistingOutput && fs.existsSync(backupDirectory)) {
    try {
      removeDirectory(backupDirectory, parent, 'pages-site.backup-');
    } catch {
      cleanupWarning = `Validated artifact committed, but the prior output backup could not be removed: ${backupDirectory}.`;
    }
  }
  return Object.freeze({ cleanupWarning, validationResult });
}

function acquireBuildLock(parent) {
  const lockPath = path.join(parent, '.pages-site.build.lock');
  const token = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(descriptor, token, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The exclusive lock remains for operator inspection if closing failed.
      }
    }
    fail('OUTPUT_LOCKED', 'Another Pages artifact build is active or a stale build lock requires inspection.');
  }
  return Object.freeze({ lockPath, token });
}

function releaseBuildLock(lock) {
  if (!lock || !fs.existsSync(lock.lockPath)) return false;
  try {
    const info = fs.lstatSync(lock.lockPath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return false;
    if (fs.readFileSync(lock.lockPath, 'utf8') !== lock.token) return false;
    fs.unlinkSync(lock.lockPath);
    return true;
  } catch {
    return false;
  }
}

function buildPagesArtifact(options = {}) {
  const sourceRoot = resolveSourceRoot(options.sourceRoot || PROJECT_ROOT);
  const config = validateRuntimeInputs(options);
  const metadata = readApplicationMetadata(sourceRoot);
  const sourceContent = new Map();
  for (const relativePath of SOURCE_FILES) sourceContent.set(relativePath, readSourceText(sourceRoot, relativePath));

  const outputDirectory = resolveOutputDirectory(options.outputDirectory || DEFAULT_OUTPUT_DIRECTORY);
  const parent = path.dirname(outputDirectory);
  const buildLock = acquireBuildLock(parent);
  let stagingDirectory;
  let cleanupWarning = null;
  let preserveTransaction = false;
  let lockHandled = false;

  try {
    stagingDirectory = fs.mkdtempSync(path.join(parent, 'pages-site.tmp-'));
    writeArtifactFile(stagingDirectory, '.nojekyll', Buffer.alloc(0));
    writeArtifactFile(stagingDirectory, 'index.html', transformIndex(sourceContent.get('index.html')));
    writeArtifactFile(stagingDirectory, RUNTIME_CONFIG_PATH, generateRuntimeConfig(config));
    for (const relativePath of RUNTIME_SOURCE_FILES) {
      writeArtifactFile(stagingDirectory, relativePath, sourceContent.get(relativePath));
    }
    const manifest = createManifest(stagingDirectory, metadata);
    writeArtifactFile(stagingDirectory, MANIFEST_PATH, canonicalJson(manifest));

    validatePagesArtifact({ sourceRoot, artifactDirectory: stagingDirectory, ...config });
    const transaction = transactionalReplaceDirectory(stagingDirectory, outputDirectory, {
      renameSync: options.renameSync,
      removeDirectory: options.removeDirectory,
      validateExisting: existing => validateOwnedExistingArtifact({
        artifactDirectory: existing,
        application: metadata.application
      }),
      validatePromoted: promoted => validatePagesArtifact({ sourceRoot, artifactDirectory: promoted, ...config })
    });
    cleanupWarning = transaction.cleanupWarning;
    const validated = transaction.validationResult;
    if (!releaseBuildLock(buildLock)) {
      cleanupWarning = [
        cleanupWarning,
        'Validated artifact committed, but the build lock changed or could not be removed.'
      ].filter(Boolean).join(' ');
    }
    lockHandled = true;
    return Object.freeze({ ...validated, cleanupWarning });
  } catch (error) {
    preserveTransaction = Boolean(error && error.preserveTransaction);
    throw error;
  } finally {
    try {
      if (!preserveTransaction && stagingDirectory && fs.existsSync(stagingDirectory)) {
        removeOwnedDirectory(stagingDirectory, parent, 'pages-site.tmp-');
      }
    } finally {
      if (!preserveTransaction && !lockHandled) releaseBuildLock(buildLock);
    }
  }
}

function redact(message, values) {
  let result = String(message || 'Unknown artifact error.');
  for (const value of values) {
    if (typeof value === 'string' && value) result = result.split(value).join('[REDACTED]');
  }
  return result;
}

function parseCliArguments(argv) {
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  let validateOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      if (!argv[index + 1]) fail('CLI_ARGUMENT_INVALID', '--output requires a directory.');
      outputDirectory = argv[index + 1];
      index += 1;
    } else if (argument === '--validate-only') {
      validateOnly = true;
    } else {
      fail('CLI_ARGUMENT_INVALID', 'Unknown Pages artifact CLI argument.');
    }
  }
  return Object.freeze({ outputDirectory, validateOnly });
}

function runCli(argv = process.argv.slice(2), environment = process.env, streams = process) {
  const sensitive = [environment[CONFIG_ENV.projectUrl], environment[CONFIG_ENV.publishableKey]];
  try {
    const args = parseCliArguments(argv);
    const options = {
      sourceRoot: PROJECT_ROOT,
      outputDirectory: args.outputDirectory,
      projectUrl: environment[CONFIG_ENV.projectUrl],
      publishableKey: environment[CONFIG_ENV.publishableKey]
    };
    const result = args.validateOnly
      ? validatePagesArtifact({ ...options, artifactDirectory: path.resolve(args.outputDirectory) })
      : buildPagesArtifact(options);
    streams.stdout.write(`Pages artifact ${args.validateOnly ? 'validation' : 'build'} passed (${result.fileCount} files, manifest ${result.manifestDigest}).\n`);
    if (result.cleanupWarning) {
      streams.stderr.write(`Pages artifact warning: ${redact(result.cleanupWarning, sensitive)}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof ArtifactError ? error.code : 'UNEXPECTED_FAILURE';
    streams.stderr.write(`Pages artifact failed [${code}]: ${redact(error.message, sensitive)}\n`);
    return 1;
  }
}

module.exports = Object.freeze({
  APPLICATION_METADATA_PATH: 'package.json',
  ARTIFACT_DIRECTORIES,
  ARTIFACT_FILES,
  CONFIG_ENV,
  DEFAULT_OUTPUT_DIRECTORY,
  EXPECTED_EXTERNAL_LINKS,
  EXPECTED_SCRIPT_REFERENCES,
  MANIFEST_PATH,
  PAYLOAD_FILES,
  PROJECT_ROOT,
  RUNTIME_CONFIG_PATH,
  RUNTIME_SOURCE_FILES,
  SOURCE_FILES,
  ArtifactError,
  buildPagesArtifact,
  canonicalJson,
  createManifest,
  generateRuntimeConfig,
  normalizeText,
  parseCanonicalRuntimeConfig,
  parseCliArguments,
  readApplicationMetadata,
  redact,
  runCli,
  sha256,
  transactionalReplaceDirectory,
  transformIndex,
  validateOwnedExistingArtifact,
  validatePagesArtifact,
  validateRuntimeInputs
});

if (require.main === module) process.exitCode = runCli();

'use strict';

// Minimal loopback static server for local dashboard development.
//
// It exists so that a local dashboard address is unambiguous: the server binds
// 127.0.0.1 only, serves a fixed top-level allowlist out of one repository, and
// answers an identity endpoint that proves which repository and which launcher
// owns the port. That identity is what lets the launcher reuse its own port and
// refuse a port held by an unrelated project.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const IDENTITY_PATH = '/__dev-local-identity__';

// Everything the browser needs to run index.html, and nothing else. Tests,
// scripts, migrations, artifacts, node_modules, and .git are never served.
const ALLOWED_TOP_LEVEL = Object.freeze(['index.html', 'config', 'src', 'vendor']);

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
});

function decodePath(requestUrl) {
  const withoutQuery = String(requestUrl || '/').split('?')[0].split('#')[0];
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
}

// Resolves a request path to a real file inside the served root, or null.
function resolveRequestPath(root, requestUrl) {
  const decoded = decodePath(requestUrl);
  if (decoded === null || decoded.includes('\0')) return null;
  const normalized = path.posix.normalize(decoded === '/' ? '/index.html' : decoded);
  if (!normalized.startsWith('/') || normalized.includes('..')) return null;

  const relative = normalized.slice(1);
  if (!relative) return null;
  const segments = relative.split('/').filter(Boolean);
  if (!segments.length || !ALLOWED_TOP_LEVEL.includes(segments[0])) return null;
  if (segments.some(segment => segment.startsWith('.'))) return null;

  const candidate = path.resolve(root, ...segments);
  const prefix = path.resolve(root) + path.sep;
  if (!candidate.startsWith(prefix)) return null;

  let info;
  try {
    info = fs.lstatSync(candidate);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  return candidate;
}

function createStaticServer(options) {
  const root = path.resolve(options.root);
  const identity = Object.freeze({
    application: String(options.application || ''),
    repositoryRoot: root,
    token: String(options.token || ''),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    environment: 'LOCAL'
  });

  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      response.end();
      return;
    }

    const requestPath = decodePath(request.url);
    if (requestPath === IDENTITY_PATH) {
      const body = `${JSON.stringify(identity, null, 2)}\n`;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    const target = resolveRequestPath(root, request.url);
    if (!target) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : 'Not found\n');
      return;
    }

    let content;
    try {
      content = fs.readFileSync(target);
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : 'Read error\n');
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': content.length,
      // Local development must never serve a stale module after an edit.
      'cache-control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  });

  return { server, identity };
}

function startStaticServer(options) {
  return new Promise((resolve, reject) => {
    const { server, identity } = createStaticServer(options);
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, identity, port: server.address().port });
    });
  });
}

async function main(argv) {
  const options = { root: process.cwd(), port: 3100, token: '', application: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[index += 1];
    else if (argument === '--port') options.port = Number.parseInt(argv[index += 1], 10);
    else if (argument === '--token') options.token = argv[index += 1];
    else if (argument === '--application') options.application = argv[index += 1];
    else {
      process.stderr.write(`Unknown argument: ${argument}\n`);
      return 64;
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    process.stderr.write('Port must be an integer between 1024 and 65535.\n');
    return 64;
  }
  const started = await startStaticServer(options);
  process.stdout.write(`${JSON.stringify({ ready: true, port: started.port, pid: process.pid })}\n`);
  const shutdown = () => {
    started.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

module.exports = { ALLOWED_TOP_LEVEL, IDENTITY_PATH, createStaticServer, resolveRequestPath, startStaticServer };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    if (typeof code === 'number') process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`static server failed: ${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  });
}

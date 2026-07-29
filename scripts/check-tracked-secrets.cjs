'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/i,
  /^config\/.*\.local\./i,
  /migration-user-map\.local\.json$/i,
  /reactivation-desk-(?:recovery-sensitive|migration-snapshot)-/i
];
const contentRules = [
  ['JWT', new RegExp('eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', 'g')],
  ['Supabase secret key', new RegExp('sb_' + 'secret_[A-Za-z0-9_-]{16,}', 'gi')],
  ['GitHub token', new RegExp('gh' + '[opsu]_[A-Za-z0-9]{20,}', 'g')],
  ['private key', new RegExp('-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'g')]
];
const passwordLiteral = /(?:^|[,{\s])['"]?password['"]?\s*[:=]\s*['"](?!YOUR_|example|password|not-used)([^'"\r\n]{8,})['"]/gi;
const failures = [];

for (const file of files) {
  if (forbiddenPaths.some(rule => rule.test(file))) failures.push(`${file}: forbidden local or environment config path`);
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const [label, rule] of contentRules) {
    rule.lastIndex = 0;
    if (rule.test(content)) failures.push(`${file}: possible ${label}`);
  }
  if (!file.startsWith('tests/') && !file.startsWith('docs/')) {
    passwordLiteral.lastIndex = 0;
    if (passwordLiteral.test(content)) failures.push(`${file}: possible password literal`);
  }
}

if (failures.length) {
  console.error('Tracked-file secret scan failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Tracked-file secret scan passed (${files.length} files).`);

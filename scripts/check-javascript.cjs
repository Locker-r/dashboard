'use strict';

const { execFileSync, spawnSync } = require('node:child_process');

const files = execFileSync('git', ['ls-files', '*.js', '*.cjs'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(file => file && !file.startsWith('vendor/'));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`JavaScript syntax checks passed (${files.length} files).`);

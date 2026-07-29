const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.dirname(require.resolve('@supabase/supabase-js/package.json'));
const source = path.join(packageRoot, 'dist', 'umd', 'supabase.js');
const targetDirectory = path.join(__dirname, '..', 'vendor');
const target = path.join(targetDirectory, 'supabase.js');

fs.mkdirSync(targetDirectory, { recursive: true });
const bundle = fs.readFileSync(source, 'utf8').replace(/[ \t]+$/gm, '');
fs.writeFileSync(target, bundle);
console.log('Built local Supabase browser bundle.');

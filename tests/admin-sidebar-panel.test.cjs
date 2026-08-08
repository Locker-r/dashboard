'use strict';

// Regression for a staging bug: the sidebar stretched to match `.main`'s
// content height (flex align-items:stretch, the default). `.sidebar-foot`
// (name/role/language/logout) sits at the bottom of that stretched box via
// margin-top:auto, so on admin tabs whose main content is tall enough to
// push the page past one screen — Dashboard, Analytics, Access, each of
// which renders large per-agent/per-user tables — the panel landed far
// below the fold and required scrolling the *entire* page to reach, making
// it look absent. Worklist/Distribute/Import happened to render shorter
// content in the reported case, so the same layout bug wasn't as visible
// there.
//
// The fix pins `.sidebar` to the viewport (position:sticky; top:0;
// height:100vh) with its own overflow-y:auto, so the profile panel stays
// on screen regardless of how tall the active view's main content is.
//
// index.html has no test harness that executes its inline script (see
// tests/login-init-failure.test.cjs for the same string-assertion
// approach), so this checks the source CSS directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function sidebarRule() {
  const match = indexHtml.match(/\.sidebar\{[^}]*\}/);
  assert.ok(match, '.sidebar CSS rule must exist');
  return match[0];
}

test('.sidebar is pinned to the viewport instead of stretching to main content height', () => {
  const rule = sidebarRule();
  assert.match(rule, /position:sticky/, 'sidebar must stick to the viewport as the page scrolls');
  assert.match(rule, /top:0/, 'sidebar must stick starting from the top of the viewport');
  assert.match(rule, /height:100vh/, 'sidebar height must be capped to the viewport, not stretch to match tall main content');
});

test('.sidebar scrolls its own overflow instead of clipping the profile panel', () => {
  const rule = sidebarRule();
  assert.match(rule, /overflow-y:auto/, 'sidebar must scroll internally if nav + profile panel exceed the viewport height');
});

test('the shared profile panel is defined once, outside the per-view sections', () => {
  const sidebarFootCount = (indexHtml.match(/class="sidebar-foot"/g) || []).length;
  assert.equal(sidebarFootCount, 1, 'the account panel must be a single shared element, not duplicated per admin tab');

  const footIndex = indexHtml.indexOf('class="sidebar-foot"');
  const asideStart = indexHtml.lastIndexOf('<aside class="sidebar">');
  const firstViewStart = indexHtml.indexOf('<section class="view');
  assert.ok(asideStart >= 0 && asideStart < footIndex, 'the profile panel must live inside the shared <aside class="sidebar">');
  assert.ok(firstViewStart < 0 || footIndex < firstViewStart, 'the profile panel must be rendered before any per-tab <section class="view"> content, i.e. shared sidebar markup, not tab markup');
});

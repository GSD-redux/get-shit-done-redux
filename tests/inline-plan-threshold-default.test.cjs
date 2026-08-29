'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3801 — workflow.inline_plan_threshold's default must have ONE owner.
//
// The effective default existed only as execute-plan.md's shell fallback
// (`|| echo "2"`); the key was never registered in
// config-defaults.manifest.json, and settings-advanced.md documented the
// default as 3. This guard pins: the manifest OWNS the default (key present,
// value 2), every shipped doc that names a default agrees with the manifest,
// and the shell fallbacks agree too.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(REPO, 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json'),
  'utf8',
));

test('#3801: the defaults manifest owns workflow.inline_plan_threshold (default 2)', () => {
  assert.ok(
    MANIFEST.workflow && Object.prototype.hasOwnProperty.call(MANIFEST.workflow, 'inline_plan_threshold'),
    'the key must be registered in config-defaults.manifest.json — one source of truth',
  );
  assert.strictEqual(MANIFEST.workflow.inline_plan_threshold, 2);
});

test('#3801: every shipped surface naming the default agrees with the manifest', () => {
  const surfaces = [
    ['gsd-core/workflows/settings-advanced.md', /inline_plan_threshold`\s*\(default:\s*`(\d+)`/],
    ['gsd-core/references/planning-config.md', /\|\s*`workflow\.inline_plan_threshold`\s*\|\s*`?(\d+)`?\s*\|/],
  ];
  for (const [rel, re] of surfaces) {
    const md = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const m = re.exec(md);
    assert.ok(m, `${rel} must name the inline_plan_threshold default`);
    assert.strictEqual(m[1], '2', `#3801: ${rel} documents the default as ${m[1]} — must agree with the manifest's 2`);
  }
  // The execute-plan prose default and the shell fallback both say 2.
  const ep = fs.readFileSync(path.join(REPO, 'gsd-core', 'workflows', 'execute-plan.md'), 'utf8');
  assert.match(ep, /config-get workflow\.inline_plan_threshold --raw[^|]*\|\|\s*echo "2"/,
    'the shell fallback must agree with the manifest default');
  assert.match(ep, /default: 2, set to `0` to always spawn/, 'the prose default must stay 2');
});

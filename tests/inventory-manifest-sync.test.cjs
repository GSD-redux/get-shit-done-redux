'use strict';

/**
 * Asserts docs/INVENTORY-MANIFEST.json is in sync with the filesystem.
 * A stale manifest means a surface shipped without updating INVENTORY.md.
 * Fix by running: node scripts/gen-inventory-manifest.cjs --write
 * then adding the corresponding row(s) in docs/INVENTORY.md.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'INVENTORY-MANIFEST.json');

// #2996: FAMILIES and NESTED_FAMILIES are IMPORTED, never redeclared. This file used to
// carry its own copy of the family table — the `DEFECT.GENERATIVE-FIX` divergence class:
// a family added to the generator but not here left this test silently verifying a
// subset while still reporting green. Importing makes divergence impossible rather than
// merely detectable.
const { FAMILIES, NESTED_FAMILIES, collectNested } = require('../scripts/gen-inventory-manifest.cjs');

test('docs/INVENTORY-MANIFEST.json matches the filesystem', () => {
  const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const additions = [];
  const removals = [];

  for (const { name, dir, filter, toName } of FAMILIES) {
    const live = new Set(
      fs.readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile() && filter(f))
        .map(toName),
    );
    const recorded = new Set((committed.families || {})[name] || []);

    for (const entry of live) {
      if (!recorded.has(entry)) additions.push(name + '/' + entry);
    }
    for (const entry of recorded) {
      if (!live.has(entry)) removals.push(name + '/' + entry);
    }
  }

  for (const family of NESTED_FAMILIES) {
    const live = new Set(collectNested(family));
    const recorded = new Set((committed.families || {})[family.name] || []);
    for (const entry of live) {
      if (!recorded.has(entry)) additions.push(family.name + '/' + entry);
    }
    for (const entry of recorded) {
      if (!live.has(entry)) removals.push(family.name + '/' + entry);
    }
  }

  const msg = [
    additions.length ? 'New surfaces not in manifest (run node scripts/gen-inventory-manifest.cjs --write):\n' + additions.map((e) => '  + ' + e).join('\n') : '',
    removals.length  ? 'Manifest entries with no matching file:\n'                                                  + removals.map((e) => '  - ' + e).join('\n') : '',
  ].filter(Boolean).join('\n');

  assert.ok(additions.length === 0 && removals.length === 0, msg);
});

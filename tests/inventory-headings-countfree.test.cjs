// allow-test-rule: source-text-is-the-product
// INVENTORY.md heading format is the shipped doc surface being locked
'use strict';

/**
 * Guards that docs/INVENTORY.md does NOT contain "(N shipped)" count
 * scalars in section headings. Hard counts in shared-line headings cause
 * silent undercount when two branches each add a module (DEFECT.INVENTORY-MERGE-UNDERCOUNT).
 *
 * Regression-must-fail-first: run this BEFORE removing the counts to confirm
 * it catches the bad heading format, then after removal to confirm it passes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_PATH = path.join(ROOT, 'docs', 'INVENTORY.md');

test('docs/INVENTORY.md has no "(N shipped)" count scalars in headings', () => {
  const content = fs.readFileSync(INVENTORY_PATH, 'utf8');
  const offenders = content
    .split(/\r?\n/)
    .filter((line) => /^##\s+.+\(\d+\s+shipped\)/.test(line));

  assert.ok(
    offenders.length === 0,
    'docs/INVENTORY.md still has hard-count headings (DEFECT.INVENTORY-MERGE-UNDERCOUNT).\n' +
      'Remove the "(N shipped)" parenthetical from each:\n' +
      offenders.map((l) => '  ' + l).join('\n'),
  );
});

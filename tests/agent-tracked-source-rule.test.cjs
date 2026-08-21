/**
 * #3645: gsd-planner and gsd-pattern-mapper must write only git-TRACKED
 * source paths into PLAN.md / PATTERNS.md — never a gitignored install/
 * runtime mirror (e.g. <root>/.gsd/capabilities/<id>/... synced from a
 * plugin's tracked tree). Executors that trust a mirror path edit a copy
 * whose changes die on the next sync; the wrong path also self-propagates
 * across phases because pattern-mapper builds on prior phases' docs.
 *
 * These are shipped-content contract rows: the agent .md text IS the product
 * the runtime loads, so asserting its contract lines tests the deployed
 * behavior (the sanctioned source-text-is-the-product category).
 */

// allow-test-rule: source-text-is-the-product (#3645)
// Agent workflow text is the runtime instruction; testing its content tests
// the deployed contract — if the tracked-source rule is absent from the
// agent file, the agent does not enforce it.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

describe('#3645 — agents write only git-tracked source paths', () => {
  const read = (name) => fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');

  test('gsd-planner carries the #3645 tracked-source rule for files_modified', () => {
    const src = read('gsd-planner.md');
    assert.ok(
      src.includes('git ls-files') && /files_modified/.test(src.split('Tracked-source rule')[1] || ''),
      'gsd-planner.md must carry a Tracked-source rule (#3645) that verifies files_modified paths via git ls-files',
    );
    assert.ok(
      /Tracked-source rule[\s\S]*\.gsd\/capabilities/.test(src),
      'the rule must name the gitignored install-mirror shape (.gsd/capabilities) it exists to reject (#3645)',
    );
    assert.ok(
      /Tracked-source rule[\s\S]*plugins\//.test(src),
      'the rule must point at the tracked plugin-source fallback locations (#3645)',
    );
  });

  test('gsd-planner re-verifies inherited PATTERNS.md paths (#3645)', () => {
    const src = read('gsd-planner.md');
    assert.ok(
      /Tracked-source rule[\s\S]*PATTERNS\.md/.test(src),
      'the rule must cover paths inherited from PATTERNS.md and prior phases — mirror paths are re-verified, not inherited (#3645)',
    );
  });

  test('gsd-pattern-mapper emits only tracked analog paths (#3645)', () => {
    const src = read('gsd-pattern-mapper.md');
    assert.ok(
      src.includes('git ls-files'),
      'gsd-pattern-mapper.md must verify analog paths against git ls-files (#3645)',
    );
    assert.ok(
      /gitignored[\s\S]*mirror|mirror[\s\S]*gitignored/i.test(src),
      'the mapper must name the gitignored-mirror rejection explicitly (#3645)',
    );
    assert.ok(
      /PATTERNS\.md[\s\S]*never[\s\S]*mirror|mirror[\s\S]*never/i.test(src) || /never emit[\s\S]*mirror/i.test(src),
      'PATTERNS.md output must be required to never carry mirror paths (#3645)',
    );
  });

  test('growth ack recorded for both grown agent files (#3645)', () => {
    const acksDir = path.join(__dirname, 'emitted-drift-acks');
    const acks = fs.readdirSync(acksDir).join('\n');
    assert.ok(acks.includes('3645'), 'an emitted-drift-acks fragment for #3645 must exist');
    const fragment = fs
      .readdirSync(acksDir)
      .filter((f) => f.includes('3645'))
      .map((f) => fs.readFileSync(path.join(acksDir, f), 'utf8'))
      .join('\n');
    assert.ok(fragment.includes('planner.md') && fragment.includes('pattern-mapper.md'),
      'the #3645 fragment must acknowledge BOTH grown filenames');
  });
});

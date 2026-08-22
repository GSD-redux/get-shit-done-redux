'use strict';

/**
 * Tests for `normalizeLegacyKeys` legacy-key hoisting (#3648 round-2 review).
 *
 * Blocks 1 and 5 hoist a top-level legacy key into its canonical nested
 * section (`branching_strategy` → `git.branching_strategy`, `base_branch` →
 * `git.base_branch`). Both spread `result['git']` without first proving it is
 * a plain object, so a config whose `git` key holds a string is spread into
 * index keys. That output is then persisted by config-loader's write-on-
 * normalize path, so the corruption reaches the user's config.json.
 *
 * Both blocks also record a normalization entry on the canonical-wins branch
 * carrying the DISCARDED value, describing a migration that did not happen.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { normalizeLegacyKeys } = require('../gsd-core/bin/lib/configuration.cjs');

/** Keys that only a string/array spread can produce. */
function numericKeys(obj) {
  return Object.keys(obj).filter((k) => /^\d+$/.test(k));
}

describe('#3648 normalizeLegacyKeys — non-object `git` section must not be spread', () => {
  test('block 5: a string `git` section does not leak index keys into git.base_branch', () => {
    const { parsed } = normalizeLegacyKeys({ git: 'main', base_branch: 'release' });

    assert.deepStrictEqual(numericKeys(parsed.git), [],
      'spreading a string `git` value produces {0:"m",1:"a",...}; the guard must reject it first');
    assert.deepStrictEqual(parsed.git, { base_branch: 'release' });
    assert.strictEqual(parsed.base_branch, undefined, 'stale top-level key must still be dropped');
  });

  test('block 1: a string `git` section does not leak index keys into git.branching_strategy', () => {
    const { parsed } = normalizeLegacyKeys({ git: 'main', branching_strategy: 'phase' });

    assert.deepStrictEqual(numericKeys(parsed.git), []);
    assert.deepStrictEqual(parsed.git, { branching_strategy: 'phase' });
    assert.strictEqual(parsed.branching_strategy, undefined);
  });

  test('negative control: object / array / null `git` sections were already clean', () => {
    // These three must keep behaving exactly as before the guard was added —
    // if the guard changed them, it is doing more than rejecting non-objects.
    assert.deepStrictEqual(
      normalizeLegacyKeys({ git: [], base_branch: 'release' }).parsed.git,
      { base_branch: 'release' });
    assert.deepStrictEqual(
      normalizeLegacyKeys({ git: null, base_branch: 'release' }).parsed.git,
      { base_branch: 'release' });
    assert.deepStrictEqual(
      normalizeLegacyKeys({ git: { phase_branch_template: 'x' }, base_branch: 'release' }).parsed.git,
      { phase_branch_template: 'x', base_branch: 'release' });
  });
});

describe('#3648 normalizeLegacyKeys — canonical-wins must not report a migration that did not happen', () => {
  test('block 5: the recorded value is the surviving canonical one, not the discarded flat one', () => {
    const { parsed, normalizations } = normalizeLegacyKeys({
      git: { base_branch: 'nested' },
      base_branch: 'flat',
    });

    assert.strictEqual(parsed.git.base_branch, 'nested', 'canonical value must win');

    const entry = normalizations.find((n) => n.from === 'base_branch');
    assert.ok(entry, 'an entry must still be recorded so the stale key is written away');
    assert.strictEqual(entry.value, 'nested',
      'value must describe what now lives at git.base_branch, not the value that was thrown away');
    assert.strictEqual(entry.discarded, 'flat',
      'the discarded flat value belongs in its own field, not masquerading as the migrated value');
  });

  test('block 1: same contract for branching_strategy', () => {
    const { normalizations } = normalizeLegacyKeys({
      git: { branching_strategy: 'milestone' },
      branching_strategy: 'phase',
    });

    const entry = normalizations.find((n) => n.from === 'branching_strategy');
    assert.ok(entry);
    assert.strictEqual(entry.value, 'milestone');
    assert.strictEqual(entry.discarded, 'phase');
  });

  test('negative control: a genuine migration records the migrated value and no `discarded`', () => {
    const { normalizations } = normalizeLegacyKeys({ base_branch: 'release' });
    const entry = normalizations.find((n) => n.from === 'base_branch');

    assert.strictEqual(entry.value, 'release');
    assert.strictEqual(entry.discarded, undefined,
      'nothing was discarded, so the field must be absent — otherwise it cannot distinguish the two cases');
  });
});

describe('#3648 normalizeLegacyKeys — property: hoisting never fabricates index keys', () => {
  test('hoisting adds no key the input section did not already carry', () => {
    // NOTE the invariant is "adds none", not "has none". A user's `git`
    // section may legitimately contain a numeric-looking key ({"0": ""}), and
    // preserving it is correct — fast-check found exactly that counterexample
    // against the stronger phrasing. What must never happen is the hoist
    // MANUFACTURING index keys by spreading a non-object.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.string()),
          fc.dictionary(fc.string(), fc.string()),
        ),
        fc.string({ minLength: 1 }),
        (gitValue, branch) => {
          const isPlainObject = gitValue !== null
            && typeof gitValue === 'object'
            && !Array.isArray(gitValue);
          const carriedIn = isPlainObject ? numericKeys(gitValue) : [];

          const { parsed } = normalizeLegacyKeys({ git: gitValue, base_branch: branch });

          // The section must always end up a plain object…
          assert.ok(parsed.git && typeof parsed.git === 'object' && !Array.isArray(parsed.git));
          // …carrying the hoisted key…
          assert.strictEqual(parsed.git.base_branch, branch);
          // …and no numeric key beyond whatever the input already had.
          assert.deepStrictEqual(numericKeys(parsed.git).sort(), carriedIn.sort());
        },
      ),
      { numRuns: 300 },
    );
  });
});

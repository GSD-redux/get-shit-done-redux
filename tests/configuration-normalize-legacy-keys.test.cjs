'use strict';

/**
 * Tests for `normalizeLegacyKeys` block 5 — top-level `base_branch` →
 * `git.base_branch` (#3648).
 *
 * Block 5 is new in this PR and is a fifth trigger for the write-on-normalize
 * path, so it must obey the same contract #3760 established for blocks 1-3:
 * hoist into an absent or object section, and REFUSE — preserving the legacy
 * key, pushing no `Normalization`, and reporting via `skipped` — when the
 * destination section is present but is not an object.
 *
 * #3760's own suite (tests/configuration-migrate-config.test.cjs) locks that
 * contract for blocks 1, 2 and 3. This file locks it for block 5, which did not
 * exist when that suite was written, plus block 5's ordinary hoist semantics.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { normalizeLegacyKeys } = require('../gsd-core/bin/lib/configuration.cjs');

/** Keys only a string/array spread can produce. */
function numericKeys(obj) {
  return Object.keys(obj).filter((k) => /^\d+$/.test(k));
}

describe('#3648 normalizeLegacyKeys block 5 — ordinary hoist semantics', () => {
  test('an absent `git` section is created carrying the hoisted value', () => {
    const { parsed, normalizations, skipped } = normalizeLegacyKeys({ base_branch: 'release' });

    assert.deepStrictEqual(parsed.git, { base_branch: 'release' });
    assert.strictEqual(parsed.base_branch, undefined, 'the stale flat key must be dropped');
    assert.deepStrictEqual(skipped, []);
    assert.deepStrictEqual(
      normalizations.find((n) => n.from === 'base_branch'),
      { from: 'base_branch', to: 'git.base_branch', value: 'release' },
    );
  });

  test('an existing `git` section is merged into, not replaced', () => {
    const { parsed } = normalizeLegacyKeys({
      git: { phase_branch_template: 'x' },
      base_branch: 'release',
    });

    assert.deepStrictEqual(parsed.git, { phase_branch_template: 'x', base_branch: 'release' });
  });

  test('a null `git` section still means "absent" and is created', () => {
    const { parsed, skipped } = normalizeLegacyKeys({ git: null, base_branch: 'release' });

    assert.deepStrictEqual(parsed.git, { base_branch: 'release' });
    assert.deepStrictEqual(skipped, [], 'null is absence, not a malformed section');
  });

  test('a canonical `git.base_branch` outranks the flat key, which is dropped', () => {
    const { parsed, normalizations } = normalizeLegacyKeys({
      git: { base_branch: 'nested' },
      base_branch: 'flat',
    });

    assert.strictEqual(parsed.git.base_branch, 'nested', 'canonical value must win');
    assert.strictEqual(parsed.base_branch, undefined);
    assert.ok(normalizations.find((n) => n.from === 'base_branch'),
      'an entry is still recorded so the stale flat key is written away');
  });
});

describe('#3648 normalizeLegacyKeys block 5 — a non-object `git` section blocks the migration', () => {
  // Same contract as #3760 blocks 1-3: preserve, refuse, report. Anything else
  // is destructive, because config-loader persists whatever normalization
  // produced whenever `normalizations` is non-empty.

  for (const [label, section] of [
    ['string', 'main'],
    ['number', 42],
    ['boolean', true],
    ['array', ['main']],
  ]) {
    test(`a ${label} \`git\` section: value preserved, nothing normalized, refusal reported`, () => {
      const input = { git: section, base_branch: 'release' };
      const { parsed, normalizations, skipped } = normalizeLegacyKeys(input);

      assert.deepStrictEqual(parsed.git, section, 'the section value must survive verbatim');
      assert.strictEqual(parsed.base_branch, 'release', 'the legacy key must NOT be consumed');
      assert.deepStrictEqual(
        normalizations.filter((n) => n.from === 'base_branch'), [],
        'pushing a Normalization is what makes config-loader write the file back',
      );
      assert.deepStrictEqual(skipped, [{
        from: 'base_branch',
        to: 'git.base_branch',
        section: 'git',
        reason: 'non_object_section',
        value: 'release',
        sectionType: label,
      }]);
    });
  }

  test('negative control: the refusal is scoped to block 5, not to the whole call', () => {
    // A non-object `git` must not stop an unrelated block from normalizing —
    // otherwise the guard is a blanket bail-out rather than a per-section one.
    const { parsed, normalizations } = normalizeLegacyKeys({
      git: 'main',
      base_branch: 'release',
      depth: 'quick',
    });

    assert.strictEqual(parsed.granularity, 'coarse', 'block 4 must still run');
    assert.ok(normalizations.find((n) => n.from === 'depth'));
  });
});

describe('#3648 normalizeLegacyKeys block 5 — property: hoist or refuse, never corrupt', () => {
  test('across arbitrary `git` values the two outcomes are exhaustive and exclusive', () => {
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
          const receivable = gitValue === null
            || (typeof gitValue === 'object' && !Array.isArray(gitValue));
          const carriedIn = receivable && gitValue !== null ? numericKeys(gitValue) : [];

          const { parsed, normalizations, skipped } =
            normalizeLegacyKeys({ git: gitValue, base_branch: branch });

          const hoisted = normalizations.some((n) => n.from === 'base_branch');
          const refused = skipped.some((s) => s.from === 'base_branch');
          assert.notStrictEqual(hoisted, refused,
            'exactly one of the two outcomes must be reported for this key');
          assert.strictEqual(hoisted, receivable);

          if (receivable) {
            assert.ok(parsed.git && typeof parsed.git === 'object' && !Array.isArray(parsed.git));
            assert.strictEqual(parsed.git.base_branch, branch);
            assert.strictEqual(parsed.base_branch, undefined);
            // No numeric key beyond whatever the input section already had: a
            // spread of a non-object is what would manufacture them.
            assert.deepStrictEqual(numericKeys(parsed.git).sort(), carriedIn.sort());
          } else {
            assert.deepStrictEqual(parsed.git, gitValue);
            assert.strictEqual(parsed.base_branch, branch);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

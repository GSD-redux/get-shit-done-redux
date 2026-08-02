'use strict';

/**
 * Property-based tests for src/section-manifest.cts (compiled to
 * gsd-core/bin/lib/section-manifest.cjs) — issue #2932 (epic #1671 Phase 5).
 * Covers 50-test-matrix.md rows 25-28.
 *
 * Document-shaped generators (CONTRIBUTING.md "Fixture provenance #2371",
 * mirroring tests/workflow-fragments.property.test.cjs): section lists are
 * generated as arbitrary document-order id/when sequences — the SHAPE a
 * real `parseWorkflowSections` output would have — never by round-tripping
 * through `selectSections`/`WHEN_PREDICATES` itself. `when` values are drawn
 * from the module's own frozen `WHEN_VOCABULARY` re-export (imported from
 * `workflow-fragments.cjs`, the true source of truth) rather than a
 * hardcoded local copy, so the generator can never silently desync from
 * production (DEFECT.GENERATIVE-FIX).
 *
 * Deterministic per CONTRIBUTING.md: seed and numRuns are pinned by
 * tests/helpers/fast-check-setup.cjs (seed 42, numRuns 200).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { selectSections } = require('../gsd-core/bin/lib/section-manifest.cjs');
const { WHEN_VOCABULARY } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const WHEN_VALUES = [...WHEN_VOCABULARY];

// ─── Document-shaped generators ────────────────────────────────────────────

const whenArb = fc.constantFrom(...WHEN_VALUES);

// Ids are made unique WITHIN one generated document by suffixing the array
// index at assembly time (below) rather than relying on the raw string
// generator for uniqueness — this keeps the shape arbitrary while still
// letting assertions key on "this exact id".
const idBaseArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);

/** A document-order list of `{id, when}` sections, id uniqueness enforced by index-suffixing. */
const sectionsArb = fc
  .array(fc.tuple(idBaseArb, whenArb), { minLength: 0, maxLength: 15 })
  .map((pairs) => pairs.map(([base, when], idx) => ({ id: `${base}-${idx}`, when })));

const phaseNumberArb = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.stringMatching(/^[0-9]{1,2}$/),
  fc.stringMatching(/^[0-9]{1,2}\.[0-9]{1,2}$/),
);

const factsArb = fc.record({
  waveFlag: fc.boolean(),
  phaseNumber: phaseNumberArb,
  hasPriorPhases: fc.boolean(),
});

// ─── Row 25: exact partition ────────────────────────────────────────────────

describe('property: selection is always an exact partition', () => {
  test('selectionIsAlwaysAnExactPartitionOfInputSections', () => {
    fc.assert(
      fc.property(sectionsArb, factsArb, (sections, facts) => {
        const { included, excluded } = selectSections(sections, facts);
        const allIds = sections.map((s) => s.id);

        // Union recovers every id exactly once, intersection is empty.
        const unionSorted = [...included, ...excluded].sort();
        assert.deepEqual(unionSorted, [...allIds].sort());
        const intersection = included.filter((id) => excluded.includes(id));
        assert.deepEqual(intersection, []);
      }),
    );
  });
});

// ─── Row 26: `always` sections included under every fact combination ──────

describe('property: always sections are included under every fact combination', () => {
  test('alwaysSectionsAreIncludedUnderEveryFactCombination', () => {
    fc.assert(
      fc.property(sectionsArb, factsArb, (sections, facts) => {
        const { included } = selectSections(sections, facts);
        const alwaysIds = sections.filter((s) => s.when === 'always').map((s) => s.id);
        for (const id of alwaysIds) {
          assert.equal(included.includes(id), true, `expected always-section "${id}" to be included`);
        }
      }),
    );
  });
});

// ─── Row 27: totality — never throws for vocab-valid when × arbitrary facts ─

describe('property: never throws for vocabulary-valid when and arbitrary facts', () => {
  test('neverThrowsForVocabularyValidWhenAndArbitraryFacts', () => {
    fc.assert(
      fc.property(sectionsArb, factsArb, (sections, facts) => {
        assert.doesNotThrow(() => selectSections(sections, facts));
      }),
    );
  });

  test('neverThrowsWhenFactsAreMissingKeysEntirely', () => {
    // Totality also over PARTIAL facts objects (row 19's property-level
    // twin): dropping zero or more of the three fact keys must never throw.
    const factKeys = ['waveFlag', 'phaseNumber', 'hasPriorPhases'];
    fc.assert(
      fc.property(sectionsArb, factsArb, fc.subarray(factKeys), (sections, facts, keysToKeep) => {
        const partialFacts = {};
        for (const key of keysToKeep) partialFacts[key] = facts[key];
        assert.doesNotThrow(() => selectSections(sections, partialFacts));
      }),
    );
  });
});

// ─── Row 28: order preservation ─────────────────────────────────────────────

describe('property: included ids preserve document order', () => {
  test('includedIdsPreserveDocumentOrder', () => {
    fc.assert(
      fc.property(sectionsArb, factsArb, (sections, facts) => {
        const { included, excluded } = selectSections(sections, facts);
        const allIds = sections.map((s) => s.id);

        // A subsequence check: the positions of `included` ids within
        // `allIds`, taken in the order they appear in `included`, must be
        // strictly increasing (never reordered relative to the input).
        let cursor = -1;
        for (const id of included) {
          const pos = allIds.indexOf(id, cursor + 1);
          assert.ok(pos > cursor, `id "${id}" out of document order in included[]`);
          cursor = pos;
        }

        // Same subsequence guarantee for excluded[].
        cursor = -1;
        for (const id of excluded) {
          const pos = allIds.indexOf(id, cursor + 1);
          assert.ok(pos > cursor, `id "${id}" out of document order in excluded[]`);
          cursor = pos;
        }
      }),
    );
  });
});

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

const { selectSections, REASON } = require('../gsd-core/bin/lib/section-manifest.cjs');
const { WHEN_VOCABULARY } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

const WHEN_VALUES = [...WHEN_VOCABULARY];

// Object.prototype-shaped `when` values — added during review — prototype-
// chain fail-open found by isolated adversarial pass. A bracket lookup on a
// plain frozen object resolves these as inherited members instead of failing
// closed; the totality property below must cover them too.
const HOSTILE_WHEN_VALUES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'prototype',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

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

// Flag atoms drawn from the module's own frozen WHEN_VOCABULARY re-export
// (DEFECT.GENERATIVE-FIX — never a hardcoded local copy of flag names).
const FLAG_TOKENS = WHEN_VOCABULARY.filter((w) => w.startsWith('flag:--')).map((w) => w.slice('flag:'.length));

const flagsArb = fc.subarray(FLAG_TOKENS).map((tokens) => new Set(tokens));

const factsArb = fc.record({
  flags: flagsArb,
  phaseNumber: phaseNumberArb,
  hasPriorPhases: fc.boolean(),
  // #2992 review finding: the three newer state:* booleans (needsCodebaseMap,
  // phaseMvpMode, worktreesEnabled) must also participate in the partition
  // invariant, not just the original three W/D/P facts.
  needsCodebaseMap: fc.boolean(),
  phaseMvpMode: fc.boolean(),
  worktreesEnabled: fc.boolean(),
  // #2993 (epic #1671 Phase 6.2): chunkedMode is a shape addition to
  // InvocationFacts — must also participate in the partition/totality
  // properties below, not just the six pre-existing fact keys.
  chunkedMode: fc.boolean(),
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
    // twin): dropping zero or more of the seven fact keys must never throw.
    const factKeys = ['flags', 'phaseNumber', 'hasPriorPhases', 'needsCodebaseMap', 'phaseMvpMode', 'worktreesEnabled', 'chunkedMode'];
    fc.assert(
      fc.property(sectionsArb, factsArb, fc.subarray(factKeys), (sections, facts, keysToKeep) => {
        const partialFacts = {};
        for (const key of keysToKeep) partialFacts[key] = facts[key];
        assert.doesNotThrow(() => selectSections(sections, partialFacts));
      }),
    );
  });
});

// ─── Added during review: totality fails closed for prototype-shaped keys ──
// A hostile, Object.prototype-shaped `when` value injected anywhere in an
// otherwise vocab-valid document must always throw REASON.UNKNOWN_WHEN and
// must never appear in `included` — the prototype-chain fail-open the
// isolated adversarial pass found (constructor/toString/etc. resolving as
// truthy inherited members, or `__proto__` throwing an untyped error).

describe('property: prototype-shaped when values always fail closed', () => {
  const hostileWhenArb = fc.constantFrom(...HOSTILE_WHEN_VALUES);
  const hostileIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);

  test('injectingAHostileWhenAnywhereAlwaysThrowsUnknownWhen', () => {
    fc.assert(
      fc.property(
        sectionsArb,
        hostileIdArb,
        hostileWhenArb,
        fc.nat(),
        (sections, hostileIdBase, hostileWhen, rawIndex) => {
          const hostileSection = { id: `hostile-${hostileIdBase}`, when: hostileWhen };
          const insertAt = sections.length === 0 ? 0 : rawIndex % (sections.length + 1);
          const withHostile = [...sections.slice(0, insertAt), hostileSection, ...sections.slice(insertAt)];

          let caught;
          try {
            selectSections(withHostile, {});
          } catch (err) {
            caught = err;
          }
          assert.ok(caught instanceof TypeError, 'expected selectSections to throw for a hostile when value');
          assert.equal(caught.reason, REASON.UNKNOWN_WHEN);
        },
      ),
    );
  });
});

// ─── B18: flag monotonicity — more flags never yields fewer included ───────

describe('property: adding more flags never yields fewer included sections (#2992 row B18)', () => {
  test('flagSupersetNeverShrinksIncluded', () => {
    fc.assert(
      fc.property(sectionsArb, flagsArb, fc.subarray(FLAG_TOKENS), factsArb, (sections, baseFlags, extraTokens, restFacts) => {
        const supersetFlags = new Set([...baseFlags, ...extraTokens]);
        const baseResult = selectSections(sections, { ...restFacts, flags: baseFlags });
        const supersetResult = selectSections(sections, { ...restFacts, flags: supersetFlags });

        for (const id of baseResult.included) {
          assert.ok(
            supersetResult.included.includes(id),
            `id "${id}" included under a flags subset must remain included under a flags superset`,
          );
        }
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

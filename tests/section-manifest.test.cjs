'use strict';

/**
 * Example-based unit tests for src/section-manifest.cts (compiled to
 * gsd-core/bin/lib/section-manifest.cjs) — issue #2932 (epic #1671 Phase 5).
 *
 * Covers 50-test-matrix.md rows 1-24: section A (the pure `when=` evaluator)
 * and section B (the `DEFECT.GENERATIVE-FIX` / Greenspun vocabulary parity
 * guard against Phase 3's exported `WHEN_VOCABULARY`).
 *
 * No source-grep (CONTRIBUTING.md): every assertion is on typed values
 * (`included`/`excluded` id arrays, the thrown error's `.reason`) — never on
 * rendered text via `.includes()`/`.match()` of source/message prose.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { selectSections, WHEN_PREDICATES, REASON } = require('../gsd-core/bin/lib/section-manifest.cjs');
const { WHEN_VOCABULARY } = require('../gsd-core/bin/lib/workflow-fragments.cjs');

// The three branch sections named throughout the design doc's behavior
// table, plus one `always` section — the exact shape `selectSections`
// consumes (structurally compatible with a parsed `WorkflowSection` array,
// but hand-built here since this suite tests the evaluator in isolation).
const BRANCH_SECTIONS = Object.freeze([
  { id: 'preamble', when: 'always' },
  { id: 'partial-wave', when: 'flag:--wave' },
  { id: 'gap-closure-artifacts', when: 'state:gap-closure-phase' },
  { id: 'regression-gate', when: 'state:has-prior-phases' },
]);

function facts(overrides) {
  return { waveFlag: false, phaseNumber: null, hasPriorPhases: false, ...overrides };
}

// ─── Rows 1-8: happy path + combinations over W/D/P ─────────────────────────

describe('W/D/P combination matrix (design doc behavior table rows 1-8)', () => {
  test('selectsOnlyAlwaysSectionsWhenNoFactsHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({}));
    assert.deepEqual(result.included, ['preamble']);
    assert.deepEqual(result.excluded, ['partial-wave', 'gap-closure-artifacts', 'regression-gate']);
  });

  test('includesPartialWaveWhenWaveFlagPresent', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ waveFlag: true }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave']);
    assert.deepEqual(result.excluded, ['gap-closure-artifacts', 'regression-gate']);
  });

  test('includesGapClosureWhenPhaseNumberHasDecimal', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ phaseNumber: '3.1' }));
    assert.deepEqual(result.included, ['preamble', 'gap-closure-artifacts']);
    assert.deepEqual(result.excluded, ['partial-wave', 'regression-gate']);
  });

  test('includesRegressionGateWhenPriorPhasesExist', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'regression-gate']);
    assert.deepEqual(result.excluded, ['partial-wave', 'gap-closure-artifacts']);
  });

  test('includesBothWaveAndGapClosureWhenBothHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ waveFlag: true, phaseNumber: '3.1' }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave', 'gap-closure-artifacts']);
    assert.deepEqual(result.excluded, ['regression-gate']);
  });

  test('includesBothWaveAndRegressionWhenBothHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ waveFlag: true, hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave', 'regression-gate']);
    assert.deepEqual(result.excluded, ['gap-closure-artifacts']);
  });

  test('includesBothGapClosureAndRegressionWhenBothHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ phaseNumber: '3.1', hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'gap-closure-artifacts', 'regression-gate']);
    assert.deepEqual(result.excluded, ['partial-wave']);
  });

  test('includesEveryBranchSectionWhenAllFactsHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ waveFlag: true, phaseNumber: '3.1', hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave', 'gap-closure-artifacts', 'regression-gate']);
    assert.deepEqual(result.excluded, []);
  });
});

// ─── Rows 9-14: phase-number decimal boundary + hostile literal rule ───────

describe('gap-closure-phase predicate boundary and hostile inputs', () => {
  test('treatsTrailingZeroDecimalPhaseAsGapClosure', () => {
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '3.0' })), true);
  });

  test('treatsZeroPaddedDecimalPhaseAsGapClosure', () => {
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '03.1' })), true);
  });

  test('treatsIntegerPhaseAsNotGapClosure', () => {
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '3' })), false);
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '04' })), false);
  });

  test('treatsNullPhaseNumberAsNotGapClosure', () => {
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: null })), false);
  });

  test('treatsEmptyPhaseNumberAsNotGapClosure', () => {
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '' })), false);
  });

  test('treatsBareDotPhaseNumberLiterallyPerDocumentedRule', () => {
    // The predicate is deliberately literal (`.includes('.')`) per the
    // design doc's negative-space note — it does not invent a stricter
    // regex the section body's documented rule does not claim.
    assert.equal(WHEN_PREDICATES['state:gap-closure-phase'](facts({ phaseNumber: '.' })), true);
  });
});

// ─── Rows 15-17: boundary section-list sizes ────────────────────────────────

describe('boundary section-list sizes (limit-1 / limit / limit+1)', () => {
  test('returnsEmptySelectionForWorkflowWithNoSections', () => {
    const result = selectSections([], facts({}));
    assert.deepEqual(result, { included: [], excluded: [] });
  });

  test('partitionsSingleSectionWorkflow', () => {
    const includedResult = selectSections([{ id: 'only', when: 'always' }], facts({}));
    assert.deepEqual(includedResult, { included: ['only'], excluded: [] });

    const excludedResult = selectSections([{ id: 'only', when: 'flag:--wave' }], facts({}));
    assert.deepEqual(excludedResult, { included: [], excluded: ['only'] });
  });

  test('preservesDocumentOrderAcrossManySections', () => {
    // Duplicates-by-when: several sections sharing the SAME when= value must
    // each retain their own id and their own document-order position.
    const sections = [
      { id: 's0', when: 'always' },
      { id: 's1', when: 'flag:--wave' },
      { id: 's2', when: 'always' },
      { id: 's3', when: 'flag:--wave' },
      { id: 's4', when: 'state:gap-closure-phase' },
      { id: 's5', when: 'always' },
      { id: 's6', when: 'state:has-prior-phases' },
    ];
    const result = selectSections(sections, facts({ waveFlag: true }));
    assert.deepEqual(result.included, ['s0', 's1', 's2', 's3', 's5']);
    assert.deepEqual(result.excluded, ['s4', 's6']);
  });
});

// ─── Row 18: fail-closed on unknown when= ───────────────────────────────────

describe('fail-closed on an unrecognized when= value', () => {
  test('throwsOnWhenValueOutsideFrozenVocabulary', () => {
    assert.throws(
      () => selectSections([{ id: 'x', when: 'flag:--nonexistent' }], facts({})),
      (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
    );
  });
});

// ─── Row 19: totality over facts ────────────────────────────────────────────

describe('totality: an absent fact key is treated as falsy, never throws', () => {
  test('treatsAbsentFactAsFalseWithoutThrowing', () => {
    assert.doesNotThrow(() => selectSections(BRANCH_SECTIONS, {}));
    const result = selectSections(BRANCH_SECTIONS, {});
    assert.deepEqual(result.included, ['preamble']);
    assert.deepEqual(result.excluded, ['partial-wave', 'gap-closure-artifacts', 'regression-gate']);
  });
});

// ─── Row 20: determinism + non-mutation ─────────────────────────────────────

describe('determinism and input non-mutation', () => {
  test('isDeterministicAndDoesNotMutateInput', () => {
    const sections = [
      { id: 'a', when: 'always' },
      { id: 'b', when: 'flag:--wave' },
    ];
    const snapshotBefore = sections.map((s) => ({ ...s }));
    const f = facts({ waveFlag: true });

    const first = selectSections(sections, f);
    const second = selectSections(sections, f);

    assert.deepEqual(first, second);
    assert.deepEqual(sections, snapshotBefore);
    assert.equal(Array.isArray(sections), true);
    assert.equal(sections.length, 2);
  });
});

// ─── Rows 21-23: DEFECT.GENERATIVE-FIX vocabulary parity guard ─────────────

describe('WHEN_PREDICATES and WHEN_VOCABULARY parity (DEFECT.GENERATIVE-FIX)', () => {
  test('everyFrozenVocabularyEntryHasAPredicate', () => {
    for (const when of WHEN_VOCABULARY) {
      assert.equal(typeof WHEN_PREDICATES[when], 'function', `expected a predicate for when="${when}"`);
    }
  });

  test('everyPredicateKeyIsInTheFrozenVocabulary', () => {
    for (const when of Object.keys(WHEN_PREDICATES)) {
      assert.equal(WHEN_VOCABULARY.includes(when), true, `predicate key "${when}" is not in WHEN_VOCABULARY`);
    }
  });

  test('failsWhenVocabularyGainsAnEntryWithoutAPredicate', () => {
    // Simulates a 5th vocabulary entry being added without a corresponding
    // predicate: the SAME parity check as row 21, run against a vocabulary
    // array with an extra entry, must fail (i.e. NOT every entry has a
    // predicate) until a predicate is added on the evaluator side too.
    const widenedVocabulary = [...WHEN_VOCABULARY, 'state:not-yet-real'];
    const missing = widenedVocabulary.filter((when) => typeof WHEN_PREDICATES[when] !== 'function');
    assert.deepEqual(missing, ['state:not-yet-real']);
  });
});

// ─── Row 24: REASON enum shape is locked ────────────────────────────────────

describe('REASON enum is frozen and its shape is locked', () => {
  test('locksReasonEnumKeySet', () => {
    assert.equal(Object.isFrozen(REASON), true);
    assert.deepEqual(Object.keys(REASON).sort(), ['UNKNOWN_WHEN']);
  });
});

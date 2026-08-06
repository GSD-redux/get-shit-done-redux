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
const fs = require('node:fs');
const path = require('node:path');

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
  // #2993 (epic #1671 Phase 6.2): chunkedMode is a shape addition to
  // InvocationFacts — defaulted false here so every pre-existing call site
  // above keeps its prior behavior unchanged.
  return { flags: new Set(), phaseNumber: null, hasPriorPhases: false, chunkedMode: false, ...overrides };
}

// ─── Rows 1-8: happy path + combinations over W/D/P ─────────────────────────

describe('W/D/P combination matrix (design doc behavior table rows 1-8)', () => {
  test('selectsOnlyAlwaysSectionsWhenNoFactsHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({}));
    assert.deepEqual(result.included, ['preamble']);
    assert.deepEqual(result.excluded, ['partial-wave', 'gap-closure-artifacts', 'regression-gate']);
  });

  test('includesPartialWaveWhenWaveFlagPresent', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ flags: new Set(['--wave']) }));
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
    const result = selectSections(BRANCH_SECTIONS, facts({ flags: new Set(['--wave']), phaseNumber: '3.1' }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave', 'gap-closure-artifacts']);
    assert.deepEqual(result.excluded, ['regression-gate']);
  });

  test('includesBothWaveAndRegressionWhenBothHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ flags: new Set(['--wave']), hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'partial-wave', 'regression-gate']);
    assert.deepEqual(result.excluded, ['gap-closure-artifacts']);
  });

  test('includesBothGapClosureAndRegressionWhenBothHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ phaseNumber: '3.1', hasPriorPhases: true }));
    assert.deepEqual(result.included, ['preamble', 'gap-closure-artifacts', 'regression-gate']);
    assert.deepEqual(result.excluded, ['partial-wave']);
  });

  test('includesEveryBranchSectionWhenAllFactsHold', () => {
    const result = selectSections(BRANCH_SECTIONS, facts({ flags: new Set(['--wave']), phaseNumber: '3.1', hasPriorPhases: true }));
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
    const result = selectSections(sections, facts({ flags: new Set(['--wave']) }));
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
    const f = facts({ flags: new Set(['--wave']) });

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

// ─── B11: atom↔flag-string desync (#2992 — "the key new test") ─────────────
// For EVERY 'flag:--X' atom in the frozen WHEN_VOCABULARY, the predicate must
// be true iff `flags={--X}` and false for `flags={}`. Derived FROM the
// vocabulary export (never a hand-copied local list of flag names), so a
// typo in WHEN_PREDICATES' hand-written literal map (e.g. matching the wrong
// token) is caught behaviorally instead of only by eyeballing the diff.

describe('atom<->flag-string desync guard (#2992 row B11)', () => {
  const flagAtoms = WHEN_VOCABULARY.filter((w) => w.startsWith('flag:--'));

  test('everyFlagAtomHasAtLeastOneEntryToGuard', () => {
    // Sanity: this guard is vacuous if the vocabulary somehow shipped zero
    // flag atoms — fail loudly rather than silently passing on an empty loop.
    assert.ok(flagAtoms.length > 0, 'expected at least one flag: atom in WHEN_VOCABULARY');
  });

  for (const atom of flagAtoms) {
    // The atom's own token, derived ONLY for use as the flags-Set member in
    // this TEST (never fed back into production, which forbids exactly this
    // derivation in WHEN_PREDICATES itself — see the module doc comment).
    const token = atom.slice('flag:'.length);

    test(`predicateForAtomMatchesItsOwnToken_${atom}`, () => {
      const included = selectSections([{ id: 'x', when: atom }], facts({ flags: new Set([token]) }));
      assert.deepEqual(included, { included: ['x'], excluded: [] }, `expected "${atom}" included when flags={${token}}`);

      const excluded = selectSections([{ id: 'x', when: atom }], facts({ flags: new Set() }));
      assert.deepEqual(excluded, { included: [], excluded: ['x'] }, `expected "${atom}" excluded when flags={}`);
    });
  }
});

// ─── B14: flags set cardinality boundary (0 / 1 / many) ────────────────────

describe('flags set cardinality (#2992 row B14)', () => {
  const sections = Object.freeze([
    { id: 'a', when: 'flag:--auto' },
    { id: 'b', when: 'flag:--discuss' },
    { id: 'c', when: 'flag:--fix' },
  ]);

  test('zeroFlagsExcludesEveryFlagSection', () => {
    const result = selectSections(sections, facts({ flags: new Set() }));
    assert.deepEqual(result, { included: [], excluded: ['a', 'b', 'c'] });
  });

  test('oneFlagIncludesOnlyItsOwnSection', () => {
    const result = selectSections(sections, facts({ flags: new Set(['--discuss']) }));
    assert.deepEqual(result, { included: ['b'], excluded: ['a', 'c'] });
  });

  test('manyFlagsIncludeEveryMatchingSection', () => {
    const result = selectSections(sections, facts({ flags: new Set(['--auto', '--discuss', '--fix', '--irrelevant']) }));
    assert.deepEqual(result, { included: ['a', 'b', 'c'], excluded: [] });
  });
});

// ─── Row 24: REASON enum shape is locked ────────────────────────────────────

describe('REASON enum is frozen and its shape is locked', () => {
  test('locksReasonEnumKeySet', () => {
    assert.equal(Object.isFrozen(REASON), true);
    assert.deepEqual(Object.keys(REASON).sort(), ['UNKNOWN_WHEN']);
  });
});

// ─── #2992 review finding: state:needs-codebase-map / state:phase-mvp-mode /
// state:worktrees-enabled predicate coverage ─────────────────────────────
//
// These three atoms were shipped (src/section-manifest.cts) with zero
// direct predicate-level test coverage — `state:phase-mvp-mode` and
// `state:worktrees-enabled` DO have real prod-shape integration coverage
// (tests/init.test.cjs "init execute-phase: state:* detector degradation
// (#2992 rows D9-D11)"), but `state:needs-codebase-map` had none anywhere.
// Locking all three here at the evaluator level too, matching every other
// shipped predicate's dedicated matrix test.

describe('state:needs-codebase-map / state:phase-mvp-mode / state:worktrees-enabled predicates', () => {
  test('needsCodebaseMapTrueWhenFactIsTrue', () => {
    assert.equal(WHEN_PREDICATES['state:needs-codebase-map'](facts({ needsCodebaseMap: true })), true);
  });

  test('needsCodebaseMapFalseWhenFactIsFalse', () => {
    assert.equal(WHEN_PREDICATES['state:needs-codebase-map'](facts({ needsCodebaseMap: false })), false);
  });

  test('needsCodebaseMapFalseWhenFactIsAbsent', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:needs-codebase-map'](facts({})));
    assert.equal(WHEN_PREDICATES['state:needs-codebase-map'](facts({})), false);
  });

  test('needsCodebaseMapFalseWhenFactIsUndefined', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:needs-codebase-map'](facts({ needsCodebaseMap: undefined })));
    assert.equal(WHEN_PREDICATES['state:needs-codebase-map'](facts({ needsCodebaseMap: undefined })), false);
  });

  test('phaseMvpModeTrueWhenFactIsTrue', () => {
    assert.equal(WHEN_PREDICATES['state:phase-mvp-mode'](facts({ phaseMvpMode: true })), true);
  });

  test('phaseMvpModeFalseWhenFactIsFalse', () => {
    assert.equal(WHEN_PREDICATES['state:phase-mvp-mode'](facts({ phaseMvpMode: false })), false);
  });

  test('phaseMvpModeFalseWhenFactIsAbsent', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:phase-mvp-mode'](facts({})));
    assert.equal(WHEN_PREDICATES['state:phase-mvp-mode'](facts({})), false);
  });

  test('phaseMvpModeFalseWhenFactIsUndefined', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:phase-mvp-mode'](facts({ phaseMvpMode: undefined })));
    assert.equal(WHEN_PREDICATES['state:phase-mvp-mode'](facts({ phaseMvpMode: undefined })), false);
  });

  test('worktreesEnabledTrueWhenFactIsTrue', () => {
    assert.equal(WHEN_PREDICATES['state:worktrees-enabled'](facts({ worktreesEnabled: true })), true);
  });

  test('worktreesEnabledFalseWhenFactIsFalse', () => {
    assert.equal(WHEN_PREDICATES['state:worktrees-enabled'](facts({ worktreesEnabled: false })), false);
  });

  test('worktreesEnabledFalseWhenFactIsAbsent', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:worktrees-enabled'](facts({})));
    assert.equal(WHEN_PREDICATES['state:worktrees-enabled'](facts({})), false);
  });

  test('worktreesEnabledFalseWhenFactIsUndefined', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:worktrees-enabled'](facts({ worktreesEnabled: undefined })));
    assert.equal(WHEN_PREDICATES['state:worktrees-enabled'](facts({ worktreesEnabled: undefined })), false);
  });

  test('selectSectionsIncludesNeedsCodebaseMapSectionOnlyWhenFactIsTrue', () => {
    const sections = [{ id: 'needs-map', when: 'state:needs-codebase-map' }];
    assert.deepEqual(selectSections(sections, facts({ needsCodebaseMap: true })), { included: ['needs-map'], excluded: [] });
    assert.deepEqual(selectSections(sections, facts({ needsCodebaseMap: false })), { included: [], excluded: ['needs-map'] });
    assert.deepEqual(selectSections(sections, facts({})), { included: [], excluded: ['needs-map'] });
  });
});

// ─── #2993 (epic #1671 Phase 6.2) row A6: flag:--research-phase and
// flag:--research are DISTINCT atoms — neither aliases the other, each
// gates only its own sections ─────────────────────────────────────────────

describe('flag:--research-phase and flag:--research do not alias each other (row A6)', () => {
  const sections = Object.freeze([
    { id: 'research-section', when: 'flag:--research' },
    { id: 'research-phase-section', when: 'flag:--research-phase' },
  ]);

  test('onlyResearchFlagIncludesOnlyTheResearchSection', () => {
    const result = selectSections(sections, facts({ flags: new Set(['--research']) }));
    assert.deepEqual(result, { included: ['research-section'], excluded: ['research-phase-section'] });
  });

  test('onlyResearchPhaseFlagIncludesOnlyTheResearchPhaseSection', () => {
    const result = selectSections(sections, facts({ flags: new Set(['--research-phase']) }));
    assert.deepEqual(result, { included: ['research-phase-section'], excluded: ['research-section'] });
  });

  test('bothFlagsIncludeBothSections', () => {
    const result = selectSections(sections, facts({ flags: new Set(['--research', '--research-phase']) }));
    assert.deepEqual(result, { included: ['research-section', 'research-phase-section'], excluded: [] });
  });

  test('neitherFlagExcludesBothSections', () => {
    const result = selectSections(sections, facts({ flags: new Set() }));
    assert.deepEqual(result, { included: [], excluded: ['research-section', 'research-phase-section'] });
  });

  test('predicatesAreIndependentFunctionsNotSharedByToken', () => {
    // A stronger structural guard than the behavioral ones above: the two
    // predicates must not literally be the same function reference (which
    // would make aliasing possible by construction, even if it happened to
    // pass every input/output check above by coincidence).
    assert.notEqual(WHEN_PREDICATES['flag:--research'], WHEN_PREDICATES['flag:--research-phase']);
  });
});

// ─── #2993 (epic #1671 Phase 6.2) row A8: state:chunked-mode fact true /
// false / absent ────────────────────────────────────────────────────────

describe('state:chunked-mode predicate (row A8)', () => {
  test('chunkedModeTrueWhenFactIsTrue', () => {
    assert.equal(WHEN_PREDICATES['state:chunked-mode'](facts({ chunkedMode: true })), true);
  });

  test('chunkedModeFalseWhenFactIsFalse', () => {
    assert.equal(WHEN_PREDICATES['state:chunked-mode'](facts({ chunkedMode: false })), false);
  });

  test('chunkedModeFalseWhenFactIsAbsent', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:chunked-mode'](facts({})));
    const { chunkedMode: _omit, ...withoutChunkedMode } = facts({});
    assert.doesNotThrow(() => WHEN_PREDICATES['state:chunked-mode'](withoutChunkedMode));
    assert.equal(WHEN_PREDICATES['state:chunked-mode'](withoutChunkedMode), false);
  });

  test('chunkedModeFalseWhenFactIsUndefined', () => {
    assert.doesNotThrow(() => WHEN_PREDICATES['state:chunked-mode'](facts({ chunkedMode: undefined })));
    assert.equal(WHEN_PREDICATES['state:chunked-mode'](facts({ chunkedMode: undefined })), false);
  });

  test('chunkedModeFalseForTheStringLiteralTrue (strict === true, never coerced)', () => {
    // Mirrors readConfigJsonBoolean's own strict discipline (src/init.cts):
    // a truthy-but-non-boolean value must never pass. This is the FACT's own
    // strictness contract; the config-string-"true" case itself is exercised
    // at the init seam in tests/init.test.cjs (prod-shape, row B9).
    assert.equal(WHEN_PREDICATES['state:chunked-mode'](facts({ chunkedMode: 'true' })), false);
  });

  test('selectSectionsIncludesChunkedPlanningModeSectionOnlyWhenFactIsTrue', () => {
    const sections = [{ id: 'chunked-section', when: 'state:chunked-mode' }];
    assert.deepEqual(selectSections(sections, facts({ chunkedMode: true })), { included: ['chunked-section'], excluded: [] });
    assert.deepEqual(selectSections(sections, facts({ chunkedMode: false })), { included: [], excluded: ['chunked-section'] });
    assert.deepEqual(selectSections(sections, facts({})), { included: [], excluded: ['chunked-section'] });
  });
});

// ─── Rows 25-33: Object.prototype-shaped when= values fail closed ──────────
// Added during review — prototype-chain fail-open found by isolated
// adversarial pass. A bracket lookup on a plain frozen object resolves
// inherited Object.prototype members (`constructor`, `toString`, etc.) as if
// they were predicates, silently including the section or throwing an
// untyped error instead of failing closed with REASON.UNKNOWN_WHEN.

// ─── #2994 (epic #1671 Phase 6.3) matrix §A: atom admission — the gate-2 hole ──
//
// The two load-time parity guards above (rows 21-23) prove WHEN_VOCABULARY <->
// WHEN_PREDICATES symmetry — every atom has SOME predicate function. Neither
// proves the predicate's underlying FACT is ever computed by a real cmdInit*
// caller: an atom whose fact no caller assembles evaluates false forever,
// which is the silent-wrong-answer class this PR exists to prevent (matrix
// row A/#8). This block closes that hole by driving every one of the 30
// frozen atoms to both a TRUE and a FALSE outcome via a constructed
// InvocationFacts, entirely at this module's own boundary (never reaching
// into src/init.cts, which is covered separately in
// tests/section-manifest-init-facts.test.cjs).

/**
 * Per-atom recipe: how to build an `InvocationFacts` fragment that drives
 * `WHEN_PREDICATES[atom]` to `true`, and a second fragment that drives it to
 * `false`. `flag` atoms derive their token mechanically (`atom.slice('flag:'.length)`,
 * the same derivation B11 above already established as test-only-legal); every
 * `state:` atom's backing fact FIELD is a hand-written literal here — same
 * discipline as `WHEN_PREDICATES` itself (module doc comment "The evaluator is
 * a LOOKUP, not a parser"): there is no mechanical way to derive
 * `chunkedMode` from `"state:chunked-mode"` without inventing a tokenizer.
 * `'always'` is the one structural exception: its predicate is `() => true`
 * unconditionally (it backs every synthesized gap fragment), so no `facts`
 * value can ever drive it to `false` — handled as its own branch below, not
 * silently dropped from the 30-atom set A5 checks against.
 */
const STATE_ATOM_FACT_FIELD = Object.freeze({
  'state:has-prior-phases': 'hasPriorPhases',
  'state:auto-advance-active': 'autoAdvanceActive',
  'state:chunked-mode': 'chunkedMode',
  'state:fallow-enabled': 'fallowEnabled',
  'state:git-create-tag': 'gitCreateTag',
  'state:needs-codebase-map': 'needsCodebaseMap',
  'state:phase-mvp-mode': 'phaseMvpMode',
  'state:plan-strategy-converge': 'planStrategyConverge',
  'state:reviewer-instances-configured': 'reviewerInstancesConfigured',
  'state:ui-phase-active': 'uiPhaseActive',
  'state:worktrees-enabled': 'worktreesEnabled',
  'state:is-monorepo': 'isMonorepo',
  'state:next-channel': 'nextChannel',
  'state:workstream-active': 'workstreamActive',
  'state:flat-mode': 'flatMode',
});

/** `state:gap-closure-phase` is the one atom keyed off `phaseNumber`, not a plain boolean field. */
const GAP_CLOSURE_ATOM = 'state:gap-closure-phase';

/** @returns {{truthy: object, falsy: object | null}} fact FRAGMENTS (merged onto `facts({})` by the caller) for `atom`; `falsy: null` marks the `'always'` exception. */
function factFragmentsFor(atom) {
  if (atom === 'always') {
    return { truthy: {}, falsy: null };
  }
  if (atom === GAP_CLOSURE_ATOM) {
    return { truthy: { phaseNumber: '3.1' }, falsy: { phaseNumber: '3' } };
  }
  if (atom.startsWith('flag:--')) {
    const token = atom.slice('flag:'.length);
    return { truthy: { flags: new Set([token]) }, falsy: { flags: new Set() } };
  }
  const field = STATE_ATOM_FACT_FIELD[atom];
  if (!field) {
    throw new Error(`factFragmentsFor: atom "${atom}" has no fact-field mapping — update STATE_ATOM_FACT_FIELD`);
  }
  return { truthy: { [field]: true }, falsy: { [field]: false } };
}

describe('every when= atom is satisfiable by some InvocationFacts (#2994 matrix rows A1/A2/A5)', () => {
  // A5 anti-vacuity: the atom set this describe block iterates must be
  // non-empty AND exactly equal to WHEN_VOCABULARY's full 29-entry set — an
  // A1/A2 loop over an empty or partial collection would be a green test
  // proving nothing (ADR-1671 eval-gate rot, named explicitly in the design).
  test('atom satisfiability set is non-empty and equals the full frozen WHEN_VOCABULARY (row A5)', () => {
    assert.ok(WHEN_VOCABULARY.length > 0, 'WHEN_VOCABULARY must not be empty');
    const coveredAtoms = [...WHEN_VOCABULARY].sort();
    // Every atom must resolve via factFragmentsFor without throwing — this is
    // the completeness check on STATE_ATOM_FACT_FIELD itself: an atom added
    // to WHEN_VOCABULARY without a corresponding entry here throws loudly
    // instead of silently narrowing the set A1/A2 below actually cover.
    for (const atom of WHEN_VOCABULARY) {
      assert.doesNotThrow(() => factFragmentsFor(atom), `factFragmentsFor must resolve "${atom}"`);
    }
    assert.deepEqual(coveredAtoms, [...WHEN_VOCABULARY].sort(), 'the covered atom set must be exactly WHEN_VOCABULARY');
    assert.equal(WHEN_VOCABULARY.length, 29, 'sanity: the frozen vocabulary is expected at 29 entries for #2994 — update this literal alongside a deliberate vocabulary widening');
  });

  for (const atom of WHEN_VOCABULARY) {
    test(`atom "${atom}" is included when its fact is true, excluded when false (rows A1/A2)`, () => {
      const { truthy, falsy } = factFragmentsFor(atom);
      const sections = [{ id: 'target', when: atom }];

      // A1: some constructed InvocationFacts drives this section into `included`.
      const includedResult = selectSections(sections, facts(truthy));
      assert.deepEqual(includedResult, { included: ['target'], excluded: [] }, `expected "${atom}" included under its truthy facts`);

      if (falsy === null) {
        // The 'always' exception: no facts value can ever exclude it — assert
        // that deliberately, rather than silently skipping the atom (which
        // would violate A5's "set is non-empty" guarantee for THIS assertion).
        const stillIncluded = selectSections(sections, facts({}));
        assert.deepEqual(stillIncluded, { included: ['target'], excluded: [] }, '"always" must remain included under every facts value — it has no false branch');
        return;
      }

      // A2: some constructed InvocationFacts drives the SAME section into `excluded`.
      const excludedResult = selectSections(sections, facts(falsy));
      assert.deepEqual(excludedResult, { included: [], excluded: ['target'] }, `expected "${atom}" excluded under its falsy facts`);
    });
  }
});

// ─── #2994 matrix row A3: no admitted atom lacks a consuming section ───────
//
// An atom present in WHEN_VOCABULARY with zero consuming `when=` markers
// anywhere in the SHIPPED gsd-core/workflows/section-manifest.json is dead
// vocabulary: cardinality without a section, the exact rot the frozen list's
// "no atom is admitted without a consumer, in the same commit" discipline
// exists to prevent (40-design.md "Vocabulary growth"). Driven from the real
// installed-shape artifact — never a hand-built fixture — per the matrix's
// prime directive ("a hand-built manifest proves a property no real caller
// exercises").

describe('no admitted atom lacks a consuming section in the shipped manifest (#2994 matrix row A3)', () => {
  const SHIPPED_MANIFEST_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'section-manifest.json');

  test('every WHEN_VOCABULARY atom is used as a when= value by at least one shipped section', () => {
    const manifest = JSON.parse(fs.readFileSync(SHIPPED_MANIFEST_PATH, 'utf8'));
    const usedAtoms = new Set();
    for (const sections of Object.values(manifest.workflows)) {
      for (const section of sections) {
        usedAtoms.add(section.when);
      }
    }

    // `always` is a NAMED, single exemption — not a blanket skip. It is the
    // implicit gap-fragment default (a section with no `when=` marker at all
    // is treated as unconditionally included) and is structural, not a
    // marker atom: `gen-section-manifest.cjs`'s `explicitSections` filter
    // (`s.explicit`) deliberately EXCLUDES it from the generated
    // section-manifest.json, so no shipped section's `when=` value can ever
    // literally read `"always"` — the atom is real (WHEN_PREDICATES and
    // section-marker-parsing both accept it) but by design has zero
    // consuming JSON entries.
    const unusedAtoms = WHEN_VOCABULARY.filter((atom) => atom !== 'always' && !usedAtoms.has(atom));

    // Deliberately UNWEAKENED per 50-test-matrix.md row A3's own instruction:
    // "if any atom legitimately has no consumer today, do NOT weaken this
    // test — report it to me instead, it is a real finding." No exclusion
    // list beyond the single named `always` exemption above is applied here
    // — if this assertion is red, that redness IS the finding, not a defect
    // in the test.
    assert.deepEqual(unusedAtoms, [], `dead vocabulary: these WHEN_VOCABULARY atoms have no consuming section anywhere in ${SHIPPED_MANIFEST_PATH}`);
  });
});

describe('Object.prototype-shaped when= values fail closed (REASON.UNKNOWN_WHEN)', () => {
  const HOSTILE_WHEN_VALUES = Object.freeze([
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'prototype',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ]);

  for (const when of HOSTILE_WHEN_VALUES) {
    test(`throwsUnknownWhenFor_${when}`, () => {
      assert.throws(
        () => selectSections([{ id: 'x', when }], facts({})),
        (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
      );
    });

    test(`neverIncludesSectionFor_${when}`, () => {
      let caught;
      try {
        selectSections([{ id: 'x', when }], facts({}));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `expected selectSections to throw for when="${when}"`);
      assert.equal(caught.reason, REASON.UNKNOWN_WHEN);
    });
  }

  test('noneOfTheHostileValuesAppearInIncludedAcrossAMixedSectionList', () => {
    for (const when of HOSTILE_WHEN_VALUES) {
      assert.throws(
        () => selectSections([{ id: 'safe', when: 'always' }, { id: 'hostile', when }], facts({})),
        (err) => err instanceof TypeError && err.reason === REASON.UNKNOWN_WHEN,
      );
    }
  });
});

'use strict';

/**
 * trim-safety.test.cjs — the trim-safety contract gate over `ComposeMetadata`
 * (issue #2931, epic #1671, Phase 4). Exercises
 * `tests/helpers/trim-safety.cjs` per
 * `.gsd/phase/chore-2931-emitted-byte-caps/50-test-matrix.md` section E.
 *
 * Assertion discipline: every check compares typed structured values
 * (`REASON` enum members, ids) — never rendered prose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { REASON, evaluateTrimSafety } = require('./helpers/trim-safety.cjs');

/** A fully "nothing happened" ComposeMetadata, per src/context-composer.cts's
 *  ComposeMetadata shape — every field a real compose result always carries. */
function baseMetadata(overrides = {}) {
  return {
    budget: 1000,
    effectiveBudget: 1000,
    contentBudget: 1000,
    underPressure: false,
    omitted: [],
    shrunk: [],
    floored: [],
    truncationPct: 0,
    hardFailed: false,
    hardFailReason: null,
    isolatePrefix: '',
    ...overrides,
  };
}

test('passesWhenNothingTrimmed', () => {
  const r = evaluateTrimSafety({ metadata: baseMetadata(), loadBearingIds: ['a', 'b'] });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
});

test('passesWhenOnlyNonLoadBearingDropped', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ omitted: ['c'] }),
    loadBearingIds: ['a', 'b'],
  });
  assert.deepEqual(r.findings, []);
  assert.ok(r.ok);
});

test('failsWhenLoadBearingFragmentOmitted', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ omitted: ['a'] }),
    loadBearingIds: ['a', 'b'],
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].reason, REASON.LOAD_BEARING_OMITTED);
  assert.equal(r.findings[0].id, 'a');
  assert.ok(!r.ok);
});

test('failsWhenLoadBearingFragmentShrunk', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ shrunk: ['b'] }),
    loadBearingIds: ['a', 'b'],
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].reason, REASON.LOAD_BEARING_SHRUNK);
  assert.equal(r.findings[0].id, 'b');
  assert.ok(!r.ok);
});

test('passesWhenIsolatePrefixByteIdentical', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ isolatePrefix: 'ABC' }),
    loadBearingIds: ['a'],
    expectedIsolatePrefix: 'ABC',
  });
  assert.deepEqual(r.findings, []);
  assert.ok(r.ok);
});

test('failsWhenIsolatePrefixDriftsByOneByte', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ isolatePrefix: 'ABD' }),
    loadBearingIds: ['a'],
    expectedIsolatePrefix: 'ABC',
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].reason, REASON.ISOLATE_PREFIX_DRIFT);
  assert.equal(r.findings[0].expected, 'ABC');
  assert.equal(r.findings[0].actual, 'ABD');
  assert.ok(!r.ok);
});

test('failsWhenIsolatePrefixDiffersOnlyByWhitespace', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ isolatePrefix: 'ABC ' }),
    loadBearingIds: ['a'],
    expectedIsolatePrefix: 'ABC',
  });
  assert.equal(r.findings.length, 1, 'byte-identical means byte-identical — trailing whitespace IS drift');
  assert.equal(r.findings[0].reason, REASON.ISOLATE_PREFIX_DRIFT);
  assert.ok(!r.ok);
});

test('failsOnMinimumSetHardFail', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ hardFailed: true, hardFailReason: 'minimum-set' }),
    loadBearingIds: ['a'],
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].reason, REASON.MINIMUM_SET_HARD_FAIL);
  assert.equal(r.errors[0].hardFailReason, 'minimum-set');
  assert.ok(!r.ok, 'a hard-failed compose must never be reported as a silent empty pass');
});

test('failsWhenNoFragmentIsMarkedLoadBearing', () => {
  for (const loadBearingIds of [[], undefined, null]) {
    const r = evaluateTrimSafety({ metadata: baseMetadata(), loadBearingIds });
    assert.equal(r.errors.length, 1, `${JSON.stringify(loadBearingIds)} must be rejected`);
    assert.equal(r.errors[0].reason, REASON.NO_LOAD_BEARING_DECLARED);
    assert.deepEqual(r.findings, [], 'an empty assertion set must compute no findings at all');
    assert.ok(!r.ok, 'an empty assertion set proves nothing and must never read as a pass');
  }
});

test('passesWhenLoadBearingFragmentWasFloored', () => {
  const r = evaluateTrimSafety({
    metadata: baseMetadata({ floored: ['a'] }),
    loadBearingIds: ['a'],
  });
  assert.deepEqual(r.findings, [], 'the floor did its job — never a finding');
  assert.ok(r.ok);
});

test('isIdempotentOverRepeatedEvaluation', () => {
  const metadata = baseMetadata({ omitted: ['a'], shrunk: ['b'], floored: ['c'], isolatePrefix: 'XYZ' });
  const loadBearingIds = ['a', 'b', 'c'];
  const metadataBefore = JSON.stringify(metadata);
  const idsBefore = JSON.stringify(loadBearingIds);

  const r1 = evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix: 'XYZ' });
  const r2 = evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix: 'XYZ' });

  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(metadata), metadataBefore, 'metadata must not be mutated');
  assert.equal(JSON.stringify(loadBearingIds), idsBefore, 'loadBearingIds must not be mutated');
});

// ─── property tests ───────────────────────────────────────────────────────

const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e');
const idSetArb = fc.uniqueArray(idArb, { maxLength: 5 });
const nonEmptyIdSetArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: 5 });
const prefixArb = fc.string({ maxLength: 6 });

test('propertyOkIffNoLoadBearingIdOmittedOrShrunkAndPrefixMatchesAndNoHardFail', () => {
  fc.assert(
    fc.property(
      nonEmptyIdSetArb,
      idSetArb,
      idSetArb,
      idSetArb,
      fc.boolean(),
      prefixArb,
      prefixArb,
      (loadBearingIds, omitted, shrunk, floored, hardFailed, isolatePrefix, expectedIsolatePrefix) => {
        const metadata = baseMetadata({ omitted, shrunk, floored, hardFailed, isolatePrefix });
        const r = evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix });

        const noneOmittedOrShrunk = loadBearingIds.every((id) => !omitted.includes(id) && !shrunk.includes(id));
        const prefixMatches = isolatePrefix === expectedIsolatePrefix;
        const expectedOk = noneOmittedOrShrunk && prefixMatches && hardFailed === false;

        assert.equal(r.ok, expectedOk);
      },
    ),
  );
});

test('propertyIdInOnlyFlooredNeverProducesAFinding', () => {
  fc.assert(
    fc.property(nonEmptyIdSetArb, (loadBearingIds) => {
      const flooredOnlyId = loadBearingIds[0];
      const metadata = baseMetadata({ omitted: [], shrunk: [], floored: [flooredOnlyId] });
      const r = evaluateTrimSafety({ metadata, loadBearingIds });

      assert.ok(
        !r.findings.some((f) => f.id === flooredOnlyId),
        `${flooredOnlyId} appears only in floored and must never produce a finding`,
      );
    }),
  );
});

test('propertyEvaluationIsIdempotentAndNeverMutatesInputs', () => {
  fc.assert(
    fc.property(
      nonEmptyIdSetArb,
      idSetArb,
      idSetArb,
      idSetArb,
      fc.boolean(),
      prefixArb,
      prefixArb,
      (loadBearingIds, omitted, shrunk, floored, hardFailed, isolatePrefix, expectedIsolatePrefix) => {
        const metadata = baseMetadata({ omitted, shrunk, floored, hardFailed, isolatePrefix });
        const metadataBefore = JSON.stringify(metadata);
        const idsBefore = JSON.stringify(loadBearingIds);

        const r1 = evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix });
        const r2 = evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix });

        assert.deepEqual(r1, r2);
        assert.equal(JSON.stringify(metadata), metadataBefore, 'metadata must not be mutated');
        assert.equal(JSON.stringify(loadBearingIds), idsBefore, 'loadBearingIds must not be mutated');
      },
    ),
  );
});

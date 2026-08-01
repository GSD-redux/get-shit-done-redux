'use strict';

/**
 * prompt-budget-parity.test.cjs
 *
 * Characterization-parity suite for issue #2929 (epic #1671 Phase 2 —
 * context-composer). `tests/fixtures/prompt-budget-parity/corpus.json` was
 * captured from the PRE-REFACTOR `prompt-budget.applyBudget` implementation
 * by `scripts/gen-prompt-budget-parity-corpus.cjs` (see that script's header
 * for the fixture-provenance rationale). It is the oracle for behavioral
 * parity after the composer-seam refactor: every case's `prompt` and
 * `metadata` must reproduce byte-for-byte / field-for-field.
 *
 * Regenerating this corpus to make a failure here go away DEFEATS ITS
 * PURPOSE — the corpus is frozen precisely so that a disagreement always
 * means the refactor moved observable behavior, never the other way around.
 * If a case fails, fix the refactor, not the fixture.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { applyBudget, estimateTokens } = require('../gsd-core/bin/lib/prompt-budget.cjs');
const corpus = require('./fixtures/prompt-budget-parity/corpus.json');

describe('prompt-budget parity vs pre-refactor corpus', () => {
  test('refactoredOutputIsByteIdenticalToCapturedCorpus', () => {
    for (const c of corpus.cases) {
      const result = applyBudget({
        sections: c.input.sections,
        budget: c.input.budget,
        options: c.input.options,
      });
      assert.equal(
        result.prompt,
        c.expected.prompt,
        `case "${c.name}": prompt mismatch (got ${result.prompt.length} chars, want ${c.expected.prompt.length} chars)`
      );
    }
  });

  test('refactoredMetadataMatchesCapturedCorpus', () => {
    for (const c of corpus.cases) {
      const result = applyBudget({
        sections: c.input.sections,
        budget: c.input.budget,
        options: c.input.options,
      });
      assert.deepStrictEqual(
        result.metadata,
        c.expected.metadata,
        `case "${c.name}": metadata mismatch`
      );
    }
  });

  test('parityCorpusCoversEveryParityCriticalRow', () => {
    const cases = corpus.cases;
    assert.ok(cases.length >= 45, `expected >= 45 corpus cases, got ${cases.length}`);

    const has = (pred, msg) => assert.ok(cases.some(pred), msg);

    has((c) => c.expected.metadata.hardFailed === true, 'expected >=1 case with hardFailed===true');
    has((c) => c.expected.metadata.hardFailed === false, 'expected >=1 case with hardFailed===false');
    has((c) => c.expected.metadata.noteInjected === true, 'expected >=1 case with noteInjected===true');
    has((c) => c.expected.metadata.noteInjected === false, 'expected >=1 case with noteInjected===false');
    has((c) => c.expected.metadata.omitted.length > 0, 'expected >=1 case with omitted.length > 0');
    has((c) => c.expected.metadata.projectMdShrunk === true, 'expected >=1 case with projectMdShrunk===true');
    has(
      (c) => c.expected.metadata.planTruncationPct > 0,
      'expected >=1 case with planTruncationPct > 0'
    );

    const a4 = cases.filter((c) => c.name.startsWith('A4-'));
    const a10 = cases.filter((c) => c.name.startsWith('A10-'));
    assert.ok(a4.length >= 8, `expected >= 8 A4- cases, got ${a4.length}`);
    assert.ok(a10.length >= 6, `expected >= 6 A10- cases, got ${a10.length}`);

    const noTrimOccurred = (c) =>
      c.expected.metadata.omitted.length === 0 &&
      c.expected.metadata.projectMdShrunk === false &&
      c.expected.metadata.planTruncationPct === 0;

    for (const c of a4) {
      assert.ok(noTrimOccurred(c), `A4 case "${c.name}" must have NO trim of any kind`);
    }
    for (const c of a10) {
      assert.ok(!noTrimOccurred(c), `A10 case "${c.name}" must have at least one trim`);
    }
  });

  test('estimateTokensRemainsExportedAndUnchanged', () => {
    // src/phase-estimation.cts re-exports this function as `measureTokens`,
    // and CONTEXT.md pins downstream estimate/actual comparisons to this
    // exact chars/4 scale — its math is frozen, not merely conventional.
    assert.equal(typeof estimateTokens, 'function');
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });
});

'use strict';

/**
 * Property-based tests for context-composer.cjs
 *
 * Module: gsd-core/bin/lib/context-composer.cjs
 * Exported: composeWithinBudget({ fragments, budget, measure, options })
 *
 * Key invariants (issue #2929 criterion 4):
 *   - moreBudgetNeverYieldsLessContent: raising the budget never shrinks the
 *     total surviving content.
 *   - neverDroppableFragmentsAlwaysSurvive: `verbatim` and `isolate`
 *     fragments retain their exact original content in every non-hard-fail
 *     result.
 *   - flooredFragmentNeverFallsBelowItsFloor: a `flexReserve`d fragment's
 *     final measured size never drops below min(flexReserve, original).
 *   - omittedIsAlwaysASubsequenceOfDeclaredDroppableOrder: `metadata.omitted`
 *     never reorders the declared `drop`-strategy ids.
 *   - isolatePrefixIsByteStable: `metadata.isolatePrefix` is identical
 *     regardless of budget or measure function.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { composeWithinBudget } = require('../gsd-core/bin/lib/context-composer.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Monotone measure functions: growing text never yields a smaller measure.
const measureChars4 = (text) => (text ? Math.ceil(text.length / 4) : 0);
const measureBytes = (text) => (text ? Buffer.byteLength(text, 'utf8') : 0);

const strategyArb = fc.oneof(
  fc.constant({ kind: 'verbatim' }),
  fc.record({ kind: fc.constant('head-shrink'), maxLines: fc.integer({ min: 0, max: 8 }) }),
  fc.record({
    kind: fc.constant('proportional-truncate'),
    floorChars: fc.integer({ min: 0, max: 40 }),
  }),
  fc.constant({ kind: 'drop' })
);

/** A realistic mixed fragment set: varying content, all four strategies, unique ids. */
function fragmentsArb({ minLength = 0, maxLength = 8 } = {}) {
  return fc
    .array(
      fc.record({
        content: fc.string({ maxLength: 300 }),
        strategy: strategyArb,
        required: fc.boolean(),
        flexReserve: fc.integer({ min: 0, max: 30 }),
      }),
      { minLength, maxLength }
    )
    .map((items) =>
      items.map((item, idx) => ({
        id: `f${idx}`,
        content: item.content,
        strategy: item.strategy,
        required: item.required,
        flexReserve: item.flexReserve,
      }))
    );
}

/** Marks a random leading prefix of `fragments` as isolate (order-legal). */
function withIsolatePrefix(fragments, isolateCount) {
  const n = Math.min(isolateCount, fragments.length);
  return fragments.map((f, idx) => (idx < n ? { ...f, isolate: true } : f));
}

const totalContentLength = (result) => result.fragments.reduce((sum, f) => sum + f.content.length, 0);

// ─── Properties ──────────────────────────────────────────────────────────────

describe('context-composer: composeWithinBudget properties', () => {
  test('property: moreBudgetNeverYieldsLessContent', () => {
    fc.assert(
      fc.property(
        fragmentsArb(),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        (fragments, budgetA, budgetB) => {
          const lo = Math.min(budgetA, budgetB);
          const hi = Math.max(budgetA, budgetB);
          const resultLo = composeWithinBudget({ fragments, budget: lo, measure: measureChars4 });
          const resultHi = composeWithinBudget({ fragments, budget: hi, measure: measureChars4 });
          if (resultLo.metadata.hardFailed || resultHi.metadata.hardFailed) return;

          const contentLo = totalContentLength(resultLo);
          const contentHi = totalContentLength(resultHi);
          assert.ok(
            contentHi >= contentLo,
            `budget ${hi} yielded less content (${contentHi}) than budget ${lo} (${contentLo})`
          );
        }
      )
    );
  });

  test('property: neverDroppableFragmentsAlwaysSurvive (verbatim + isolate)', () => {
    fc.assert(
      fc.property(
        fragmentsArb({ minLength: 1 }),
        fc.nat({ max: 8 }),
        fc.integer({ min: 0, max: 50 }),
        (fragments, isolateCount, budget) => {
          const withIsolates = withIsolatePrefix(fragments, isolateCount);
          const result = composeWithinBudget({ fragments: withIsolates, budget, measure: measureChars4 });
          if (result.metadata.hardFailed) return;

          for (const f of withIsolates) {
            const isNeverDroppable = f.isolate === true || f.strategy.kind === 'verbatim';
            if (!isNeverDroppable) continue;
            const composed = result.fragments.find((c) => c.id === f.id);
            assert.ok(composed, `fragment ${f.id} missing from result`);
            assert.equal(
              composed.content,
              f.content,
              `never-droppable fragment ${f.id} (isolate=${f.isolate === true}, strategy=${f.strategy.kind}) was altered`
            );
          }
        }
      )
    );
  });

  test('property: flooredFragmentNeverFallsBelowItsFloor', () => {
    fc.assert(
      fc.property(fragmentsArb({ minLength: 1 }), fc.integer({ min: 0, max: 2000 }), (fragments, budget) => {
        const result = composeWithinBudget({ fragments, budget, measure: measureChars4 });
        if (result.metadata.hardFailed) return;

        for (const f of fragments) {
          if (!f.flexReserve || f.flexReserve <= 0) continue;
          const composed = result.fragments.find((c) => c.id === f.id);
          assert.ok(composed, `fragment ${f.id} missing from result`);
          const originalMeasured = measureChars4(f.content);
          const finalMeasured = measureChars4(composed.content);
          const expectedFloor = Math.min(f.flexReserve, originalMeasured);
          assert.ok(
            finalMeasured >= expectedFloor,
            `fragment ${f.id}: final measured size ${finalMeasured} < floor ${expectedFloor} ` +
              `(flexReserve=${f.flexReserve}, originalMeasured=${originalMeasured})`
          );
        }
      })
    );
  });

  test('property: omittedIsAlwaysASubsequenceOfDeclaredDroppableOrder', () => {
    fc.assert(
      fc.property(fragmentsArb(), fc.integer({ min: 0, max: 2000 }), (fragments, budget) => {
        const result = composeWithinBudget({ fragments, budget, measure: measureChars4 });
        if (result.metadata.hardFailed) return;

        const declaredDroppableOrder = fragments
          .filter((f) => f.strategy.kind === 'drop')
          .map((f) => f.id);

        // A subsequence: walk declaredDroppableOrder once, consuming
        // omitted ids in order — every omitted id must be found, in order,
        // without skipping backward.
        let cursor = 0;
        for (const omittedId of result.metadata.omitted) {
          const foundAt = declaredDroppableOrder.indexOf(omittedId, cursor);
          assert.ok(
            foundAt !== -1,
            `omitted id "${omittedId}" is not a subsequence of declared droppable order ` +
              `[${declaredDroppableOrder.join(', ')}] (omitted: [${result.metadata.omitted.join(', ')}])`
          );
          cursor = foundAt + 1;
        }
      })
    );
  });

  test('property: isolatePrefixIsByteStable', () => {
    fc.assert(
      fc.property(
        fragmentsArb({ minLength: 1 }),
        fc.nat({ max: 8 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 500, max: 5000 }),
        (fragments, isolateCount, tinyBudget, hugeBudget) => {
          const withIsolates = withIsolatePrefix(fragments, isolateCount);
          if (!withIsolates.some((f) => f.isolate)) return;

          const resultTinyChars = composeWithinBudget({
            fragments: withIsolates,
            budget: tinyBudget,
            measure: measureChars4,
          });
          const resultHugeChars = composeWithinBudget({
            fragments: withIsolates,
            budget: hugeBudget,
            measure: measureChars4,
          });
          const resultTinyBytes = composeWithinBudget({
            fragments: withIsolates,
            budget: tinyBudget,
            measure: measureBytes,
          });
          const resultHugeBytes = composeWithinBudget({
            fragments: withIsolates,
            budget: hugeBudget,
            measure: measureBytes,
          });

          const prefixes = [
            resultTinyChars.metadata.isolatePrefix,
            resultHugeChars.metadata.isolatePrefix,
            resultTinyBytes.metadata.isolatePrefix,
            resultHugeBytes.metadata.isolatePrefix,
          ];
          for (const prefix of prefixes) {
            assert.equal(
              prefix,
              prefixes[0],
              `isolatePrefix diverged across budget/measure combinations: ${JSON.stringify(prefixes)}`
            );
          }
        }
      )
    );
  });
});

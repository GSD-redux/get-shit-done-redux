'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2939 — `shouldFlattenDispatch` ignores the declared
 * depth budget, so a runtime advertising `maxDepth:1` (no room for a background
 * orchestrator plus a delegated leaf) is still told it may background.
 *
 * Root cause: `shouldFlattenDispatch` (src/host-integration.cts) checked ONLY
 * `dispatch.background` and `dispatch.backgroundDispatch`, never `nested`,
 * `subagentToolkit`, or `maxDepth`. With the live Codex descriptor
 * (background:true, backgroundDispatch:true, nested:true, subagentToolkit:"full",
 * maxDepth:1) it returned `shouldFlatten:false`, which then permitted a depth-2
 * orchestration tree the declared contract cannot support.
 *
 * The fix reconciles `shouldFlattenDispatch` with the depth-budget convention
 * already used in the same file (`degradationFor`: nested && depth>=2 is
 * full-depth; maxDepth===1 is flat) and in `bin/install.js`
 * (`_normalizeDispatchCallSpan`: subagentToolkit==='full' && (maxDepth===-1 ||
 * maxDepth>1)). A host may background only if it can background AND has a depth
 * budget sufficient for a backgrounded orchestrator plus a delegated leaf.
 *
 * Matrix: .gsd/bug/fix/2939-dispatch-flatten-maxdepth/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldFlattenDispatch } = require('../gsd-core/bin/lib/host-integration.cjs');

/** The live Codex-shaped descriptor (the bug input), with per-test depth overrides. */
function codexLike(overrides = {}) {
  return {
    namedDispatch: true,
    nested: true,
    maxDepth: 1,
    background: true,
    subagentToolkit: 'full',
    backgroundDispatch: true,
    ...overrides,
  };
}

describe('shouldFlattenDispatch depth budget (#2939)', () => {
  test('codexLikeMaxDepth1Flattens', () => {
    // Row 1 (failing-first regression): maxDepth:1 cannot host a bg orchestrator
    // (depth 1) AND a delegated leaf (depth 2) → must flatten (inline).
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: 1 })),
      true,
      'maxDepth:1 is insufficient for a backgrounded orchestrator plus a leaf → flatten',
    );
  });

  test('maxDepth2BackgroundsUnchanged', () => {
    // Row 2: maxDepth:2 leaves room → background permitted, unchanged from today.
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: 2 })),
      false,
      'maxDepth:2 is sufficient → background permitted (unchanged)',
    );
  });

  test('maxDepthUnboundedBackgroundsUnchanged', () => {
    // Row 3: maxDepth:-1 (unbounded) → background permitted, unchanged.
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: -1 })),
      false,
      'maxDepth:-1 (unbounded) → background permitted (unchanged)',
    );
  });

  test('nestedFalseFlattensRegardlessOfDepth', () => {
    // Row 4 / acceptance #4: nested:false cannot host a nesting orchestrator →
    // flatten regardless of maxDepth.
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ nested: false, maxDepth: 5 })),
      true,
      'nested:false → flatten regardless of maxDepth',
    );
  });

  test('nonFullToolkitFlattens', () => {
    // Row 5 / acceptance #4: a non-full toolkit cannot delegate → flatten
    // regardless of maxDepth.
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ subagentToolkit: 'read-only', maxDepth: 5 })),
      true,
      'subagentToolkit!=="full" → flatten regardless of maxDepth',
    );
  });

  test('backgroundFalseStillFlattens', () => {
    // Row 6 / negative-space: background:false → flatten (the existing
    // background-boolean fail-closed path is unchanged).
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ background: false, maxDepth: 5 })),
      true,
      'background:false → flatten (unchanged)',
    );
  });

  test('backgroundDispatchFalseStillFlattens', () => {
    // Row 7 / negative-space: backgroundDispatch:false → flatten (unchanged).
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ backgroundDispatch: false, maxDepth: 5 })),
      true,
      'backgroundDispatch:false → flatten (unchanged)',
    );
  });

  test('maxDepth0Flattens', () => {
    // Row 9: maxDepth:0 (zero depth budget) → flatten.
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: 0 })),
      true,
      'maxDepth:0 → flatten (zero depth budget)',
    );
  });

  test('maxDepthMissingFlattens', () => {
    // Row 10: maxDepth missing/non-number → flatten (fail-closed on absent
    // budget, mirrors degradationFor treating non-finite as 0).
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: undefined })),
      true,
      'maxDepth missing → flatten (fail-closed)',
    );
    assert.strictEqual(
      shouldFlattenDispatch(codexLike({ maxDepth: 'deep' })),
      true,
      'maxDepth non-number → flatten (fail-closed)',
    );
  });
});

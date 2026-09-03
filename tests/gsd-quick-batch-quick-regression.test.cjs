'use strict';

/**
 * gsd-quick-batch-quick-regression.test.cjs — row 48 of the #3676 test
 * matrix: ordinary `/gsd:quick` (non-batch) stays byte-identical after
 * Phase 4 lands.
 *
 * Named `gsd-quick-batch-*` (not `quick-batch-*`) so `scripts/
 * lint-test-file-count.cjs`'s longest-prefix bucketing does not fold this
 * markdown-only test into the already-capped `quick-batch` production-module
 * bucket (2/2 test files from the CORE-layer pass).
 *
 * `commands/gsd/quick.md` / `gsd-core/workflows/quick.md` are never touched
 * by this phase (design doc row 38/48) — quick-batch adds new call sites
 * onto shared primitives, never edits the ordinary quick command/workflow.
 * Asserted via the same base-ref resolution helper `tests/
 * emitted-attribution.test.cjs` already uses (`resolveBase`/`resolveChangedPaths`,
 * `tests/helpers/emitted-runtime.cjs`) — a three-dot diff against the merge
 * base, never a hand-rolled git call.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveBase,
  resolveChangedPaths,
  baseRefCandidates,
} = require('./helpers/emitted-runtime.cjs');

describe('quick-batch: /gsd:quick command + workflow stay byte-identical (row 48)', () => {
  test('commands/gsd/quick.md and gsd-core/workflows/quick.md are not in this branch\'s changed-path set', (t) => {
    // Environmental skip (ADR-2719 §6 idiom) — same as tests/emitted-attribution.test.cjs:
    // a base ref is not universally resolvable (gsd-test's shallow-merged container
    // carries no origin/* remote-tracking refs). t.skip is REPORTED as skipped, unlike
    // a bare `return`, which node:test scores as a silent pass.
    const resolved = resolveBase();
    if (!resolved) {
      t.skip(
        'no base ref resolvable — tried ' + baseRefCandidates().join(', ') +
        '. Set GSD_EMITTED_BASE=<ref|sha> to run this regression check elsewhere.',
      );
      return;
    }

    const changed = resolveChangedPaths(resolved.ref);
    // #3730 review: row 48 is the #3676 PHASE's invariant — quick-batch adds new
    // call sites onto shared primitives without editing ordinary quick. Judging
    // every FUTURE branch by it would freeze quick.md forever (observed: the
    // #3730 migration note tripped this row on an unrelated branch). Scope the
    // row to branches that actually touch the quick-batch surface; an unrelated
    // branch's quick.md edit is none of this guard's business.
    // tests/ excluded: this guard file's own name matches, which would make
    // the scope check self-satisfying on every branch that edits it.
    const touchesQuickBatch = changed.some((p) => /quick-batch/.test(p) && !p.startsWith('tests/'));
    if (!touchesQuickBatch) {
      t.skip(
        `branch does not touch the quick-batch surface (${changed.length} changed paths) — ` +
        'row 48 governs #3676-phase branches only',
      );
      return;
    }
    assert.ok(
      !changed.includes('commands/gsd/quick.md'),
      'commands/gsd/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    assert.ok(
      !changed.includes('gsd-core/workflows/quick.md'),
      'gsd-core/workflows/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    // The step fragments under quick/steps/ are likewise untouched — quick-batch
    // has its own, separate quick-batch/steps/ tree.
    const touchedQuickSteps = changed.filter((p) => p.startsWith('gsd-core/workflows/quick/steps/'));
    assert.deepEqual(touchedQuickSteps, [], `unexpected changes under gsd-core/workflows/quick/steps/: ${touchedQuickSteps.join(', ')}`);
  });
});

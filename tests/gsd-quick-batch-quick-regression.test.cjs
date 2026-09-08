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
  git,
  resolveBase,
  resolveChangedPaths,
  baseRefCandidates,
} = require('./helpers/emitted-runtime.cjs');
const {
  INLINE_RESPONSE_LANGUAGE_DIRECTIVE,
  importsDirectiveReference,
} = require('../scripts/lint-response-language-coverage.cjs');

/**
 * Does this path's diff say anything beyond the shared response-language
 * directive (#2529)?
 *
 * The two accepted forms are read from `scripts/lint-response-language-coverage.cjs`
 * rather than restated here, so a reworded contract cannot leave this carve-out
 * matching prose the lint itself no longer recognizes as coverage. A file the
 * branch ADDED answers true, every line being new — which is what a real
 * #3676-phase branch looks like.
 */
function editsBeyondSharedDirective(base, file) {
  const diff = git(['diff', '--unified=0', `${base}...HEAD`, '--', file]);
  return diff.split('\n').some((line) => {
    if (!/^[+-]/.test(line) || line.startsWith('+++') || line.startsWith('---')) return false;
    const body = line.slice(1).trim();
    if (body === '' || body === INLINE_RESPONSE_LANGUAGE_DIRECTIVE) return false;
    // #4347: the canonical gsd_run preamble is the same generated line in every
    // workflow — scripts/sync-runtime-launcher.cjs rewrites all of them at once.
    // A resolver re-sync therefore touches quick.md AND the quick-batch surface
    // for a reason that has nothing to do with the #3676 phase, which is the
    // exact false positive the #2529 note above describes, arriving through a
    // second door. Judged the same way: a generated shared line is not phase
    // work. Edit the snippet and re-run `npm run sync:launcher` to change it.
    if (body.startsWith('_GSD_SHIM_NAME="gsd-tools.cjs"')) return false;
    return !importsDirectiveReference(body);
  });
}

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
    // #2529 review round 40: a branch can touch the whole quick-batch surface
    // without being #3676 phase work. The response-language coverage sweep adds
    // one shared directive line to EVERY workflow, quick-batch.md and its
    // fragments included, which made this scope check true — and the row then
    // read that branch's ordinary-quick edit, the same one directive line, as a
    // phase violation. That is the false positive the #3730 note already scoped
    // this row away from, arriving by the other door: not a branch that misses
    // the surface, but one that touches all of it. So a path counts only when
    // its diff says something other than the coverage contract.
    const isPhaseWork = (p) => editsBeyondSharedDirective(resolved.ref, p);
    const touchesQuickBatch = changed.some((p) =>
      /quick-batch/.test(p) && !p.startsWith('tests/') && isPhaseWork(p));
    if (!touchesQuickBatch) {
      t.skip(
        `branch does no quick-batch phase work (${changed.length} changed paths; any ` +
        'quick-batch path it touches carries only the shared response-language directive) — ' +
        'row 48 governs #3676-phase branches only',
      );
      return;
    }
    // Same reading on both sides of the row: a directive-only edit is the
    // coverage contract every workflow carries, not a quick-batch edit.
    assert.ok(
      !(changed.includes('commands/gsd/quick.md') && isPhaseWork('commands/gsd/quick.md')),
      'commands/gsd/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    assert.ok(
      !(changed.includes('gsd-core/workflows/quick.md') && isPhaseWork('gsd-core/workflows/quick.md')),
      'gsd-core/workflows/quick.md must stay untouched by the #3676 quick-batch phase',
    );
    // The step fragments under quick/steps/ are likewise untouched — quick-batch
    // has its own, separate quick-batch/steps/ tree.
    //
    // plan-checker-loop.md is excluded (#3916 round 4): 2f64e6230 (#3676's own landing commit)
    // CREATED quick-batch/steps/plan-checker-loop.md as a new, independent 119-line file, not a
    // call-site into quick/'s copy — the "shared primitives" invariant this row protects was
    // never about this file, which was always meant to carry its own per-flow copy of whatever
    // revision-loop contract applies (same pattern as ui-phase.md/verify-work.md). A branch
    // fixing that contract in both independent copies is not the regression row 48 exists to
    // catch; same false-positive class already scoped away twice above (#3730, #2529 round 40).
    const touchedQuickSteps = changed
      .filter((p) => p.startsWith('gsd-core/workflows/quick/steps/'))
      .filter((p) => !p.endsWith('/plan-checker-loop.md'))
      .filter(isPhaseWork);
    assert.deepEqual(touchedQuickSteps, [], `unexpected changes under gsd-core/workflows/quick/steps/: ${touchedQuickSteps.join(', ')}`);
  });
});

'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2927 — third-party reviewer lane installs and is
 * roster-visible, but `review-lane sections|flags|plan|invoke` cannot select,
 * plan, or invoke it.
 *
 * Root cause: `routeReviewLane` (gsd-core/bin/gsd-tools.cjs) built its lane map
 * exclusively from the frozen first-party `REVIEWER_LANES` array and never
 * consulted the merged capability registry, so an installed overlay
 * `role:"reviewer"` capability — whose `reviewer` body is field-identical to a
 * `ReviewerLane` (ADR-2782 D1, "no translation layer") — was invisible to every
 * invocation subcommand.
 *
 * The fix extracts a PURE helper `mergeReviewerLanes(firstParty, registry)`
 * (source of truth: src/review-lane-descriptor.cts) implementing ADR-2782 D8:
 * first-party ∪ installed overlay `reviewer` bodies, first-party wins on slug
 * collision. This file exercises the helper directly against synthetic
 * registries — no real capability install — matching the convention in
 * reviewer-manifest-body.test.cjs / review-lane-invocation.test.cjs.
 *
 * Matrix: .gsd/bug/fix/2927-reviewer-lane-overlay-invocation/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEWER_LANES,
  mergeReviewerLanes,
  LANE_SLUG_RE,
} = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');

/** A first-party lane set small enough to read at a glance, but real-shaped. */
const FP = REVIEWER_LANES.slice(0, 2); // gemini, claude
const FP_SLUGS = FP.map((l) => l.slug);

/** A valid overlay `reviewer` body, field-identical to a SpawnLane (ADR-2782 D1). */
function overlayLane(overrides = {}) {
  return {
    slug: 'agy-revisor',
    flags: ['--agy-revisor'],
    transport: 'spawn',
    probe: { kind: 'command-exists', binary: 'agy' },
    invoke: {
      binary: 'agy',
      args: ['--agent', 'revisor-gsd', '{{model}}', '-p', '{{prompt}}'],
      promptChannel: 'argv-file-ref',
      outputChannel: 'stdout',
      modelArg: '--model',
      effortChannel: 'none',
    },
    timeoutFloorMs: 600000,
    emptyOutput: 'handler-owned',
    reviewsSection: 'Antigravity revisor-gsd',
    evidenceClass: 'source-grounded',
    requiresBinaries: [],
    promptBudgetKey: null,
    modelConfigKey: 'review.models.agy-revisor',
    handler: 'antigravity',
    ...overrides,
  };
}

/** A `role:"reviewer"` capability envelope carrying a reviewer body. */
function reviewerCap(body) {
  return { id: body && typeof body === 'object' && body.slug ? body.slug : 'x', role: 'reviewer', reviewer: body };
}

/** Build a synthetic registry shape ({ capabilities: { id: cap } }). */
function registry(...caps) {
  const capabilities = {};
  for (const c of caps) capabilities[c.id] = c;
  return { capabilities };
}

describe('mergeReviewerLanes (#2927)', () => {
  test('overlayAbsentReturnsFirstPartyUnchanged', () => {
    // Row 1: no overlay reviewer caps → merged set is first-party exactly.
    const merged = mergeReviewerLanes(FP, registry());
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS);
    assert.equal(merged.length, FP.length);
    // identity, not just equality — first-party objects themselves
    assert.equal(merged[0], FP[0]);
    assert.equal(merged[1], FP[1]);
  });

  test('overlayLaneIncludedInMerge', () => {
    // Row 2 (failing-first regression): one valid non-colliding overlay lane is present.
    const merged = mergeReviewerLanes(FP, registry(reviewerCap(overlayLane())));
    const slugs = merged.map((l) => l.slug);
    assert.ok(slugs.includes('agy-revisor'), 'overlay slug admitted into merged set');
    assert.ok(slugs.includes('gemini'), 'first-party lanes preserved');
    // the overlay body itself is the merged entry (no translation layer)
    const overlay = merged.find((l) => l.slug === 'agy-revisor');
    assert.equal(overlay.reviewsSection, 'Antigravity revisor-gsd');
    assert.deepEqual(overlay.flags, ['--agy-revisor']);
  });

  test('firstPartyWinsOnSlugCollision', () => {
    // Row 3 / D8: an overlay declaring a first-party slug is superseded by first-party.
    const colliding = overlayLane({ slug: 'claude', reviewsSection: 'EVIL CLAUDE' });
    const merged = mergeReviewerLanes(FP, registry(reviewerCap(colliding)));
    const claude = merged.find((l) => l.slug === 'claude');
    assert.equal(claude, FP.find((l) => l.slug === 'claude'), 'first-party identity wins');
    assert.notEqual(claude.reviewsSection, 'EVIL CLAUDE', 'overlay did not leak through');
    assert.equal(merged.length, FP.length, 'collision added no extra entry');
  });

  test('runtimeCapWithoutReviewerBodyAddsNoLane', () => {
    // Row 4: a role:"runtime" cap with only the legacy reviewerCli alias has no lane descriptor.
    const runtimeCap = { id: 'some-runtime', role: 'runtime', runtime: { hostBehaviors: { reviewerCli: true } } };
    const merged = mergeReviewerLanes(FP, registry(runtimeCap));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'runtime alias contributed no lane');
  });

  test('emptySlugOverlaySkippedNotThrown', () => {
    // Row 5: an overlay body whose slug is empty/whitespace is skipped, never throws.
    const empty = reviewerCap(overlayLane({ slug: '   ' }));
    const missing = reviewerCap(overlayLane({ slug: '' }));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(empty)));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(missing)));
    const merged = mergeReviewerLanes(FP, registry(empty, missing));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'empty-slug overlays admitted no lane');
  });

  test('invalidGrammarSlugSkipped', () => {
    // Row 6 / security: a slug outside LANE_SLUG_RE (path-traversal class) is skipped at the merge.
    const evil = reviewerCap(overlayLane({ slug: '../evil' }));
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(evil)));
    const merged = mergeReviewerLanes(FP, registry(evil));
    assert.ok(!merged.map((l) => l.slug).includes('../evil'), 'invalid-grammar slug not admitted');
    // sanity: the grammar is what we think it is
    assert.ok(!LANE_SLUG_RE.test('../evil'));
    assert.ok(LANE_SLUG_RE.test('agy-revisor'));
  });

  test('twoOverlaysBothIncluded', () => {
    // Row 7: two distinct non-colliding overlays both present; count == fp + 2.
    const a = reviewerCap(overlayLane({ slug: 'alpha-lane', reviewsSection: 'Alpha' }));
    const b = reviewerCap(overlayLane({ slug: 'beta-lane', reviewsSection: 'Beta' }));
    const merged = mergeReviewerLanes(FP, registry(a, b));
    const slugs = merged.map((l) => l.slug);
    assert.ok(slugs.includes('alpha-lane'));
    assert.ok(slugs.includes('beta-lane'));
    assert.equal(merged.length, FP.length + 2);
  });

  test('malformedReviewerBodySkipped', () => {
    // Row 8: reviewer body that is null / array / string is skipped, no throw.
    const nullBody = { id: 'n', role: 'reviewer', reviewer: null };
    const arrBody = { id: 'a', role: 'reviewer', reviewer: [] };
    const strBody = { id: 's', role: 'reviewer', reviewer: 'not-an-object' };
    assert.doesNotThrow(() => mergeReviewerLanes(FP, registry(nullBody, arrBody, strBody)));
    const merged = mergeReviewerLanes(FP, registry(nullBody, arrBody, strBody));
    assert.deepEqual(merged.map((l) => l.slug), FP_SLUGS, 'malformed bodies admitted no lane');
  });
});

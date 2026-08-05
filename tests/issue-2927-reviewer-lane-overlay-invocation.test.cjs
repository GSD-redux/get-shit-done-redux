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

// ---------------------------------------------------------------------------
// Rows 9–10: the WIRING defect this PR exists to close. The eight rows above
// guard the pure helper, but the actual bug was that `routeReviewLane` never
// CALLED any merge — so a revert of the one-line wiring change would leave every
// helper test green. These rows exercise the real CLI end-to-end: install a
// global-scope `role:"reviewer"` overlay (global scope is trusted without a
// consent record, CONTEXT.md capability-loader predicate), then assert
// `review-lane sections|flags|plan` actually see it through loadRegistry →
// mergeReviewerLanes → the lane map. This is acceptance criteria #1–#3.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { runGsdTools, cleanup } = require('./helpers.cjs');

const cliTmps = [];
function cliTmpDir(prefix) {
  const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
  cliTmps.push(d);
  return d;
}
test.after(() => { for (const d of cliTmps) cleanup(d); });

/** A GSD_HOME-sandboxed env that neutralizes ambient GSD_ vars (hermeticity). */
function scopeEnv(home) {
  return { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
}

/** A cwd with a .planning/ root so findProjectRoot resolves cleanly. */
function makeCwd() {
  const cwd = cliTmpDir('rev2927-cwd-');
  fs.mkdirSync(nodePath.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(nodePath.join(cwd, '.planning', 'config.json'), '{}');
  return cwd;
}

/**
 * Write a conformant `role:"reviewer"` capability source dir whose `reviewer`
 * body is a valid SpawnLane (ADR-2782 D1 shape). Returns the source path,
 * usable as a `capability install <spec>` argument.
 */
function writeReviewerCapSource(id, bodyOverrides = {}) {
  const src = cliTmpDir(`rev2927-src-${id}-`);
  // A `role:"reviewer"` manifest carries ONLY id/role/version/title/description/
  // tier/requires/engines/reviewer (+ optional config) — skills/agents/steps/
  // contributions/gates/hooks/runtimeCompat are feature-only fields the validator
  // rejects for a reviewer (mirrors the shipped `capabilities/lm-studio` shape).
  const cap = {
    id,
    role: 'reviewer',
    version: '1.0.0',
    title: `${id} test lane`,
    description: 'test third-party reviewer lane for #2927',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.9.0' },
    reviewer: {
      slug: id,
      flags: [`--${id}`],
      transport: 'spawn',
      probe: { kind: 'command-exists', binary: id },
      invoke: {
        binary: id,
        args: ['{{model}}', '-p', '{{prompt}}'],
        promptChannel: 'stdin',
        outputChannel: 'stdout',
        modelArg: '--model',
        effortChannel: 'none',
      },
      timeoutFloorMs: 600000,
      emptyOutput: 'stub-with-stderr',
      reviewsSection: `${id} review`,
      evidenceClass: 'source-grounded',
      requiresBinaries: [],
      promptBudgetKey: null,
      modelConfigKey: `review.models.${id}`,
      handler: null,
      ...bodyOverrides,
    },
  };
  fs.writeFileSync(nodePath.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
  return src;
}

describe('review-lane CLI overlay invocation (#2927, rows 9–10)', () => {
  test('cliSectionsAndPlanSeeOverlayLane', () => {
    // Acceptance #1 + #3: an installed overlay lane appears in `sections` and
    // `plan --selected <slug>` returns ok:true with a usable plan.
    const home = cliTmpDir('rev2927-home-');
    const cwd = makeCwd();
    const src = writeReviewerCapSource('rev2927lane');
    // Global scope is trusted without a consent record; --yes acknowledges the
    // executable reviewer surface; --raw emits JSON.
    const install = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--raw'],
      cwd,
      scopeEnv(home),
    );
    assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
    const installOut = JSON.parse(install.output);
    assert.equal(installOut.status, 'installed', `install did not report installed: ${install.output}`);

    // Row 9 / acceptance #1: sections includes the overlay slug + reviewsSection.
    const sections = runGsdTools(['review-lane', 'sections'], cwd, scopeEnv(home));
    assert.equal(sections.success, true, `sections failed: ${sections.error || sections.output}`);
    const sectionRows = sections.output.split('\n').filter(Boolean);
    const overlayRow = sectionRows.find((r) => r.startsWith('rev2927lane\t'));
    assert.ok(overlayRow, `overlay lane missing from sections output:\n${sections.output}`);
    assert.equal(overlayRow, 'rev2927lane\trev2927lane review');

    // Row 9 / acceptance #3: plan --selected <overlay-slug> resolves ok (NOT
    // malformed_lane / no such declared lane — the pre-fix failure). The `plan`
    // subcommand renders an ARRAY of {slug, ok, section, transport, ...} (it strips
    // the nested invocation `plan` object before output), so find the overlay entry.
    const plan = runGsdTools(
      ['review-lane', 'plan', '--selected', 'rev2927lane', '--run-dir', cwd, '--repo-root', cwd],
      cwd,
      scopeEnv(home),
    );
    assert.equal(plan.success, true, `plan failed: ${plan.error || plan.output}`);
    const planOut = JSON.parse(plan.output);
    assert.ok(Array.isArray(planOut), `plan output is not an array:\n${plan.output}`);
    const overlayPlan = planOut.find((p) => p.slug === 'rev2927lane');
    assert.ok(overlayPlan, `overlay plan entry missing:\n${plan.output}`);
    assert.equal(overlayPlan.ok, true, `overlay plan did not resolve ok:\n${plan.output}`);
    assert.equal(overlayPlan.section, 'rev2927lane review');
    assert.equal(overlayPlan.transport, 'spawn');
  });

  test('cliFlagsIncludeOverlayFlag', () => {
    // Acceptance #2: the overlay's declared --flag appears in `flags` output.
    //
    // NOTE on the negative-space "malformed flag filtered" case: the capability
    // validator enforces the /^--[a-z0-9][a-z0-9-]*$/ flag grammar AT INSTALL TIME
    // (capability-validator rejects a reviewer.flags entry that fails it), so a lane
    // carrying a malformed flag (e.g. `--bad flag`, `*.js`) can never be installed
    // and therefore never reaches the `flags` shape filter. That filter is
    // defense-in-depth over an input class the validator already excludes; it is
    // not independently reachable through a validated install, so it is not asserted
    // here. A lane declaring two well-formed flags (mirroring antigravity's
    // --antigravity/--agy) proves the per-lane flag array is preserved, not flattened.
    const home = cliTmpDir('rev2927-home-');
    const cwd = makeCwd();
    const src = writeReviewerCapSource('rev2927flag', {
      flags: ['--rev2927flag', '--rev2927alt'],
    });
    const install = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--raw'],
      cwd,
      scopeEnv(home),
    );
    assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
    assert.equal(JSON.parse(install.output).status, 'installed', `install did not report installed: ${install.output}`);

    const flags = runGsdTools(['review-lane', 'flags'], cwd, scopeEnv(home));
    assert.equal(flags.success, true, `flags failed: ${flags.error || flags.output}`);
    const flagLines = flags.output.split('\n').filter(Boolean);
    assert.ok(flagLines.includes('--rev2927flag'), `overlay flag missing from flags output:\n${flags.output}`);
    assert.ok(flagLines.includes('--rev2927alt'), 'second well-formed overlay flag missing (flag array flattened?)');
  });
});

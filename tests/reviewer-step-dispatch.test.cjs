'use strict';

/**
 * Reviewer Step Dispatch — the interpreter for "a step declares
 * `supportsReviewerLanes: true`" (#4209 Phase 1 Plan 2, ADR-2782 seam).
 *
 * Every case here drives the public function through injected `plan`/`invoke` spies — never a
 * real spawn, never a real reviewer CLI. `resolveSelection`/`getLane` default to the real,
 * pure `resolveReviewerSelection`/`REVIEWER_LANES` lookup unless a test overrides them, so
 * selection-layer behavior (dedup, availability) is exercised for real while transport stays
 * fully stubbed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchReviewerLanes,
  buildSourceReviewPrompt,
  SOURCE_REVIEW_PROHIBITIONS,
  DISPATCH_REASON,
} = require('../gsd-core/bin/lib/reviewer-step-dispatch.cjs');

const REPO_ROOT = '/repo';
const RUN_DIR = '/run';

/** Minimal fake lane — only the fields this module or a test assertion reads. */
function fakeLane(slug, overrides = {}) {
  return { slug, reviewsSection: slug, promptBudgetKey: null, flags: [`--${slug}`], ...overrides };
}

/** Spy factory: records calls, returns queued results in call order (or a fixed result). */
function spy(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

function okPlan(slug) {
  return {
    ok: true,
    warnings: [],
    plan: {
      transport: 'spawn',
      slug,
      binary: slug,
      argv: [],
      model: null,
      effort: null,
      stdin: `${RUN_DIR}/gsd-review-prompt.md`,
      promptPath: `${RUN_DIR}/gsd-review-prompt.md`,
      outputTarget: { kind: 'stdout' },
      reviewPath: `${RUN_DIR}/gsd-review-${slug}.md`,
      errPath: `${RUN_DIR}/gsd-review-${slug}.err`,
      timeoutMs: 60000,
      emptyOutput: 'stub',
      evidenceClass: 'source-grounded',
      handler: 'default',
      requiresBinaries: [slug],
      probe: { kind: 'binary' },
      env: null,
    },
  };
}

/** No-op prompt writer for tests that don't assert on the write itself. */
const noopWrite = () => {};

function baseInput(overrides = {}) {
  return {
    trait: true,
    selection: { explicitFlags: ['gemini'], detected: ['gemini'] },
    repoRoot: REPO_ROOT,
    paths: ['src/foo.ts'],
    depth: 'standard',
    baseSha: 'abc1234',
    runDir: RUN_DIR,
    ...overrides,
  };
}

// ─── inert cases: zero calls ────────────────────────────────────────────────

describe('dispatchReviewerLanes — inert (trait off / nothing selected)', () => {
  test('trait !== true (absent, false, string, number, object) dispatches nothing', async () => {
    for (const trait of [undefined, false, 'true', 1, null, {}]) {
      const resolveSelection = spy(() => { throw new Error('must not be called'); });
      const plan = spy(() => { throw new Error('must not be called'); });
      const invoke = spy(() => { throw new Error('must not be called'); });

      const result = await dispatchReviewerLanes(
        baseInput({ trait }),
        { resolveSelection, plan, invoke },
      );

      assert.equal(resolveSelection.calls.length, 0, `trait=${JSON.stringify(trait)} must not call resolveSelection`);
      assert.equal(plan.calls.length, 0);
      assert.equal(invoke.calls.length, 0);
      assert.deepEqual(result, {
        dispatched: false,
        ok: true,
        reason: DISPATCH_REASON.TRAIT_NOT_ENABLED,
        results: [],
      });
    }
  });

  test('trait === true but selection resolves to zero lanes dispatches nothing', async () => {
    const plan = spy(() => { throw new Error('must not be called'); });
    const invoke = spy(() => { throw new Error('must not be called'); });

    const result = await dispatchReviewerLanes(
      baseInput({ selection: {} }), // no explicit/detected/default/instances at all
      { plan, invoke },
    );

    assert.equal(plan.calls.length, 0);
    assert.equal(invoke.calls.length, 0);
    assert.equal(result.dispatched, false);
    assert.equal(result.ok, true);
    assert.equal(result.reason, DISPATCH_REASON.NO_LANES_SELECTED);
  });
});

// ─── happy path: exactly-once dispatch ──────────────────────────────────────

describe('dispatchReviewerLanes — selected lanes are planned and invoked exactly once', () => {
  test('two selected lanes each get exactly one plan call and one invoke call', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy((lane) => ({ ok: true, reviewPath: `${RUN_DIR}/gsd-review-${lane.slug}.md`, errPath: `${RUN_DIR}/gsd-review-${lane.slug}.err` }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    assert.equal(plan.calls.length, 2);
    assert.equal(invoke.calls.length, 2);
    // Sorted selected order (resolveReviewerSelection sorts `selected`).
    assert.deepEqual(plan.calls.map((c) => c[0].slug), ['claude', 'codex']);
    assert.deepEqual(invoke.calls.map((c) => c[0].slug), ['claude', 'codex']);

    assert.equal(result.dispatched, true);
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.slug), ['claude', 'codex']);
    assert.ok(result.results.every((r) => r.ok === true));
  });

  test('duplicate explicit aliases for the same slug still produce exactly one plan/invoke call', async () => {
    const lanes = new Map([['gemini', fakeLane('gemini')]]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['gemini', 'gemini', 'GEMINI'], detected: ['gemini'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    assert.equal(plan.calls.length, 1);
    assert.equal(invoke.calls.length, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.ok, true);
  });
});

// ─── prompt content: metadata only ──────────────────────────────────────────

describe('dispatchReviewerLanes — bounded source-review prompt', () => {
  test('buildSourceReviewPrompt embeds repoRoot, paths+baseSha, depth, and the four prohibitions verbatim — never file contents', () => {
    const prompt = buildSourceReviewPrompt({
      repoRoot: REPO_ROOT,
      paths: ['src/a.ts', 'src/b.ts'],
      depth: 'deep',
      baseSha: 'deadbeef',
    });

    assert.match(prompt, /Repository root: \/repo/);
    assert.match(prompt, /Review depth: deep/);
    assert.match(prompt, /Base SHA: deadbeef/);
    assert.match(prompt, /- src\/a\.ts \(base SHA deadbeef\)/);
    assert.match(prompt, /- src\/b\.ts \(base SHA deadbeef\)/);
    for (const rule of SOURCE_REVIEW_PROHIBITIONS) {
      assert.ok(prompt.includes(rule), `prompt missing prohibition: ${rule}`);
    }
    assert.equal(SOURCE_REVIEW_PROHIBITIONS.length, 4);
  });

  test('the shared prompt file is written exactly once even across multiple selected lanes', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));
    const writePromptFile = spy(() => {});

    await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile },
    );

    assert.equal(writePromptFile.calls.length, 1);
    const [writtenPath, writtenContent] = writePromptFile.calls[0];
    assert.equal(writtenPath, `${RUN_DIR}/gsd-review-prompt.md`);
    assert.match(writtenContent, /Repository root: \/repo/);
  });
});

// ─── capability-neutral reuse ───────────────────────────────────────────────

describe('dispatchReviewerLanes — capability-neutral (no capability id in the input contract)', () => {
  test('a second, unrelated synthetic step context dispatches through the same function identically', async () => {
    const lanes = new Map([['claude', fakeLane('claude')]]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));

    // "code-review"-shaped call.
    const codeReview = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude'], detected: ['claude'] }, depth: 'standard' }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    // A wholly synthetic "source-audit" step — different depth/paths/runDir, same function,
    // same deps shape, no capability-id parameter exists to special-case on.
    const sourceAudit = await dispatchReviewerLanes(
      baseInput({
        selection: { explicitFlags: ['claude'], detected: ['claude'] },
        depth: 'audit',
        paths: ['docs/spec.md'],
        runDir: '/run-audit',
      }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    assert.equal(codeReview.ok, true);
    assert.equal(sourceAudit.ok, true);
    assert.equal(plan.calls.length, 2);
    assert.equal(invoke.calls.length, 2);
  });
});

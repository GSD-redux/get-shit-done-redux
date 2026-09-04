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

// ─── fail-closed: explicit unavailability never narrows the requested set ──

describe('dispatchReviewerLanes — fail-closed: explicit lane unavailable', () => {
  test('one unavailable explicit lane still runs the OTHER resolved lane, but the aggregate is failed', async () => {
    const lanes = new Map([['claude', fakeLane('claude')]]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'ghost'], detected: ['claude'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    // The unavailable lane never reaches plan/invoke — only the resolved one does.
    assert.equal(plan.calls.length, 1);
    assert.equal(invoke.calls.length, 1);
    assert.equal(plan.calls[0][0].slug, 'claude');

    // "Never claim a complete external set": the successful lane's result is kept...
    assert.equal(result.dispatched, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].slug, 'claude');
    assert.equal(result.results[0].ok, true);
    // ...but the aggregate must not read as a clean success.
    assert.equal(result.ok, false);
    assert.ok(result.selection.errors.some((e) => e.includes('ghost')));
  });

  test('every explicit lane unavailable dispatches nothing, distinct from the plain no-flags case', async () => {
    const plan = spy(() => { throw new Error('must not be called'); });
    const invoke = spy(() => { throw new Error('must not be called'); });

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['ghost'], detected: [] } }),
      { plan, invoke },
    );

    assert.equal(plan.calls.length, 0);
    assert.equal(invoke.calls.length, 0);
    assert.equal(result.dispatched, false);
    assert.equal(result.ok, false); // NOT the same "ok: true" no-flags-passed inert case
    assert.equal(result.reason, DISPATCH_REASON.SELECTION_FAILED);
  });
});

// ─── fail-closed: per-lane plan/invoke failures never cancel siblings ──────

describe('dispatchReviewerLanes — fail-closed: per-lane plan/invoke failure', () => {
  test('one lane failing to plan does not stop the sibling from being planned and invoked', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => (
      lane.slug === 'codex'
        ? { ok: false, reason: 'missing_binary', detail: 'codex not on PATH', warnings: [] }
        : okPlan(lane.slug)
    ));
    const invoke = spy(() => ({ ok: true }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    assert.equal(plan.calls.length, 2);
    assert.equal(invoke.calls.length, 1); // never invoked for the lane whose plan failed
    assert.equal(invoke.calls[0][0].slug, 'claude');

    assert.equal(result.ok, false);
    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, true);
    assert.equal(bySlug.codex.ok, false);
    assert.equal(bySlug.codex.reason, 'missing_binary');
  });

  test('one lane failing to invoke does not cancel or discard the sibling that succeeded', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy((lane) => (
      lane.slug === 'codex'
        ? { ok: false, reason: 'probe_failed', detail: 'codex exited 1' }
        : { ok: true, reviewPath: `${RUN_DIR}/gsd-review-claude.md` }
    ));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    assert.equal(plan.calls.length, 2);
    assert.equal(invoke.calls.length, 2);
    assert.equal(result.ok, false);
    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, true);
    assert.equal(bySlug.claude.reviewPath, `${RUN_DIR}/gsd-review-claude.md`);
    assert.equal(bySlug.codex.ok, false);
    assert.equal(bySlug.codex.reason, 'probe_failed');
  });
});

// ─── fail-closed: request-level validation halts BEFORE any lane runs ──────

describe('dispatchReviewerLanes — fail-closed: unsafe/incomplete request halts before invocation', () => {
  const cases = [
    {
      name: 'path traversal (..) escaping repoRoot',
      overrides: { paths: ['../../etc/passwd'] },
      reason: DISPATCH_REASON.PATH_ESCAPES_REPO_ROOT,
    },
    {
      name: 'absolute path outside repoRoot',
      overrides: { paths: ['/etc/passwd'] },
      reason: DISPATCH_REASON.PATH_ESCAPES_REPO_ROOT,
    },
    {
      name: 'empty paths array',
      overrides: { paths: [] },
      reason: DISPATCH_REASON.INVALID_PATHS,
    },
    {
      name: 'non-string path element',
      overrides: { paths: [42] },
      reason: DISPATCH_REASON.INVALID_PATHS,
    },
    {
      name: 'missing depth',
      overrides: { depth: '' },
      reason: DISPATCH_REASON.MISSING_PROVENANCE,
    },
    {
      name: 'missing base SHA',
      overrides: { baseSha: '' },
      reason: DISPATCH_REASON.MISSING_PROVENANCE,
    },
  ];

  for (const { name, overrides, reason } of cases) {
    test(`${name} halts the whole dispatch before any plan/invoke call`, async () => {
      const plan = spy(() => { throw new Error('must not be called'); });
      const invoke = spy(() => { throw new Error('must not be called'); });

      const result = await dispatchReviewerLanes(
        baseInput(overrides),
        { plan, invoke },
      );

      assert.equal(plan.calls.length, 0);
      assert.equal(invoke.calls.length, 0);
      assert.equal(result.dispatched, false);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
    });
  }
});

// ─── fail-closed: per-lane budget overflow stops that lane before invoke ───

describe('dispatchReviewerLanes — fail-closed: budget overflow', () => {
  test('a lane whose resolved budget the prompt exceeds hard-fails before invoke; the sibling still runs', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude', { promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.claude' })],
      ['codex', fakeLane('codex', { promptBudgetKey: null })], // unbounded
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));
    const configGet = (key) => (
      key === 'review.max_prompt_tokens_per_reviewer.claude' ? 5 : undefined
    );

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, configGet, writePromptFile: noopWrite },
    );

    assert.equal(plan.calls.length, 2); // both were planned
    assert.equal(invoke.calls.length, 1); // only the unbounded lane was invoked
    assert.equal(invoke.calls[0][0].slug, 'codex');

    assert.equal(result.ok, false);
    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, false);
    assert.equal(bySlug.claude.reason, 'budget_exceeded');
    assert.equal(bySlug.codex.ok, true);
  });

  test('budget 0 means unbounded (no hard-fail), mirroring the existing review-lane budgetFor convention', async () => {
    const lanes = new Map([['claude', fakeLane('claude', { promptBudgetKey: 'review.max_prompt_tokens_per_reviewer.claude' })]]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));
    const configGet = (key) => (key === 'review.max_prompt_tokens_per_reviewer.claude' ? 0 : undefined);

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude'], detected: ['claude'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, configGet, writePromptFile: noopWrite },
    );

    assert.equal(invoke.calls.length, 1);
    assert.equal(result.ok, true);
  });

  test('WR-01: dispatched is false when the only selected slug never resolves to a lane', async () => {
    const plan = spy(() => okPlan('ghost'));
    const invoke = spy(() => ({ ok: true }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['ghost'] } }),
      {
        resolveSelection: () => ({ selected: ['ghost'], errors: [] }),
        getLane: () => undefined,
        plan,
        invoke,
        writePromptFile: noopWrite,
      },
    );

    assert.equal(plan.calls.length, 0, 'plan() must never be called for an unresolved lane');
    assert.equal(invoke.calls.length, 0, 'invoke() must never be called for an unresolved lane');
    assert.equal(result.dispatched, false, 'dispatched must reflect that zero lanes were actually planned');
    assert.equal(result.results[0].reason, 'malformed_lane');
  });

  test('WR-02: a throwing plan() for one lane does not discard results already collected for a sibling lane', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => {
      if (lane.slug === 'codex') throw new Error('boom: malformed manifest');
      return okPlan(lane.slug);
    });
    const invoke = spy(() => ({ ok: true }));

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, true, 'the sibling lane that planned fine must still be invoked and reported');
    assert.equal(invoke.calls.length, 1, 'invoke must have run for the sibling lane despite the throw');
    assert.equal(bySlug.codex.ok, false);
    assert.match(bySlug.codex.detail, /boom: malformed manifest/);
    assert.equal(result.ok, false);
  });

  test('WR-02b: a throwing writePromptFile() for the first lane does not stop a later sibling lane from running', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy(() => ({ ok: true }));
    let writeCalls = 0;
    const writePromptFile = spy(() => {
      writeCalls += 1;
      if (writeCalls === 1) throw new Error('boom: disk full');
    });

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile },
    );

    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, false);
    assert.match(bySlug.claude.detail, /boom: disk full/);
    assert.equal(bySlug.codex.ok, true, 'the later sibling lane must still be invoked despite the first lane\'s writePromptFile throw');
    assert.equal(invoke.calls.length, 1);
    assert.equal(result.ok, false);
  });

  test('WR-02c: a throwing invoke() for the first lane does not stop a later sibling lane from running', async () => {
    const lanes = new Map([
      ['claude', fakeLane('claude')],
      ['codex', fakeLane('codex')],
    ]);
    const plan = spy((lane) => okPlan(lane.slug));
    const invoke = spy((lane) => {
      if (lane.slug === 'claude') throw new Error('boom: spawn EMFILE');
      return { ok: true };
    });

    const result = await dispatchReviewerLanes(
      baseInput({ selection: { explicitFlags: ['claude', 'codex'], detected: ['claude', 'codex'] } }),
      { getLane: (slug) => lanes.get(slug), plan, invoke, writePromptFile: noopWrite },
    );

    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r]));
    assert.equal(bySlug.claude.ok, false);
    assert.match(bySlug.claude.detail, /boom: spawn EMFILE/);
    assert.equal(bySlug.codex.ok, true, 'the later sibling lane must still be invoked despite the first lane\'s invoke throw');
    assert.equal(result.ok, false);
  });
});

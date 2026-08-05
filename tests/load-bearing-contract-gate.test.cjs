'use strict';

/**
 * Deterministic load-bearing fragment contract gate.
 *
 * ADR-1671 Consequences → Negative/risks (as amended by #2931) claims a
 * deterministic gate proves no load-bearing fragment is ever omitted or
 * shrunk under budget pressure. Until #3065 that gate did not exist — only
 * `tests/context-composer.test.cjs`, synthetic unit tests of the
 * `composeWithinBudget` primitive over invented fragments, unconnected to
 * any real declared strategy.
 *
 * This file:
 *   1. IMPORTS the real fragment construction from `buildBudgetFragments`
 *      (src/prompt-budget.cts, exported for issue #3065) rather than
 *      hand-copying it. A hand-copy is exactly the `DEFECT.GENERATIVE-FIX`
 *      divergence class this gate exists to guard against: if production
 *      flips a fragment's strategy (e.g. `roadmap` from `verbatim` to
 *      `drop`), a copy would keep passing because it computes from stale
 *      duplicated data instead of the real declaration. Importing means the
 *      gate can only pass if the REAL declared strategies still hold.
 *   2. Derives the load-bearing set mechanically — every fragment whose
 *      declared `strategy.kind === 'verbatim'` — rather than hand-listing
 *      ids, so the gate follows automatically if the upstream declarations
 *      change (test-matrix row 13).
 *   3. Drives `composeWithinBudget` directly (not `applyBudget`, whose
 *      `BudgetMetadata` return type only exposes
 *      {budget, effectiveBudget, estimatedTokens, omitted, projectMdShrunk,
 *      planTruncationPct, hardFailed, noteInjected} — it does NOT expose
 *      `shrunk` (full array), `floored`, `underPressure`, `isolatePrefix`,
 *      or `hardFailReason`, all of which this gate must assert on).
 *
 * Module under test: gsd-core/bin/lib/context-composer.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { composeWithinBudget } = require('../gsd-core/bin/lib/context-composer.cjs');
const { buildBudgetFragments, PLAN_FLOOR_CHARS } = require('../gsd-core/bin/lib/prompt-budget.cjs');

// Same estimator prompt-budget.cts uses (estimateTokens: chars/4, rounded up).
const measure = (text) => (text ? Math.ceil(text.length / 4) : 0);

/**
 * Build realistic, non-trivial input sections (not one-word placeholders)
 * and call the REAL `buildBudgetFragments` (src/prompt-budget.cts) to get
 * the fragment array, so the sweep below exercises real head-shrink and
 * proportional-truncate behavior against production's actual declared
 * strategies — not a hand-copied duplicate (issue #3065).
 */
function buildProductionFragments() {
  const instructions = [
    '# Review Instructions',
    '',
    'You are reviewing a change against the acceptance criteria below. Read every',
    'plan section fully before commenting. Cite file:line for every finding and',
    'never approve a PR missing a changeset entry or docs update. Flag any',
    'unbounded subprocess call, any missing timeout, and any test that asserts on',
    'wall-clock time. Findings must be actionable — no vague "consider improving"',
    'language. Severity is one of BLOCKER, MAJOR, MINOR, or NIT.',
  ].join('\n');

  const roadmap = [
    '## Roadmap',
    '',
    '1. Phase 1 — land the composer seam and characterize existing behavior.',
    '2. Phase 2 — extract the trim ladder into a shared module.',
    '3. Phase 3 — wire prompt-budget through the shared seam.',
    '4. Phase 4 — add flexReserve and isolate-prefix support.',
    '5. Phase 5 — this phase: build the deterministic contract gate.',
  ].join('\n');

  const projectMdLines = [];
  for (let i = 0; i < 220; i++) {
    projectMdLines.push(`Project note line ${i}: context that matters for review and must survive head-shrink.`);
  }
  const projectMd = projectMdLines.join('\n');

  const planContent = (n) => {
    const lines = [];
    for (let i = 0; i < 45; i++) {
      lines.push(`Plan ${n} step ${i}: a concrete, non-trivial implementation detail worth reviewing carefully and at length.`);
    }
    return lines.join('\n');
  };
  const plan1 = planContent(1);
  const plan2 = planContent(2);

  const context = 'Context: ' + 'relevant background prose describing the surrounding subsystem and its invariants. '.repeat(20);
  const research = 'Research: ' + 'prior art and precedent gathered before this change was proposed. '.repeat(20);
  const requirements = 'Requirements: ' + 'acceptance criteria extracted verbatim from the linked issue. '.repeat(20);

  const sections = {
    instructions,
    roadmap,
    plans: [
      { file: 'plan1.md', content: plan1 },
      { file: 'plan2.md', content: plan2 },
    ],
    projectMd,
    context,
    research,
    requirements,
  };

  return buildBudgetFragments(sections, 40);
}

/**
 * Derive the load-bearing set: every fragment whose declared strategy is
 * {kind:'verbatim'}. NEVER hardcode this list — it must follow the
 * production declarations mechanically (test-matrix row 13).
 */
function deriveLoadBearingSet(fragments) {
  return fragments.filter((f) => f.strategy.kind === 'verbatim').map((f) => f.id);
}

/**
 * Anti-vacuity guard (test-matrix row 6 / design.md "Rejected" section).
 * A gate that derives an empty load-bearing set proves nothing — it must
 * fail loudly rather than silently pass an empty sweep.
 */
function assertLoadBearingSetNonEmpty(set) {
  if (!Array.isArray(set) || set.length === 0) {
    throw new Error(
      'load-bearing set is empty — a gate asserting over nothing proves nothing (test-matrix row 6)'
    );
  }
}

const composeOptions = () => ({
  safetyMarginPct: 10,
  reserve: 80,
  charsPerUnit: 4,
  // Mirrors the minimumFor in src/prompt-budget.cts:230-234.
  minimumFor: (f) => {
    if (f.id === 'instructions' || f.id === 'roadmap') return f.content;
    if (f.id.startsWith('plan:')) return f.content.slice(0, PLAN_FLOOR_CHARS);
    return null;
  },
});

const fragments = buildProductionFragments();
const loadBearing = deriveLoadBearingSet(fragments);
const total = fragments.reduce((sum, f) => sum + measure(f.content), 0);
const budgets = [
  total * 4,
  total + 1,
  total,
  total - 1,
  Math.floor(total * 0.75),
  Math.floor(total * 0.5),
  Math.floor(total * 0.25),
];

describe('load-bearing fragment contract gate (ADR-1671, #2931, #3065)', () => {
  test('load-bearing set is derived (not hardcoded) and non-empty', () => {
    assertLoadBearingSetNonEmpty(loadBearing);
    // The production fragment array declares exactly three verbatim
    // fragments today: instructions, roadmap, and plans-header (the empty
    // "## Plans" section header). ADR-1671's own prose only names
    // instructions/roadmap; plans-header is verbatim too and this
    // mechanical derivation correctly includes it.
    assert.deepEqual(loadBearing, ['instructions', 'roadmap', 'plans-header']);
  });

  test('budget sweep: no load-bearing fragment is ever omitted or shrunk; isolatePrefix is pinned; hardFailed never fires', () => {
    let firstIsolatePrefix;
    let sawUnderPressure = false;

    for (const budget of budgets) {
      const result = composeWithinBudget({ fragments, budget, measure, options: composeOptions() });

      if (result.metadata.hardFailed) {
        assert.fail(`budget ${budget}: hardFailed with reason "${result.metadata.hardFailReason}"`);
      }

      for (const id of loadBearing) {
        assert.ok(!result.metadata.omitted.includes(id), `budget ${budget}: load-bearing "${id}" was omitted`);
        assert.ok(!result.metadata.shrunk.includes(id), `budget ${budget}: load-bearing "${id}" was shrunk`);
      }

      // `floored` is a PASS (design.md row 3 / "floored is a success, not a
      // finding"): a non-empty `floored` means flexReserve prevented a cut
      // that would otherwise have happened. Do NOT assert it is empty.

      // HONEST NOTE (#3065 review): no production `applyBudget` fragment
      // currently sets `isolate: true`, so `isolatePrefix` is always `''`
      // for the real production fragment set — this equality assertion by
      // itself would be decorative (it could never observe a change,
      // because there is nothing to observe). It is kept because it is
      // still the correct invariant to hold, and its ability to actually
      // detect drift is proven separately below (isolate-prefix pinning
      // test), which builds a fragment set WITH an isolate fragment.
      if (firstIsolatePrefix === undefined) {
        firstIsolatePrefix = result.metadata.isolatePrefix;
      } else {
        assert.equal(result.metadata.isolatePrefix, firstIsolatePrefix, `budget ${budget}: isolatePrefix drifted from the first sampled budget`);
      }

      if (result.metadata.underPressure) sawUnderPressure = true;
    }

    // Row 7 anti-vacuity: the sweep must have applied real pressure at
    // least once, or the assertions above prove nothing.
    assert.ok(sawUnderPressure, 'no sampled budget reported underPressure — an always-unpressured sweep proves nothing (test-matrix row 7)');
  });

  test('isolate-prefix pinning is a REAL check: a fragment set WITH isolate:true produces a non-empty, byte-identical isolatePrefix across budgets', () => {
    // Proves the equality assertion in the budget-sweep test above is
    // capable of failing, not merely decorative. Production has no
    // isolate:true fragment today (see the HONEST NOTE above), so this
    // constructs one explicitly.
    const isolateFragments = [
      { id: 'canonical-header', content: 'STABLE CANONICAL PREFIX — must never move.', wrapper: '', strategy: { kind: 'verbatim' }, required: true, isolate: true },
      { id: 'instructions', content: 'Body instructions that may be trimmed under pressure. '.repeat(40), wrapper: '', strategy: { kind: 'verbatim' }, required: true },
      { id: 'context', content: 'Droppable context. '.repeat(40), wrapper: '', strategy: { kind: 'drop' } },
    ];
    const isolateTotal = isolateFragments.reduce((sum, f) => sum + measure(f.content), 0);

    const resultRoomy = composeWithinBudget({ fragments: isolateFragments, budget: isolateTotal * 4, measure, options: composeOptions() });
    const resultTight = composeWithinBudget({ fragments: isolateFragments, budget: Math.floor(isolateTotal * 0.3), measure, options: composeOptions() });

    assert.notEqual(resultRoomy.metadata.isolatePrefix, '', 'isolatePrefix must be non-empty when an isolate:true fragment is present');
    assert.equal(resultRoomy.metadata.isolatePrefix, resultTight.metadata.isolatePrefix, 'isolatePrefix must stay byte-identical across budgets, including under severe pressure');
    assert.equal(resultTight.metadata.isolatePrefix, isolateFragments[0].content, 'isolatePrefix must equal the isolate fragment content verbatim');
  });

  test('anti-vacuity row 7: a sweep of only budget=total*4 never reports underPressure, proving the guard CAN fail', () => {
    const result = composeWithinBudget({ fragments, budget: total * 4, measure, options: composeOptions() });
    assert.equal(result.metadata.underPressure, false);
    // If total*4 were the ONLY sampled budget in the sweep above, its
    // `assert.ok(sawUnderPressure, ...)` would legitimately fail — this
    // test demonstrates that failure condition is real, not vacuous.
  });

  test('row 12 negative space: a drop-strategy fragment IS allowed in `omitted` under severe pressure — that is the ladder working', () => {
    const severeBudget = Math.floor(total * 0.25);
    const result = composeWithinBudget({ fragments, budget: severeBudget, measure, options: composeOptions() });

    assert.equal(result.metadata.hardFailed, false, `severe budget ${severeBudget} unexpectedly hardFailed: ${result.metadata.hardFailReason}`);
    assert.ok(
      result.metadata.omitted.includes('context'),
      'expected the drop-strategy "context" fragment to be omitted under severe pressure (ladder step 6/prompt-budget.cts:212)'
    );
    for (const id of loadBearing) {
      assert.ok(!result.metadata.omitted.includes(id), `load-bearing "${id}" must never be omitted, even under the same severe pressure that dropped "context"`);
    }
  });

  test('anti-vacuity row 6 (executable): an all-non-verbatim fragment set derives an empty load-bearing set, and the guard throws on it', () => {
    const noVerbatimFragments = [
      { id: 'projectMd', content: 'x'.repeat(2000), wrapper: '', strategy: { kind: 'head-shrink', maxLines: 10 } },
      { id: 'plan:only.md', content: 'y'.repeat(2000), wrapper: '', strategy: { kind: 'proportional-truncate', floorChars: PLAN_FLOOR_CHARS }, group: 'plans' },
      { id: 'context', content: 'z'.repeat(500), wrapper: '', strategy: { kind: 'drop' } },
    ];

    const derived = deriveLoadBearingSet(noVerbatimFragments);
    assert.deepEqual(derived, []);
    assert.throws(() => assertLoadBearingSetNonEmpty(derived), /load-bearing set is empty/);
  });

  test('boundary: budget = total-1 / total / total+1 all hold the contract against the real measured total', () => {
    for (const budget of [total - 1, total, total + 1]) {
      const result = composeWithinBudget({ fragments, budget, measure, options: composeOptions() });
      assert.equal(result.metadata.hardFailed, false, `budget ${budget} unexpectedly hardFailed: ${result.metadata.hardFailReason}`);
      for (const id of loadBearing) {
        assert.ok(!result.metadata.omitted.includes(id));
        assert.ok(!result.metadata.shrunk.includes(id));
      }
    }
  });
});

/**
 * Tests for Phase 7 (#3217, ADR-3180 §7.6 rules 3-4): a derivation whose
 * scope is not COMPLETE renders no percentage at all.
 *
 * Design:       .gsd/phase/refactor-3217-completion-ratio-scoping/40-design.md
 * Test matrix:  .gsd/phase/refactor-3217-completion-ratio-scoping/50-test-matrix.md
 *
 * Section A asserts at each CONSUMER's observable output (ADR Decision 4c),
 * never at a helper's return value — a percentage post-filtered after the
 * fact is indistinguishable from one never withheld. All CLI assertions use
 * `--raw` (typed JSON), never rendered prose (CONTRIBUTING.md: no source-grep,
 * no prose matching).
 *
 * Fixture note on constructing each SCOPE without fs mocking (a subprocess
 * CLI test cannot `mock.method` inside the child process): COMPLETE and
 * TRUNCATED and UNSCOPED are constructed via ROADMAP/STATE content shape
 * alone. UNREADABLE is constructed by making `.planning/phases` a REGULAR
 * FILE instead of a directory — `listMilestonePhaseDirs`'s own
 * `fs.readdirSync(phasesDir, ...)` then throws ENOTDIR and its catch block
 * returns `scope: SCOPE.UNREADABLE` (src/phase-locator.cts). This is
 * deterministic and cross-platform, unlike a `chmod`-based trick (repo rule:
 * IO failure via `mock.method`, never `chmod 0o000` — this sidesteps both by
 * not needing IO-failure injection into the CLI's own process at all).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const drift = require('../scripts/lint-completion-ratio-drift.cjs');
const { clampPercent } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');
const { computeProgressPercent } = require('../gsd-core/bin/lib/state-document.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// ─── Fixture helpers (mirrors tests/completion-ratio-single-owner.test.cjs) ─

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Makes `.planning/phases` an UNREADABLE-as-a-directory node: a regular file
// where callers expect a directory. `fs.readdirSync` on it throws ENOTDIR,
// which `listMilestonePhaseDirs` (src/phase-locator.cts) catches and reports
// as `scope: SCOPE.UNREADABLE` — the real production catch path, not a mock.
function makePhasesDirUnreadable(cwd) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'phases'), 'not a directory\n');
}

// COMPLETE-scope fixture: v1.0 is the current (and only) milestone, one
// Complete phase and one Planned phase.
function buildCompleteFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
    '',
    '### Phase 2: Bar',
  ].join('\n'));
  writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
  writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');
}

// TRUNCATED-scope fixture: STATE asserts v2.0, whose ROADMAP heading is
// found but whose OWN window has no Phase entries, while the document (under
// v1.0) does — classifyMilestoneWindow row 8 (src/roadmap-parser.cts).
function buildTruncatedFixture(cwd) {
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, [
    '## v1.0 Planned',
    '',
    '### Phase 1: Foo',
    '',
    '## v2.0 Current 🚧',
  ].join('\n'));
}

// UNSCOPED-scope fixture: STATE asserts a version with no matching ROADMAP
// heading at all (classifyMilestoneWindow row 5).
function buildUnscopedFixture(cwd) {
  writeState(cwd, { milestone: 'v9.9' });
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
  ].join('\n'));
  writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
}

// UNREADABLE-scope fixture: a valid milestone window, but the phases
// directory itself cannot be enumerated.
function buildUnreadableFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, [
    '## v1.0 Current 🚧',
    '',
    '### Phase 1: Foo',
  ].join('\n'));
  makePhasesDirUnreadable(cwd);
}

function analyzeRaw(cwd) {
  const result = runGsdTools(['roadmap', 'analyze', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return JSON.parse(result.output);
}

function queryProgressRaw(cwd) {
  const result = runGsdTools(['query', 'progress', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return JSON.parse(result.output);
}

function statsRaw(cwd) {
  const result = runGsdTools(['stats', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return JSON.parse(result.output);
}

function stateUpdateProgressRaw(cwd) {
  const result = runGsdTools(['state', 'update-progress', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return result.output;
}

function stateJsonRaw(cwd) {
  const result = runGsdTools(['state', 'json', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return JSON.parse(result.output);
}

// ═════════════════════════════════════════════════════════════════════════
// A. Rule 4 at each consumer's OBSERVABLE output (ADR Decision 4c)
// ═════════════════════════════════════════════════════════════════════════

describe('A. rule 4 — a non-COMPLETE scope renders no percentage, at the CLI surface', () => {
  test('A1: roadmap analyze --json, COMPLETE scope -> numeric progress_percent', (t) => {
    const cwd = createTempDir('gsd-3217-a1-');
    t.after(() => cleanup(cwd));
    buildCompleteFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(typeof analyzed.progress_percent, 'number');
    assert.strictEqual(analyzed.progress_percent, 50);
    // Finding 2: `progress_scope` is the field that governs `progress_percent`
    // specifically — it must be exposed (not merely equal to `scope` by
    // coincidence on this fixture) so a consumer never has to infer it.
    assert.strictEqual(analyzed.progress_scope, SCOPE.COMPLETE);
  });

  test('A2: roadmap analyze --json, TRUNCATED scope -> progress_percent: null (never 0, never 100)', (t) => {
    const cwd = createTempDir('gsd-3217-a2-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.TRUNCATED);
    assert.strictEqual(analyzed.progress_percent, null);
    assert.notStrictEqual(analyzed.progress_percent, 0);
    assert.notStrictEqual(analyzed.progress_percent, 100);
  });

  test('A3: roadmap analyze --json, UNSCOPED scope -> progress_percent: null', (t) => {
    const cwd = createTempDir('gsd-3217-a3-');
    t.after(() => cleanup(cwd));
    buildUnscopedFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.UNSCOPED);
    assert.strictEqual(analyzed.progress_percent, null);
  });

  test('A4: roadmap analyze --json, UNREADABLE phases dir -> progress_percent: null', (t) => {
    const cwd = createTempDir('gsd-3217-a4-');
    t.after(() => cleanup(cwd));
    buildUnreadableFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.progress_percent, null);
    // Finding 2's exact repro shape: the top-level `scope` (heading-windowing
    // identity) is COMPLETE — the ROADMAP heading resolves fine — while
    // `progress_scope` (the listMilestonePhaseDirs scope that actually gates
    // `progress_percent`) is UNREADABLE. Without `progress_scope` a consumer
    // sees `scope: "complete"` next to `progress_percent: null` with nothing
    // in the JSON explaining why.
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(analyzed.progress_scope, SCOPE.UNREADABLE);
  });

  test('A5: query progress, non-COMPLETE scope -> percent: null, no number rendered', (t) => {
    const cwd = createTempDir('gsd-3217-a5-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixture(cwd);
    const rendered = queryProgressRaw(cwd);
    assert.strictEqual(rendered.phase_scope, SCOPE.TRUNCATED);
    assert.strictEqual(rendered.percent, null);
  });

  test('A6: stats, non-COMPLETE scope -> percent: null and plan_percent: null', (t) => {
    const cwd = createTempDir('gsd-3217-a6-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixture(cwd);
    const stats = statsRaw(cwd);
    assert.strictEqual(stats.phase_scope, SCOPE.TRUNCATED);
    assert.strictEqual(stats.percent, null);
    assert.strictEqual(stats.plan_percent, null);
  });

  test('A7: state update-progress, non-COMPLETE scope -> STATE.md Progress line untouched, no percentage written', (t) => {
    const cwd = createTempDir('gsd-3217-a7-');
    t.after(() => cleanup(cwd));
    buildUnscopedFixture(cwd);
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');
    writeFile(cwd, '.planning/STATE.md', fs.readFileSync(statePath, 'utf-8') + '\n**Progress:** [░░░░░░░░░░] 0%\n');
    const before = fs.readFileSync(statePath, 'utf-8');

    const output = stateUpdateProgressRaw(cwd);
    assert.strictEqual(output, 'false');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, before, 'STATE.md must not be modified when scope is not COMPLETE');
  });

  // A8 (workstream inventory, non-COMPLETE scope -> no percentage in the
  // projection): NOT covered. `buildWorkstreamInventory`
  // (src/workstream-inventory-builder.cts) is a pure projection whose caller
  // (workstream-inventory.cts) does not thread a real `SCOPE` value into its
  // inputs, and its own `milestoneScoped` is a pre-ADR-3180 bespoke boolean
  // that cannot distinguish TRUNCATED from UNSCOPED from UNREADABLE. Doing
  // this honestly requires either widening `WorkstreamInventory.progress_percent`
  // from `number` to `number | null` (an explicitly out-of-scope
  // return-type re-architecture per this phase's design doc, "Known limits")
  // or reusing the bespoke boolean as a `Scope` stand-in (exactly the
  // textual-proxy-for-a-data-flow-property this phase's own guard section
  // rejects). See the written-reason comment at
  // src/workstream-inventory-builder.cts's `progress_percent` field. A bare
  // `return` here is this repo's documented PASS-not-skip shape for a row
  // this phase deliberately leaves un-migrated, rather than silently
  // omitting the row.
  test('A8: workstream inventory — NOT migrated this phase (written reason above; see src/workstream-inventory-builder.cts)', () => {
    return;
  });

  test('A9: cross-surface — one non-COMPLETE fixture, none of roadmap analyze / query progress / stats renders a number', (t) => {
    const cwd = createTempDir('gsd-3217-a9-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixture(cwd);

    const analyzed = analyzeRaw(cwd);
    const progress = queryProgressRaw(cwd);
    const stats = statsRaw(cwd);

    assert.strictEqual(analyzed.scope, SCOPE.TRUNCATED);
    assert.strictEqual(progress.phase_scope, SCOPE.TRUNCATED);
    assert.strictEqual(stats.phase_scope, SCOPE.TRUNCATED);

    assert.strictEqual(analyzed.progress_percent, null);
    assert.strictEqual(progress.percent, null);
    assert.strictEqual(stats.percent, null);
    assert.strictEqual(stats.plan_percent, null);
  });

  test('A10: state json --raw, UNREADABLE phases dir -> progress.percent is ABSENT (not 0, not null-valued)', (t) => {
    const cwd = createTempDir('gsd-3217-a10-');
    t.after(() => cleanup(cwd));
    buildUnreadableFixture(cwd);

    const built = stateJsonRaw(cwd);
    // buildStateFrontmatter's established convention (unchanged by this
    // phase): a null percent is OMITTED from `progress`, never emitted as
    // `percent: 0` or `percent: null`. Before finding 1's fix this hardcoded
    // SCOPE.COMPLETE and, because the ROADMAP heading gave a real
    // totalPhases=1 with disk-scanned completedPhases=0 (the phases dir
    // being unreadable collapses to an empty scanned set), rendered an
    // EARNED-LOOKING but untrustworthy `percent: 0`.
    assert.ok(built.progress === undefined || !('percent' in built.progress));
  });

  test('A11 (finding-1 repro): one genuinely UNREADABLE-phases-dir fixture — state json / roadmap analyze / stats / query progress / state update-progress ALL withhold, none renders a number', (t) => {
    const cwd = createTempDir('gsd-3217-a11-');
    t.after(() => cleanup(cwd));
    buildUnreadableFixture(cwd);
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');
    const before = fs.readFileSync(statePath, 'utf-8');

    const built = stateJsonRaw(cwd);
    const analyzed = analyzeRaw(cwd);
    const stats = statsRaw(cwd);
    const progress = queryProgressRaw(cwd);
    const updateOutput = stateUpdateProgressRaw(cwd);

    assert.ok(built.progress === undefined || !('percent' in built.progress), 'state json must not render a percent');
    assert.strictEqual(analyzed.progress_percent, null, 'roadmap analyze must withhold');
    assert.strictEqual(analyzed.progress_scope, SCOPE.UNREADABLE, 'roadmap analyze must expose WHY via progress_scope');
    assert.strictEqual(stats.percent, null, 'stats must withhold');
    assert.strictEqual(stats.phase_scope, SCOPE.UNREADABLE);
    assert.strictEqual(progress.percent, null, 'query progress must withhold');
    assert.strictEqual(progress.phase_scope, SCOPE.UNREADABLE);
    assert.strictEqual(updateOutput, 'false', 'state update-progress must not write');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(after, before, 'state update-progress must leave STATE.md untouched');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. The negative space — a real 0 must survive (over-withholding guard)
// ═════════════════════════════════════════════════════════════════════════

describe('B. negative space — a REAL 0 under COMPLETE must still render', () => {
  test('B1: COMPLETE scope, zero phases in a freshly-declared milestone -> 0, rendered (not withheld)', (t) => {
    const cwd = createTempDir('gsd-3217-b1-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true });

    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(analyzed.progress_percent, 0);

    const progress = queryProgressRaw(cwd);
    assert.strictEqual(progress.phase_scope, SCOPE.COMPLETE);
    assert.strictEqual(progress.percent, 0);
  });

  test('B2: COMPLETE scope, denominator 0 (plans exist in no phase) -> 0 (rule 2, unchanged)', (t) => {
    const cwd = createTempDir('gsd-3217-b2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    // Phase directory exists but has no PLAN files at all -> denominator 0.
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '01-foo'), { recursive: true });

    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(analyzed.total_plans, 0);
    assert.strictEqual(analyzed.progress_percent, 0);
  });

  test('B3: COMPLETE scope, all phases complete -> 100', (t) => {
    const cwd = createTempDir('gsd-3217-b3-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(analyzed.progress_percent, 100);
  });

  test('B4: a free-form legacy ROADMAP is COMPLETE for windowing (§7.1) — its percentage must NOT be lost', (t) => {
    const cwd = createTempDir('gsd-3217-b4-');
    t.after(() => cleanup(cwd));
    // No STATE.md, no versioned milestone headings at all — the classic
    // free-form legacy shape (classifyMilestoneWindow row 3).
    writeRoadmap(cwd, ['# ROADMAP', '', '### Phase 1: Foo'].join('\n'));
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');

    const analyzed = analyzeRaw(cwd);
    // Identity scope is UNSCOPED for a free-form roadmap, but WINDOWING scope
    // (what gates progress_percent here) must be COMPLETE per §7.1.
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(typeof analyzed.progress_percent, 'number');
    assert.strictEqual(analyzed.progress_percent, 0);
  });

  test('B5: boundary on the denominator under COMPLETE: 0, 1, >1', (t) => {
    const cwd = createTempDir('gsd-3217-b5-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));

    // Denominator 0: no PLAN files.
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', '01-foo'), { recursive: true });
    assert.strictEqual(analyzeRaw(cwd).progress_percent, 0);

    // Denominator 1, completed: 1/1 -> 100.
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
    assert.strictEqual(analyzeRaw(cwd).progress_percent, 100);

    // Denominator >1: add a second, incomplete plan -> 1/2 -> 50.
    writeFile(cwd, '.planning/phases/01-foo/01-02-PLAN.md', '# Plan\n');
    assert.strictEqual(analyzeRaw(cwd).progress_percent, 50);
  });

  test('B6: null vs 0 are distinguishable by a typed consumer', (t) => {
    const cwd = createTempDir('gsd-3217-b6-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v1.0' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
    fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true });
    const zeroCase = analyzeRaw(cwd);
    assert.strictEqual(zeroCase.progress_percent, 0);
    assert.notStrictEqual(zeroCase.progress_percent, null);

    cleanup(cwd);
    const cwd2 = createTempDir('gsd-3217-b6b-');
    t.after(() => cleanup(cwd2));
    buildTruncatedFixture(cwd2);
    const nullCase = analyzeRaw(cwd2);
    assert.strictEqual(nullCase.progress_percent, null);
    assert.notStrictEqual(nullCase.progress_percent, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. Rule 3 at cmdRoadmapAnalyze — the site Phase 3 did not reach
// ═════════════════════════════════════════════════════════════════════════

describe('C. rule 3 at roadmap analyze — progress_percent routed through listMilestonePhaseDirs', () => {
  // One fixture exercising C1 and C3 together: a backlog/sentinel dir
  // (999.1-backlog, fully "complete") and a phase outside the current
  // milestone window (01-foo, under v1.0, fully "complete") must both be
  // excluded from progress_percent's numerator AND denominator — only
  // 02-bar (under the current v2.0 window) may count.
  function buildScopedFixture(cwd) {
    writeState(cwd, { milestone: 'v2.0' });
    writeRoadmap(cwd, [
      '## v1.0 Old',
      '',
      '### Phase 1: Foo',
      '',
      '## v2.0 Current 🚧',
      '',
      '### Phase 2: Bar',
    ].join('\n'));
    // Out-of-window, fully complete — must not inflate the scoped total.
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
    // In-window, incomplete.
    writeFile(cwd, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');
    // Backlog/sentinel, fully complete — must never count as a milestone phase.
    writeFile(cwd, '.planning/phases/999.1-backlog/999.1-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/999.1-backlog/999.1-01-SUMMARY.md', '# Summary\n');
  }

  test('C1 + C3: numerator/denominator are the listMilestonePhaseDirs-scoped set only — no inflation from backlog or out-of-window dirs', (t) => {
    const cwd = createTempDir('gsd-3217-c1c3-');
    t.after(() => cleanup(cwd));
    buildScopedFixture(cwd);

    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    // Only 02-bar's 1 plan / 0 summaries — not 01-foo's or the backlog's.
    assert.strictEqual(analyzed.total_plans, 1);
    assert.strictEqual(analyzed.total_summaries, 0);
    assert.strictEqual(analyzed.progress_percent, 0);
    assert.notStrictEqual(analyzed.progress_percent, 100, 'the two complete-but-excluded dirs must not leak in');
  });

  test('C2: roadmap analyze vs stats vs query progress on one fixture report the SAME percentage', (t) => {
    const cwd = createTempDir('gsd-3217-c2-');
    t.after(() => cleanup(cwd));
    buildScopedFixture(cwd);

    const analyzed = analyzeRaw(cwd);
    const progress = queryProgressRaw(cwd);
    const stats = statsRaw(cwd);

    assert.strictEqual(analyzed.progress_percent, 0);
    assert.strictEqual(progress.percent, 0);
    assert.strictEqual(stats.plan_percent, 0);
    assert.strictEqual(analyzed.progress_percent, progress.percent);
    assert.strictEqual(progress.percent, stats.plan_percent);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. computeProgressPercent (state-document.cts:329) — direct unit tests
// ═════════════════════════════════════════════════════════════════════════

describe('D. computeProgressPercent — scope-required signature', () => {
  test('D1: no plan data and no phase data -> null (pre-existing behavior, must not regress)', () => {
    assert.strictEqual(computeProgressPercent(null, null, null, null, SCOPE.COMPLETE), null);
  });

  test('D2a: plan data only -> min of the two fractions (phase fraction defaults to 1) via clampPercentFromFraction', () => {
    // completedPlans=1, totalPlans=2 -> planFraction 0.5; no phase data ->
    // phaseFraction defaults to 1; min(0.5, 1) = 0.5 -> 50.
    assert.strictEqual(computeProgressPercent(1, 2, null, null, SCOPE.COMPLETE), 50);
  });

  test('D2b: phase data only -> min of the two fractions (plan fraction defaults to 1)', () => {
    assert.strictEqual(computeProgressPercent(null, null, 1, 4, SCOPE.COMPLETE), 25);
  });

  test('D2c: both plan and phase data -> the MIN fraction wins', () => {
    // planFraction = 1/1 = 1.0; phaseFraction = 1/4 = 0.25 -> min is 0.25 -> 25.
    assert.strictEqual(computeProgressPercent(1, 1, 1, 4, SCOPE.COMPLETE), 25);
  });

  test('D3: scope not COMPLETE -> null, even with otherwise-valid plan/phase data', () => {
    assert.strictEqual(computeProgressPercent(1, 1, 1, 1, SCOPE.TRUNCATED), null);
    assert.strictEqual(computeProgressPercent(1, 1, 1, 1, SCOPE.UNSCOPED), null);
    assert.strictEqual(computeProgressPercent(1, 1, 1, 1, SCOPE.UNREADABLE), null);
  });

  test('D4: completedPlans > totalPlans (over-count) -> clamped at 100, never above', () => {
    assert.strictEqual(computeProgressPercent(7, 5, null, null, SCOPE.COMPLETE), 100);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. Tier-2 regression surface
// ═════════════════════════════════════════════════════════════════════════

describe('E. Tier-2 regression surface', () => {
  test('E1: a consumer parsing progress_percent as always-numeric must now handle null — pins the new nullable contract', (t) => {
    const cwd = createTempDir('gsd-3217-e1-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    // Deliberate Tier-2 break, pinned: an always-numeric parse of
    // `progress_percent` (e.g. `Number(progress_percent).toFixed(0)`) would
    // have silently coerced this to "NaN" or "0" pre-#3217. It is `null`.
    assert.strictEqual(analyzed.progress_percent, null);
    assert.throws(() => {
      if (typeof analyzed.progress_percent !== 'number') throw new TypeError('progress_percent is not always numeric');
    }, TypeError);
  });

  test('E2: existing power-proof / consumer-identity fixture (tests/completion-ratio-single-owner.test.cjs) still resolves COMPLETE and matches clampPercent(owner totals)', (t) => {
    // Reuses that file's own fixture shape (a clean single-milestone project)
    // to confirm this phase's routing change does not alter the COMPLETE
    // case those pre-existing tests assert on.
    const cwd = createTempDir('gsd-3217-e2-');
    t.after(() => cleanup(cwd));
    buildCompleteFixture(cwd);
    const analyzed = analyzeRaw(cwd);
    assert.strictEqual(analyzed.scope, SCOPE.COMPLETE);
    assert.strictEqual(analyzed.progress_percent, clampPercent(analyzed.total_summaries, analyzed.total_plans));
  });

  test('E3: scripts/lint-completion-ratio-drift.cjs on the real tree — still an earned 0 for rules 1-2', () => {
    const violations = drift.scanRepo(REPO_ROOT);
    assert.deepStrictEqual(violations, []);
  });

  test('E4: a deliberate arithmetic re-derivation fixture is still flagged — the existing guard keeps working, unmodified by this phase', () => {
    const line = 'const p = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;';
    const out = drift.findCompletionRatioDrift(line, 'src/somewhere.cts');
    assert.strictEqual(out.length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F/G/H. `state sync` (cmdStateSync) — BLOCKER fix (post-review, #3217)
//
// cmdStateSync's own disk scan (`entries`, ~state.cts:3113) is UNFILTERED by
// the real milestone window — it only drops retired phase numbers (#1514).
// A phase directory outside the real window (or present while the window
// itself is TRUNCATED/UNSCOPED) still counted toward totalDiskPlans /
// totalDiskSummaries / diskCompletedPhases, and the percent gate hardcoded
// SCOPE.COMPLETE, so a non-COMPLETE window could still compute and WRITE a
// fabricated percentage into STATE.md's body. Fixed by threading the real
// `listMilestonePhaseDirs` scope through the same gate `computeProgressPercent`
// already enforces for every other consumer.
// ═════════════════════════════════════════════════════════════════════════

// UNSCOPED-row-4 fixture: no milestone asserted in STATE.md at all
// (`versionResolved` false) while the ROADMAP carries versioned milestone
// headings (`hasVersionedMilestones` true) — classifyMilestoneWindow row 4,
// distinct from the row-5 fixture above (which asserts an unmatched version).
// A completed phase directory is included so the pre-fix hardcoded-COMPLETE
// disk scan has real numbers to fabricate a percentage from.
function buildUnscopedRow4Fixture(cwd) {
  writeState(cwd, {});
  writeRoadmap(cwd, [
    '## v1.0 Shipped',
    '',
    '### Phase 1: Foo',
  ].join('\n'));
  writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
}

// TRUNCATED fixture (mirrors buildTruncatedFixture above) but WITH a
// completed phase directory on disk — the empty-window/empty-phases-dir
// shape above never exercises cmdStateSync's fabrication bug because
// cmdStateSync returns early ({ changes: [] }) when `.planning/phases`
// itself does not exist. This variant makes the phases dir real so the
// disk-scan gate is actually reached.
function buildTruncatedFixtureWithPhaseDir(cwd) {
  writeState(cwd, { milestone: 'v2.0' });
  writeRoadmap(cwd, [
    '## v1.0 Planned',
    '',
    '### Phase 1: Foo',
    '',
    '## v2.0 Current 🚧',
  ].join('\n'));
  writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
  writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
}

// A COMPLETE-scope fixture whose disk-derived percent is a genuine 0 (empty
// milestone window, empty phases dir) — the over-withholding guard (rule 2
// negative space) for the WRITE path specifically.
function buildSyncCompleteZeroFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
  fs.mkdirSync(path.join(planningDirOf(cwd), 'phases'), { recursive: true });
}

// Appends a syncable body (STATE.md's frontmatter is already written by
// writeState/buildXFixture above) carrying a `Progress:` line that
// `state-transition.cts`'s syncCore can locate and, if warranted, replace —
// `stateExtractField`'s plain-line pattern (`^Progress:`). `initialPercent`
// lets a test start from a value distinguishable from both 0 and any
// fabricated disk-derived number.
function appendSyncableBody(cwd, initialPercent) {
  const statePath = path.join(planningDirOf(cwd), 'STATE.md');
  const existing = fs.readFileSync(statePath, 'utf-8');
  fs.writeFileSync(
    statePath,
    existing + [
      '',
      '# GSD State',
      '',
      '## Configuration',
      'Total Plans in Phase: 1',
      `Progress: [░░░░░░░░░░] ${initialPercent}`,
      'Last Activity: 2020-01-01',
      '',
    ].join('\n'),
  );
}

function stateSyncRaw(cwd) {
  const result = runGsdTools(['state', 'sync', '--cwd', cwd, '--raw'], cwd);
  assert.strictEqual(result.success, true, result.error);
  return JSON.parse(result.output);
}

describe('F. state sync (cmdStateSync) — BLOCKER: withhold on a non-COMPLETE scope, never fabricate', () => {
  test('F1: TRUNCATED window — no Progress rewrite, a skip entry appears in changes, body carries no fabricated percent', (t) => {
    const cwd = createTempDir('gsd-3217-f1-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixtureWithPhaseDir(cwd);
    appendSyncableBody(cwd, '0%');
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');

    const out = stateSyncRaw(cwd);
    assert.strictEqual(out.synced, true);
    assert.ok(
      out.changes.some((c) => /^Progress: skipped/.test(c) && /#3217/.test(c)),
      `expected a #3217 skip entry in changes, got: ${JSON.stringify(out.changes)}`,
    );
    assert.ok(
      !out.changes.some((c) => /^Progress: \[/.test(c)),
      `must not record a Progress bar rewrite, got: ${JSON.stringify(out.changes)}`,
    );

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Progress: [░░░░░░░░░░] 0%'), 'body Progress line must be untouched');
    assert.ok(!/100%/.test(after), 'must never fabricate 100% (the pre-fix defect: disk scan saw 1/1 complete)');
  });

  test('F2: UNSCOPED row 4 (no milestone asserted, ROADMAP has versioned headings) — same withholding', (t) => {
    const cwd = createTempDir('gsd-3217-f2-');
    t.after(() => cleanup(cwd));
    buildUnscopedRow4Fixture(cwd);
    appendSyncableBody(cwd, '0%');
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');

    const out = stateSyncRaw(cwd);
    assert.ok(
      out.changes.some((c) => /^Progress: skipped/.test(c) && /#3217/.test(c)),
      `expected a #3217 skip entry, got: ${JSON.stringify(out.changes)}`,
    );
    assert.ok(!out.changes.some((c) => /^Progress: \[/.test(c)));

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(after.includes('Progress: [░░░░░░░░░░] 0%'), 'body Progress line must be untouched');
    assert.ok(!/100%/.test(after), 'must never fabricate 100%');
  });

  test('F3: UNSCOPED row 5 (asserted version with no matching heading) — unchanged: the pre-existing #1761 guard still fires first', (t) => {
    const cwd = createTempDir('gsd-3217-f3-');
    t.after(() => cleanup(cwd));
    buildUnscopedFixture(cwd);
    appendSyncableBody(cwd, '0%');

    const out = stateSyncRaw(cwd);
    assert.ok(
      out.changes.some((c) => /^Progress: skipped/.test(c) && /#1761/.test(c)),
      `row 5 must still hit the pre-existing #1761 guard, got: ${JSON.stringify(out.changes)}`,
    );
    // The new #3217 gate is orthogonal and must never fire once #1761 already
    // skipped — only one skip entry should be recorded.
    assert.strictEqual(out.changes.filter((c) => /^Progress: skipped/.test(c)).length, 1);
    assert.ok(!out.changes.some((c) => /#3217/.test(c)));
  });

  test('F4: COMPLETE scope, genuine 0 — still WRITTEN (over-withholding guard)', (t) => {
    const cwd = createTempDir('gsd-3217-f4-');
    t.after(() => cleanup(cwd));
    buildSyncCompleteZeroFixture(cwd);
    appendSyncableBody(cwd, '100%');
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');

    const out = stateSyncRaw(cwd);
    assert.ok(
      out.changes.some((c) => /^Progress: .* -> \[░{10}\] 0%$/.test(c)),
      `expected a real 0% write, got: ${JSON.stringify(out.changes)}`,
    );
    assert.ok(!out.changes.some((c) => /^Progress: skipped/.test(c)), 'a COMPLETE scope must never skip');

    const after = fs.readFileSync(statePath, 'utf-8');
    assert.ok(/Progress: \[░{10}\] 0%/.test(after), 'body must carry the real 0%, not the stale 100%');
  });
});

describe('G. cross-surface — one non-COMPLETE fixture, ALL FIVE surfaces withhold (the assertion that would have caught the defect)', () => {
  test('G1: state sync / state json / roadmap analyze / stats / query progress all agree on withholding', (t) => {
    const cwd = createTempDir('gsd-3217-g1-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixtureWithPhaseDir(cwd);
    appendSyncableBody(cwd, '0%');
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');

    const syncOut = stateSyncRaw(cwd);
    const jsonOut = stateJsonRaw(cwd);
    const analyzed = analyzeRaw(cwd);
    const stats = statsRaw(cwd);
    const progress = queryProgressRaw(cwd);

    assert.ok(
      syncOut.changes.some((c) => /^Progress: skipped/.test(c)),
      'state sync must withhold (skip entry present)',
    );
    assert.ok(!syncOut.changes.some((c) => /^Progress: \[/.test(c)), 'state sync must not rewrite Progress');
    assert.ok(jsonOut.progress === undefined || !('percent' in jsonOut.progress), 'state json must withhold');
    assert.strictEqual(analyzed.progress_percent, null, 'roadmap analyze must withhold');
    assert.strictEqual(stats.percent, null, 'stats must withhold');
    assert.strictEqual(progress.percent, null, 'query progress must withhold');

    const afterSync = fs.readFileSync(statePath, 'utf-8');
    assert.ok(afterSync.includes('Progress: [░░░░░░░░░░] 0%'), 'body Progress line untouched by state sync');
    assert.ok(!/100%/.test(afterSync), 'state sync must never fabricate 100% on this fixture');
  });
});

describe('H. self-consistency — after state sync, STATE.md body and frontmatter never contradict each other', () => {
  test('H1: non-COMPLETE scope — body carries no fabricated percent AND frontmatter progress: carries no percent key', (t) => {
    const cwd = createTempDir('gsd-3217-h1-');
    t.after(() => cleanup(cwd));
    buildTruncatedFixtureWithPhaseDir(cwd);
    appendSyncableBody(cwd, '0%');
    const statePath = path.join(planningDirOf(cwd), 'STATE.md');

    stateSyncRaw(cwd);
    const after = fs.readFileSync(statePath, 'utf-8');

    // Body half: the Progress: bar line must still read 0%, never 100%.
    assert.ok(/Progress: \[░{10}\] 0%/.test(after), 'body Progress line must remain at 0%');

    // Frontmatter half: syncStateFrontmatter (called from writeStateMd on
    // every write, including this one) regenerates the YAML block via the
    // already-fixed buildStateFrontmatter — its progress: sub-block must
    // omit `percent` entirely on this non-COMPLETE fixture. Before this fix
    // the two halves could disagree within the SAME write: frontmatter
    // (already scoped) omitted percent while the body (hardcoded
    // SCOPE.COMPLETE) rendered one.
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
    const fmMatch = after.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, 'STATE.md must carry a frontmatter block after a write');
    assert.ok(!/^\s*percent:/m.test(fmMatch[1]), 'frontmatter progress: block must not carry a percent key');

    // The self-contradiction shape this test guards against: body renders a
    // percent while frontmatter's own progress: block has none (or vice
    // versa). Assert directly that no percent digit sequence beyond the
    // untouched-0% line's own "0%" appears anywhere else in the body.
    const percentTokens = after.match(/\d+%/g) || [];
    assert.deepStrictEqual(percentTokens, ['0%'], `no other percentage may appear anywhere in STATE.md, got: ${JSON.stringify(percentTokens)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// The guard — narrow syntactic check considered and DROPPED (documented)
// ═════════════════════════════════════════════════════════════════════════
//
// The design (`40-design.md`, "The guard") named one candidate narrow,
// syntactic structural check: a call to `listMilestonePhaseDirs(...)` whose
// `.value` is read while `.scope` is never bound in the same function. This
// was prototyped and REJECTED against the real tree: `src/milestone.cts` has
// three call sites (`~697`, `~753`, `~881`) that read only `.value` from
// `listMilestonePhaseDirs` — legitimately, because they use the directory
// list for milestone ARCHIVING, not percentage rendering, and have nothing to
// do with rule 3/4 at all. A purely syntactic "was `.scope` bound" check
// cannot distinguish "this consumer renders a percentage" from "this
// consumer does something else with the directory list" — exactly the
// false-positive class the design's own "guard" section predicts for a
// textual proxy over a data-flow property. Per this phase's explicit
// instruction ("if it produces false positives on the real tree, drop it and
// say so"), no such check was added to
// scripts/lint-completion-ratio-drift.cjs; the existing arithmetic-detection
// guard (rules 1-2) is unchanged, and this phase's real enforcement is the
// consumer-identity tests in sections A-C above (ADR Decision 4b/4c).

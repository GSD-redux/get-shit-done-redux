/**
 * Tests for the live-plan-counting single-owner contract (#3183, ADR-3180).
 *
 * Covers:
 *   - src/plan-scan.cts `scanPhasePlans` — plan/summary counting matrix,
 *     superseded-plan exclusion (#2349), root+nested layouts, exclusion
 *     filters (-OUTLINE.md, .pre-bounce.md, -PLAN-REVIEW.md), the additive
 *     `scope` field (COMPLETE/TRUNCATED/UNREADABLE).
 *   - src/planning-scope.cts `SCOPE` — frozen enum contract.
 *   - IDENTITY GUARD (ADR-3180 Decision 4c): core-utils.cts's
 *     `getPhaseFileStats` must return the EXACT `planFiles`/`summaryFiles`
 *     scanPhasePlans produced — asserted at the consumer's output, not the
 *     owner's return value, so a future local post-filter at the call site
 *     fails it. Also asserts `findUnsummarizedPlans` never disagrees with
 *     `summaryCount` for the same inputs.
 *
 * Uses helpers.cjs createTempDir/cleanup per CONTRIBUTING.md — never inline
 * mkdtemp. IO failure injection uses mock.method(fs, 'readdirSync', ...)
 * restored via t.after(), never fs.chmodSync (root bypasses 000 in Docker/CI).
 */

'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

function writeFile(dir, relName, content) {
  const full = path.join(dir, relName);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function planBody() {
  return ['# Plan', ''].join('\n');
}

function summaryBody() {
  return ['# Summary', ''].join('\n');
}

function frontmatterBlock(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '', '# Plan', '');
  return lines.join('\n');
}

// ─── Scenario matrix (rows 1-14) ──────────────────────────────────────────
// Reused by both the scanPhasePlans matrix tests below AND the identity-guard
// tests (rows 22-23), so the two suites can never see different fixtures.

const SCENARIOS = [
  {
    id: 'row1',
    label: 'root layout: 3 plans/3 summaries, none superseded',
    build(dir) {
      for (const n of ['01', '02', '03']) {
        writeFile(dir, `${n}-PLAN.md`, planBody());
        writeFile(dir, `${n}-SUMMARY.md`, summaryBody());
      }
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 3);
      assert.strictEqual(scan.summaryCount, 3);
      assert.strictEqual(scan.scope, SCOPE.COMPLETE);
    },
  },
  {
    id: 'row2',
    label: '1 of 3 plans has frontmatter status: superseded -> planCount 2',
    build(dir) {
      writeFile(dir, '01-PLAN.md', frontmatterBlock({ status: 'superseded' }));
      writeFile(dir, '02-PLAN.md', planBody());
      writeFile(dir, '03-PLAN.md', planBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 2);
    },
  },
  {
    id: 'row3',
    label: 'ALL plans superseded -> planCount 0 AND completed TRUE (#2349 invariant)',
    build(dir) {
      for (const n of ['01', '02', '03']) {
        writeFile(dir, `${n}-PLAN.md`, frontmatterBlock({ status: 'superseded' }));
      }
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 0);
      assert.strictEqual(scan.completed, true);
    },
  },
  {
    id: 'row4',
    label: 'zero plans authored -> planCount 0, completed FALSE, scope COMPLETE',
    build() { /* empty phase dir */ },
    check(scan) {
      assert.strictEqual(scan.planCount, 0);
      assert.strictEqual(scan.completed, false);
      assert.strictEqual(scan.scope, SCOPE.COMPLETE);
    },
  },
  {
    id: 'row5',
    label: 'exactly 1 plan (boundary limit)',
    build(dir) { writeFile(dir, '01-PLAN.md', planBody()); },
    check(scan) { assert.strictEqual(scan.planCount, 1); },
  },
  {
    id: 'row6',
    label: 'exactly 2 plans (boundary limit+1)',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, '02-PLAN.md', planBody());
    },
    check(scan) { assert.strictEqual(scan.planCount, 2); },
  },
  {
    id: 'row7',
    label: 'nested plans/PLAN-01.md ONLY -> planCount 1 (regression: used to report 0)',
    build(dir) { writeFile(dir, 'plans/PLAN-01.md', planBody()); },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.ok(scan.planFiles.includes('plans/PLAN-01.md'));
    },
  },
  {
    id: 'row8',
    label: 'mixed root + nested plans -> both counted, no double count',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, 'plans/PLAN-02.md', planBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 2);
      assert.deepEqual([...scan.planFiles].sort(), ['01-PLAN.md', 'plans/PLAN-02.md']);
    },
  },
  {
    id: 'row9',
    label: '-OUTLINE.md present -> NOT counted',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, '01-OUTLINE.md', planBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.ok(!scan.planFiles.includes('01-OUTLINE.md'));
    },
  },
  {
    id: 'row10',
    label: '.pre-bounce.md present -> NOT counted',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, '01-PLAN.pre-bounce.md', planBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.ok(!scan.planFiles.includes('01-PLAN.pre-bounce.md'));
    },
  },
  {
    id: 'row11',
    label: '-PLAN-REVIEW.md present -> NOT counted',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, '01-PLAN-REVIEW.md', planBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.ok(!scan.planFiles.includes('01-PLAN-REVIEW.md'));
    },
  },
  {
    id: 'row12',
    label: 'stray summary with no matching plan -> summaryCount excludes it',
    build(dir) {
      writeFile(dir, '01-PLAN.md', planBody());
      writeFile(dir, '01-SUMMARY.md', summaryBody());
      writeFile(dir, '99-GAPCLOSURE-SUMMARY.md', summaryBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.strictEqual(scan.summaryCount, 1);
    },
  },
  {
    id: 'row13',
    label: 'bare PLAN.md <-> SUMMARY.md pairing',
    build(dir) {
      writeFile(dir, 'PLAN.md', planBody());
      writeFile(dir, 'SUMMARY.md', summaryBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.strictEqual(scan.summaryCount, 1);
    },
  },
  {
    id: 'row14',
    label: 'nested PLAN-01.md <-> SUMMARY-01.md pairing',
    build(dir) {
      writeFile(dir, 'plans/PLAN-01.md', planBody());
      writeFile(dir, 'plans/SUMMARY-01.md', summaryBody());
    },
    check(scan) {
      assert.strictEqual(scan.planCount, 1);
      assert.strictEqual(scan.summaryCount, 1);
    },
  },
];

// ─── scanPhasePlans matrix (rows 1-14) ────────────────────────────────────

describe('scanPhasePlans — counting matrix (#3183 rows 1-14)', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: ${scenario.label}`, (t) => {
      const dir = createTempDir('gsd-plan-scan-');
      t.after(() => cleanup(dir));
      scenario.build(dir);
      const scan = planScan(dir);
      scenario.check(scan);
    });
  }
});

// ─── IDENTITY GUARD (rows 22-23, ADR-3180 Decision 4c) ────────────────────

describe('identity guard: getPhaseFileStats output === scanPhasePlans output (row 22)', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: getPhaseFileStats.plans/.summaries deep-equal scanPhasePlans.planFiles/.summaryFiles`, (t) => {
      const dir = createTempDir('gsd-plan-scan-identity-');
      t.after(() => cleanup(dir));
      scenario.build(dir);
      const scan = planScan(dir);
      const stats = coreUtils.getPhaseFileStats(dir);
      assert.deepEqual(stats.plans, scan.planFiles);
      assert.deepEqual(stats.summaries, scan.summaryFiles);
    });
  }
});

describe('identity guard: findUnsummarizedPlans length never disagrees with summaryCount (row 23)', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: findUnsummarizedPlans(...).length === planFiles.length - summaryCount`, (t) => {
      const dir = createTempDir('gsd-plan-scan-unsummarized-');
      t.after(() => cleanup(dir));
      scenario.build(dir);
      const scan = planScan(dir);
      const unsummarized = coreUtils.findUnsummarizedPlans(scan.planFiles, scan.summaryFiles);
      assert.strictEqual(unsummarized.length, scan.planFiles.length - scan.summaryCount);
    });
  }
});

// ─── Superseded frontmatter detection (rows 18-20) ────────────────────────

describe('isPlanSuperseded — frontmatter detection edge cases', () => {
  test('row18: uppercase SUPERSEDED with surrounding whitespace still detected', (t) => {
    const dir = createTempDir('gsd-plan-scan-');
    t.after(() => cleanup(dir));
    writeFile(dir, '01-PLAN.md', ['---', 'status:   SUPERSEDED  ', '---', '', '# Plan', ''].join('\n'));
    writeFile(dir, '02-PLAN.md', planBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 1);
    assert.ok(!scan.planFiles.includes('01-PLAN.md'));
  });

  test('row19: status: supersededX is NOT superseded (no prefix matching)', (t) => {
    const dir = createTempDir('gsd-plan-scan-');
    t.after(() => cleanup(dir));
    writeFile(dir, '01-PLAN.md', ['---', 'status: supersededX', '---', '', '# Plan', ''].join('\n'));
    writeFile(dir, '02-PLAN.md', planBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 2);
    assert.ok(scan.planFiles.includes('01-PLAN.md'));
  });

  test('row20: CRLF line endings in a superseded plan frontmatter still detected', (t) => {
    const dir = createTempDir('gsd-plan-scan-');
    t.after(() => cleanup(dir));
    writeFile(dir, '01-PLAN.md', ['---', 'status: superseded', '---', '', '# Plan', ''].join('\r\n'));
    writeFile(dir, '02-PLAN.md', planBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 1);
    assert.ok(!scan.planFiles.includes('01-PLAN.md'));
  });
});

// ─── scope field: UNREADABLE / TRUNCATED / COMPLETE independence (rows 15-17) ──

describe('scope field — UNREADABLE / TRUNCATED / COMPLETE independence', () => {
  test('row15: nonexistent phase dir -> scope UNREADABLE, planCount 0, getPhaseFileStats does not throw', () => {
    const base = createTempDir('gsd-plan-scan-');
    const missing = path.join(base, 'does-not-exist');
    try {
      const scan = planScan(missing);
      assert.strictEqual(scan.scope, SCOPE.UNREADABLE);
      assert.strictEqual(scan.planFiles.length, 0);
      assert.strictEqual(scan.planCount, 0);

      assert.doesNotThrow(() => coreUtils.getPhaseFileStats(missing));
      const stats = coreUtils.getPhaseFileStats(missing);
      assert.strictEqual(stats.scope, SCOPE.UNREADABLE);
      assert.deepEqual(stats.plans, []);
    } finally {
      cleanup(base);
    }
  });

  test('row16: plans/ exists but readdirSync on it throws -> scope TRUNCATED, root plans still returned', (t) => {
    const dir = createTempDir('gsd-plan-scan-');
    writeFile(dir, '01-PLAN.md', planBody());
    const nestedDir = path.join(dir, 'plans');
    fs.mkdirSync(nestedDir);
    const originalReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (p === nestedDir) throw new Error('EACCES: permission denied, scandir plans/');
      return originalReaddirSync.call(fs, p, ...rest);
    });
    t.after(() => {
      mock.restoreAll();
      cleanup(dir);
    });

    const scan = planScan(dir);
    assert.strictEqual(scan.scope, SCOPE.TRUNCATED);
    assert.deepEqual(scan.planFiles, ['01-PLAN.md']);
  });

  test('row17: zero plans AND dir readable -> scope COMPLETE, assertably different from row16 TRUNCATED', (t) => {
    // Same zero planFiles.length as row16, but readable — must diverge in scope.
    const readableEmptyDir = createTempDir('gsd-plan-scan-');
    const truncatedDir = createTempDir('gsd-plan-scan-');
    const nestedDir = path.join(truncatedDir, 'plans');
    fs.mkdirSync(nestedDir);
    const originalReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (p === nestedDir) throw new Error('EACCES: permission denied, scandir plans/');
      return originalReaddirSync.call(fs, p, ...rest);
    });
    t.after(() => {
      mock.restoreAll();
      cleanup(readableEmptyDir);
      cleanup(truncatedDir);
    });

    const completeScan = planScan(readableEmptyDir);
    const truncatedScan = planScan(truncatedDir);

    assert.strictEqual(completeScan.planFiles.length, 0);
    assert.strictEqual(truncatedScan.planFiles.length, 0);
    assert.strictEqual(completeScan.scope, SCOPE.COMPLETE);
    assert.strictEqual(truncatedScan.scope, SCOPE.TRUNCATED);
    assert.notStrictEqual(completeScan.scope, truncatedScan.scope);
  });
});

// ─── Case sensitivity: plan.md/Plan.md vs summary.md/Summary.md (#3183) ───
//
// isRootPlanFile (src/plan-scan.cts) has a loose fallback —
// `/\.md$/i.test(f) && /PLAN/i.test(f)` — that is case-INSENSITIVE, so
// `plan.md`/`Plan.md` count as plans even though neither matches the
// canonical `-PLAN.md`/`PLAN.md` suffix exactly. isRootSummaryFile has no
// such fallback — `f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md'` is
// case-SENSITIVE — so `summary.md`/`Summary.md` do NOT count as summaries.
// This asymmetry is INTENTIONAL (the loose plan fallback is the point of
// consolidating onto the single owner; summary detection was never given
// the same fallback) — these tests pin the current behavior at both
// altitudes (scanPhasePlans and getPhaseFileStats) so a future change to
// either rule is caught rather than silently drifting.
describe('case sensitivity: plan.md/Plan.md counted, summary.md/Summary.md NOT (#3183 asymmetry)', () => {
  test('lowercase plan.md is counted as a plan (loose /PLAN/i fallback is case-insensitive)', (t) => {
    const dir = createTempDir('gsd-plan-scan-case-');
    t.after(() => cleanup(dir));
    writeFile(dir, 'plan.md', planBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 1);
    assert.ok(scan.planFiles.includes('plan.md'));

    const stats = coreUtils.getPhaseFileStats(dir);
    assert.ok(stats.plans.includes('plan.md'));
  });

  test('mixed-case Plan.md is counted as a plan (loose /PLAN/i fallback is case-insensitive)', (t) => {
    const dir = createTempDir('gsd-plan-scan-case-');
    t.after(() => cleanup(dir));
    writeFile(dir, 'Plan.md', planBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 1);
    assert.ok(scan.planFiles.includes('Plan.md'));

    const stats = coreUtils.getPhaseFileStats(dir);
    assert.ok(stats.plans.includes('Plan.md'));
  });

  test('lowercase summary.md is NOT counted as a summary (isRootSummaryFile is case-sensitive)', (t) => {
    const dir = createTempDir('gsd-plan-scan-case-');
    t.after(() => cleanup(dir));
    writeFile(dir, '01-PLAN.md', planBody());
    writeFile(dir, 'summary.md', summaryBody());
    const scan = planScan(dir);
    assert.ok(!scan.summaryFiles.includes('summary.md'));
    // Not swept in as a plan either — no "PLAN" substring.
    assert.ok(!scan.planFiles.includes('summary.md'));

    const stats = coreUtils.getPhaseFileStats(dir);
    assert.ok(!stats.summaries.includes('summary.md'));
  });

  test('mixed-case Summary.md is NOT counted as a summary (isRootSummaryFile is case-sensitive)', (t) => {
    const dir = createTempDir('gsd-plan-scan-case-');
    t.after(() => cleanup(dir));
    writeFile(dir, '01-PLAN.md', planBody());
    writeFile(dir, 'Summary.md', summaryBody());
    const scan = planScan(dir);
    assert.ok(!scan.summaryFiles.includes('Summary.md'));
    assert.ok(!scan.planFiles.includes('Summary.md'));

    const stats = coreUtils.getPhaseFileStats(dir);
    assert.ok(!stats.summaries.includes('Summary.md'));
  });
});

// ─── SCOPE frozen enum contract (row 21) ──────────────────────────────────

describe('SCOPE — frozen enum contract', () => {
  test('row21: Object.isFrozen(SCOPE) is true, and assigning to a member does not change it', () => {
    assert.strictEqual(Object.isFrozen(SCOPE), true);
    const before = SCOPE.COMPLETE;
    const assigned = Reflect.set(SCOPE, 'COMPLETE', 'mutated-value');
    assert.strictEqual(assigned, false);
    assert.strictEqual(SCOPE.COMPLETE, before);
  });
});

// ─── summaryCandidates canonical-id coverage (#3183 I001 regression) ──────
//
// The pre-migration bespoke I001 rule (verify.cts, pre-#3183) matched a plan
// carrying a descriptive slug after its <phase>-<plan> id — e.g.
// `68-01-scaffolding-PLAN.md` — against a summary named only by the bare id
// — `68-01-SUMMARY.md` — via `canonicalPlanStem` (validate.cjs). The
// consolidation onto the single `summaryCandidates` rule in core-utils.cts
// (used by countMatchedSummaries / findUnsummarizedPlans / findOrphanSummaries)
// dropped that candidate, causing 13 remote-runner failures (health-validation
// and phase test suites) — a live-scaffolding-style plan with a matching
// bare-id SUMMARY was misreported as unsummarized. These tests pin the
// restored candidate at both altitudes: the pure core-utils functions AND
// scanPhasePlans's real-directory integration.
describe('summaryCandidates canonical-id form — long PLAN stem matches short SUMMARY stem (#3183)', () => {
  test('68-01-scaffolding-PLAN.md pairs with 68-01-SUMMARY.md: countMatchedSummaries/findUnsummarizedPlans agree', () => {
    const plans = ['68-01-scaffolding-PLAN.md'];
    const summaries = ['68-01-SUMMARY.md'];
    assert.strictEqual(coreUtils.countMatchedSummaries(plans, summaries), 1);
    assert.deepEqual(coreUtils.findUnsummarizedPlans(plans, summaries), []);
    assert.deepEqual(coreUtils.findOrphanSummaries(plans, summaries), []);
  });

  test('same pairing, real directory: scanPhasePlans + validate health emit zero I001', (t) => {
    const dir = createTempDir('gsd-plan-count-i001-');
    t.after(() => cleanup(dir));
    writeFile(dir, '68-01-scaffolding-PLAN.md', frontmatterBlock({ wave: 1 }));
    writeFile(dir, '68-01-SUMMARY.md', summaryBody());
    const scan = planScan(dir);
    assert.strictEqual(scan.planCount, 1);
    assert.strictEqual(scan.summaryCount, 1);
    assert.strictEqual(scan.completed, true);
    assert.deepEqual(coreUtils.findUnsummarizedPlans(scan.planFiles, scan.summaryFiles), []);
  });

  test('COLLISION: two plans sharing one canonical id (differing only by slug) both pair to the ' +
    'SAME single summary — reproduces the pre-migration bespoke rule\'s own collapsing behavior, ' +
    'not a new regression (the old rule populated one Set keyed by canonical stem with no ' +
    'cardinality check)', () => {
    const plans = ['68-01-alpha-PLAN.md', '68-01-beta-PLAN.md'];
    const summaries = ['68-01-SUMMARY.md'];
    // Both plans read as summarized off the one shared summary.
    assert.deepEqual(coreUtils.findUnsummarizedPlans(plans, summaries), []);
    // countMatchedSummaries counts per-plan matches, so it double-counts the
    // single summary here (2), not the number of distinct summary files (1) —
    // same modeling limit as the pre-migration rule, preserved intentionally.
    assert.strictEqual(coreUtils.countMatchedSummaries(plans, summaries), 2);
    assert.deepEqual(coreUtils.findOrphanSummaries(plans, summaries), []);
  });

  test('NEGATIVE: a plan whose canonical stem has no matching summary is still reported unsummarized', () => {
    const plans = ['68-02-other-PLAN.md'];
    const summaries = ['68-01-SUMMARY.md'];
    assert.deepEqual(coreUtils.findUnsummarizedPlans(plans, summaries), ['68-02-other-PLAN.md']);
    assert.strictEqual(coreUtils.countMatchedSummaries(plans, summaries), 0);
  });

  test('narrowing: a plan whose base has no extractable <id>-<id> pair does not gain a redundant ' +
    'candidate (canonicalId falls back to the plain base, already covered by the <stem>-SUMMARY.md ' +
    'candidate)', () => {
    const plans = ['setup-PLAN.md'];
    const summaries = ['setup-SUMMARY.md'];
    assert.strictEqual(coreUtils.countMatchedSummaries(plans, summaries), 1);
    assert.deepEqual(coreUtils.findUnsummarizedPlans(plans, summaries), []);
  });
});

// ─── #2893 regression: non-canonical plan filenames must stay non-canonical
//     when routed through scanPhasePlans's live-plan set (find-phase /
//     phase-plan-index / phases list --type plans naming diagnostic) ──────
//
// scanPhasePlans's `isRootPlanFile` loose `/PLAN/i` fallback is deliberately
// permissive for live-plan COUNTING (see the case-sensitivity describe block
// above). Routing phase.cts's #2893 naming-convention diagnostic through
// `allPlanFiles`/`planFiles` directly (the #3183 migration's first pass) let
// that loose fallback silently recognize a non-canonically-named file (e.g.
// the reporter's own `01-PLAN-01-foundation.md`) as a valid, already-matched
// plan — defeating the diagnostic (no warning, offender listed as if valid).
// `isCanonicalPlanFile` is the strict predicate those three call sites now
// intersect against. Pinned here at the predicate level; the CLI-level
// behavior is covered by tests/phase.test.cjs's `(#2893 parity)` suite.
describe('isCanonicalPlanFile — strict predicate excludes the loose /PLAN/i fallback (#2893 regression)', () => {
  test('root canonical forms match', () => {
    assert.strictEqual(planScan.isCanonicalPlanFile('03-01-PLAN.md'), true);
    assert.strictEqual(planScan.isCanonicalPlanFile('PLAN.md'), true);
  });

  test('nested canonical forms match only when plans/-prefixed', () => {
    assert.strictEqual(planScan.isCanonicalPlanFile('plans/PLAN-01.md'), true);
    assert.strictEqual(planScan.isCanonicalPlanFile('plans/03-PLAN-01-foo.md'), true);
  });

  test('the #2893 reporter\'s exact non-canonical example does NOT match at root level, even though ' +
    'its basename shape collides with the nested-form regex', () => {
    assert.strictEqual(planScan.isCanonicalPlanFile('01-PLAN-01-foundation.md'), false);
    assert.strictEqual(planScan.isCanonicalPlanFile('01-PLAN-02-api.md'), false);
  });

  test('loose-fallback-only root matches (lowercase plan.md) do NOT satisfy the strict predicate', () => {
    assert.strictEqual(planScan.isCanonicalPlanFile('plan.md'), false);
    assert.strictEqual(planScan.isCanonicalPlanFile('Plan.md'), false);
  });
});

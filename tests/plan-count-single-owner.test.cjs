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
const { execFileSync } = require('node:child_process');

const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const drift = require('../scripts/lint-plan-count-drift.cjs');

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

// ─── findRegexLiteralMdMatch — literal tokenizer regression
// (scripts/lint-plan-count-drift.cjs)
//
// The scanner's "unquoted regex literal that mentions PLAN/SUMMARY and \.md"
// detector used to be a single backtracking regex (REGEX_LITERAL_MD_RE). An
// independent security review found it was STILL defective after a prior
// backslash-exclusion fix: it was cubic (not just exponential) on
// `"/" + "PLAN\\.md".repeat(N)` with no closing `/`, and it structurally
// could not see a character class containing a BARE, unescaped `/` between
// the PLAN/SUMMARY token and `\.md` (e.g. `/SUMMARY[^/]*\.md$/`) — the old
// regex treated that `/` as the literal's terminator and stopped scanning
// before ever reaching `\.md`, silently missing real re-derivation shapes.
// A class holding an ESCAPED `\/` (e.g. `/PLAN[\\/].*\.md$/`) was already
// matched by the old regex's `\\.` alternative, so those shapes are parity
// coverage, not regressions. Both genuine defects share one root cause:
// regex-literal grammar (escapes, and `/` inside `[...]` not terminating) is
// not expressible in a backtracking regex. The fix replaces it with
// `readRegexLiteralAt`/`findRegexLiteralMdMatch`, a deterministic
// single-pass tokenizer with no backtracking at all.
describe('findRegexLiteralMdMatch — literal tokenizer (ReDoS + character-class regression)', () => {
  test('findPlanCountDrift completes on backslash-dense and repetition-dense lines (ReDoS regression)', (t) => {
    // Catastrophic backtracking is synchronous and cannot be interrupted
    // in-process — a hang here would freeze the whole suite instead of
    // failing this one test. Spawn a child process with a hard timeout.
    // Exercises BOTH pathological shapes the old regex blew up on:
    //   - exponential: `/\.mdplan` + `\.`.repeat(reps) + `X` (no closing `/`)
    //     at reps 24 / 28 / 32;
    //   - cubic: `/` + `PLAN\.md`.repeat(reps) + ` ` (no closing `/`) at reps
    //     400 / 800 / 1600.
    // These are GROWTH-RATE samples, deliberately doubling, not limit-1/limit/
    // limit+1 boundary coverage — there is no limit here to sit either side
    // of, and under the old regex each step multiplied the runtime (~2x per
    // rep exponential, ~8x per doubling cubic) so a tokenizer that had
    // silently regressed to backtracking blows the child's timeout at the top
    // of either ladder. The one real numeric limit in this module,
    // MAX_REGEX_LITERAL_LEN, gets true limit-1/limit/limit+1 coverage in the
    // readRegexLiteralAt test below.
    const dir = createTempDir('gsd-plan-count-drift-redos-');
    t.after(() => cleanup(dir));

    const guardPath = path.join(__dirname, '..', 'scripts', 'lint-plan-count-drift.cjs');
    const childPath = path.join(dir, 'probe.cjs');
    const childSource = [
      "'use strict';",
      "const { findPlanCountDrift } = require(process.argv[2]);",
      "for (const reps of [24, 28, 32]) {",
      "  const attack = '\\\\.'.repeat(reps);",
      "  const line = `const RE = /\\\\.mdplan${attack}X; names.filter(n => RE.test(n));`;",
      "  findPlanCountDrift(line, 'src/probe.cts');",
      "}",
      "for (const reps of [400, 800, 1600]) {",
      "  const attack = 'PLAN\\\\.md'.repeat(reps);",
      "  const line = `const RE = /${attack} ; names.filter(n => RE.test(n));`;",
      "  findPlanCountDrift(line, 'src/probe.cts');",
      "}",
      "process.stdout.write('done');",
    ].join('\n');
    fs.writeFileSync(childPath, childSource);

    try {
      const output = execFileSync(process.execPath, [childPath, guardPath], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      assert.strictEqual(output, 'done');
    } catch (err) {
      // `code === 'ETIMEDOUT'` is the canonical execFileSync timeout signal;
      // on darwin the kill yields signal 'SIGTERM' with `killed` undefined,
      // so all three are checked rather than relying on any one platform's
      // spelling.
      if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' || err.killed) {
        assert.fail(
          'findPlanCountDrift did not complete within PROBE_TIMEOUT_MS: the child probe ' +
            'process was killed instead of exiting. Catastrophic backtracking (ReDoS) in ' +
            'the literal tokenizer is the expected cause; an externally killed child would ' +
            'also land here.',
        );
      }
      throw err;
    }
  });

  test('findRegexLiteralMdMatch semantics: matches genuine plan/summary literals, ' +
    'catches path-separator character-class shapes, rejects near-misses and attack lines', () => {
    const matchOf = (line) => drift.findRegexLiteralMdMatch(line);

    // Positive: genuine plan/summary regex literals must still match.
    assert.strictEqual(
      matchOf("if (/-PLAN\\.md$/.test(name)) return true;"),
      '/-PLAN\\.md$/',
    );
    assert.strictEqual(
      matchOf('names.filter((n) => /^PLAN-\\d+.*\\.md$/i.test(n));'),
      '/^PLAN-\\d+.*\\.md$/i',
    );
    assert.strictEqual(
      matchOf('names.filter((n) => /-SUMMARY-\\d+.*\\.md$/i.test(n));'),
      '/-SUMMARY-\\d+.*\\.md$/i',
    );
    assert.strictEqual(
      matchOf('names.filter((n) => /\\.md.*SUMMARY/.test(n));'),
      '/\\.md.*SUMMARY/',
    );

    // Character classes containing an ESCAPED `\/` pair. The old backtracking
    // regex also matched these (its `\\.` alternative consumed the `\/`), so
    // they are NOT regression cases — they are parity coverage proving the
    // tokenizer did not LOSE behaviour when it replaced the regex.
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /PLAN[\\/].*\.md$/.test(f));`),
      String.raw`/PLAN[\\/].*\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /PLAN[\\/]\d+\.md$/.test(f));`),
      String.raw`/PLAN[\\/]\d+\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /SUMMARY[\\/][^x]*\.md$/.test(f));`),
      String.raw`/SUMMARY[\\/][^x]*\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /\.md[\\/]SUMMARY/.test(f));`),
      String.raw`/\.md[\\/]SUMMARY/`,
    );

    // Character classes containing a BARE, UNESCAPED `/`. These are the real
    // regression cases: the old regex treated that `/` as the literal's
    // terminator, so it stopped scanning before reaching `\.md` and MISSED
    // every one of them — verified against the parent-commit blob, where all
    // four return null. A guard that cannot see `/SUMMARY[^/]*\.md$/` is
    // blind to an ordinary path-excluding filter.
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /PLAN[/\\].*\.md$/.test(f));`),
      String.raw`/PLAN[/\\].*\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /PLAN[a/b]\.md$/.test(f));`),
      String.raw`/PLAN[a/b]\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /SUMMARY[^/]*\.md$/.test(f));`),
      String.raw`/SUMMARY[^/]*\.md$/`,
    );
    assert.strictEqual(
      matchOf(String.raw`files.filter(f => /PLAN[/]\.md$/.test(f));`),
      String.raw`/PLAN[/]\.md$/`,
    );

    // Positive: an escaped slash (`\/`) inside the literal must not
    // terminate it early — the whole literal is returned, not a truncated
    // fragment up to the escaped `/`.
    assert.strictEqual(
      matchOf(String.raw`names.filter(n => /PLAN\/\d+\.md$/.test(n));`),
      String.raw`/PLAN\/\d+\.md$/`,
    );

    // Negative: \.md with no PLAN/SUMMARY token in the literal.
    assert.strictEqual(matchOf('names.filter((n) => /\\.md$/.test(n));'), null);
    // Negative: PLAN with no escaped \.md token in the literal.
    assert.strictEqual(matchOf('names.filter((n) => /PLAN/.test(n));'), null);
    // Negative: the backslash-dense ReDoS attack construction (no closing
    // `/`, so the literal never resolves).
    const attack = '\\.'.repeat(8);
    const attackLine = `const RE = /\\.mdplan${attack}X; names.filter(n => RE.test(n));`;
    assert.strictEqual(matchOf(attackLine), null);
  });

  // Direct coverage of readRegexLiteralAt — the tokenizer's single-pass
  // scan primitive. Replaces the deleted `!source.includes('[^/')`
  // structural check, which was a gameable substring test (respelling the
  // class as `[^\r\n/]` would still pass it while remaining exponential)
  // inspecting a constant (REGEX_LITERAL_MD_RE) that no longer exists.
  describe('readRegexLiteralAt', () => {
    test('an unterminated literal (no closing `/`) returns null', () => {
      assert.strictEqual(
        drift.readRegexLiteralAt('/PLAN and no closing slash at all', 0),
        null,
      );
    });

    test('MAX_REGEX_LITERAL_LEN boundary: limit-1 reads, limit reads, limit+1 returns null', () => {
      // Derived from the exported constant so the boundary cannot silently
      // drift from it (a missing/undefined export must fail loudly, not
      // vacuously pass a boundary computed from `undefined`).
      const MAX = drift.MAX_REGEX_LITERAL_LEN;
      assert.ok(Number.isInteger(MAX) && MAX > 10, `MAX_REGEX_LITERAL_LEN must be exported as an integer > 10, got ${MAX}`);

      // Total literal length (both delimiters included) = contentLen + 2.
      const build = (contentLen) => '/' + 'a'.repeat(contentLen) + '/';
      const underBound = build(MAX - 3); // total length MAX-1 — limit-1
      const atBound = build(MAX - 2); // total length MAX — limit (MAX_REGEX_LITERAL_LEN)
      const overBound = build(MAX - 1); // total length MAX+1 — limit+1

      assert.strictEqual(drift.readRegexLiteralAt(underBound, 0)?.text, underBound);
      assert.strictEqual(drift.readRegexLiteralAt(atBound, 0)?.text, atBound);
      assert.strictEqual(drift.readRegexLiteralAt(overBound, 0), null);
    });

    test('a `/` inside a `[...]` character class does not terminate the literal', () => {
      const line = '/a[/]b/';
      assert.strictEqual(drift.readRegexLiteralAt(line, 0)?.text, line);
    });

    test('an escaped `\\/` does not terminate the literal', () => {
      const line = String.raw`/a\/b/`;
      assert.strictEqual(drift.readRegexLiteralAt(line, 0)?.text, line);
    });

    test('trailing flags are included in the returned literal text', () => {
      const line = '/foo/gi';
      assert.strictEqual(drift.readRegexLiteralAt(line, 0)?.text, line);
    });
  });

  // scanRepo's `walk` follows symlinks (via fs.statSync) to close the
  // Dirent-classification evasion documented at `walk`'s definition, which
  // means it must also confine itself to the repo root — an unconfined
  // symlink follow would let a fork PR read and leak arbitrary files outside
  // the repo into the CI-log report. `{ skip }` mirrors the win32 symlink
  // guard used elsewhere in this repo (tests/phase.test.cjs) — symlink
  // creation needs elevated privilege on Windows CI runners.
  describe('walk — symlink handling and root confinement', () => {
    const skip = process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false;

    function violatingLine() {
      return "module.exports.isPlan = (f) => f.endsWith('-PLAN.md');\n";
    }

    test('(a) a symlinked .cts INSIDE the root IS scanned, reported under its canonical real path', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      t.after(() => cleanup(root));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
      const realFile = path.join(root, 'vendor', 'real-target.cts');
      fs.writeFileSync(realFile, violatingLine());
      fs.symlinkSync(realFile, path.join(root, 'src', 'linked.cts'));

      const violations = drift.scanRepo(root);
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].file, path.join('vendor', 'real-target.cts'));
    });

    test('(b) a symlinked .cts pointing OUTSIDE the root is NOT scanned: zero violations reported', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      const outside = createTempDir('gsd-plan-count-drift-outside-');
      t.after(() => cleanup(root));
      t.after(() => cleanup(outside));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const outsideFile = path.join(outside, 'evil.cts');
      fs.writeFileSync(outsideFile, violatingLine());
      fs.symlinkSync(outsideFile, path.join(root, 'src', 'evil.cts'));

      const violations = drift.scanRepo(root);
      assert.strictEqual(violations.length, 0);
    });

    test('(c) a directory symlink pointing OUTSIDE the root is not descended into', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      const outside = createTempDir('gsd-plan-count-drift-outside-');
      t.after(() => cleanup(root));
      t.after(() => cleanup(outside));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const outsideDir = path.join(outside, 'dir');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'evil.cts'), violatingLine());
      fs.symlinkSync(outsideDir, path.join(root, 'src', 'outdir'), 'dir');

      const violations = drift.scanRepo(root);
      assert.strictEqual(violations.length, 0);
    });

    test('(d) a symlink CYCLE terminates rather than recursing forever, and dedupes the real file', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      t.after(() => cleanup(root));
      const srcDir = path.join(root, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'real.cts'), violatingLine());
      fs.symlinkSync(srcDir, path.join(srcDir, 'loop'), 'dir');

      const violations = drift.scanRepo(root);
      assert.strictEqual(violations.filter((v) => v.file === path.join('src', 'real.cts')).length, 1);
    });

    test('(e) a BROKEN symlink is skipped without throwing', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      t.after(() => cleanup(root));
      const srcDir = path.join(root, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.symlinkSync(path.join(srcDir, '.does-not-exist.cts'), path.join(srcDir, 'broken.cts'));

      assert.doesNotThrow(() => drift.scanRepo(root));
      assert.strictEqual(drift.scanRepo(root).length, 0);
    });

    test('(f) two symlinks inside the root to the SAME real file yield ONE entry, not two', { skip }, (t) => {
      const root = createTempDir('gsd-plan-count-drift-root-');
      t.after(() => cleanup(root));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
      const realFile = path.join(root, 'vendor', 'shared-target.cts');
      fs.writeFileSync(realFile, violatingLine());
      fs.symlinkSync(realFile, path.join(root, 'src', 'link1.cts'));
      fs.symlinkSync(realFile, path.join(root, 'src', 'link2.cts'));

      const violations = drift.scanRepo(root);
      assert.strictEqual(violations.length, 1);
      assert.strictEqual(violations[0].file, path.join('vendor', 'shared-target.cts'));
    });
  });
});

// Direct coverage of isInsideRoot — a reviewer mutating its body to a bare
// `realPath.startsWith(realRoot)` left every existing test above still
// passing, because none of those temp fixtures ever produce a SIBLING
// directory sharing the root's name as a strict prefix. This describe closes
// that gap so the mutant is actually killed (relevant to the repo's 80%
// Stryker mutation gate).
describe('isInsideRoot', () => {
  test('the root itself is inside', () => {
    const root = path.join(path.sep, 'tmp', 'repo');
    assert.strictEqual(drift.isInsideRoot(root, root), true);
  });

  test('a child path is inside', () => {
    const root = path.join(path.sep, 'tmp', 'repo');
    const child = path.join(root, 'src', 'file.cts');
    assert.strictEqual(drift.isInsideRoot(child, root), true);
  });

  test('a SIBLING whose name is the root plus a suffix is NOT inside', () => {
    // This is the case that kills the `startsWith(realRoot)` mutant: a bare
    // prefix check wrongly admits `/tmp/repo-evil/x.cts` as "inside"
    // `/tmp/repo`, because the string "/tmp/repo-evil/x.cts" does start with
    // the string "/tmp/repo". The real implementation requires an exact
    // match or a root+separator prefix, so this must be rejected.
    const root = path.join(path.sep, 'tmp', 'repo');
    const sibling = path.join(path.sep, 'tmp', 'repo-evil', 'x.cts');
    assert.strictEqual(drift.isInsideRoot(sibling, root), false);
  });

  test('a parent path is not inside', () => {
    const root = path.join(path.sep, 'tmp', 'repo', 'src');
    const parent = path.join(path.sep, 'tmp', 'repo');
    assert.strictEqual(drift.isInsideRoot(parent, root), false);
  });

  test('an unrelated absolute path is not inside', () => {
    const root = path.join(path.sep, 'tmp', 'repo');
    const unrelated = path.join(path.sep, 'var', 'other', 'x.cts');
    assert.strictEqual(drift.isInsideRoot(unrelated, root), false);
  });
});

// Direct coverage of sanitizeForReport — both a matched `found` fragment and
// a reported file path are attacker-controlled source text on a fork PR, and
// both are written straight to a CI log; this asserts the escaping contract
// documented at the function's definition (C0/C1 control bytes plus the
// listed bidi/line-separator/zero-width codepoints), and that ordinary
// printable text — including the regex-literal punctuation this module
// itself tokenizes — passes through completely unchanged.
describe('sanitizeForReport', () => {
  test('escapes a C0 control byte (ESC 0x1b)', () => {
    assert.strictEqual(drift.sanitizeForReport(String.fromCharCode(0x1b)), '\\x1b');
  });

  test('escapes DEL (0x7f)', () => {
    assert.strictEqual(drift.sanitizeForReport(String.fromCharCode(0x7f)), '\\x7f');
  });

  test('escapes a C1 byte (0x9b)', () => {
    assert.strictEqual(drift.sanitizeForReport(String.fromCharCode(0x9b)), '\\x9b');
  });

  test('escapes ZERO WIDTH SPACE (U+200B)', () => {
    assert.strictEqual(drift.sanitizeForReport('\u200B'), '\\u200b');
  });

  test('escapes LINE SEPARATOR (U+2028)', () => {
    assert.strictEqual(drift.sanitizeForReport('\u2028'), '\\u2028');
  });

  test('escapes PARAGRAPH SEPARATOR (U+2029)', () => {
    assert.strictEqual(drift.sanitizeForReport('\u2029'), '\\u2029');
  });

  test('escapes RIGHT-TO-LEFT OVERRIDE (U+202E)', () => {
    assert.strictEqual(drift.sanitizeForReport('\u202E'), '\\u202e');
  });

  test('ordinary printable text, including regex-literal punctuation, is unchanged', () => {
    const text = String.raw`/-PLAN\.md$/i names.filter([].$^*+ )`;
    assert.strictEqual(drift.sanitizeForReport(text), text);
  });
});

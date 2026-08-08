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

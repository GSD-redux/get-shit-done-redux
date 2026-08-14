/**
 * Tests for SUMMARY-frontmatter-status-aware plan completion (#3345).
 *
 * Before #3345, both completion readers paired PLAN↔SUMMARY by FILENAME
 * EXISTENCE only: `scanPhasePlans`'s `summaryCount`/`completed`
 * (src/plan-scan.cts, via core-utils `countMatchedSummaries`) and
 * `phase-plan-index`'s `has_summary`/`incomplete` (src/phase.cts, via
 * core-utils `findUnsummarizedPlans`) never opened a SUMMARY file, so a
 * SUMMARY declaring `status: blocked` counted as a completed plan in STATE.md
 * progress counters AND was omitted from phase-plan-index's `incomplete` list.
 *
 * This suite pins the #3345 contract:
 *   - a SUMMARY whose frontmatter `status:` is `blocked` is NOT a completion
 *     record (count side: not counted; read side: has_summary false, lands in
 *     `incomplete`);
 *   - filename existence stays the fallback when the SUMMARY carries no
 *     `status` key (untouched projects are byte-for-behaviour unchanged);
 *   - `status: halted` STAYS counted — #2830's designed-stop model (a halt
 *     still writes a completion record; dependents get `blocked_by`
 *     propagation) is deliberately preserved;
 *   - PARITY GUARD (Generative Fix Divergence convention): the count side and
 *     the read side must filter their summary lists through the ONE shared
 *     predicate (`plan-dependency-graph.cjs`'s `isSummaryFileBlocked`), so the
 *     two can never re-diverge on this rule;
 *   - fail-open: an unreadable SUMMARY degrades to the pre-#3345
 *     filename-existence behaviour, never throws.
 *
 * Uses helpers.cjs createTempProject/cleanup per CONTRIBUTING.md and the
 * process-seam-backed runGsdTools for the CLI-level assertions.
 */

'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { join } = path;

function tempDir(prefix) {
  return fs.mkdtempSync(join(os.tmpdir(), prefix));
}

const planScan = require('../gsd-core/bin/lib/plan-scan.cjs');
const planDependencyGraph = require('../gsd-core/bin/lib/plan-dependency-graph.cjs');
const coreUtils = require('../gsd-core/bin/lib/core-utils.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function planBody() {
  return '# Plan\n';
}

function summaryWithStatus(status) {
  return status === undefined
    ? '# Summary\n'
    : `---\nstatus: ${status}\n---\n\n# Summary\n`;
}

function writePhase(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(join(dir, name), content);
  }
}

// ─── isBlockedStatus unit (the one place "blocked" is decided) ─────────────

describe('#3345 isBlockedStatus — truthtable', () => {
  test('matches exactly the blocked spelling, case/whitespace/comment tolerant', () => {
    const { isBlockedStatus } = planDependencyGraph;
    assert.equal(typeof isBlockedStatus, 'function', 'isBlockedStatus must be exported');
    assert.equal(isBlockedStatus('blocked'), true);
    assert.equal(isBlockedStatus('Blocked'), true);
    assert.equal(isBlockedStatus('  BLOCKED  '), true);
    // Unquoted trailing YAML comment (same #2830 review defect-2 rule as isHaltedStatus).
    assert.equal(isBlockedStatus('blocked # waiting on upstream'), true);
    assert.equal(isBlockedStatus('halted'), false, 'halted is NOT blocked (designed stop)');
    assert.equal(isBlockedStatus('complete'), false);
    assert.equal(isBlockedStatus('superseded'), false);
    assert.equal(isBlockedStatus('blocked#nospace'), false, 'no-whitespace # is not a YAML comment');
    assert.equal(isBlockedStatus(undefined), false);
    assert.equal(isBlockedStatus(42), false);
    assert.equal(isBlockedStatus(null), false);
  });
});

// ─── scanPhasePlans: the count side ────────────────────────────────────────

describe('#3345 scanPhasePlans — blocked SUMMARY is not a completion record', () => {
  test('status: blocked SUMMARY -> summaryCount 0, completed false', () => {
    const dir = tempDir('gsd-3345-blocked-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
      });
      const scan = planScan(dir);
      assert.equal(scan.planCount, 1);
      assert.equal(scan.summaryCount, 0, 'blocked SUMMARY must not count as a completion record');
      assert.equal(scan.completed, false, 'a blocked plan must not read as phase-complete');
      // The on-disk list is untouched — callers that list summaries still see the file.
      assert.deepEqual(scan.summaryFiles, ['01-01-SUMMARY.md']);
    } finally {
      cleanup(dir);
    }
  });

  test('no status key -> filename-existence fallback, counted exactly as before', () => {
    const dir = tempDir('gsd-3345-nostatus-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus(undefined),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('status: complete SUMMARY -> counted', () => {
    const dir = tempDir('gsd-3345-complete-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('complete'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('status: halted SUMMARY stays counted (#2830 designed-stop pin)', () => {
    const dir = tempDir('gsd-3345-halted-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('halted'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1, 'a designed stop still writes a completion record');
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });

  test('mixed phase: 1 blocked + 1 complete of 2 plans -> summaryCount 1, completed false', () => {
    const dir = tempDir('gsd-3345-mixed-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
        '01-02-PLAN.md': planBody(),
        '01-02-SUMMARY.md': summaryWithStatus(undefined),
      });
      const scan = planScan(dir);
      assert.equal(scan.planCount, 2);
      assert.equal(scan.summaryCount, 1);
      assert.equal(scan.completed, false);
    } finally {
      cleanup(dir);
    }
  });

  test('case/whitespace/comment variants of blocked are recognized', () => {
    const dir = tempDir('gsd-3345-casing-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('Blocked # waiting on upstream'),
      });
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 0);
      assert.equal(scan.completed, false);
    } finally {
      cleanup(dir);
    }
  });

  test('unreadable SUMMARY degrades fail-open to the filename fallback', (t) => {
    const dir = tempDir('gsd-3345-unreadable-');
    try {
      writePhase(dir, {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
      });
      const mocked = mock.method(fs, 'openSync', () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });
      t.after(() => mocked.mock.restore());
      const scan = planScan(dir);
      assert.equal(scan.summaryCount, 1, 'unreadable SUMMARY counts by filename, never throws');
      assert.equal(scan.completed, true);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── PARITY GUARD: count side and read side share ONE predicate ────────────

describe('#3345 parity — scanPhasePlans counts and findUnsummarizedPlans agree through the shared predicate', () => {
  const PARITY_SCENARIOS = [
    { id: 'blocked', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus('blocked') } },
    { id: 'no-status', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus(undefined) } },
    { id: 'halted', files: { '01-01-PLAN.md': planBody(), '01-01-SUMMARY.md': summaryWithStatus('halted') } },
    {
      id: 'mixed',
      files: {
        '01-01-PLAN.md': planBody(),
        '01-01-SUMMARY.md': summaryWithStatus('blocked'),
        '01-02-PLAN.md': planBody(),
        '01-02-SUMMARY.md': summaryWithStatus(undefined),
      },
    },
  ];

  for (const scenario of PARITY_SCENARIOS) {
    test(`scenario ${scenario.id}: unsummarized-through-predicate mirrors summaryCount`, () => {
      const dir = tempDir(`gsd-3345-parity-${scenario.id}-`);
      try {
        writePhase(dir, scenario.files);
        const scan = planScan(dir);
        const { isSummaryFileBlocked } = planDependencyGraph;
        assert.equal(typeof isSummaryFileBlocked, 'function', 'isSummaryFileBlocked must be exported');
        const countable = scan.summaryFiles.filter((f) => !isSummaryFileBlocked(join(dir, f)));
        const unsummarized = coreUtils.findUnsummarizedPlans(scan.planFiles, countable);
        assert.equal(
          scan.planCount - scan.summaryCount,
          unsummarized.length,
          'the count side (scanPhasePlans) and the read side (findUnsummarizedPlans over the SAME predicate-filtered list) must agree',
        );
      } finally {
        cleanup(dir);
      }
    });
  }
});

// ─── CLI: the read path (phase-plan-index) ─────────────────────────────────

describe('#3345 phase-plan-index — blocked plan lands in incomplete', () => {
  function writeCliPhase(projectDir, summaryContent) {
    const phaseDir = join(projectDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const planFm = [
      '---',
      'phase: 01-test',
      'plan: "01"',
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      '---',
      '# plan',
      '',
    ].join('\n');
    fs.writeFileSync(join(phaseDir, '01-01-PLAN.md'), planFm);
    fs.writeFileSync(join(phaseDir, '01-01-SUMMARY.md'), summaryContent);
    return phaseDir;
  }

  test('blocked SUMMARY -> has_summary false and the plan appears in incomplete', () => {
    const project = createTempProject('gsd-3345-idx-blocked-');
    try {
      writeCliPhase(project, summaryWithStatus('blocked'));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.ok(plan, 'plan 01-01 must be indexed');
      assert.equal(plan.has_summary, false, 'a blocked SUMMARY is not a completion record');
      assert.ok(idx.incomplete.includes('01-01'), 'the blocked plan must land in incomplete');
    } finally {
      cleanup(project);
    }
  });

  test('plain SUMMARY (no status) -> has_summary true, incomplete empty (unchanged)', () => {
    const project = createTempProject('gsd-3345-idx-plain-');
    try {
      writeCliPhase(project, summaryWithStatus(undefined));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.equal(plan.has_summary, true);
      assert.deepEqual(idx.incomplete, []);
    } finally {
      cleanup(project);
    }
  });

  test('halted SUMMARY stays has_summary true with halted true (#2830 pin, unchanged)', () => {
    const project = createTempProject('gsd-3345-idx-halted-');
    try {
      writeCliPhase(project, summaryWithStatus('halted'));
      const r = runGsdTools(['phase-plan-index', '01-test', '--json'], project);
      assert.equal(r.exitCode, 0, r.output);
      const idx = JSON.parse(r.output);
      const plan = idx.plans.find((p) => p.id === '01-01');
      assert.equal(plan.has_summary, true, 'a designed stop keeps its completion record');
      assert.equal(plan.halted, true);
      assert.deepEqual(idx.incomplete, []);
    } finally {
      cleanup(project);
    }
  });
});

'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2945 — `phase complete`'s inline REQUIREMENTS.md checkbox
 * flip is traceability-blind: it flips `- [ ] **REQ-ID**` → `- [x]` unconditionally,
 * then attempts the traceability-row write, and KEEPS the flip when the row exists
 * but rejects the write (Out/Deferred/Blocked). The sibling `requirements.mark-complete`
 * got the #2788 defect-2 rollback; `cmdPhaseComplete`'s inline copy did not.
 *
 * The fix ports the rollback from `cmdRequirementsMarkComplete` (src/milestone.cts):
 * capture beforeCheckbox, track whether the row write actually changed (tableHit), and
 * restore beforeCheckbox when the row EXISTS but rejects the write.
 *
 * Matrix: .gsd/bug/fix/2945-phase-complete-checkbox-rollback/50-test-matrix.md
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Write a passed-VERIFICATION marker for the phase, then run `phase complete N`.
 * Mirrors phase.test.cjs's writePassedVerificationForPhase: a `<phase>-VERIFICATION.md`
 * with `status: passed` frontmatter. Requires the phase directory to exist.
 */
function runVerifiedPhaseComplete(args, tmpDir) {
  const argv = Array.isArray(args) ? args : args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  const completeIdx = argv.findIndex((t, i) => t === 'complete' && argv[i - 1] === 'phase');
  const phase = argv[completeIdx + 1];
  const phasesDir = path.join(tmpDir, '.planning', 'phases');
  const wanted = parseInt(String(phase).replace(/^0+/, ''), 10);
  const phaseDirName = fs.readdirSync(phasesDir).find((name) => {
    const m = name.match(/^(\d+)/);
    return m && parseInt(m[1], 10) === wanted;
  });
  if (!phaseDirName) throw new Error(`no phase directory for phase ${phase}`);
  fs.writeFileSync(
    path.join(phasesDir, phaseDirName, `${phase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
  return runGsdTools(args, tmpDir);
}

describe('phase complete checkbox rollback (#2945)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2945-');
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Scaffold a single-phase project whose ROADMAP cites the given REQ-IDs, with a
   * REQUIREMENTS.md whose traceability table rows carry the given statuses, then run
   * `phase complete 1`. Returns the REQUIREMENTS.md content after completion.
   */
  function completeWithRows(reqIds, rowStatuses) {
    const reqList = reqIds.join(', ');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: The phase\n\n### Phase 1: The phase\n**Goal:** do it\n**Requirements:** ${reqList}\n**Plans:** 1 plans\n`,
    );
    const reqLines = reqIds.map((id) => `- [ ] **${id}**: a requirement`).join('\n');
    const tableRows = reqIds.map((id, i) => `| ${id} | Phase 1 | ${rowStatuses[i]} |`).join('\n');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n## v1 Requirements\n\n${reqLines}\n\n## Traceability\n\n| Requirement | Phase | Status |\n|-------------|-------|--------|\n${tableRows}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** The phase\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-the-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  test('deferredRowRollsBackCheckbox', () => {
    // Row 1 (failing-first regression): a Deferred row rejects the Status write, so the
    // checkbox must NOT flip (it stays [ ]), and the row must stay Deferred.
    const req = completeWithRows(['DEF-01'], ['Deferred']);
    assert.ok(req.includes('- [ ] **DEF-01**'), 'checkbox must stay [ ] when the row is Deferred (no silent divergence)');
    assert.ok(/^\| DEF-01 \| Phase 1 \| Deferred \|/m.test(req), 'row must stay Deferred');
    assert.ok(!req.includes('- [x] **DEF-01**'), 'checkbox must NOT have flipped to [x]');
  });

  test('blockedRowRollsBackCheckbox', () => {
    // Row 2: an Out/Blocked row likewise rejects the write → checkbox stays [ ].
    const req = completeWithRows(['BLK-01'], ['Blocked']);
    assert.ok(req.includes('- [ ] **BLK-01**'), 'checkbox must stay [ ] when the row is Blocked');
    assert.ok(/^\| BLK-01 \| Phase 1 \| Blocked \|/m.test(req), 'row must stay Blocked');
    assert.ok(!req.includes('- [x] **BLK-01**'), 'checkbox must NOT have flipped to [x]');
  });

  test('pendingRowStillFlipsAndAdvances', () => {
    // Row 3 (negative-space / unchanged forward behavior): a Pending row accepts the write,
    // so the checkbox MUST flip to [x] and the row MUST advance to Complete. An over-broad
    // rollback would break this.
    const req = completeWithRows(['FWD-01'], ['Pending']);
    assert.ok(req.includes('- [x] **FWD-01**'), 'checkbox MUST flip to [x] for a Pending (forward) row');
    assert.ok(/^\| FWD-01 \| Phase 1 \| Complete \|/m.test(req), 'row MUST advance to Complete');
  });

  test('noRowStillFlipsCheckbox', () => {
    // Row 4 (acceptance #3): a cited REQ-ID with NO traceability row → checkbox still flips
    // (nothing to disagree with). The rollback only fires when a row EXISTS and rejects.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: The phase\n\n### Phase 1: The phase\n**Goal:** do it\n**Requirements:** NOROW-01\n**Plans:** 1 plans\n`,
    );
    // REQUIREMENTS.md with the checkbox but NO traceability table.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n## v1 Requirements\n\n- [ ] **NOROW-01**: a requirement with no traceability row\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** The phase\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-the-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);
    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [x] **NOROW-01**'), 'checkbox MUST flip to [x] when no traceability row exists');
  });
});

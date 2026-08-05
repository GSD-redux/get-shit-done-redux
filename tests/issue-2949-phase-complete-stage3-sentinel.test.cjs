'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2949 — `phase complete`'s stage-3 lowest-outstanding-override
 * loop admits unchecked `0.x` backlog sentinel rows as `next_phase`, corrupting STATE.md
 * and desyncing `current_phase` from `current_phase_name`.
 *
 * Root cause: `src/phase.cts` stage-3 condition `!isChecked && comparePhaseNum(cbm[2], phaseNum) < 0`
 * has no sentinel filter, so `comparePhaseNum("0.1","12") === -12` admits the `0.x` backlog row.
 * The fix adds `&& !isSentinelPhaseId(cbm[2])` (reusing the existing zero-caller predicate), which
 * excludes both sentinel ranges (0 and 999). Stage-3 only here — PR #2815 (in-flight) covers
 * stages 1-2 for #2786.
 *
 * Matrix: .gsd/bug/fix/2949-phase-complete-stage3-sentinel-filter/50-test-matrix.md
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Write a passed-verification marker for a phase, then run `phase complete N`.
 * Mirrors phase.test.cjs's writePassedVerificationForPhase: a `<phase>-VERIFICATION.md`
 * with `status: passed` frontmatter, plus a SUMMARY for each plan (the completion gate
 * requires executed plans). Requires the phase directory to already exist.
 */
function runVerifiedPhaseComplete(args, tmpDir) {
  const argv = Array.isArray(args) ? args : args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  const completeIdx = argv.findIndex((t, i) => t === 'complete' && argv[i - 1] === 'phase');
  const phase = argv[completeIdx + 1];
  const phasesDir = path.join(tmpDir, '.planning', 'phases');
  // Find the phase directory whose leading token matches the requested phase number.
  const wantedPadded = String(phase).replace(/^0+/, '');
  const phaseDirName = fs.readdirSync(phasesDir).find((name) => {
    const m = name.match(/^(\d+)/);
    return m && parseInt(m[1], 10) === parseInt(wantedPadded, 10);
  });
  if (!phaseDirName) throw new Error(`no phase directory for phase ${phase}`);
  const phaseDir = path.join(phasesDir, phaseDirName);
  fs.writeFileSync(
    path.join(phaseDir, `${phase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
  return runGsdTools(args, tmpDir);
}

describe('phase complete stage-3 sentinel filter (#2949)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2949-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Scaffold a phase dir with one executed plan (PLAN + SUMMARY). */
  function scaffoldPhase(slug, planNum) {
    const dir = path.join(tmpDir, '.planning', 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    const padded = String(planNum).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan');
    fs.writeFileSync(path.join(dir, `${padded}-01-SUMMARY.md`), '# Summary');
  }

  test('zeroXSentinelDoesNotBecomeNextPhase', () => {
    // Row 1 (failing-first regression): completing the last real phase with an unchecked
    // 0.x backlog sentinel row present must NOT select the sentinel as next_phase.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 0.1: Backlog sentinel item** — deferred work
- [x] **Phase 11: First phase** (completed 2025-01-01)
- [ ] **Phase 12: Last phase**

### Phase 11: First phase
**Goal:** first
**Plans:** 1 plans

### Phase 12: Last phase
**Goal:** last
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 12\n**Current Phase Name:** Last phase\n**Status:** In progress\n**Current Plan:** 12-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 12\n`,
    );
    scaffoldPhase('11-first-phase', 11);
    scaffoldPhase('12-last-phase', 12);

    const result = runVerifiedPhaseComplete('phase complete 12', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.completed_phase, '12');
    assert.strictEqual(output.is_last_phase, true, '0.x sentinel must not prevent milestone completion (is_last_phase=true)');
    assert.strictEqual(output.next_phase, null, '0.x sentinel must not be selected as next_phase');

    // STATE.md current_phase must stay on the completed phase (12), not advance to 0.1.
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!/\*\*Current Phase:\*\*\s*0\.1/i.test(state), 'STATE.md current_phase must NOT have advanced to the 0.x sentinel');
  });

  test('realLowerOutstandingPhaseStillSelected', () => {
    // Row 2 (#2028 non-regression): a REAL lower-numbered unchecked phase must STILL be
    // selected as next_phase. The sentinel filter must not over-broaden to real phases.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 9: Skipped-then-resumed phase**
- [ ] **Phase 10: Current phase**

### Phase 9: Skipped-then-resumed phase
**Goal:** nine
**Plans:** 1 plans

### Phase 10: Current phase
**Goal:** ten
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 10\n**Current Phase Name:** Current phase\n**Status:** In progress\n**Current Plan:** 10-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 10\n`,
    );
    scaffoldPhase('09-skipped-then-resumed-phase', 9);
    scaffoldPhase('10-current-phase', 10);

    const result = runVerifiedPhaseComplete('phase complete 10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    // A real lower phase (9) IS selected — the #2028 out-of-order behavior is preserved.
    // next_phase may be padded ("09") or unpadded ("9"); compare numerically.
    assert.strictEqual(output.is_last_phase, false, 'a real lower outstanding phase must keep is_last_phase=false');
    const nextNum = parseInt(String(output.next_phase), 10);
    assert.strictEqual(nextNum, 9, `real lower phase 9 must be selected as next_phase (got ${output.next_phase})`);
  });

  test('zeroXSentinelNoCurrentPhaseDesync', () => {
    // Row 3 (acceptance #3/#4): current_phase and current_phase_name must not desync when
    // a 0.x sentinel is present and the milestone completes.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 0.1: Backlog**
- [ ] **Phase 5: Only phase**

### Phase 5: Only phase
**Goal:** five
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 5\n**Current Phase Name:** Only phase\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 5\n`,
    );
    scaffoldPhase('05-only-phase', 5);

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'milestone completes despite the 0.x sentinel');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // current_phase must NOT have advanced to 0.1 (no desync into the sentinel).
    assert.ok(!/\*\*Current Phase:\*\*\s*0\.1/i.test(state), 'no desync: current_phase did not advance to 0.1');
  });

  test('checkedZeroXSentinelIrrelevant', () => {
    // Row 4 (boundary): a CHECKED 0.x sentinel is irrelevant — completing the last real phase
    // still completes the milestone.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] **Phase 0.1: Already-done backlog item**
- [ ] **Phase 3: Last phase**

### Phase 3: Last phase
**Goal:** three
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 3\n**Current Phase Name:** Last phase\n**Status:** In progress\n**Current Plan:** 03-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 3\n`,
    );
    scaffoldPhase('03-last-phase', 3);

    const result = runVerifiedPhaseComplete('phase complete 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'checked sentinel is irrelevant; milestone completes');
    assert.strictEqual(output.next_phase, null);
  });
});

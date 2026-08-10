/**
 * GSD Tools Tests - Init Manager
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// Helper: write a minimal ROADMAP.md with phases
function writeRoadmap(tmpDir, phases) {
  const sections = phases.map(p => {
    let section = `### Phase ${p.number}: ${p.name}\n\n**Goal:** ${p.goal || 'Do the thing'}\n`;
    if (p.depends_on) section += `**Depends on:** ${p.depends_on}\n`;
    return section;
  }).join('\n');

  const checklist = phases.map(p => {
    const mark = p.complete ? 'x' : ' ';
    return `- [${mark}] **Phase ${p.number}: ${p.name}**`;
  }).join('\n');

  const content = `# Roadmap\n\n## Progress\n\n${checklist}\n\n${sections}`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

// Helper: write a minimal STATE.md
function writeState(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n');
}

// Helper: scaffold a phase directory with specific artifacts
function scaffoldPhase(tmpDir, num, opts = {}) {
  const padded = String(num).padStart(2, '0');
  const slug = opts.slug || 'test-phase';
  const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.context) fs.writeFileSync(path.join(dir, `${padded}-CONTEXT.md`), '# Context');
  if (opts.research) fs.writeFileSync(path.join(dir, `${padded}-RESEARCH.md`), '# Research');
  if (opts.plans) {
    for (let i = 1; i <= opts.plans; i++) {
      const planPad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `${padded}-${planPad}-PLAN.md`), `# Plan ${i}`);
    }
  }
  if (opts.summaries) {
    for (let i = 1; i <= opts.summaries; i++) {
      const sumPad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir, `${padded}-${sumPad}-SUMMARY.md`), `# Summary ${i}`);
    }
  }

  return dir;
}

function writePassedVerification(phaseDir, padded) {
  fs.writeFileSync(
    path.join(phaseDir, `${padded}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n')
  );
}

describe('init manager', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fails without ROADMAP.md', () => {
    writeState(tmpDir);
    const result = runGsdTools('init manager', tmpDir);
    assert.ok(!result.success);
    assert.ok(result.error.includes('ROADMAP.md'));
  });

  test('fails without STATE.md', () => {
    writeRoadmap(tmpDir, [{ number: '1', name: 'Setup' }]);
    const result = runGsdTools('init manager', tmpDir);
    assert.ok(!result.success);
    assert.ok(result.error.includes('STATE.md'));
  });

  test('returns basic structure with phases', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.roadmap_exists, true);
    assert.strictEqual(output.state_exists, true);
    assert.ok(Array.isArray(output.phases));
    assert.ok(Array.isArray(output.recommended_actions));
  });

  test('detects disk status correctly for each phase state', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Complete Phase', complete: true },
      { number: '2', name: 'Planned Phase' },
      { number: '3', name: 'Discussed Phase' },
      { number: '4', name: 'Empty Phase' },
      { number: '5', name: 'Not Started' },
    ]);

    // Phase 1: complete (plans + matching summaries + passed verification)
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'complete-phase', context: true, plans: 2, summaries: 2 }), '01');
    // Phase 2: planned (plans, no summaries)
    scaffoldPhase(tmpDir, 2, { slug: 'planned-phase', context: true, plans: 3 });
    // Phase 3: discussed (context only)
    scaffoldPhase(tmpDir, 3, { slug: 'discussed-phase', context: true });
    // Phase 4: empty directory
    scaffoldPhase(tmpDir, 4, { slug: 'empty-phase' });
    // Phase 5: no directory at all

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'complete');
    assert.strictEqual(output.phases[1].disk_status, 'planned');
    assert.strictEqual(output.phases[2].disk_status, 'discussed');
    assert.strictEqual(output.phases[3].disk_status, 'empty');
    assert.strictEqual(output.phases[4].disk_status, 'no_directory');
  });

  test('treats plans/PLAN-NN.md layout as planned/complete counts (#3053)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Nested Plans' },
    ]);

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-nested-plans');
    fs.mkdirSync(path.join(phaseDir, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'plans', 'PLAN-01.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, 'plans', 'PLAN-02.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, 'plans', 'SUMMARY-01.md'), '# Summary 1');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].plan_count, 2);
    assert.strictEqual(output.phases[0].summary_count, 1);
    assert.strictEqual(output.phases[0].disk_status, 'partial');
  });

  test('dependency satisfaction: deps on complete phases = satisfied', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'Depends on 1', depends_on: 'Phase 1' },
    ]);
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 }), '01');

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].deps_satisfied, true);
    assert.strictEqual(output.phases[1].deps_satisfied, true);
  });

  test('dependency satisfaction: deps on incomplete phases = not satisfied', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'Depends on 1', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].deps_satisfied, true); // no deps
    assert.strictEqual(output.phases[1].deps_satisfied, false); // phase 1 not complete
  });

  test('parallel discuss: all undiscussed phases are marked is_next_to_discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // All three phases are undiscussed — all should be discussable
    assert.strictEqual(output.phases[0].is_next_to_discuss, true);
    assert.strictEqual(output.phases[1].is_next_to_discuss, true);
    assert.strictEqual(output.phases[2].is_next_to_discuss, true);

    // All three should have discuss recommendations
    const discussActions = output.recommended_actions.filter(a => a.action === 'discuss');
    assert.strictEqual(discussActions.length, 3);
  });

  test('discussed phase is not discussable; undiscussed siblings are', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'UI' },
    ]);

    // Phase 1 discussed
    scaffoldPhase(tmpDir, 1, { slug: 'foundation', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 1 is discussed; phases 2 and 3 are both undiscussed and discussable
    assert.strictEqual(output.phases[0].is_next_to_discuss, false);
    assert.strictEqual(output.phases[1].is_next_to_discuss, true);
    assert.strictEqual(output.phases[2].is_next_to_discuss, true);

    // Should recommend plan phase 1 AND discuss phases 2 and 3
    const phase1Rec = output.recommended_actions.find(r => r.phase === '1');
    const phase2Rec = output.recommended_actions.find(r => r.phase === '2');
    const phase3Rec = output.recommended_actions.find(r => r.phase === '3');
    assert.strictEqual(phase1Rec.action, 'plan');
    assert.strictEqual(phase2Rec.action, 'discuss');
    assert.strictEqual(phase3Rec.action, 'discuss');
  });

  test('sliding window: full pipeline — execute N, plan N+1, discuss N+2', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer' },
      { number: '3', name: 'Auth' },
      { number: '4', name: 'UI' },
      { number: '5', name: 'Polish' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 }), '01');
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2 }); // planned
    scaffoldPhase(tmpDir, 3, { slug: 'auth', context: true }); // discussed

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phases 4 and 5 are both undiscussed — both discussable
    assert.strictEqual(output.phases[3].is_next_to_discuss, true);
    assert.strictEqual(output.phases[4].is_next_to_discuss, true);

    // Recommendations: execute 2, plan 3, discuss 4, discuss 5
    assert.strictEqual(output.recommended_actions[0].action, 'execute');
    assert.strictEqual(output.recommended_actions[0].phase, '2');
    assert.strictEqual(output.recommended_actions[1].action, 'plan');
    assert.strictEqual(output.recommended_actions[1].phase, '3');
    const discussRecs = output.recommended_actions.filter(a => a.action === 'discuss').map(a => a.phase).sort();
    assert.deepStrictEqual(discussRecs, ['4', '5']);
  });

  test('recommendation ordering: execute > plan > discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Complete', complete: true },
      { number: '2', name: 'Ready to Execute' },
      { number: '3', name: 'Ready to Plan' },
      { number: '4', name: 'Ready to Discuss' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'complete', plans: 1, summaries: 1 }), '01');
    scaffoldPhase(tmpDir, 2, { slug: 'ready-to-execute', context: true, plans: 2 });
    scaffoldPhase(tmpDir, 3, { slug: 'ready-to-plan', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.recommended_actions.length >= 3);
    assert.strictEqual(output.recommended_actions[0].action, 'execute');
    assert.strictEqual(output.recommended_actions[0].phase, '2');
    assert.strictEqual(output.recommended_actions[1].action, 'plan');
    assert.strictEqual(output.recommended_actions[1].phase, '3');
    assert.strictEqual(output.recommended_actions[2].action, 'discuss');
    assert.strictEqual(output.recommended_actions[2].phase, '4');
  });

  test('blocked phases not recommended', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'In Progress' },
      { number: '2', name: 'Blocked', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 2 should not appear in recommendations (blocked by phase 1)
    const phase2Rec = output.recommended_actions.find(r => r.phase === '2');
    assert.strictEqual(phase2Rec, undefined);
  });

  test('all phases complete sets all_complete flag', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Done', complete: true },
      { number: '2', name: 'Also Done', complete: true },
    ]);
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'done', plans: 1, summaries: 1 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'also-done', plans: 1, summaries: 1 }), '02');

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.all_complete, true);
    assert.strictEqual(output.recommended_actions.length, 0);
  });

  test('implementation-complete phase without passed verification is not all_complete', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Implemented', complete: true },
    ]);
    scaffoldPhase(tmpDir, 1, { slug: 'implemented', plans: 1, summaries: 1 });

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.phases[0].disk_status, 'executed');
    assert.strictEqual(output.phases[0].implementation_complete, true);
    assert.strictEqual(output.phases[0].verification_status, 'missing');
    assert.strictEqual(output.phases[0].verification_passed, false);
    assert.strictEqual(output.recommended_actions[0].action, 'verify');
    assert.match(output.recommended_actions[0].command, /execute-phase 1/);
  });

  test('stale passed verification is not projected as complete', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Implemented', complete: true },
    ]);
    const phaseDir = scaffoldPhase(tmpDir, 1, { slug: 'implemented', plans: 1, summaries: 1 });
    writePassedVerification(phaseDir, '01');
    const verificationPath = path.join(phaseDir, '01-VERIFICATION.md');
    const summaryPath = path.join(phaseDir, '01-01-SUMMARY.md');
    const older = new Date('2025-01-01T00:00:00.000Z');
    const newer = new Date('2025-01-01T00:01:00.000Z');
    fs.utimesSync(verificationPath, older, older);
    fs.utimesSync(summaryPath, newer, newer);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.phases[0].disk_status, 'executed');
    assert.strictEqual(output.phases[0].implementation_complete, true);
    assert.strictEqual(output.phases[0].verification_status, 'stale');
    assert.strictEqual(output.phases[0].verification_passed, false);
    assert.strictEqual(output.phases[0].phase_complete, false);
    assert.strictEqual(output.recommended_actions[0].action, 'verify');
    assert.match(output.recommended_actions[0].reason, /verification stale/);
    assert.match(output.recommended_actions[0].command, /verify-work 1/);
  });

  test('checked unpadded roadmap token does not satisfy padded unverified dependency', () => {
    writeState(tmpDir);
    const roadmap = [
      '# Roadmap',
      '',
      '## Progress',
      '',
      '- [x] **Phase 1: Foundation**',
      '- [ ] **Phase 02: Followup**',
      '',
      '### Phase 01: Foundation',
      '',
      '**Goal:** Build foundation',
      '',
      '### Phase 02: Followup',
      '',
      '**Goal:** Build followup',
      '**Depends on:** Phase 1',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    scaffoldPhase(tmpDir, 1, { slug: 'foundation', plans: 1, summaries: 1 });

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phase1 = output.phases.find(p => p.number === '01');
    const phase2 = output.phases.find(p => p.number === '02');

    assert.ok(phase1, 'Phase 01 should be in the output');
    assert.strictEqual(phase1.phase_complete, false, 'Phase 01 is unverified and must not be complete');
    assert.ok(phase2, 'Phase 02 should be in the output');
    assert.strictEqual(phase2.deps_satisfied, false, 'Phase 02 dependency must wait for canonical Phase 01 verification');
  });

  test('WAITING.json detected when present', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const waiting = { type: 'decision', phase: '1', question: 'Pick one' };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'WAITING.json'),
      JSON.stringify(waiting)
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.deepStrictEqual(output.waiting_signal, waiting);
  });

  test('phase fields include goal and depends_on from roadmap', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', goal: 'Set up the base' },
      { number: '2', name: 'API', goal: 'Build endpoints', depends_on: 'Phase 1' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].goal, 'Set up the base');
    assert.strictEqual(output.phases[0].depends_on, null);
    assert.strictEqual(output.phases[1].goal, 'Build endpoints');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });

  test('display_name truncates long phase names', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Short' },
      { number: '2', name: 'Exactly Twenty Chars' },
      { number: '3', name: 'This Name Is Way Too Long For The Table' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].display_name, 'Short');
    assert.strictEqual(output.phases[1].display_name, 'Exactly Twenty Chars');
    assert.strictEqual(output.phases[2].display_name, 'This Name Is Way To…');
    assert.strictEqual(output.phases[2].display_name.length, 20);
    // Full name is preserved
    assert.strictEqual(output.phases[2].name, 'This Name Is Way Too Long For The Table');
  });

  test('activity detection: recent file = active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Active Phase' }]);

    // Scaffold with a file — it will have current mtime (within 5 min)
    scaffoldPhase(tmpDir, 1, { slug: 'active-phase', context: true });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_active, true);
    assert.ok(output.phases[0].last_activity !== null);
  });

  test('activity detection: hour-old file = not active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Stale Phase' }]);

    const PINNED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (second-aligned)
    const phaseDir = scaffoldPhase(tmpDir, 1, { slug: 'stale-phase', context: true });
    const files = fs.readdirSync(phaseDir);
    const old = new Date(PINNED_NOW_MS - 60 * 60 * 1000); // 1 hour before the pinned "now"
    for (const f of files) {
      fs.utimesSync(path.join(phaseDir, f), old, old);
    }

    const result = runGsdTools('init manager', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_NOW_MS),
    });
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_active, false);
  });

  // #3314 — ADR-456 subprocess clock pin: cmdInitManager's `is_active` gate
  // (nowMs - newestMtime < 300000) is CLI-subprocess tested, so only the
  // GSD_TEST_MODE+GSD_NOW_MS pin can control "now" here (t.mock.timers in the
  // test process cannot reach the spawned child). newestMtime is set via
  // fs.utimesSync to an exact epoch offset from the pinned "now" so the
  // 300000ms boundary is provable exactly, not just "roughly recent"/"roughly old".
  describe('is_active boundary (#3314 — exactly 300000ms, condition is strict <)', () => {
    const PINNED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (second-aligned)
    const PIN_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_NOW_MS) };

    function scaffoldWithMtimeOffset(tmpDirLocal, offsetMs) {
      writeState(tmpDirLocal);
      writeRoadmap(tmpDirLocal, [{ number: '1', name: 'Boundary Phase' }]);
      const phaseDir = scaffoldPhase(tmpDirLocal, 1, { slug: 'boundary-phase', context: true });
      const mtimeMs = PINNED_NOW_MS - offsetMs;
      const mtimeDate = new Date(mtimeMs);
      for (const f of fs.readdirSync(phaseDir)) {
        fs.utimesSync(path.join(phaseDir, f), mtimeDate, mtimeDate);
      }
    }

    test('boundary: 299999ms since last activity → is_active true', () => {
      scaffoldWithMtimeOffset(tmpDir, 299_999);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, true);
    });

    test('boundary: exactly 300000ms since last activity → is_active false', () => {
      scaffoldWithMtimeOffset(tmpDir, 300_000);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, false);
    });

    test('boundary: 300001ms since last activity → is_active false', () => {
      scaffoldWithMtimeOffset(tmpDir, 300_001);
      const result = runGsdTools('init manager', tmpDir, PIN_ENV);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.phases[0].is_active, false);
    });
  });

  test('conflict filter: blocks dependent phase execute when dep is active', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer', depends_on: 'Phase 1' },
      { number: '3', name: 'Auth', depends_on: 'Phase 2' },
    ]);

    // Phase 2: partial (actively executing — has 2 plans, 1 summary)
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2, summaries: 1 });
    // Phase 3: planned and deps would be met if Phase 2 were complete, but it's not
    scaffoldPhase(tmpDir, 3, { slug: 'auth', context: true, plans: 1 });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 2 is partial — should NOT appear as execute recommendation (already running)
    // Phase 3 deps_satisfied is false (Phase 2 not complete) — also no recommendation
    const execRecs = output.recommended_actions.filter(r => r.action === 'execute');
    assert.strictEqual(execRecs.length, 0);
  });

  test('conflict filter: allows independent phase execute in parallel', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation', complete: true },
      { number: '2', name: 'API Layer', depends_on: 'Phase 1' },
      { number: '3', name: 'Notifications' }, // no deps — independent
    ]);

    // Phase 2: partial (actively executing)
    scaffoldPhase(tmpDir, 2, { slug: 'api-layer', context: true, plans: 2, summaries: 1 });
    // Phase 3: planned, no deps — independent of Phase 2
    scaffoldPhase(tmpDir, 3, { slug: 'notifications', context: true, plans: 1 });

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Phase 3 is independent of Phase 2 — should be recommended for execution
    const execRecs = output.recommended_actions.filter(r => r.action === 'execute');
    assert.strictEqual(execRecs.length, 1);
    assert.strictEqual(execRecs[0].phase, '3');
  });

  test('output includes project_root field', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // macOS resolves /var → /private/var; normalize both sides
    assert.strictEqual(fs.realpathSync(output.project_root), fs.realpathSync(tmpDir));
  });

  test('output includes manager_flags defaults when not configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.manager_flags, 'should include manager_flags');
    assert.strictEqual(output.manager_flags.discuss, '');
    assert.strictEqual(output.manager_flags.plan, '');
    assert.strictEqual(output.manager_flags.execute, '');
  });

  test('output includes manager_flags from config when set', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    // Write config with manager flags
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        manager: {
          flags: {
            discuss: '--auto --analyze',
            plan: '--skip-research',
            execute: '--interactive',
          }
        }
      })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.ok(output.manager_flags, 'should include manager_flags');
    assert.strictEqual(output.manager_flags.discuss, '--auto --analyze');
    assert.strictEqual(output.manager_flags.plan, '--skip-research');
    assert.strictEqual(output.manager_flags.execute, '--interactive');
  });

  test('sanitizes invalid manager_flags to prevent injection (#1410)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        manager: {
          flags: {
            discuss: '; rm -rf /',
            plan: '--valid-flag',
            execute: '$(whoami)',
          }
        }
      })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    // Invalid flags should be sanitized to empty string
    assert.strictEqual(output.manager_flags.discuss, '', 'injection attempt should be sanitized');
    assert.strictEqual(output.manager_flags.plan, '--valid-flag', 'valid flag should pass through');
    assert.strictEqual(output.manager_flags.execute, '', 'command substitution should be sanitized');
  });

  test('does not recommend BACKLOG phases (999.x) as next actions', () => {
    writeState(tmpDir);
    // Regular phase (planned, deps met) plus a backlog phase (999.1) also planned
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '999.1', name: 'Nice to have feature (BACKLOG)' },
    ]);
    // Phase 1: planned (has plan, no summary)
    scaffoldPhase(tmpDir, 1, { plans: 1 });
    // Phase 999.1: planned (has plan, no summary)
    const backlogDir = path.join(tmpDir, '.planning', 'phases', '999.1-backlog');
    fs.mkdirSync(backlogDir, { recursive: true });
    fs.writeFileSync(path.join(backlogDir, '999.1-01-PLAN.md'), '# Backlog Plan');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const recommended = output.recommended_actions || [];
    const backlogRecs = recommended.filter(r => /^999/.test(r.phase));
    assert.strictEqual(backlogRecs.length, 0, 'no 999.x phases should appear in recommended_actions');

    // Phase 1 (non-backlog) should still be recommended
    const activeRecs = recommended.filter(r => r.phase === '1');
    assert.strictEqual(activeRecs.length, 1, 'phase 1 should still be recommended');
  });

  test('output includes response_language when configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ response_language: 'Japanese' })
    );

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.response_language, 'Japanese');
  });

  test('output omits response_language when not configured', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Test' }]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.response_language, undefined);
  });

  test('all_complete is true when non-backlog phases are complete and 999.x exists (#2129)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Setup', complete: true },
      { number: '2', name: 'Core', complete: true },
      { number: '3', name: 'Polish', complete: true },
      { number: '999.1', name: 'Backlog idea' },
    ]);

    // Scaffold completed phases on disk
    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'setup', plans: 2, summaries: 2 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'core', plans: 1, summaries: 1 }), '02');
    writePassedVerification(scaffoldPhase(tmpDir, 3, { slug: 'polish', plans: 1, summaries: 1 }), '03');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, true, 'all_complete should be true when only 999.x phases remain incomplete');
  });

  test('all_complete false with incomplete non-backlog phase still produces recommended_actions (#2129)', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Setup', complete: true },
      { number: '2', name: 'Core', complete: true },
      { number: '3', name: 'Polish' },
      { number: '999.1', name: 'Backlog idea' },
    ]);

    writePassedVerification(scaffoldPhase(tmpDir, 1, { slug: 'setup', plans: 1, summaries: 1 }), '01');
    writePassedVerification(scaffoldPhase(tmpDir, 2, { slug: 'core', plans: 1, summaries: 1 }), '02');
    // Phase 3 has no directory — should trigger discuss recommendation

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.all_complete, false, 'all_complete should be false with phase 3 incomplete');
    assert.ok(output.recommended_actions.length > 0, 'recommended_actions should not be empty when non-backlog phases remain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2267: deps_satisfied should include phases from shipped milestones.
//
// Root cause: completedNums was built only from the current milestone's phases,
// so a dependency on a phase from a previously shipped milestone was never
// satisfied — even though all prior-milestone phases are complete by definition.
// ─────────────────────────────────────────────────────────────────────────────

describe('init manager — cross-milestone dependency satisfaction (#2267)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Write a ROADMAP.md that has:
   *   - A shipped previous milestone (v1.0) inside a <details> block containing
   *     Phase 5 marked [x] complete.
   *   - A current active milestone (v2.0) containing Phase 6 that depends on
   *     Phase 5.
   */
  function writeRoadmapWithShippedMilestone(dir) {
    const content = [
      '# Roadmap',
      '',
      '<details>',
      '<summary>v1.0 — Initial Release (Shipped)</summary>',
      '',
      '## Roadmap v1.0: Initial Release',
      '',
      '- [x] **Phase 5: Auth**',
      '',
      '### Phase 5: Auth',
      '**Goal:** Add authentication',
      '',
      '</details>',
      '',
      '## Roadmap v2.0: Dashboard',
      '',
      '- [ ] **Phase 6: Dashboard**',
      '',
      '### Phase 6: Dashboard',
      '**Goal:** Build dashboard',
      '**Depends on:** Phase 5',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), content);
  }

  function writeStateWithMilestone(dir, version) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      `---\nmilestone: ${version}\n---\n# State\n`
    );
  }

  test('phase depending on a shipped-milestone phase has deps_satisfied: true (#2267)', () => {
    writeRoadmapWithShippedMilestone(tmpDir);
    writeStateWithMilestone(tmpDir, 'v2.0');

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    // Only the current milestone's phases should appear in the phases array
    assert.strictEqual(output.phases.length, 1, 'Should have exactly one phase from the current milestone');

    const phase6 = output.phases[0];
    assert.strictEqual(phase6.number, '6', 'Should be Phase 6');

    // Phase 6 depends on Phase 5 from the prior milestone — must be satisfied
    assert.strictEqual(
      phase6.deps_satisfied,
      true,
      'Phase 6 dep on shipped Phase 5 should be satisfied'
    );
  });

  test('phase depending on a non-existent phase has deps_satisfied: false (#2267)', () => {
    writeRoadmapWithShippedMilestone(tmpDir);
    writeStateWithMilestone(tmpDir, 'v2.0');

    // Add a second phase in the current milestone that depends on a phantom phase
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const existing = fs.readFileSync(roadmapPath, 'utf-8');
    const withExtra = existing + [
      '### Phase 7: Extra',
      '**Goal:** Extra work',
      '**Depends on:** Phase 99',
      '',
    ].join('\n');
    fs.writeFileSync(roadmapPath, withExtra);

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const phase7 = output.phases.find(p => p.number === '7');
    assert.ok(phase7, 'Phase 7 should be in the output');

    assert.strictEqual(
      phase7.deps_satisfied,
      false,
      'Phase 7 dep on non-existent Phase 99 should not be satisfied'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3584-runtime-slash-emitters.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3584-runtime-slash-emitters (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for bug #3584 — runtime emitters use the slash formatter.
 *
 * These tests exercise the actual runtime command handlers via `runGsdTools`
 * and assert on the structured payloads they emit/persist. They prove that
 * the high-impact emitters identified in the issue (`init.cjs` recommended
 * actions, `phase.cjs` ROADMAP persistence, `verify.cjs` remediation hints,
 * `milestone.cjs` Operator-Next-Steps persistence, `validate-command-router`
 * fracture recommendations) no longer emit the unroutable `/gsd:<cmd>` colon
 * form for skills-based runtimes.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  runGsdTools,
  createTempProject,
  createTempDir,
  cleanup,
} = require('./helpers.cjs');

// Helper: assert no string field anywhere in `value` (recursive) contains '/gsd:'.
function assertNoColonForm(value, label) {
  const stack = [{ v: value, p: label }];
  while (stack.length > 0) {
    const { v, p } = stack.pop();
    if (typeof v === 'string') {
      assert.ok(
        !v.includes('/gsd:'),
        `${p}: must not contain deprecated /gsd: form, got ${JSON.stringify(v)}`,
      );
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push({ v: item, p: `${p}[${i}]` }));
    } else if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) {
        stack.push({ v: v[key], p: `${p}.${key}` });
      }
    }
  }
}

// Helper: collect every `command` string under a recommendedActions-style array.
function collectCommandFields(value) {
  const out = [];
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v && typeof v === 'object') {
      if (typeof v.command === 'string') out.push(v.command);
      for (const key of Object.keys(v)) stack.push(v[key]);
    }
  }
  return out;
}

describe('bug-3584: init manager recommendedActions emit hyphen form', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Minimal ROADMAP + STATE so init manager will run.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Milestone v1',
        '',
        '### Phase 1: Foundation',
        '**Goal:** scaffold',
        '**Plans:** 1 plan',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\nCurrent Phase: 1\n',
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('skills runtime (claude) emits /gsd-<cmd> in recommended_actions[].command', () => {
    // Plan-but-not-executed: directory exists with a PLAN.md → execute is recommended.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'claude' });
    assert.ok(result.success, `init manager failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0, 'recommended_actions should produce at least one command');

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('/gsd-'),
        `recommended_actions command must start with /gsd- for skills-based runtimes, got ${cmd}`,
      );
      assert.ok(
        !cmd.includes('/gsd:'),
        `recommended_actions command must not contain /gsd: colon form, got ${cmd}`,
      );
    }
    assertNoColonForm(payload, 'init.manager payload');
  });

  test('codex runtime emits $gsd-<cmd> in recommended_actions[].command', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'codex' });
    assert.ok(result.success, `init manager (codex) failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0);

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('$gsd-'),
        `codex recommended_actions command must use $gsd- shell-var form, got ${cmd}`,
      );
    }
  });

  test('codex alias runtime emits $gsd-<cmd> in recommended_actions[].command', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('init manager', tmpDir, { GSD_RUNTIME: 'codex-app' });
    assert.ok(result.success, `init manager (codex-app) failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    const commands = collectCommandFields(payload.recommended_actions || []);
    assert.ok(commands.length > 0);

    for (const cmd of commands) {
      assert.ok(
        cmd.startsWith('$gsd-'),
        `codex alias recommended_actions command must use $gsd- shell-var form, got ${cmd}`,
      );
    }
  });
});

describe('bug-3584: phase add persists hyphen form into ROADMAP.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone v1\n\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n',
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('phase add persists hyphen-form slash command in roadmap get-phase payload', () => {
    // 1. Add a phase — the system under test persists the phase entry into ROADMAP.md.
    const addResult = runGsdTools(
      ['phase', 'add', 'Test new feature'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(addResult.success, `phase add failed: ${addResult.error || addResult.output}`);
    const addPayload = JSON.parse(addResult.output);
    assert.ok(addPayload.phase_number, 'phase add must return phase_number');

    // 2. Read the persisted section back via the structured roadmap-get-phase
    //    contract (NOT via readFileSync; the `section` field on the JSON payload
    //    is the runtime's typed projection of the on-disk ROADMAP content).
    const getResult = runGsdTools(
      ['roadmap', 'get-phase', String(addPayload.phase_number)],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(getResult.success, `roadmap get-phase failed: ${getResult.error || getResult.output}`);
    const getPayload = JSON.parse(getResult.output);
    assert.ok(getPayload.found, 'roadmap get-phase must find the newly-added phase');
    assert.ok(typeof getPayload.section === 'string', 'roadmap get-phase must return a section field');

    // 3. The persisted phase section must use the routable hyphen form.
    assert.ok(
      !getPayload.section.includes('/gsd:plan-phase'),
      `persisted phase section must not contain /gsd:plan-phase, got: ${getPayload.section}`,
    );
    assert.ok(
      getPayload.section.includes('/gsd-plan-phase'),
      `persisted phase section must contain /gsd-plan-phase, got: ${getPayload.section}`,
    );
  });
});

describe('bug-3584: validate health emits hyphen form in fix hints', () => {
  test('validate health on a broken project returns hyphen-form fix strings', (t) => {
    const tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));
    // No .planning directory → E001 fires with a `fix:` string that contains
    // the slash-command form.

    const result = runGsdTools(
      ['validate', 'health'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    // validate health exits non-zero on broken projects but still emits JSON to stdout.
    const stdout = result.output;
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`validate health did not emit parseable JSON: ${stdout.slice(0, 400)}`);
    }

    const allIssues = []
      .concat(payload.errors || [])
      .concat(payload.warnings || [])
      .concat(payload.info || []);

    assert.ok(allIssues.length > 0, 'validate health on a bare tmpdir should report at least one issue');

    const fixesWithSlash = allIssues
      .map((i) => i.fix)
      .filter((f) => typeof f === 'string' && /gsd[-:]/.test(f));
    assert.ok(
      fixesWithSlash.length > 0,
      'at least one fix hint should reference a /gsd- slash command',
    );

    for (const fix of fixesWithSlash) {
      assert.ok(
        !fix.includes('/gsd:'),
        `validate health fix hint must not contain /gsd: colon form, got ${JSON.stringify(fix)}`,
      );
    }
    assertNoColonForm(payload, 'validate health payload');
  });
});

describe('bug-3584: validate context recommendation uses hyphen form', () => {
  test('warning/critical recommendations emit /gsd-thread', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Critical band: 75% utilization. validate context emits JSON only with --json.
    const result = runGsdTools(
      ['validate', 'context', '--tokens-used', '75000', '--context-window', '100000', '--json'],
      tmpDir,
      { GSD_RUNTIME: 'claude' },
    );
    assert.ok(result.success, `validate context failed: ${result.error || result.output}`);

    const payload = JSON.parse(result.output);
    assert.ok(payload.recommendation, 'critical utilization should produce a recommendation');
    assert.ok(
      !payload.recommendation.includes('/gsd:'),
      `recommendation must not contain /gsd:, got ${JSON.stringify(payload.recommendation)}`,
    );
    assert.ok(
      payload.recommendation.includes('/gsd-thread'),
      `recommendation must reference /gsd-thread, got ${JSON.stringify(payload.recommendation)}`,
    );
  });
});

describe('bug-3584: validate health uses formatter for codex runtime too', () => {
  test('validate health under codex emits $gsd-<cmd> in fix strings (positive assertion)', (t) => {
    const tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(
      ['validate', 'health'],
      tmpDir,
      { GSD_RUNTIME: 'codex' },
    );
    let payload;
    try {
      payload = JSON.parse(result.output);
    } catch (e) {
      throw new Error(`validate health (codex) did not emit JSON: ${result.output.slice(0, 400)}`);
    }

    const allIssues = []
      .concat(payload.errors || [])
      .concat(payload.warnings || [])
      .concat(payload.info || []);

    // Collect fixes that mention any gsd slash-command form so we can lock
    // both the absence of legacy forms AND the presence of the codex shape.
    const fixesWithGsdRef = allIssues
      .map((i) => i.fix)
      .filter((f) => typeof f === 'string' && /(?:\$|\/)gsd[-:]/.test(f));

    assert.ok(
      fixesWithGsdRef.length > 0,
      'validate health on a bare tmpdir must produce at least one fix hint referencing a gsd command',
    );

    for (const fix of fixesWithGsdRef) {
      assert.ok(
        fix.includes('$gsd-'),
        `codex validate health fix must use shell-var $gsd- form, got ${JSON.stringify(fix)}`,
      );
      assert.ok(
        !fix.includes('/gsd:'),
        `codex validate health fix must not contain /gsd: colon form, got ${JSON.stringify(fix)}`,
      );
      assert.ok(
        !fix.includes('/gsd-'),
        `codex validate health fix must not contain /gsd- (skills) form, got ${JSON.stringify(fix)}`,
      );
    }
  });
});
  });
}

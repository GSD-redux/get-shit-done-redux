'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Phase-completion single-owner tests (epic #3180, issue #3186, ADR-3180
 * §7.4, disk-strict per #2957). Covers `.gsd/phase/refactor-3186-phase-
 * completion-predicate/50-test-matrix.md` sections A-F:
 *
 *   A — the predicate itself (`src/verification.cts` · `isPhaseComplete`)
 *   B — disk-strict: the ROADMAP checkbox has no machine authority
 *   C — identity at each CONSUMER's observable output (Decision 4c)
 *   D — the 0.x-split: sites answering a DIFFERENT question keep answering it
 *   F — Tier-2 regression surface
 *
 * Section E (the drift guard itself) lives in
 * tests/completion-predicate-drift-guard.test.cjs.
 *
 * A1 is the #3168 regression (zero plans + passing `*-VERIFICATION.md` must
 * read complete). Verified RED-before/GREEN-after manually against this
 * change (git stash the src/ edits, rebuild, and probe `init manager` on
 * the exact A1 fixture below): pre-fix it reported
 * `{ phase_complete: false, verification_status: 'not_required',
 * disk_status: 'empty' }`; post-fix it reports
 * `{ phase_complete: true, verification_status: 'passed', disk_status:
 * 'complete' }`. That evidence is reported in the implementation PR/summary
 * rather than re-run here (a stash/rebuild inside a test body would not be
 * hermetic); the assertions below pin the GREEN (post-fix) behavior as a
 * permanent regression net.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isPhaseComplete } = require('../gsd-core/bin/lib/verification.cjs');
const { SCOPE } = require('../gsd-core/bin/lib/planning-scope.cjs');
const { scanPhasePlans } = require('../gsd-core/bin/lib/plan-scan.cjs');
const { buildWorkstreamInventory } = require('../gsd-core/bin/lib/workstream-inventory-builder.cjs');
const { runGsdTools, createTempDir, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Fixture helpers ────────────────────────────────────────────────────────

function writeRoadmap(tmpDir, phases) {
  const sections = phases.map((p) => {
    let section = `### Phase ${p.number}: ${p.name}\n\n**Goal:** ${p.goal || 'Do the thing'}\n`;
    if (p.depends_on) section += `**Depends on:** ${p.depends_on}\n`;
    return section;
  }).join('\n');
  const checklist = phases.map((p) => {
    const mark = p.complete ? 'x' : ' ';
    return `- [${mark}] **Phase ${p.number}: ${p.name}**`;
  }).join('\n');
  const content = `# Roadmap\n\n## Progress\n\n${checklist}\n\n${sections}`;
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function writeState(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n');
}

function scaffoldPhase(tmpDir, num, opts = {}) {
  const padded = String(num).padStart(2, '0');
  const slug = opts.slug || 'test-phase';
  const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.plans) {
    for (let i = 1; i <= opts.plans; i++) {
      fs.writeFileSync(path.join(dir, `${padded}-${String(i).padStart(2, '0')}-PLAN.md`), `# Plan ${i}`);
    }
  }
  if (opts.summaries) {
    for (let i = 1; i <= opts.summaries; i++) {
      fs.writeFileSync(path.join(dir, `${padded}-${String(i).padStart(2, '0')}-SUMMARY.md`), `# Summary ${i}`);
    }
  }
  return dir;
}

function writeVerification(phaseDir, padded, status, filenameOverride) {
  const filename = filenameOverride || `${padded}-VERIFICATION.md`;
  fs.writeFileSync(path.join(phaseDir, filename), `---\nstatus: ${status}\n---\n# Verification\n`);
}

// ═════════════════════════════════════════════════════════════════════════
// A — isPhaseComplete: the predicate itself
// ═════════════════════════════════════════════════════════════════════════

describe('A — isPhaseComplete: disk-strict, unconditional readVerificationStatus', () => {
  test('A1 (#3168 regression): zero plans + passing *-VERIFICATION.md -> complete', (t) => {
    const dir = createTempDir('gsd-phase-complete-a1-');
    t.after(() => cleanup(dir));
    writeVerification(dir, '01', 'passed');

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, true);
    assert.strictEqual(result.value.verification.status, 'passed');
    assert.strictEqual(result.scope, SCOPE.COMPLETE);
  });

  test('A2: plans present, all summarized, passing verification -> complete', (t) => {
    const dir = createTempDir('gsd-phase-complete-a2-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary');
    writeVerification(dir, '01', 'passed');

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, true);
  });

  test('A3: plans present, all summarized, NO verification -> not complete', (t) => {
    const dir = createTempDir('gsd-phase-complete-a3-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary');

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, false);
    assert.strictEqual(result.value.verification.status, 'missing');
  });

  test('A4: verification present but FAILING -> not complete, distinguishable from absent', (t) => {
    const dir = createTempDir('gsd-phase-complete-a4-');
    t.after(() => cleanup(dir));
    writeVerification(dir, '01', 'gaps_found');

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, false);
    assert.strictEqual(result.value.verification.status, 'gaps_found');
    assert.notStrictEqual(result.value.verification.status, 'missing');
  });

  test('A5: zero plans, NO verification -> not complete', (t) => {
    const dir = createTempDir('gsd-phase-complete-a5-');
    t.after(() => cleanup(dir));

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, false);
    assert.strictEqual(result.value.verification.status, 'missing');
  });

  test('A6: plan count boundary 0/1/2 with passing verification -> complete at every count', (t) => {
    for (const planCount of [0, 1, 2]) {
      const dir = createTempDir(`gsd-phase-complete-a6-${planCount}-`);
      t.after(() => cleanup(dir));
      for (let i = 1; i <= planCount; i++) {
        fs.writeFileSync(path.join(dir, `01-0${i}-PLAN.md`), `# Plan ${i}`);
        fs.writeFileSync(path.join(dir, `01-0${i}-SUMMARY.md`), `# Summary ${i}`);
      }
      writeVerification(dir, '01', 'passed');

      const result = isPhaseComplete(dir);
      assert.strictEqual(result.value.complete, true, `planCount=${planCount} must be complete`);
    }
  });

  test('A7: phase dir unreadable -> non-COMPLETE scope, not a false "incomplete"', (t) => {
    const dir = createTempDir('gsd-phase-complete-a7-');
    t.after(() => cleanup(dir));
    // Injected via a fake `deps.fs` (method monkeypatching through the
    // function's own dependency-injection seam) rather than chmod 0o000 —
    // chmod is bypassed by root/Docker CI and does not exercise the code
    // path deterministically.
    const fakeFs = {
      readdirSync: () => {
        throw new Error('EACCES: permission denied, scandir');
      },
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    };

    const result = isPhaseComplete(dir, { fs: fakeFs });
    assert.notStrictEqual(result.scope, SCOPE.COMPLETE);
    assert.strictEqual(result.scope, SCOPE.UNREADABLE);
  });

  test('A8: multiple *-VERIFICATION.md files, one passing one failing -> defined, documented verdict', (t) => {
    const dir = createTempDir('gsd-phase-complete-a8-');
    t.after(() => cleanup(dir));
    // readVerificationStatus (which isPhaseComplete wraps) takes the
    // lexicographically-FIRST matching filename (`.sort()[0]`) — pin that
    // contract here rather than leaving "multiple files" undefined.
    writeVerification(dir, '01', 'gaps_found', '01-A-VERIFICATION.md');
    writeVerification(dir, '01', 'passed', '01-B-VERIFICATION.md');

    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.verification.status, 'gaps_found', '01-A- sorts before 01-B-');
    assert.strictEqual(result.value.complete, false);
  });

  test('A9: CRLF in the verification file -> identical to LF', (t) => {
    const dirLf = createTempDir('gsd-phase-complete-a9-lf-');
    const dirCrlf = createTempDir('gsd-phase-complete-a9-crlf-');
    t.after(() => {
      cleanup(dirLf);
      cleanup(dirCrlf);
    });
    fs.writeFileSync(path.join(dirLf, '01-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
    fs.writeFileSync(path.join(dirCrlf, '01-VERIFICATION.md'), '---\r\nstatus: passed\r\n---\r\n# Verification\r\n');

    const lfResult = isPhaseComplete(dirLf);
    const crlfResult = isPhaseComplete(dirCrlf);
    assert.strictEqual(lfResult.value.complete, true);
    assert.strictEqual(crlfResult.value.complete, true);
    assert.strictEqual(crlfResult.value.verification.status, lfResult.value.verification.status);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B — Disk-strict: the checkbox has no machine authority
// ═════════════════════════════════════════════════════════════════════════

describe('B — disk-strict: ROADMAP checkbox carries no machine authority', () => {
  function fixture(tmpDir, { checked, plans, summaries, verificationStatus }) {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [{ number: '1', name: 'Foo', complete: checked }]);
    const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo', plans, summaries });
    if (verificationStatus) writeVerification(dir, '01', verificationStatus);
    return dir;
  }

  test('B1: checkbox ticked, plans outstanding, no verification -> NOT complete (the Tier-2 break)', () => {
    const tmpDir = createTempProject();
    try {
      fixture(tmpDir, { checked: true, plans: 2, summaries: 0 });
      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.strictEqual(analyzed.phases[0].disk_status, 'partial');
      assert.notStrictEqual(analyzed.phases[0].disk_status, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('B2: checkbox ticked AND verification passing -> complete (checkbox contributed nothing)', () => {
    const tmpDir = createTempProject();
    try {
      fixture(tmpDir, { checked: true, plans: 1, summaries: 1, verificationStatus: 'passed' });
      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.strictEqual(analyzed.phases[0].disk_status, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('B3: checkbox UNTICKED, verification passing -> complete (disk wins in both directions)', () => {
    const tmpDir = createTempProject();
    try {
      fixture(tmpDir, { checked: false, plans: 1, summaries: 1, verificationStatus: 'passed' });
      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.strictEqual(analyzed.phases[0].disk_status, 'complete');
      assert.strictEqual(analyzed.phases[0].roadmap_complete, false, 'checkbox itself stays unticked/reported');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('B4: checkbox ticked, verification FAILING -> not complete', () => {
    const tmpDir = createTempProject();
    try {
      fixture(tmpDir, { checked: true, plans: 1, summaries: 1, verificationStatus: 'gaps_found' });
      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.notStrictEqual(analyzed.phases[0].disk_status, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('B5: ROADMAP.md absent entirely -> the predicate itself is unaffected (isPhaseComplete never reads it)', (t) => {
    const dir = createTempDir('gsd-phase-complete-b5-');
    t.after(() => cleanup(dir));
    writeVerification(dir, '01', 'passed');
    // No ROADMAP.md anywhere near `dir` — isPhaseComplete takes a phase
    // directory, not a project root, and never touches ROADMAP.md.
    const result = isPhaseComplete(dir);
    assert.strictEqual(result.value.complete, true);
  });

  test('B6: a ticked checkbox is NOT deleted from ROADMAP.md — only its authority is removed', () => {
    const tmpDir = createTempProject();
    try {
      fixture(tmpDir, { checked: true, plans: 2, summaries: 0 });
      const before = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
      assert.ok(before.includes('[x] **Phase 1'), 'fixture sanity: checkbox starts ticked');

      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);

      const after = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
      assert.strictEqual(after, before, 'roadmap analyze is read-only: the human annotation survives untouched');
      assert.ok(after.includes('[x] **Phase 1'), 'the ticked checkbox itself is still present');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C — Identity at each CONSUMER's observable output (Decision 4c)
// ═════════════════════════════════════════════════════════════════════════

describe('C — consumer identity: every reader of "is phase P complete?" agrees', () => {
  test('C1: init manager reports complete for the A1 fixture (the #3168 symptom)', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo' }); // zero plans
      writeVerification(dir, '01', 'passed');

      const result = runGsdTools('init manager --raw', tmpDir);
      assert.ok(result.success, result.error);
      const output = JSON.parse(result.output);
      const phase1 = output.phases.find((p) => p.number === '1' || p.number === '01');
      assert.strictEqual(phase1.phase_complete, true);
      assert.strictEqual(phase1.verification_status, 'passed');
      assert.notStrictEqual(phase1.verification_status, 'not_required');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('C2: roadmap analyze disk_status matches the owner, with no checkbox arm', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]); // checkbox UNTICKED
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo' });
      writeVerification(dir, '01', 'passed');

      const owner = isPhaseComplete(dir);
      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.strictEqual(analyzed.phases[0].disk_status === 'complete', owner.value.complete);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('C3: phase complete is unchanged — still succeeds exactly when the owner says complete', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo' }); // zero plans, A1 shape
      writeVerification(dir, '01', 'passed');

      const owner = isPhaseComplete(dir);
      assert.strictEqual(owner.value.complete, true);

      const result = runGsdTools('phase complete 1 --raw', tmpDir);
      assert.ok(result.success, `phase complete must succeed when the owner reports complete: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('C4: roadmap update-plan-progress "complete" field matches the owner', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 1, summaries: 1 });
      writeVerification(dir, '01', 'gaps_found'); // failing -> owner says not complete

      const owner = isPhaseComplete(dir);
      assert.strictEqual(owner.value.complete, false);

      // No --raw: cmdRoadmapUpdatePlanProgress's output() call carries a
      // non-undefined rawValue (a "N/N Status" text fallback), so --raw
      // would switch this to plain text instead of JSON (unlike roadmap
      // analyze / init manager, whose output() calls pass rawValue:
      // undefined and always emit JSON regardless of --raw).
      const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
      assert.ok(result.success, result.error);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.complete, owner.value.complete);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('C5: cross-consumer — one fixture, init manager AND roadmap analyze report the SAME verdict', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo' }); // zero plans
      writeVerification(dir, '01', 'passed');

      const initResult = runGsdTools('init manager --raw', tmpDir);
      const roadmapResult = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(initResult.success, initResult.error);
      assert.ok(roadmapResult.success, roadmapResult.error);

      const initPhase = JSON.parse(initResult.output).phases.find((p) => p.number === '1' || p.number === '01');
      const roadmapPhase = JSON.parse(roadmapResult.output).phases[0];
      assert.strictEqual(initPhase.phase_complete, true);
      assert.strictEqual(roadmapPhase.disk_status, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  describe('C6: the §7.4 headline — "phase complete succeeds while init manager reports incomplete" is unrepresentable', () => {
    test('agreement case: zero plans + passing verification -> BOTH succeed/report complete', () => {
      const tmpDir = createTempProject();
      try {
        writeState(tmpDir);
        writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
        const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo' });
        writeVerification(dir, '01', 'passed');

        const initResult = runGsdTools('init manager --raw', tmpDir);
        assert.ok(initResult.success, initResult.error);
        const initPhase = JSON.parse(initResult.output).phases.find((p) => p.number === '1' || p.number === '01');
        assert.strictEqual(initPhase.phase_complete, true);

        const completeResult = runGsdTools('phase complete 1 --raw', tmpDir);
        assert.ok(completeResult.success, `phase complete must succeed to agree with init manager: ${completeResult.error}`);
      } finally {
        cleanup(tmpDir);
      }
    });

    test('agreement case: plans outstanding, no verification -> BOTH report/refuse incomplete', () => {
      const tmpDir = createTempProject();
      try {
        writeState(tmpDir);
        writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
        scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 1, summaries: 1 }); // no *-VERIFICATION.md written

        const initResult = runGsdTools('init manager --raw', tmpDir);
        assert.ok(initResult.success, initResult.error);
        const initPhase = JSON.parse(initResult.output).phases.find((p) => p.number === '1' || p.number === '01');
        assert.strictEqual(initPhase.phase_complete, false);

        const completeResult = runGsdTools('phase complete 1 --raw', tmpDir);
        assert.strictEqual(completeResult.success, false, 'phase complete must be BLOCKED to agree with init manager reporting incomplete');
      } finally {
        cleanup(tmpDir);
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D — the 0.x-split: sites asking a DIFFERENT question keep answering it
// ═════════════════════════════════════════════════════════════════════════

describe('D — the 0.x split: "are plans summarized" stays a different, legitimate answer', () => {
  function buildD1Fixture(t) {
    // All plans summarized, but NO *-VERIFICATION.md — the exact fixture
    // the design's "0.x split" section names as the trap.
    const dir = createTempDir('gsd-phase-completion-d1-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary');
    return dir;
  }

  test('D1: scanPhasePlans.completed still reports true — "are plans summarized" is a different question', (t) => {
    const dir = buildD1Fixture(t);
    const scan = scanPhasePlans(dir);
    assert.strictEqual(scan.completed, true, 'plan-scan.cts answers "are all plans summarized", not "is the phase complete"');
  });

  test('D2: the SAME fixture through isPhaseComplete -> NOT complete (the two answers legitimately differ)', (t) => {
    const dir = buildD1Fixture(t);
    const owner = isPhaseComplete(dir);
    assert.strictEqual(owner.value.complete, false);

    const scan = scanPhasePlans(dir);
    assert.notStrictEqual(scan.completed, owner.value.complete, 'the two derivations must legitimately disagree on this exact fixture');
  });

  test('D4: buildWorkstreamInventory on the D1 fixture reports its own summaries-met answer, unchanged', (t) => {
    const dir = buildD1Fixture(t);
    const scan = scanPhasePlans(dir);

    const inventory = buildWorkstreamInventory({
      name: 'default',
      projectDir: path.dirname(dir),
      workstreamDir: path.dirname(dir),
      phaseDirNames: ['01-fixture'],
      activeWorkstreamName: 'default',
      phaseFilesCounts: [
        {
          directory: '01-fixture',
          planCount: scan.planCount,
          summaryCount: scan.summaryCount,
          // No verification data supplied -> defaults to 'missing', which is
          // OUTSIDE FAILING_VERIFICATION_STATUSES (workstream-inventory-
          // builder.cts's own #2645 pre-adoption posture) — the phase's
          // status is judged purely on summaries-met, its own question.
        },
      ],
      roadmapPhaseCount: 1,
      stateProjection: { status: 'in_progress', current_phase: '01', last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: false },
    });

    assert.strictEqual(inventory.phases[0].status, 'complete', 'summaries-met alone still resolves this builder\'s own status field');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F — Tier-2 regression surface
// ═════════════════════════════════════════════════════════════════════════

describe('F — Tier-2 regression surface', () => {
  test('F1: a project relying on checkbox-only completion — roadmap analyze stops reporting complete (documented break)', () => {
    // Same fixture shape as B1, framed as the Tier-2 regression this phase
    // ships deliberately: a downstream project that was relying on a ticked
    // checkbox alone (no passing verification, plans outstanding) now sees
    // `disk_status` flip away from 'complete'.
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo', complete: true }]);
      scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 3, summaries: 0 });

      const result = runGsdTools('roadmap analyze --raw', tmpDir);
      assert.ok(result.success, result.error);
      const analyzed = JSON.parse(result.output);
      assert.notStrictEqual(analyzed.phases[0].disk_status, 'complete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('F2: gsd-core/workflows/mvp-phase.md no longer ORs PHASE_COMPLETE with disk status', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'mvp-phase.md'),
      'utf-8',
    );
    assert.ok(
      !/"\$DISK_STATUS"\s*==\s*"complete"\s*\|\|\s*"\$PHASE_COMPLETE"/.test(content),
      'the disk-strict OR must be gone from mvp-phase.md',
    );
    assert.ok(
      /if \[\[ "\$DISK_STATUS" == "complete" \]\]; then/.test(content),
      'DISK_STATUS alone must decide completion',
    );
  });

  test('F3: init manager never emits the old not_required sentinel for a zero-plan phase (regression net replacing it)', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      scaffoldPhase(tmpDir, 1, { slug: 'foo' }); // zero plans, no verification either

      const result = runGsdTools('init manager --raw', tmpDir);
      assert.ok(result.success, result.error);
      const output = JSON.parse(result.output);
      const phase1 = output.phases.find((p) => p.number === '1' || p.number === '01');
      assert.notStrictEqual(phase1.verification_status, 'not_required', 'not_required is retired — the owner always reports a real readVerificationStatus verdict');
      assert.strictEqual(phase1.verification_status, 'missing');
      assert.strictEqual(phase1.phase_complete, false);
    } finally {
      cleanup(tmpDir);
    }
  });
});

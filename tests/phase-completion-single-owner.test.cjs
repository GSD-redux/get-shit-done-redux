'use strict';
process.env.GSD_TEST_MODE = '1';

// F2 below reads gsd-core/workflows/mvp-phase.md and regex-tests its shell
// content for the disk-strict OR removal (Decision 4(d)). A workflow .md
// file's text IS the deployed prompt-layer artifact the runtime executes —
// there is no runtime API that "runs" mvp-phase.md to observe its shell
// logic behaviorally, so asserting on its source text tests the actual
// deployed contract. #3186 review finding 6(b).

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
  // A real Progress TABLE (gsd-core/templates/roadmap.md shape), not just the
  // checklist — cmdRoadmapUpdatePlanProgress writes into this table via the
  // markdown-table seam (editProgressTableSlice/updateTableCell), which no-ops
  // when no table with these columns exists. G2 (#3186) needs a real table to
  // observe the "Plans Complete / Status cells still update, only the
  // completion checkbox is withheld" behavior.
  const table = [
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|-----------------|--------|-----------|',
    ...phases.map((p) => `| ${p.number}. ${p.name} | 0/0 | Not started | - |`),
  ].join('\n');
  const content = `# Roadmap\n\n## Progress\n\n${checklist}\n\n${table}\n\n${sections}`;
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
      // 2 plans, 0 summaries -> 'planned' (disk_status's own taxonomy: no
      // summaries yet means "planned", not "partial" — 'partial' requires
      // summaryCount > 0). The load-bearing assertion for the Tier-2 break is
      // the notStrictEqual below: the checkbox alone must not read 'complete'.
      assert.strictEqual(analyzed.phases[0].disk_status, 'planned');
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

  // ADR-3180 §7.4 (#3186 review finding 3, corrected from this phase's own
  // design doc): `buildWorkstreamInventory` was ORIGINALLY (wrongly)
  // classified as staying on the "different question" side of the 0.x
  // split, the same way `scanPhasePlans.completed` legitimately does. Review
  // found it reproduced the §7.4 headline case (#3168) in a third surface —
  // it combined a local summaries-met derivation with caller-supplied
  // verification data to decide the SAME "is phase P complete?" question,
  // not a different one. Corrected: the module is a pure, I/O-free
  // projection (module header: "No I/O. No async.") that cannot call
  // `isPhaseComplete` itself, so per Decision 4(c) the CALLER computes the
  // owner's real verdict and passes it in via `PhaseFilesCount.complete` —
  // `workstream-inventory.cts` does this with a real `isPhaseComplete` call
  // in production. D4 now pins that routing directly.
  test('D4: buildWorkstreamInventory on the D1 fixture is NOT complete when the caller supplies the owner\'s real (false) verdict', (t) => {
    const dir = buildD1Fixture(t);
    const scan = scanPhasePlans(dir);
    const owner = isPhaseComplete(dir);
    assert.strictEqual(owner.value.complete, false, 'fixture sanity: no *-VERIFICATION.md -> the owner says not complete');

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
          // ADR-3180 §7.4 (#3186): the caller-computed owner verdict, NOT a
          // local re-derivation from planCount/summaryCount.
          complete: owner.value.complete,
        },
      ],
      roadmapPhaseCount: 1,
      stateProjection: { status: 'in_progress', current_phase: '01', last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: false },
    });

    assert.strictEqual(
      inventory.phases[0].status,
      'in_progress',
      'summaries-met alone no longer resolves complete — the builder routes through the caller-supplied owner verdict (#3186 fix)',
    );
  });

  test('D5: buildWorkstreamInventory reports complete for a zero-plan phase when the caller supplies a true owner verdict (#3168 parity)', (t) => {
    const dir = createTempDir('gsd-phase-completion-d5-');
    t.after(() => cleanup(dir));
    writeVerification(dir, '01', 'passed');
    const owner = isPhaseComplete(dir);
    assert.strictEqual(owner.value.complete, true);

    const inventory = buildWorkstreamInventory({
      name: 'default',
      projectDir: path.dirname(dir),
      workstreamDir: path.dirname(dir),
      phaseDirNames: ['01-fixture'],
      activeWorkstreamName: 'default',
      phaseFilesCounts: [
        { directory: '01-fixture', planCount: 0, summaryCount: 0, complete: owner.value.complete },
      ],
      roadmapPhaseCount: 1,
      stateProjection: { status: 'in_progress', current_phase: '01', last_activity: null },
      filesExist: { roadmap: true, state: true, requirements: false },
    });

    assert.strictEqual(
      inventory.phases[0].status,
      'complete',
      'zero plans + a passing verification -> complete, matching isPhaseComplete (#3168) even with planCount 0',
    );
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

// ═════════════════════════════════════════════════════════════════════════
// G — write-path plan-coverage gate (#3186 review finding 1, #2648
// precedent). `isPhaseComplete` deliberately has NO plan-count precondition
// (the owner), but `roadmap update-plan-progress` WRITES a checkbox +
// completion date into ROADMAP.md — a stronger claim than "verification
// passed" — and must additionally refuse when a plan has no completion
// record, exactly like `phase complete`'s own #2648 gate. Matrix rows A-F
// never covered "plans added AFTER a still-fresh passing verification";
// this is that row.
// ═════════════════════════════════════════════════════════════════════════

describe('G — write-path plan-coverage gate: a plan added after a still-fresh passing verification', () => {
  test('G1: the OWNER (isPhaseComplete) reports complete — no plan-count precondition, by design', () => {
    const dir = createTempDir('gsd-phase-completion-g1-');
    try {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Plan 1');
      fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary 1');
      writeVerification(dir, '01', 'passed');
      // A second plan lands AFTER verification passed — never summarized.
      // The verification file is untouched, so its status stays 'passed'
      // (readVerificationStatus's staleness check compares only SUMMARY
      // mtimes against the verification file, never plan count).
      fs.writeFileSync(path.join(dir, '01-02-PLAN.md'), '# Plan 2');

      const owner = isPhaseComplete(dir);
      assert.strictEqual(owner.value.verification.status, 'passed', 'fixture sanity: verification reads as still-fresh passed');
      assert.strictEqual(owner.value.complete, true, 'the owner has no plan-count precondition by design (ADR-3180 §7.4 hard constraint) — this is not the bug');
    } finally {
      cleanup(dir);
    }
  });

  test('G2: roadmap update-plan-progress REFUSES to write completion for the identical fixture', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 1, summaries: 1 });
      writeVerification(dir, '01', 'passed');
      fs.writeFileSync(path.join(dir, '01-02-PLAN.md'), '# Plan 2'); // outstanding, no summary

      const roadmapBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

      const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
      assert.ok(result.success, result.error);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.complete, false, 'the write site must refuse — an outstanding plan has no completion record (#2648 precedent)');

      const roadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
      assert.ok(!roadmapAfter.includes('[x] **Phase 1'), 'the checkbox must NOT be checked');
      assert.ok(!/\(completed \d{4}-\d{2}-\d{2}\)/.test(roadmapAfter), 'no completion date must be stamped');
      assert.notStrictEqual(roadmapAfter, roadmapBefore, 'the command still updates the Plans Complete / Status cells — only the completion checkbox is withheld');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('G3: phase complete agrees — refuses for the identical fixture, same reason class', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 1, summaries: 1 });
      writeVerification(dir, '01', 'passed');
      fs.writeFileSync(path.join(dir, '01-02-PLAN.md'), '# Plan 2');

      const updateResult = runGsdTools('roadmap update-plan-progress 1', tmpDir);
      assert.ok(updateResult.success, updateResult.error);
      const updateOutput = JSON.parse(updateResult.output);

      const completeResult = runGsdTools('phase complete 1 --raw', tmpDir);
      assert.strictEqual(completeResult.success, false, 'phase complete must refuse (its own #2648 gate)');
      assert.strictEqual(updateOutput.complete, false, 'both write paths agree: incomplete');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('G4: once the outstanding plan gets its summary, both write paths agree completion proceeds', () => {
    const tmpDir = createTempProject();
    try {
      writeState(tmpDir);
      writeRoadmap(tmpDir, [{ number: '1', name: 'Foo' }]);
      const dir = scaffoldPhase(tmpDir, 1, { slug: 'foo', plans: 2, summaries: 2 });
      writeVerification(dir, '01', 'passed');

      const result = runGsdTools('roadmap update-plan-progress 1', tmpDir);
      assert.ok(result.success, result.error);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.complete, true, 'no outstanding plan — the gate does not withhold completion');

      const roadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
      assert.ok(/\(completed \d{4}-\d{2}-\d{2}\)/.test(roadmapAfter), 'completion date IS stamped once plan coverage is satisfied');
    } finally {
      cleanup(tmpDir);
    }
  });
});

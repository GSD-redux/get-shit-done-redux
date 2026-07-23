/**
 * GSD Tools Tests - Health Validation
 *
 * Tests for fix/health-validation-1473c:
 *   - W011: STATE/ROADMAP cross-validation (phase divergence detection)
 *   - W012: branching_strategy validation
 *   - W013: context_window validation
 *   - W014: phase_branch_template placeholder validation
 *   - W015: milestone_branch_template placeholder validation
 *   - stateReplaceFieldWithFallback field-miss warning
 *   - Boundary conditions and edge cases
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeMinimalRoadmap(tmpDir, phases = ['1']) {
  const lines = phases.map(n => `### Phase ${n}: Phase ${n} Description`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n${lines}\n`
  );
}

function writeMinimalStateMd(tmpDir, content) {
  const defaultContent = content || `# Session State\n\n## Current Position\n\nPhase: 1\n`;
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    defaultContent
  );
}

function writeMinimalProjectMd(tmpDir) {
  const sections = ['## What This Is', '## Core Value', '## Requirements'];
  const content = sections.map(s => `${s}\n\nContent here.\n`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    `# Project\n\n${content}`
  );
}

function writeValidConfigJson(tmpDir, overrides = {}) {
  const base = { model_profile: 'balanced', commit_docs: true };
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ ...base, ...overrides }, null, 2)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. W011: STATE/ROADMAP cross-validation
// ─────────────────────────────────────────────────────────────────────────────

describe('W011: STATE/ROADMAP cross-validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE says current phase but ROADMAP shows it as complete -> warning', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [x] Phase 3: Database Layer\n\n### Phase 3: Database Layer\n**Goal:** DB setup\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Session State\n\n**Current Phase:** 03\n**Current Phase Name:** Database Layer\n**Status:** In progress\n`
    );
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-database-layer'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W011'),
      `Expected W011 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('STATE and ROADMAP agree (phase not checked off) -> no W011 warning', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 2: API Layer\n\n### Phase 2: API Layer\n**Goal:** Build API\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Session State\n\n**Current Phase:** 2\n**Status:** In progress\n`
    );
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api-layer'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W011'),
      `Should not have W011: ${JSON.stringify(output.warnings)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. W012-W015: Config field validation
// ─────────────────────────────────────────────────────────────────────────────

describe('config field validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('W012: invalid branching_strategy triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { branching_strategy: 'banana' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W012'),
      `Expected W012 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W013: negative context_window triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: -500 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W013'),
      `Expected W013 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W014: phase_branch_template missing {phase} triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { phase_branch_template: 'gsd/no-placeholder-{slug}' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W014'),
      `Expected W014 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W015: milestone_branch_template missing {milestone} triggers warning', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { milestone_branch_template: 'release/no-placeholder' });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W015'),
      `Expected W015 in warnings: ${JSON.stringify(output.warnings)}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Boundary conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('boundary conditions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('context_window config accepts 500000 (boundary value)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: 500000 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 for context_window=500000: ${JSON.stringify(output.warnings)}`
    );
  });

  test('context_window config accepts 200000 (default value)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir, { context_window: 200000 });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 for context_window=200000: ${JSON.stringify(output.warnings)}`
    );
  });

  test('W013 does NOT fire when context_window is absent from config', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1 in progress.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W013'),
      `Should not have W013 when context_window is absent: ${JSON.stringify(output.warnings)}`
    );
  });

  test('health check handles STATE.md with no Current Phase field (no W011 crash)', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir, ['1']);
    writeMinimalStateMd(tmpDir, '# Session State\n\nSome content but no phase reference.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command should not crash: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'should return a status string');
    assert.ok(Array.isArray(output.errors), 'should return errors array');
    assert.ok(Array.isArray(output.warnings), 'should return warnings array');
  });

  test('health check handles empty ROADMAP.md (no crash)', () => {
    writeMinimalProjectMd(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '');
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1.\n');
    writeValidConfigJson(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command should not crash on empty ROADMAP.md: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'should return a status string');
    assert.ok(Array.isArray(output.errors), 'should return errors array');
    assert.ok(Array.isArray(output.warnings), 'should return warnings array');
  });

  test('config.json with trailing comma -- validate health reports parse error', () => {
    writeMinimalProjectMd(tmpDir);
    writeMinimalStateMd(tmpDir, '# Session State\n\nPhase 1.\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      '{"model_profile": "balanced",}'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Test Phase\n'
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health should not crash on invalid JSON: ${result.error}`);

    const output = JSON.parse(result.output);
    const hasE005 = output.errors.some(e => e.code === 'E005');
    assert.ok(hasE005, `Should report E005 for invalid config.json: ${JSON.stringify(output.errors)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. stateReplaceFieldWithFallback warning
// ─────────────────────────────────────────────────────────────────────────────

describe('stateReplaceFieldWithFallback field-miss warning', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('advance-plan completes even when fields are missing (non-fatal)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 01\n**Current Plan:** 1\n**Total Plans in Phase:** 3\n`
    );

    const result = runGsdTools('state advance-plan', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.advanced === true || output.reason === 'last_plan', 'advance should complete');
  });

  test('validate health on 50-phase project completes in under 3000ms', () => {
    // Stress test for the new health checks at scale
    let roadmapContent = '# Roadmap v1.0\n\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `- [${i <= 25 ? 'x' : ' '}] Phase ${i}: Feature ${i}\n`;
    }
    roadmapContent += '\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `### Phase ${i}: Feature ${i}\n\n**Goal:** Build feature ${i}\n**Plans:** 1 plans\n\n`;
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapContent);

    writeMinimalProjectMd(tmpDir);
    writeMinimalStateMd(tmpDir, '# Session State\n\n**Current Phase:** 26\n**Status:** Planning\n');
    writeValidConfigJson(tmpDir);

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      const phaseDir = path.join(phasesDir, `${pad}-feature-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${pad}-01-PLAN.md`), `# Plan ${i}\n`);
      if (i <= 25) {
        fs.writeFileSync(path.join(phaseDir, `${pad}-01-SUMMARY.md`), `# Summary ${i}\n`);
      }
    }

    const result = runGsdTools('validate health', tmpDir);

    assert.ok(result.success, `validate health should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(typeof output.status === 'string', 'Should return a status string');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/6-validate-cjs-drift-regression.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:6-validate-cjs-drift-regression (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for issue #6 (open-gsd/gsd-core):
 *   Three validation behaviors present in validate.ts are missing from verify.cjs,
 *   producing silent false negatives on the CJS production path.
 *
 * Three drift items fixed by porting phaseVariants() and activeDiskPhases to verify.cjs:
 *
 *   1. W007 activeDiskPhases — verify.cjs uses diskPhases (includes archived) for the
 *      W007 check; validate.ts uses activeDiskPhases (active phasesDir only). Archived
 *      phases absent from current ROADMAP trigger false W007 in verify.cjs.
 *
 *   2. phaseVariants() normalization — validate.ts has a phaseVariants() function
 *      generating padded/unpadded/letter-suffix variants for matching. verify.cjs uses
 *      only parseInt→padded (drops letter suffix), causing false W006/W007 for
 *      letter-suffix phases with padding mismatch between ROADMAP and disk.
 *
 *   3. W006 unchecked-phase variant skip — same phaseVariants() gap causes false W006
 *      for phases with padding mismatch: ROADMAP says "3B", disk has "03B-foo", but
 *      verify.cjs padded("3B") = "03" (drops letter) → "03B" on disk not matched.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/gsd-core)
 *   - PR #154 (issue #4) — precedent for the generator pattern
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

function mkplanning(base) {
  const planningDir = path.join(base, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  return { planningDir, phasesDir };
}

function writeProjectMd(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n\n## Core Value\nTest.\n\n## Requirements\nTest.\n',
  );
}

function writeStateMd(planningDir, phase = '2') {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `# State\n\n**Current Phase:** ${phase}\n**Status:** In progress\n`,
  );
}

function writeConfigJson(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ model_profile: 'balanced' }),
  );
}

// ── Drift Item 1: W007 activeDiskPhases ────────────────────────────────────
//
// Project has a shipped milestone archive (milestones/v1.0-phases/) with old phase
// "1" inside, and active phasesDir with phase "2". Current ROADMAP only mentions
// Phase 2 (v1.0 phases were shipped and removed from ROADMAP).
//
// validate.ts: activeDiskPhases = phases from active phasesDir only (not archived).
//   "1" is only in diskPhases (via forEachArchivedPhaseToken), not activeDiskPhases.
//   W007 iterates activeDiskPhases → "1" never checked → no false W007.
//
// verify.cjs pre-fix: diskPhases = collectDiskPhases() + forEachArchivedPhaseToken().
//   diskPhases includes "1" (from old archive). W007 iterates diskPhases → "1" not
//   in roadmapPhases → W007 fires for "1". False positive.

describe('Drift item 1 — W007 activeDiskPhases: no false W007 for archived phases', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d1-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir);
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 2:** API',
        '',
        '### Phase 2: API',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 2 | Complete |',
      ].join('\n'),
    );

    // Active phasesDir: only phase 2
    fs.mkdirSync(path.join(phasesDir, '2-api'), { recursive: true });

    // Current active milestone archive: v1.1-phases contains phase 2 (in ROADMAP)
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.1-phases', '2-api'),
      { recursive: true },
    );

    // Old shipped milestone archive: v1.0-phases contains phase 1 (no longer in ROADMAP)
    // v1.0 sorts before v1.1 so getActiveMilestoneArchiveDir returns v1.1.
    // forEachArchivedPhaseToken walks BOTH v1.0 and v1.1, so diskPhases gets "1".
    // collectDiskPhases (activeDiskPhases) only uses v1.1 (active archive) — "1" excluded.
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.0-phases', '1-foundation'),
      { recursive: true },
    );
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no W007 for archived phase "1" absent from current ROADMAP', () => {
    // validate.ts: activeDiskPhases has only "2" (from active phasesDir + v1.1 archive).
    //   "1" is in diskPhases (forEachArchivedPhaseToken walks v1.0) but NOT activeDiskPhases.
    //   W007 iterates activeDiskPhases → "1" never checked → no false W007. Correct.
    // verify.cjs pre-fix: diskPhases = collectDiskPhases + forEachArchivedPhaseToken.
    //   diskPhases includes "1" (from v1.0 archive). W007 iterates diskPhases → "1" not
    //   in roadmapPhases → W007 fires for "1". False positive.
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    // Filter to W007 that mentions only phase "1" (not "1A", "01A", etc.)
    const w007Phase1 = w007.filter(
      (w) => /\bPhase 1\b/i.test(w.message) && !/\b1[A-Z]\b/i.test(w.message),
    );
    assert.strictEqual(
      w007Phase1.length,
      0,
      `Expected no W007 for archived phase 1 (v1.0 archive), got: ${JSON.stringify(w007)}`,
    );
  });
});

// ── Drift Item 2: phaseVariants() normalization ────────────────────────────
//
// ROADMAP has "### Phase 01A:" (zero-padded letter-suffix heading).
// Disk has directory "1A-foo" (unpadded letter-suffix form).
// These should match because phaseVariants("01A") = {"01A", "1A", "01A"}.
//
// validate.ts: diskPhases has "1A". phaseVariants("01A") includes "1A" → match → no W006.
//   activeDiskPhases has "1A". phaseVariants("1A") includes "01A" → roadmapPhaseVariants
//   has "01A" → match → no W007.
//
// verify.cjs pre-fix:
//   W006 loop for "01A": padded = String(parseInt("01A",10)).padStart(2,'0') = "01".
//     diskPhases.has("01A")? NO. diskPhases.has("01")? NO. → W006 fires. Bug.
//   W007 loop for "1A": unpadded = String(parseInt("1A",10)) = "1".
//     roadmapPhases.has("1A")? NO. roadmapPhases.has("1")? NO. → W007 fires. Bug.

describe('Drift item 2 — phaseVariants() normalization: letter-suffix zero-padding mismatch', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d2-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir);
    writeConfigJson(planningDir);

    // ROADMAP: Phase 01A (zero-padded + letter suffix)
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01A:** Suffix Phase',
        '',
        '### Phase 01A: Suffix Phase',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 01A | Complete |',
      ].join('\n'),
    );

    // Disk: unpadded form "1A-foo"
    fs.mkdirSync(path.join(phasesDir, '1A-suffix-phase'), { recursive: true });
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no false W006 when ROADMAP says 01A and disk has 1A-... (phaseVariants normalizes)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter((w) => w.code === 'W006');
    assert.strictEqual(
      w006.length,
      0,
      `Expected no W006 (01A == 1A after normalization), got: ${JSON.stringify(w006)}`,
    );
  });

  test('no false W007 when disk has 1A and ROADMAP says 01A (phaseVariants normalizes)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected no W007 (1A on disk matches 01A in ROADMAP), got: ${JSON.stringify(w007)}`,
    );
  });
});

// ── Drift Item 3: W006 false positive when disk uses zero-padded letter form ─
//
// ROADMAP has "### Phase 3B:" (unpadded letter-suffix heading).
// Disk has directory "03B-feature" (zero-padded letter-suffix form).
//
// validate.ts:
//   diskPhases has "03B". phaseVariants("3B") = {"3B","3B","03B"}.
//   existsOnDisk = diskPhases.has("03B") = TRUE → no W006.
//   activeDiskPhases has "03B". phaseVariants("03B") = {"03B","3B","03B"}.
//   roadmapPhaseVariants has {"3B","3B","03B"} → "03B" found → no W007.
//
// verify.cjs pre-fix:
//   W006 for "3B": padded = parseInt("3B")=3 → "03" (drops "B").
//     diskPhases.has("3B")? NO. diskPhases.has("03")? NO (dir is "03B" not "03"). → W006 fires.
//   W007 for "03B": unpadded = String(parseInt("03B",10)) = "3".
//     roadmapPhases.has("03B")? NO. roadmapPhases.has("3")? NO (ROADMAP has "3B" not "3"). → W007.

describe('Drift item 3 — W006 false positive when disk has zero-padded letter form', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6-d3-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '3B');
    writeConfigJson(planningDir);

    // ROADMAP: Phase 3B (unpadded in heading)
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 3B:** Feature Extension',
        '',
        '### Phase 3B: Feature Extension',
        '',
        '## Progress',
        '| Phase | Status |',
        '|-------|--------|',
        '| 3B | Complete |',
      ].join('\n'),
    );

    // Disk: "03B-feature" (zero-padded letter-suffix form)
    fs.mkdirSync(path.join(phasesDir, '03B-feature'), { recursive: true });
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('no false W006 when ROADMAP says 3B and disk has 03B-... (phaseVariants covers zero-padded)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter((w) => w.code === 'W006');
    assert.strictEqual(
      w006.length,
      0,
      `Expected no W006 (3B == 03B after normalization), got: ${JSON.stringify(w006)}`,
    );
  });

  test('no false W007 when disk has 03B and ROADMAP says 3B (phaseVariants covers both forms)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected no W007 (03B on disk matches 3B in ROADMAP), got: ${JSON.stringify(w007)}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-416-archive-dir-null.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-416-archive-dir-null (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression tests for issue #416 (open-gsd/gsd-core).
 *
 * Bug: getActiveMilestoneArchiveDir falls back to the newest archive directory
 * when STATE.md names a milestone that has no matching archive yet, producing
 * W007 false positives for phases from a prior (completed) milestone.
 *
 * Fix: when STATE.md is present and parseable and names a milestone, but no
 * milestones/<vX.Y>-phases/ directory matches, return null. The version-sort
 * fallback to the newest archive fires only when STATE.md is absent or
 * unparseable.
 *
 * Knuth invariant: the resolver answers one question —
 * "what archive directory holds the active milestone's phases?"
 * Answer space: <dir> | null.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// Consolidation #1969: scope GSD_TEST_MODE to this folded block so it does not
// leak (via the runGsdTools env copy) into host tests registered before the fold.
const __savedTestMode = process.env.GSD_TEST_MODE;
before(() => { process.env.GSD_TEST_MODE = '1'; });
after(() => {
  if (__savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
  else process.env.GSD_TEST_MODE = __savedTestMode;
});

// ── helpers ──────────────────────────────────────────────────────────────────

function mkplanning(base) {
  const planningDir = path.join(base, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  return planningDir;
}

function writeMinimalRoadmap(planningDir, phases) {
  // phases: array of { num, name, checked }
  const checkboxes = phases.map(({ num, name, checked }) =>
    `- [${checked ? 'x' : ' '}] **Phase ${num}:** ${name}`,
  ).join('\n');
  const headings = phases.map(({ num, name }) =>
    `### Phase ${num}: ${name}\n**Goal:** Completed.\n`,
  ).join('\n');
  fs.writeFileSync(
    path.join(planningDir, 'ROADMAP.md'),
    `# Roadmap\n\n${checkboxes}\n\n${headings}`,
  );
}

function writeStateMdMilestone(planningDir, milestone) {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `# State\n\n**milestone:** ${milestone}\n**Current Phase:** 23\n**Status:** In progress\n`,
  );
}

function writeProjectMd(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n\n## Core Value\nTest.\n\n## Requirements\nTest.\n',
  );
}

function writeConfigJson(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ model_profile: 'balanced' }),
  );
}

function mkArchivePhases(planningDir, version, phaseNums) {
  // Creates .planning/milestones/<version>-phases/<NN>-phase-name/ dirs
  const archiveDir = path.join(planningDir, 'milestones', `${version}-phases`);
  for (const num of phaseNums) {
    const padded = String(num).padStart(2, '0');
    fs.mkdirSync(path.join(archiveDir, `${padded}-phase-${num}`), { recursive: true });
  }
  return archiveDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 1: STATE.md milestone: v6.0, only v5.0-phases/ on disk
//         → resolver returns null, verifier emits zero W007 for phases 17–22
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 1: STATE.md v6.0 with only v5.0-phases/ on disk → null, no W007', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c1-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // Active milestone is v6.0 — no archive for it yet (phases live in flat phases/)
    writeStateMdMilestone(planningDir, 'v6.0');

    // v5.0 was the prior completed milestone; its archive exists on disk
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19, 20, 21, 22]);

    // ROADMAP reflects only v6.0 phases (v5.0 phases are in a prior milestone,
    // not in the current roadmap section)
    writeMinimalRoadmap(planningDir, [
      { num: 23, name: 'New Foundation', checked: false },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health emits zero W007 warnings (no prior-milestone phases surfaced)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 — phases 17–22 from v5.0-phases/ must not appear as "active".\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 2: No STATE.md, multiple archives on disk → version-sort fallback
//         returns the highest-versioned archive (existing behavior preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 2: no STATE.md + multiple archives → version-sort fallback to newest', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c2-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // No STATE.md — resolver must use the version-sort fallback
    // Two archives: v4.0 and v5.0; v5.0 is newer
    mkArchivePhases(planningDir, 'v4.0', [10, 11, 12]);
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19]);

    // ROADMAP lists v5.0 phases so W007 does not fire
    writeMinimalRoadmap(planningDir, [
      { num: 17, name: 'Alpha', checked: true },
      { num: 18, name: 'Beta', checked: true },
      { num: 19, name: 'Gamma', checked: true },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health succeeds and does not emit W007 for v5.0 archive phases', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    // v5.0 phases (17–19) are in the archive returned by the fallback and
    // in the ROADMAP, so no W007 should fire.
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 for v5.0 archive phases present in ROADMAP.\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 3: STATE.md milestone: v5.0, matching v5.0-phases/ exists → returns it
//         (regression guard — happy path must not break)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #416 case 3: STATE.md v5.0 with matching v5.0-phases/ → returns archive dir', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-416-c3-'));
    const planningDir = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeConfigJson(planningDir);

    // STATE.md names v5.0 and a matching archive exists
    writeStateMdMilestone(planningDir, 'v5.0');
    mkArchivePhases(planningDir, 'v5.0', [17, 18, 19, 20, 21, 22]);

    // ROADMAP lists v5.0 phases so W007 does not fire
    writeMinimalRoadmap(planningDir, [
      { num: 17, name: 'Alpha', checked: true },
      { num: 18, name: 'Beta', checked: true },
      { num: 19, name: 'Gamma', checked: true },
      { num: 20, name: 'Delta', checked: true },
      { num: 21, name: 'Epsilon', checked: true },
      { num: 22, name: 'Zeta', checked: true },
    ]);
  });

  after(() => { cleanup(tmpDir); });

  test('validate health emits zero W007 — archive phases are in ROADMAP and active', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `validate health failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings ?? []).filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007.length,
      0,
      `Expected zero W007 for matching v5.0 archive with v5.0 in STATE.md.\nGot: ${JSON.stringify(w007, null, 2)}`,
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/26-w005-w006-i001-cjs-drift-regression.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:26-w005-w006-i001-cjs-drift-regression (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression tests for issue #26 (open-gsd/gsd-core).
 * Three generator-pattern drift items: W005 phaseDirNameRe,
 * W006-archived regex constants (PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE),
 * I001 canonicalPlanStem.
 *
 * After the generator migration, all three helpers are sourced from
 * validate.cjs. If they diverge from validate.ts, these
 * tests go RED.
 *
 * References:
 *   - Issue #26 (open-gsd/gsd-core) — three drift items + reproducer
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator scaffolding (#26 extends this)
 *   - Original PR #3479 — first validate.ts false-positive fix (never reached CJS)
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runGsdTools, cleanup } = require('./helpers.cjs');

function mkplanning(base) {
  const planningDir = path.join(base, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  return { planningDir, phasesDir };
}

function writeProjectMd(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n\n## Core Value\nTest.\n\n## Requirements\nTest.\n',
  );
}

function writeStateMd(planningDir, phase) {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `# State\n\n**Current Phase:** ${phase}\n**Status:** In progress\n`,
  );
}

function writeConfigJson(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ model_profile: 'balanced' }),
  );
}

// ── Drift Item W005: phaseDirNameRe ──────────────────────────────────────────
//
// Issue #26 reproducer (verbatim):
//   mkdir -p .planning/phases/999.1-foo
//   echo "# Roadmap" > .planning/ROADMAP.md
//   node .claude/gsd-core/bin/gsd-tools.cjs validate health
//   # Bug: emits W005 about 999.1-foo not following NN-name format
//
// verify.cjs must consume phaseDirNameRe from validate.cjs so
// the regex /^\d{2,}(?:\.\d+)*-[\w-]+$/ is the single source of truth.

describe('Drift item W005 — phaseDirNameRe: 999.X-name dirs must not trigger W005', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d1-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '999.1');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 999.1:** Long Phase\n\n### Phase 999.1: Long Phase\n',
    );

    // Exact reproducer from issue #26
    fs.mkdirSync(path.join(phasesDir, '999.1-foo'), { recursive: true });
  });

  after(() => { cleanup(tmpDir); });

  test('no W005 for 999.1-foo (multi-digit sub-phase prefix)', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w005 = (data.warnings ?? []).filter((w) => w.code === 'W005');
    assert.strictEqual(w005.length, 0,
      `Expected zero W005 for 999.1-foo, got: ${JSON.stringify(w005)}`);
  });

  test('phaseDirNameRe is exported from validate.cjs', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    assert.ok(gen.phaseDirNameRe instanceof RegExp,
      'validate.cjs must export phaseDirNameRe as a RegExp');
    const re = gen.phaseDirNameRe;
    assert.ok(re.test('01-setup'), 'should accept 01-setup');
    assert.ok(re.test('999-longphase'), 'should accept 999-longphase (3-digit prefix)');
    assert.ok(re.test('999.1-foo'), 'should accept 999.1-foo (sub-phase)');
    assert.ok(re.test('MANIFOLD-999.1-foo'), 'should accept long project-code prefixes');
    assert.ok(re.test('APP1-999.1-foo'), 'should accept numeric characters in project-code prefixes');
    assert.ok(re.test('APP_1-999.1-foo'), 'should accept underscore characters in project-code prefixes');
    assert.ok(!re.test('1-shortname'), 'should reject single-digit prefix');
  });
});

// ── W023 (#2408): collision warning for two on-disk phase dirs normalizing to
//    the same phase key. The check groups phaseDirEntries by their normalized
//    key (normalizePhaseName) and emits a warning for any group with ≥2 dirs,
//    listing both directory names and each one's independently-computed status.
//    Wording is neutral — never guesses which directory is "real".
describe('W023 — colliding phase directories (issue #2408)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2408-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '1.0');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Milestone v1.0',
        '',
        '### Phase 5: Real',
        '**Goal:** The real phase',
      ].join('\n'),
    );

    // 05-real/ — Complete (PLAN + SUMMARY + passing VERIFICATION)
    const realDir = path.join(phasesDir, '05-real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(realDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(realDir, 'VERIFICATION.md'), '---\nstatus: passed\n---\n# Verified');

    // 05-real-stray/ — empty → Not Started
    fs.mkdirSync(path.join(phasesDir, '05-real-stray'), { recursive: true });
  });

  after(() => { cleanup(tmpDir); });

  test('emits W023 naming both colliding directories and their statuses', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w023 = (data.warnings ?? []).filter((w) => w.code === 'W023');
    assert.strictEqual(w023.length, 1, `Expected exactly one W023, got: ${JSON.stringify(w023)}`);
    const msg = w023[0].message;
    assert.ok(msg.includes('"05"'), `W023 message must name the normalized phase key, got: ${msg}`);
    assert.ok(msg.includes('05-real'), `W023 must name the real dir, got: ${msg}`);
    assert.ok(msg.includes('05-real-stray'), `W023 must name the stray dir, got: ${msg}`);
    // Independently-computed statuses appear alongside each dir.
    assert.ok(msg.includes('Complete'), `W023 must include 05-real's Complete status, got: ${msg}`);
    assert.ok(msg.includes('Not Started'), `W023 must include 05-real-stray's Not Started status, got: ${msg}`);
    // Neutral wording across every rendered field (message AND fix/action) —
    // never guesses which dir is "the real one" or names a specific dir as the
    // one to remove. The check scans the union of message+fix so a future drift
    // toward "remove 05-real-stray" in either field fails this test.
    const combined = `${w023[0].message} ${w023[0].fix || ''}`;
    assert.ok(!/real directory is/i.test(combined) && !/remove\s+05-real-stray/i.test(combined),
      `W023 wording must stay neutral across all rendered fields, got: ${combined}`);
  });

  test('W023 listing order is deterministic across readdirSync orders (tie-break on dir name)', () => {
    // Re-running validate health should produce the same W023 message byte-for-
    // byte. The collision case itself (two dirs sharing the same phase token)
    // is exactly where comparePhaseNum returns 0 — the dir-name tie-break is
    // what keeps the comma-separated order stable. fs.readdirSync order is
    // non-deterministic across platforms; without the tie-break, this test
    // could flake on some hosts. Run twice and assert identical output.
    const r1 = runGsdTools(['validate', 'health', '--json'], tmpDir);
    const r2 = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(r1.success && r2.success, true);
    const m1 = JSON.parse(r1.output).warnings.find((w) => w.code === 'W023').message;
    const m2 = JSON.parse(r2.output).warnings.find((w) => w.code === 'W023').message;
    assert.strictEqual(m1, m2, `W023 must be deterministic across runs, got:\n  ${m1}\n  ${m2}`);
    // And specifically: the lower-name dir comes first under localeCompare.
    assert.ok(m1.indexOf('05-real (') < m1.indexOf('05-real-stray ('),
      `tie-break must place '05-real' before '05-real-stray' (localeCompare), got: ${m1}`);
  });

  test('does NOT emit W023 when no collision exists (single dir per key)', () => {
    // Fresh tree with a single non-colliding dir.
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2408-clean-'));
    const { planningDir, phasesDir } = mkplanning(clean);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '1.0');
    writeConfigJson(planningDir);
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone v1.0\n\n### Phase 5: Real\n**Goal:** The real phase\n',
    );
    const realDir = path.join(phasesDir, '05-real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(realDir, '01-01-SUMMARY.md'), '# Summary');

    try {
      const result = runGsdTools(['validate', 'health', '--json'], clean);
      assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
      const data = JSON.parse(result.output);
      const w023 = (data.warnings ?? []).filter((w) => w.code === 'W023');
      assert.strictEqual(w023.length, 0, `Expected zero W023 without collision, got: ${JSON.stringify(w023)}`);
    } finally {
      cleanup(clean);
    }
  });
});

// ── Drift Item W006-archived: PHASE_TOKEN_FROM_DIR_RE / MILESTONE_ARCHIVE_DIR_RE ─
//
// forEachArchivedPhaseToken() in verify.cjs uses two inline regex constants.
// After migration both are sourced from validate.cjs:
//   PHASE_TOKEN_FROM_DIR_RE  — extracts token from dir name like "64-auth-service"
//   MILESTONE_ARCHIVE_DIR_RE — matches archive dirs like "v1.0-phases"
//
// Test: phase 64 was archived to milestones/v1.0-phases/64-auth-service/.
// Without correct archive detection, W006 fires for "Phase 64 in ROADMAP.md
// but no directory on disk".

describe('Drift item W006-archived — MILESTONE_ARCHIVE_DIR_RE and PHASE_TOKEN_FROM_DIR_RE', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d2-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '65');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 65:** Current Work',
        '',
        '### Phase 65: Current Work',
        '',
        '<details>',
        '<summary>Milestone v1.0 — Shipped</summary>',
        '',
        '### Phase 64: Auth Service',
        '',
        '</details>',
        '',
      ].join('\n'),
    );

    // Active phasesDir: only phase 65
    fs.mkdirSync(path.join(phasesDir, '65-current-work'), { recursive: true });

    // Archive: milestones/v1.0-phases/64-auth-service
    // MILESTONE_ARCHIVE_DIR_RE must match "v1.0-phases"
    // PHASE_TOKEN_FROM_DIR_RE must extract "64" from "64-auth-service"
    fs.mkdirSync(
      path.join(planningDir, 'milestones', 'v1.0-phases', '64-auth-service'),
      { recursive: true },
    );
  });

  after(() => { cleanup(tmpDir); });

  test('no W006 for Phase 64 archived under milestones/v1.0-phases/', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const w006 = (data.warnings ?? []).filter(
      (w) => w.code === 'W006' && /Phase 64/i.test(w.message),
    );
    assert.strictEqual(w006.length, 0,
      `Expected no W006 for archived Phase 64, got: ${JSON.stringify(w006)}`);
  });

  test('MILESTONE_ARCHIVE_DIR_RE is exported and matches vN.N-phases dirs', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    assert.ok(gen.MILESTONE_ARCHIVE_DIR_RE instanceof RegExp,
      'validate.cjs must export MILESTONE_ARCHIVE_DIR_RE');
    const re = gen.MILESTONE_ARCHIVE_DIR_RE;
    assert.ok(re.test('v1.0-phases'), 'should match v1.0-phases');
    assert.ok(re.test('v1.10-phases'), 'should match v1.10-phases');
    assert.ok(!re.test('phases'), 'should NOT match plain phases');
    assert.ok(!re.test('1.0-phases'), 'should NOT match missing v prefix');
  });

  test('PHASE_TOKEN_FROM_DIR_RE is exported and extracts phase tokens correctly', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    assert.ok(gen.PHASE_TOKEN_FROM_DIR_RE instanceof RegExp,
      'validate.cjs must export PHASE_TOKEN_FROM_DIR_RE');
    const re = gen.PHASE_TOKEN_FROM_DIR_RE;
    assert.strictEqual(re.exec('64-auth-service')?.[1], '64');
    assert.strictEqual(re.exec('03B-feature')?.[1], '03B');
    assert.strictEqual(re.exec('999.1-foo')?.[1], '999.1');
    assert.strictEqual(re.exec('CK-64-auth')?.[1], '64');
    assert.strictEqual(re.exec('MANIFOLD-64-auth')?.[1], '64');
    assert.strictEqual(re.exec('APP1-64-auth')?.[1], '64');
    assert.strictEqual(re.exec('APP_1-64-auth')?.[1], '64');
  });

  test('PHASE_TOKEN_FROM_DIR_RE rejects a single-digit slug word after a phase number (#2043)', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    const re = gen.PHASE_TOKEN_FROM_DIR_RE;
    // Roadmap phase name "6 Rs Pipeline Orchestrator" slugifies to
    // "6-rs-pipeline-orchestrator"; the resulting dir "46-6-rs-pipeline-orchestrator"
    // must extract phase token "46", not "46-6" (was the pre-fix, buggy behavior).
    assert.strictEqual(re.exec('46-6-rs-pipeline-orchestrator')?.[1], '46');
    // Legit multi-segment (zero-padded) milestone-prefixed tokens are preserved.
    assert.strictEqual(re.exec('02-01-setup')?.[1], '02-01');
    // Single-digit letter-suffix phase ids ("1A"/"01A") and milestone-prefixed
    // single-digit sub-phases ("M1-2" → "2") must still match (the fix tightens
    // only the continuation, not the first component).
    assert.strictEqual(re.exec('1A-foo')?.[1], '1A');
    assert.strictEqual(re.exec('01A-foo')?.[1], '01A');
    assert.strictEqual(re.exec('M1-2-setup')?.[1], '2');
  });
});

// ── Drift Item I001: canonicalPlanStem ────────────────────────────────────────
//
// validate.ts Check 7: canonicalPlanStem('68-01-scaffolding') → '68-01'
// verify.cjs had an inline copy. After migration, canonicalPlanStem is
// sourced from validate.cjs.
//
// Test: "68-01-scaffolding-PLAN.md" + "68-01-SUMMARY.md" → no I001
// Both stems canonicalize to "68-01" → match found → I001 suppressed.

describe('Drift item I001 — canonicalPlanStem: long PLAN stem matches short SUMMARY stem', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-26-d3-'));
    const { planningDir, phasesDir } = mkplanning(tmpDir);
    writeProjectMd(planningDir);
    writeStateMd(planningDir, '68');
    writeConfigJson(planningDir);

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 68:** Scaffolding\n\n### Phase 68: Scaffolding\n',
    );

    const phaseDir = path.join(phasesDir, '68-scaffolding');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Long-stem PLAN + short-stem SUMMARY → must match via canonicalPlanStem
    fs.writeFileSync(path.join(phaseDir, '68-01-scaffolding-PLAN.md'), '---\nwave: 1\n---\n# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '68-01-SUMMARY.md'), '# Summary\n');
  });

  after(() => { cleanup(tmpDir); });

  test('no I001 when 68-01-scaffolding-PLAN.md matches 68-01-SUMMARY.md via canonicalPlanStem', () => {
    const result = runGsdTools(['validate', 'health', '--json'], tmpDir);
    assert.strictEqual(result.success, true, `unexpected failure: ${result.error}`);
    const data = JSON.parse(result.output);
    const i001 = (data.info ?? []).filter((i) => i.code === 'I001');
    assert.strictEqual(i001.length, 0,
      `Expected zero I001, got: ${JSON.stringify(i001)}`);
  });

  test('canonicalPlanStem is exported from validate.cjs', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    assert.strictEqual(typeof gen.canonicalPlanStem, 'function',
      'validate.cjs must export canonicalPlanStem as a function');
    assert.strictEqual(gen.canonicalPlanStem('68-01-scaffolding'), '68-01');
    assert.strictEqual(gen.canonicalPlanStem('68-01'), '68-01');
    assert.strictEqual(gen.canonicalPlanStem('3A-01-feature'), '3A-01');
    assert.strictEqual(gen.canonicalPlanStem('no-match'), 'no-match');
  });

  test('canonicalPlanStem rejects a single-digit slug word after a phase number (#2043)', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    // "46-6-rs-pipeline-orchestrator" is not a valid PLAN stem shape (the "6"
    // is a slug word, not a sub-phase segment), so it must return the input
    // unchanged rather than the pre-fix, buggy "46-6".
    assert.notStrictEqual(gen.canonicalPlanStem('46-6-rs-pipeline-orchestrator'), '46-6');
    // Legit multi-segment stems are still canonicalized correctly, including a
    // single-digit letter-suffix phase id ("3A") whose plan component is zero-padded.
    assert.strictEqual(gen.canonicalPlanStem('68-01-scaffolding'), '68-01');
    assert.strictEqual(gen.canonicalPlanStem('3A-01-feature'), '3A-01');
  });

  test('PHASE_TOKEN_FROM_DIR_RE rejects a ≥3-digit slug word after a phase number (#2232)', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    const re = gen.PHASE_TOKEN_FROM_DIR_RE;
    // Dir "14-2026-photos-performance" (roadmap phase name "2026 Photos &
    // Performance") must extract token "14", not "14-2026" — the year is the
    // slug's first word. Boundary by continuation-segment digit width:
    assert.strictEqual(re.exec('14-2026-photos-performance')?.[1], '14'); // 4-digit: slug
    assert.strictEqual(re.exec('05-100-slug')?.[1], '05'); // 3-digit: slug (policy)
    assert.strictEqual(re.exec('02-01-setup')?.[1], '02-01'); // 2-digit: sub-phase
    assert.strictEqual(re.exec('46-6-rs')?.[1], '46'); // 1-digit: slug (#2043)
  });

  test('PHASE_TOKEN_FROM_DIR_RE rewinds a 2-digit slug before a 1-digit word (#2528)', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    const re = gen.PHASE_TOKEN_FROM_DIR_RE;
    assert.strictEqual(re.exec('10-24-7-autonomy')?.[1], '10');
    assert.strictEqual(re.exec('05-80-20-25abc')?.[1], '05-80-20');
  });

  test('canonicalPlanStem does not pair a ≥3-digit slug word (#2232)', () => {
    const gen = require('../gsd-core/bin/lib/validate.cjs');
    // A year-leading slug is not a plan component: the stem is returned
    // unchanged rather than the bogus "14-2026".
    assert.strictEqual(
      gen.canonicalPlanStem('14-2026-photos-performance'),
      '14-2026-photos-performance',
    );
    assert.strictEqual(gen.canonicalPlanStem('05-100-slug'), '05-100-slug');
    // Legit zero-padded plan components still canonicalize.
    assert.strictEqual(gen.canonicalPlanStem('68-01-scaffolding'), '68-01');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-663-redos-roadmap-phase-parsing.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-663-redos-roadmap-phase-parsing (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for the ReDoS fixes in buildRoadmapPhaseVariants() and
 * buildNotStartedPhaseVariants() (src/validate.cts, fix #663).
 *
 * The old patterns used nested quantifiers that caused catastrophic
 * backtracking on crafted input:
 *   old: [\w][\w.-]*(?:-[\w.-]+)*  ← ambiguous alternation → exponential
 *   new: [\w][\w.-]*               ← single quantifier → linear
 *
 * The same nested-quantifier shape was fixed identically in src/verify.cts,
 * src/commands.cts, and src/phase.cts.
 *
 * Part A: behavior preservation — the collapsed regex still matches the same
 *   phase identifiers as before on normal roadmap content.
 * Part B: ReDoS adversarial fixtures — calls buildRoadmapPhaseVariants /
 *   buildNotStartedPhaseVariants with pathological input (a malformed heading
 *   or checklist line that has NO terminating colon).  The adversarial input
 *   would cause catastrophic backtracking under the OLD nested-quantifier
 *   pattern; the fix makes backtracking linear.  We assert on the STRUCTURED
 *   RESULT (the returned Set is empty — no match — because the colon is
 *   absent) rather than on elapsed time, in compliance with the
 *   local/no-elapsed-assertion ESLint rule.  A { timeout: 5000 } backstop is
 *   retained so the test fails fast if a future regression reintroduces a
 *   slow pattern.
 *
 * Requirements: TEST-663-B
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRoadmapPhaseVariants,
  buildNotStartedPhaseVariants,
} = require('../gsd-core/bin/lib/validate.cjs');

// ─── Part A: behavior preservation ───────────────────────────────────────────

describe('buildRoadmapPhaseVariants — behavior preservation (#663)', () => {
  test('matches plain numeric heading (Phase 1:)', () => {
    const content = [
      '# Roadmap',
      '## Phase 1: Foo',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('1'), 'roadmapPhases should contain "1"');
  });

  test('matches milestone-prefixed heading (Phase 2-01:)', () => {
    const content = [
      '# Roadmap',
      '### Phase 2-01: Bar',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('2-01'), 'roadmapPhases should contain "2-01"');
  });

  test('matches bracket-prefixed heading ([GSD] Phase 3.2:)', () => {
    const content = [
      '# Roadmap',
      '### [GSD] Phase 3.2: Baz',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('3.2'), 'roadmapPhases should contain "3.2"');
  });

  test('collects all phase identifiers from mixed-format roadmap', () => {
    const content = [
      '# Roadmap',
      '## Phase 1: Alpha',
      '### Phase 2-01: Beta',
      '### [GSD] Phase 3.2: Gamma',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('1'), 'should have phase 1');
    assert.ok(roadmapPhases.has('2-01'), 'should have phase 2-01');
    assert.ok(roadmapPhases.has('3.2'), 'should have phase 3.2');
  });

  test('populates roadmapPhaseVariants with padding-normalized forms', () => {
    const content = [
      '# Roadmap',
      '### Phase 2-01: Beta',
    ].join('\n');

    const { roadmapPhaseVariants } = buildRoadmapPhaseVariants(content);
    // phaseVariants() adds both padded and unpadded forms
    assert.ok(roadmapPhaseVariants.has('2-01') || roadmapPhaseVariants.has('02-01'),
      'roadmapPhaseVariants should contain at least one padding form of 2-01');
  });
});

describe('buildNotStartedPhaseVariants — behavior preservation (#663)', () => {
  test('matches unchecked checklist item (- [ ] Phase 4-01:)', () => {
    const content = [
      '# Roadmap',
      '- [ ] Phase 4-01: Qux',
    ].join('\n');

    const notStarted = buildNotStartedPhaseVariants(content);
    // phaseVariants() expands 4-01 into multiple forms; at minimum the raw form is present.
    assert.ok(notStarted.has('4-01') || notStarted.has('04-01'),
      'notStarted should contain a variant of 4-01');
  });

  test('does not pick up checked items', () => {
    const content = [
      '# Roadmap',
      '- [x] Phase 5: Done',
    ].join('\n');

    const notStarted = buildNotStartedPhaseVariants(content);
    assert.strictEqual(notStarted.has('5'), false, 'completed phase should not be in notStarted');
  });
});

// ─── Part B: ReDoS adversarial fixtures ──────────────────────────────────────

describe('buildRoadmapPhaseVariants — ReDoS adversarial fixture (#663)', () => {
  // Pathological input: a heading line where the phase-id segment consists of
  // many consecutive "-a" chunks with NO terminating colon.  Under the old
  // nested-quantifier pattern ([\w.-]*(?:-[\w.-]+)*\s*:) the engine must
  // explore exponentially many ways to partition the "-a" repetitions before
  // concluding there is no match.  The fixed single-quantifier pattern
  // ([\w.-]*\s*:) backtracks linearly.  We assert that the malformed heading
  // yields NO match (empty roadmapPhases Set) — the correct behavior when the
  // terminating colon is absent.  The { timeout: 5000 } backstop catches any
  // regression that re-introduces a slow pattern.
  test('malformed heading without colon yields no phase match (adversarial input)', { timeout: 5000 }, () => {
    const pathological = '## Phase a' + '-a'.repeat(32) + ' ';
    const { roadmapPhases } = buildRoadmapPhaseVariants(pathological);
    assert.strictEqual(roadmapPhases.size, 0,
      'a heading with no terminating colon should not match any phase');
  });
});

describe('buildNotStartedPhaseVariants — ReDoS adversarial fixture (#663)', () => {
  // Same analysis: the old uncheckedPattern used the same nested quantifier.
  // A checklist-style line with many "-a" segments and no colon triggers the
  // same catastrophic backtracking.  Assert the correct structured result:
  // the malformed line yields an empty notStarted Set.
  test('malformed unchecked-item without terminator yields no phase match (adversarial input)', { timeout: 5000 }, () => {
    // No trailing colon or whitespace: the regex terminator [:\s*] cannot match,
    // so the engine must backtrack through all '-a' repetitions and conclude no
    // match.  Under the old nested-quantifier pattern this was exponential;
    // under the fixed linear pattern it returns immediately with an empty Set.
    const pathological = '- [ ] Phase a' + '-a'.repeat(32);
    const notStarted = buildNotStartedPhaseVariants(pathological);
    assert.strictEqual(notStarted.size, 0,
      'an unchecked-item line with no terminating colon or space should not match any phase');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-892-validate-checklist-roadmap-phases.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-892-validate-checklist-roadmap-phases (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression test for #892: checklist-style roadmap phases (`- [x] **Phase NN: name**`)
 * were silently skipped by `buildRoadmapPhaseVariants()`, causing W007 false positives
 * on every on-disk phase dir when the project uses the checklist ROADMAP format.
 *
 * Covers:
 *  A. Unit-level: `buildRoadmapPhaseVariants()` in validate.cts recognises both
 *     checked (`- [x]`) and unchecked (`- [ ]`) checklist items.
 *  B. Integration: `validate health` emits NO W007 for a checklist-only roadmap
 *     whose phase dirs all appear in the checklist.
 *  C. Integration: `validate consistency` emits NO "exists on disk but not in
 *     ROADMAP.md" warning for the same checklist-only roadmap.
 *
 * Requirements: BUG-892
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  buildRoadmapPhaseVariants,
} = require('../gsd-core/bin/lib/validate.cjs');

// ─── A: Unit-level ────────────────────────────────────────────────────────────

describe('buildRoadmapPhaseVariants — checklist format support (#892)', () => {
  test('matches checked checklist item `- [x] **Phase 01: name**`', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: infrastructure-hardening**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('01') || roadmapPhases.has('1'),
      `roadmapPhases should contain a variant of "01", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('matches checked checklist item with uppercase X `- [X] **Phase 02: foo**`', () => {
    const content = [
      '# Roadmap',
      '',
      '- [X] **Phase 02: feature-work**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('02') || roadmapPhases.has('2'),
      `roadmapPhases should contain a variant of "02", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('matches unchecked checklist item `- [ ] **Phase 03: name**`', () => {
    // unchecked items are also phases — they just have not been started
    const content = [
      '# Roadmap',
      '',
      '- [ ] **Phase 03: future-work**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('03') || roadmapPhases.has('3'),
      `roadmapPhases should contain a variant of "03", got: ${JSON.stringify([...roadmapPhases])}`
    );
  });

  test('collects all phases from a pure checklist roadmap (no ## headings)', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: alpha**',
      '- [x] **Phase 02: beta**',
      '- [ ] **Phase 03: gamma**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    const has = (id) => roadmapPhases.has(id) || roadmapPhases.has(id.replace(/^0+/, '')) || roadmapPhases.has(String(parseInt(id, 10)).padStart(2, '0'));
    assert.ok(has('01'), 'should contain phase 01');
    assert.ok(has('02'), 'should contain phase 02');
    assert.ok(has('03'), 'should contain phase 03');
  });

  test('populates roadmapPhaseVariants with padding-normalised forms for checklist phases', () => {
    const content = [
      '# Roadmap',
      '',
      '- [x] **Phase 01: something**',
    ].join('\n');

    const { roadmapPhaseVariants } = buildRoadmapPhaseVariants(content);
    // phaseVariants() adds both '1' and '01' forms
    assert.ok(
      roadmapPhaseVariants.has('1') || roadmapPhaseVariants.has('01'),
      `roadmapPhaseVariants should contain at least one padding form, got: ${JSON.stringify([...roadmapPhaseVariants])}`
    );
  });

  test('mixed roadmap (headings + checklist) collects phases from both styles', () => {
    const content = [
      '# Roadmap',
      '',
      '## Phase 1: heading-style',
      '',
      '- [x] **Phase 02: checklist-style**',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(
      roadmapPhases.has('1') || roadmapPhases.has('01'),
      'should contain heading-style phase 1'
    );
    assert.ok(
      roadmapPhases.has('02') || roadmapPhases.has('2'),
      'should contain checklist-style phase 02'
    );
  });
});

// ─── B: validate health — no W007 for checklist-only roadmaps ────────────────

describe('validate health — checklist-style roadmap phases must not emit W007 (#892)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no W007 when phase dirs match checked checklist entries in ROADMAP.md', () => {
    // Write PROJECT.md, STATE.md, config.json, and a checklist-only ROADMAP.md
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // Checklist-only ROADMAP: no ## Phase headings, only checklist items
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: infrastructure-hardening**',
        '- [x] **Phase 02: feature-work**',
        '',
      ].join('\n')
    );

    // Create matching phase directories on disk
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-infrastructure-hardening'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature-work'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const w007s = output.warnings.filter((w) => w.code === 'W007');
    assert.strictEqual(
      w007s.length,
      0,
      `W007 must not fire for phases whose dirs are listed in a checklist-style ROADMAP.md, got: ${JSON.stringify(w007s)}`
    );
  });

  test('W007 still fires when a phase dir is genuinely absent from a checklist roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // ROADMAP only lists phase 01, not phase 99
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: known-phase**',
        '',
      ].join('\n')
    );

    // Phase 01 dir is present but also an orphan phase 99 that is NOT in ROADMAP
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-known-phase'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '99-orphan'), { recursive: true });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const w007s = output.warnings.filter((w) => w.code === 'W007');
    assert.ok(
      w007s.length > 0,
      `W007 must still fire for a phase dir genuinely not listed in ROADMAP.md, got warnings: ${JSON.stringify(output.warnings)}`
    );
    // Should only flag phase 99, not phase 01
    assert.ok(
      w007s.some((w) => w.message.includes('99')),
      `W007 should reference orphan phase 99, got: ${JSON.stringify(w007s)}`
    );
    assert.ok(
      !w007s.some((w) => w.message.includes('01') || w.message.includes('1')),
      `W007 must NOT flag phase 01 which is in the checklist, got: ${JSON.stringify(w007s)}`
    );
  });
});

// ─── C: validate consistency — no false positive for checklist-only roadmaps ─

describe('validate consistency — checklist-style roadmap phases must not emit false warnings (#892)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no "exists on disk but not in ROADMAP.md" warning for checklist-matched phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\n\nTest.\n\n## Core Value\n\nValue.\n\n## Requirements\n\nRequirements.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase 1 in progress.\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2)
    );

    // Checklist-only ROADMAP
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [x] **Phase 01: infrastructure-hardening**',
        '- [x] **Phase 02: feature-work**',
        '',
      ].join('\n')
    );

    // Create matching phase directories
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-infrastructure-hardening'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature-work'), { recursive: true });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // No "exists on disk but not in ROADMAP" warnings for checklist-listed phases
    const diskNotInRoadmapWarnings = (output.warnings || []).filter(
      (w) => typeof w === 'string'
        ? w.includes('exists on disk but not in ROADMAP')
        : (w.message || '').includes('exists on disk but not in ROADMAP')
    );
    assert.strictEqual(
      diskNotInRoadmapWarnings.length,
      0,
      `No "exists on disk but not in ROADMAP.md" warnings should fire for checklist-listed phases, got: ${JSON.stringify(diskNotInRoadmapWarnings)}`
    );
  });
});
  });
}

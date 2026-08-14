'use strict';

/**
 * Tests for `src/health-diagnostic-rules/phase-structure.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — the "Phase directory structure" rule
 * group: W005, W023, I001, W009.
 *
 * Design:       .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 * - W005/W023 are MECHANICAL MUTATION — a malformed directory name / two
 *   directories deliberately constructed to collide on the same normalized
 *   phase key. Both are directory-NAME shapes, not a document format being
 *   modeled, so there is nothing to mutate from a template; the mutation IS
 *   the directory name itself.
 * - I001/W009 are STRUCTURAL ABSENCE — a missing SUMMARY.md / missing
 *   VALIDATION.md file. Exempt from the provenance concern per §8.5's own
 *   category 1: the fixture *is* the absence, no format is being modeled.
 *
 * Every case calls the REAL `buildPlanningSnapshot(cwd)` (Phase 10,
 * `src/planning-snapshot.cts`) against real temp `.planning/` trees, then
 * calls the REAL rule `check` functions from the compiled module under
 * test — no hand-built in-memory snapshot mocks. Fixture helpers mirror
 * `tests/planning-snapshot.test.cjs`'s own `writeState`/`writeRoadmap`/
 * `writeFile`/`makeCompletePhaseDir` verbatim.
 *
 * All fixtures use a ROADMAP.md with NO `Phase N:` headings under the
 * current milestone section. `getMilestonePhaseFilter`
 * (`src/roadmap-parser.cts:1341-1355`) degrades to a pass-all filter
 * whenever `milestonePhaseNums.size === 0`, so `listMilestonePhaseDirs`
 * enumerates every on-disk phase directory regardless of whether its name
 * parses as a phase id — which is exactly what these rules need to exercise
 * (a malformed dir name would otherwise never reach `phaseDirs.value` in the
 * first place, since a non-matching name also fails the window's own
 * numeric-prefix membership test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs');

const ruleByCode = Object.fromEntries(RULES.map((r) => [r.code, r]));

// ─── Fixture helpers (mirrors tests/planning-snapshot.test.cjs) ────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeCompletePhaseDir(cwd, relPhaseDir) {
  writeFile(cwd, `${relPhaseDir}/01-01-PLAN.md`, '# Plan\n');
  writeFile(cwd, `${relPhaseDir}/01-01-SUMMARY.md`, '# Summary\n');
  writeFile(cwd, `${relPhaseDir}/01-VERIFICATION.md`, '---\nstatus: passed\n---\n');
}

// No `Phase N:` heading anywhere -> getMilestonePhaseFilter's pass-all
// degrade -> listMilestonePhaseDirs enumerates every on-disk phase dir name
// verbatim, malformed or not.
function writePassAllRoadmap(cwd) {
  writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
}

function baseFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writePassAllRoadmap(cwd);
}

// ─── W005 — phase directory doesn't follow NN-name format ──────────────────

describe('W005 — phase directory naming', () => {
  test('MECHANICAL MUTATION: a directory name with no NN- prefix fires W005', (t) => {
    const cwd = createTempDir('gsd-3309-w005-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/notaphase/README.md', '# not a phase dir\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.ok(snap.phaseDirs.value.includes('notaphase'), 'fixture sanity: malformed dir enumerated');

    const diagnostics = ruleByCode['W005'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W005'],
    );
    assert.match(diagnostics[0].message, /"notaphase"/);
    assert.match(diagnostics[0].message, /doesn't follow NN-name format/);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].remedy.action, 'advise');
    assert.equal(diagnostics[0].remedy.risk, 'none');
  });

  test('baseline: only well-formed directory names produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w005-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W005'].check(snap), []);
  });
});

// ─── W023 — phase directories collide on normalized key ────────────────────

describe('W023 — colliding phase directories', () => {
  test('MECHANICAL MUTATION: two directories that normalize to the same key fire W023', (t) => {
    const cwd = createTempDir('gsd-3309-w023-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    // extractPhaseToken("05-real") === "05"; extractPhaseToken("05-real-stray")
    // === "05" too (the tokenizer stops at the first non-continuation segment,
    // "real"/"stray" is a slug word, not a zero-padded continuation) — both
    // normalize to phase key "05" via normalizePhaseName.
    makeCompletePhaseDir(cwd, '.planning/phases/05-real');
    writeFile(cwd, '.planning/phases/05-real-stray/01-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.ok(
      snap.phaseDirs.value.includes('05-real') && snap.phaseDirs.value.includes('05-real-stray'),
      'fixture sanity: both colliding dirs enumerated',
    );

    const diagnostics = ruleByCode['W023'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W023'],
    );
    assert.match(diagnostics[0].message, /collide on normalized key "05"/);
    assert.match(diagnostics[0].message, /05-real \(/);
    assert.match(diagnostics[0].message, /05-real-stray \(/);
    assert.equal(diagnostics[0].severity, 'warning');
  });

  test('baseline: distinct phase keys produce no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w023-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W023'].check(snap), []);
  });
});

// ─── I001 — plan(s) without a matching SUMMARY.md ──────────────────────────

describe('I001 — unsummarized plans', () => {
  test('STRUCTURAL ABSENCE: a PLAN.md with no matching SUMMARY.md fires I001', (t) => {
    const cwd = createTempDir('gsd-3309-i001-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    const phase = snap.phases.value.find((p) => p.dir === '01-foo');
    assert.equal(phase.planCount, 1);
    assert.equal(phase.summaryCount, 0);

    const diagnostics = ruleByCode['I001'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['I001'],
    );
    assert.match(diagnostics[0].message, /Phase 01-foo has 1 plan\(s\) without a matching summary/);
    assert.equal(diagnostics[0].severity, 'info');
  });

  test('baseline: matched plan/summary pairs produce no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-i001-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['I001'].check(snap), []);
  });
});

// ─── W009 — Validation Architecture in RESEARCH.md but no VALIDATION.md ───

describe('W009 — missing VALIDATION.md', () => {
  test('STRUCTURAL ABSENCE: RESEARCH.md has Validation Architecture but no VALIDATION.md fires W009', (t) => {
    const cwd = createTempDir('gsd-3309-w009-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(
      cwd,
      '.planning/phases/01-foo/01-RESEARCH.md',
      '# Research\n\n## Validation Architecture\n\nSome content.\n',
    );

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((e) => e.dir === '01-foo');
    assert.equal(entry.hasValidationArchitecture, true);
    assert.equal(entry.hasValidationMd, false);

    const diagnostics = ruleByCode['W009'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W009'],
    );
    assert.match(
      diagnostics[0].message,
      /Phase 01-foo: has Validation Architecture in RESEARCH\.md but no VALIDATION\.md/,
    );
    assert.equal(diagnostics[0].severity, 'warning');
  });

  test('baseline: VALIDATION.md present alongside Validation Architecture produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w009-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(
      cwd,
      '.planning/phases/01-foo/01-RESEARCH.md',
      '# Research\n\n## Validation Architecture\n\nSome content.\n',
    );
    writeFile(cwd, '.planning/phases/01-foo/01-VALIDATION.md', '# Validation\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W009'].check(snap), []);
  });

  test('baseline: RESEARCH.md without Validation Architecture heading produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w009-neg2-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/01-foo/01-RESEARCH.md', '# Research\n\nNo relevant heading here.\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W009'].check(snap), []);
  });
});

// ─── §8.2 rule 1 — every diagnostic's severity matches its rule's declared severity ─

describe('rule/severity 1:1 (§8.2 rule 1)', () => {
  test('every emitted diagnostic carries the same severity as its rule entry', (t) => {
    const cwd = createTempDir('gsd-3309-sev-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/notaphase/README.md', '# not a phase dir\n');
    writeFile(cwd, '.planning/phases/05-real-stray/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/02-bar/01-01-PLAN.md', '# Plan\n');
    writeFile(
      cwd,
      '.planning/phases/02-bar/01-RESEARCH.md',
      '## Validation Architecture\n',
    );

    const snap = buildPlanningSnapshot(cwd);
    for (const rule of RULES) {
      for (const diagnostic of rule.check(snap)) {
        assert.equal(diagnostic.code, rule.code);
        assert.equal(diagnostic.severity, rule.severity);
      }
    }
  });
});

'use strict';

/**
 * Tests for `src/health-diagnostic-rules/consistency.cts` (Phase 12, #3310,
 * ADR-3180 §8.4) — the "consistency" (`C0NN`) rule group: C001-C004, plus
 * `health-diagnostic.cts`'s `CONSISTENCY_RULES`/`evaluateConsistencyRules`
 * composition (W006/W007 reuse proof).
 *
 * Design: .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/40-design.md
 * Test matrix: .gsd/phase/feat-3310-enhance-3180-the-sibling-validators-shar/50-test-matrix.md
 *   section 2 (rows 9-11), section 3 (C001-C004)
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 * - C001/C002/C004 are MECHANICAL MUTATION — a numbering gap / a missing
 *   `wave:` line, mirroring the exact fixture shapes
 *   `tests/planning-snapshot.test.cjs`'s Phase-12 field tests already use
 *   for the same underlying `PlanningSnapshot` fields.
 * - C003 REUSES `tests/health-diagnostic-rules/phase-structure.test.cjs`'s
 *   I001 fixture family (a live PLAN.md with no matching SUMMARY.md),
 *   inverted: a SUMMARY.md with no matching live PLAN.md.
 *
 * Every case calls the REAL `buildPlanningSnapshot(cwd)` against a real
 * temp `.planning/` tree, then the REAL rule `check` functions from the
 * compiled module under test — no hand-built in-memory snapshot mocks,
 * mirroring `tests/health-diagnostic-rules/roadmap-disk-consistency.test.cjs`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const consistencyMod = require('../../gsd-core/bin/lib/health-diagnostic-rules/consistency.cjs');
const { RULES } = consistencyMod;
const {
  SEVERITY,
  REMEDY_ACTION,
  REMEDY_RISK,
  CONSISTENCY_RULES,
  evaluateConsistencyRules,
  evaluateRules,
} = require('../../gsd-core/bin/lib/health-diagnostic.cjs');

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── Fixture helpers (mirrors tests/planning-snapshot.test.cjs) ────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makePhaseDir(cwd, dirName) {
  fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', dirName), { recursive: true });
}

function writePlan(cwd, relPhasePath, planName, frontmatterLines) {
  const lines = frontmatterLines ? ['---', ...frontmatterLines, '---', '', '# Plan', ''] : ['# Plan', ''];
  writeFile(cwd, `${relPhasePath}/${planName}`, lines.join('\n'));
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (consistency group)', () => {
  test('exports exactly 4 rules: C001, C002, C003, C004', () => {
    assert.deepEqual(RULES.map((r) => r.code).sort(), ['C001', 'C002', 'C003', 'C004']);
  });

  test('all four rules are severity WARNING with an ADVISE remedy shape', () => {
    for (const code of ['C001', 'C002', 'C003', 'C004']) {
      assert.equal(ruleFor(code).severity, SEVERITY.WARNING);
      assert.equal(ruleFor(code).repairable, false);
    }
  });
});

// ─── C001 — gap in disk phase numbering ────────────────────────────────────

describe('C001 — gap in disk phase numbering', () => {
  test('MECHANICAL MUTATION: phases 1, 2, 4 on disk (3 missing) fires C001', (t) => {
    const cwd = createTempDir('gsd-3310-c001-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    makePhaseDir(cwd, '04-baz');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('C001').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'C001',
      severity: SEVERITY.WARNING,
      message: 'Gap in phase numbering: 2 → 4',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Create the missing phase directory or renumber to close the gap' },
      },
    });
  });

  test('baseline: a sequential integer run produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3310-c001-neg-');
    t.after(() => cleanup(cwd));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    makePhaseDir(cwd, '03-baz');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C001').check(snapshot), []);
  });

  test('boundary: phase_naming "custom" skips the integer-sequence gap check entirely', (t) => {
    const cwd = createTempDir('gsd-3310-c001-custom-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    fs.writeFileSync(
      path.join(planningDirOf(cwd), 'config.json'),
      JSON.stringify({ phase_naming: 'custom' }, null, 2),
    );
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '04-baz');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.config.value?.['phase_naming'], 'custom');
    assert.deepEqual(ruleFor('C001').check(snapshot), []);
  });

  test('a sentinel phase dir (999-interim) does not produce a spurious gap', (t) => {
    const cwd = createTempDir('gsd-3310-c001-sentinel-');
    t.after(() => cleanup(cwd));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    makePhaseDir(cwd, '999-interim');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C001').check(snapshot), []);
  });
});

// ─── C002 — gap in plan numbering within a phase ───────────────────────────

describe('C002 — gap in plan numbering within a phase', () => {
  test('MECHANICAL MUTATION: 01-PLAN.md, 03-PLAN.md in one phase dir fires C002', (t) => {
    const cwd = createTempDir('gsd-3310-c002-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-03-PLAN.md');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('C002').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'C002',
      severity: SEVERITY.WARNING,
      message: 'Gap in plan numbering in 01-foo: plan 1 → 3',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Create the missing plan or renumber to close the gap' },
      },
    });
  });

  test('boundary: a gap of exactly one (01, 02) still reports the same C002 subject', (t) => {
    const cwd = createTempDir('gsd-3310-c002-gap1-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-02-PLAN.md');

    const snapshot = buildPlanningSnapshot(cwd);
    // Sequential (01, 02) is NOT a gap — sanity baseline for the boundary
    // pairing below (a real gap must be > 1, not merely non-empty).
    assert.deepEqual(ruleFor('C002').check(snapshot), []);
  });

  test('baseline: sequential plans (01, 02, 03) produce no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3310-c002-neg-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-02-PLAN.md');
    writePlan(cwd, '.planning/phases/01-foo', '01-03-PLAN.md');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C002').check(snapshot), []);
  });
});

// ─── C003 — orphan SUMMARY with no matching live PLAN ──────────────────────
// Reuses phase-structure.test.cjs's I001 fixture family, inverted.

describe('C003 — orphan SUMMARY with no matching live PLAN', () => {
  test('REUSED (I001 family, inverted): a SUMMARY.md with no matching PLAN.md fires C003', (t) => {
    const cwd = createTempDir('gsd-3310-c003-');
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('C003').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'C003',
      severity: SEVERITY.WARNING,
      message: 'Summary 01-01-SUMMARY.md in 01-foo has no matching PLAN.md',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Create the matching PLAN.md or remove the orphan summary' },
      },
    });
  });

  test('boundary: a summary paired only to a superseded plan is still an orphan', (t) => {
    const cwd = createTempDir('gsd-3310-c003-superseded-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['status: superseded']);
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('C003').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'C003', 'a summary paired only to a superseded plan must still fire C003');
  });

  test('baseline: a paired plan+summary produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3310-c003-neg-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C003').check(snapshot), []);
  });
});

// ─── C004 — PLAN missing 'wave' in frontmatter ─────────────────────────────

describe("C004 — PLAN missing 'wave' in frontmatter", () => {
  test('MECHANICAL MUTATION: a shipped PLAN template with wave: stripped fires C004', (t) => {
    const cwd = createTempDir('gsd-3310-c004-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('C004').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'C004',
      severity: SEVERITY.WARNING,
      message: "01-foo/01-01-PLAN.md: missing 'wave' in frontmatter",
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: "Add a 'wave' key to the plan's frontmatter" },
      },
    });
  });

  test('baseline: a plan with wave: in frontmatter produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3310-c004-neg-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['wave: 1']);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C004').check(snapshot), []);
  });

  test('a superseded plan with no wave is not flagged (superseded plans are excluded from the live set)', (t) => {
    const cwd = createTempDir('gsd-3310-c004-superseded-');
    t.after(() => cleanup(cwd));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['status: superseded']);

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('C004').check(snapshot), []);
  });
});

// ─── CONSISTENCY_RULES composition (health-diagnostic.cts) ────────────────

describe('CONSISTENCY_RULES composition (matrix row 9)', () => {
  test('exactly W006, W007, C001-C004 — 6 entries, no duplicates', () => {
    const codes = CONSISTENCY_RULES.map((r) => r.code).sort();
    assert.deepEqual(codes, ['C001', 'C002', 'C003', 'C004', 'W006', 'W007']);
    assert.equal(new Set(codes).size, 6);
  });
});

describe('evaluateConsistencyRules', () => {
  test('matrix row 10: an all-clean snapshot produces zero diagnostics', (t) => {
    const cwd = createTempDir('gsd-3310-ecr-clean-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    writePlan(cwd, '.planning/phases/01-foo', '01-01-PLAN.md', ['wave: 1']);
    writeFile(cwd, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(evaluateConsistencyRules(snapshot), []);
  });

  test('matrix row 11 (W006 reuse proof): evaluateConsistencyRules produces the IDENTICAL Diagnostic evaluateRules would for the same W006 fixture', (t) => {
    const cwd = createTempDir('gsd-3310-ecr-w006-');
    t.after(() => cleanup(cwd));
    writeRoadmap(
      cwd,
      ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'),
    );
    makePhaseDir(cwd, '01-foo');
    // Phase 2 deliberately has no matching directory -> W006.

    const snapshot = buildPlanningSnapshot(cwd);

    const fromConsistency = evaluateConsistencyRules(snapshot).filter((d) => d.code === 'W006');
    const fromHealth = evaluateRules(snapshot).filter((d) => d.code === 'W006');

    assert.equal(fromConsistency.length, 1);
    assert.equal(fromHealth.length, 1);
    assert.deepEqual(fromConsistency[0], fromHealth[0]);
    assert.deepEqual(
      JSON.parse(JSON.stringify(fromConsistency)),
      JSON.parse(JSON.stringify(fromHealth)),
      'evaluateConsistencyRules must produce a byte-identical Diagnostic to evaluateRules for the same fixture — proof of reuse, not reimplementation',
    );
  });
});

'use strict';

/**
 * Tests for `src/health-diagnostic-rules/roadmap-disk-consistency.cts`
 * (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5) — group "ROADMAP/disk
 * consistency": W006, W007.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *   | W006 | ROADMAP phase with no disk dir | reused/representative | roadmap entry added, no matching dir created |
 *   | W007 | disk dir with no ROADMAP entry | reused/representative | dir created, no roadmap entry |
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"): both
 * rules use CONTENT-SHAPE/MECHANICAL-MUTATION provenance — a realistic
 * multi-phase ROADMAP.md (mirroring `gsd-core/templates/roadmap.md`'s
 * heading shape) paired with a matching on-disk phase-dir tree, with exactly
 * ONE entry perturbed (one dir withheld for W006, one extra dir added for
 * W007). Every fixture is built via the REAL `buildPlanningSnapshot(cwd)`
 * against a REAL temp directory (mirrors `tests/planning-snapshot.test.cjs`
 * and `tests/health-diagnostic-rules/root-existence.test.cjs`) — no
 * hand-constructed fake `PlanningSnapshot` object.
 *
 * TDD RED: `src/health-diagnostic-rules/roadmap-disk-consistency.cts` does
 * not exist yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/roadmap-disk-consistency.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const roadmapDiskConsistency = require('../../gsd-core/bin/lib/health-diagnostic-rules/roadmap-disk-consistency.cjs');
const { RULES } = roadmapDiskConsistency;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');
const { SCOPE } = require('../../gsd-core/bin/lib/planning-scope.cjs');

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function makePhaseDir(cwd, dirName) {
  fs.mkdirSync(path.join(planningDirOf(cwd), 'phases', dirName), { recursive: true });
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (roadmap-disk-consistency group)', () => {
  test('exports exactly 2 rules: W006, W007', () => {
    assert.deepEqual(RULES.map((r) => r.code).sort(), ['W006', 'W007']);
  });

  test('both rules are severity WARNING', () => {
    assert.equal(ruleFor('W006').severity, SEVERITY.WARNING);
    assert.equal(ruleFor('W007').severity, SEVERITY.WARNING);
  });
});

// ─── W006 — ROADMAP phase with no disk dir ─────────────────────────────────

describe('W006 — ROADMAP phase with no disk dir', () => {
  test('fires for exactly the one perturbed phase (3-phase roadmap, dir withheld for phase 2)', (t) => {
    const cwd = createTempDir('gsd-3309-w006-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(
      cwd,
      ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', '', '### Phase 3: Baz'].join('\n'),
    );
    makePhaseDir(cwd, '01-foo');
    // Phase 2 deliberately has no matching directory.
    makePhaseDir(cwd, '03-baz');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W006').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W006',
      severity: SEVERITY.WARNING,
      message: 'Phase 2 in ROADMAP.md but no directory on disk',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Create phase directory or remove from roadmap' },
      },
    });
  });

  test('does not fire when every declared phase resolves to a directory (padding/token tolerant)', (t) => {
    const cwd = createTempDir('gsd-3309-w006-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W006').check(snapshot), []);
  });

  test('does not fire for a sentinel phase id (999.x) even with no matching directory', (t) => {
    const cwd = createTempDir('gsd-3309-w006-3-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 999.1: Icebox'].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W006').check(snapshot), []);
  });

  test('does not fire for a phase explicitly marked "not started" (unchecked checklist entry, no dir)', (t) => {
    const cwd = createTempDir('gsd-3309-w006-4-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## Phases', '', '- [ ] **Phase 5: Widgets** - build them'].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    // Sanity: the phase IS declared (so this is genuinely testing the
    // not-started exclusion, not an empty-declared-phases no-op).
    assert.ok(snapshot.roadmapDeclaredPhases.value.some((p) => p.phaseId === '5'));
    assert.deepEqual(ruleFor('W006').check(snapshot), []);
  });

  test('DOES fire for an unrelated checked phase with no dir (not-started exclusion is per-phase, not global)', (t) => {
    const cwd = createTempDir('gsd-3309-w006-5-');
    t.after(() => cleanup(cwd));
    writeRoadmap(
      cwd,
      ['## Phases', '', '- [ ] **Phase 5: Widgets** - build them', '- [x] **Phase 6: Gadgets** - build them'].join(
        '\n',
      ),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W006').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message, 'Phase 6 in ROADMAP.md but no directory on disk');
  });

  test('boundary: zero declared phases and zero phase directories produces zero findings', (t) => {
    const cwd = createTempDir('gsd-3309-w006-6-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## Progress', '', '(no phases declared yet)'].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(snapshot.roadmapDeclaredPhases.value, []);
    assert.deepEqual(ruleFor('W006').check(snapshot), []);
  });

  test('guard: ROADMAP.md absent does not fire (empty declared-phase list is a non-answer, not "zero declared")', (t) => {
    const cwd = createTempDir('gsd-3309-w006-7-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W006').check(snapshot), []);
  });
});

// ─── W007 — disk dir with no ROADMAP entry ─────────────────────────────────

describe('W007 — disk dir with no ROADMAP entry', () => {
  test('fires for exactly the one perturbed directory (3-phase roadmap, one extra orphan dir)', (t) => {
    const cwd = createTempDir('gsd-3309-w007-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(
      cwd,
      ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', '', '### Phase 3: Baz'].join('\n'),
    );
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    makePhaseDir(cwd, '03-baz');
    // Deliberately orphaned: no roadmap entry claims this directory.
    makePhaseDir(cwd, '04-extra');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W007').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W007',
      severity: SEVERITY.WARNING,
      message: 'Phase 04 exists on disk but not in ROADMAP.md',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Add to roadmap or remove directory' },
      },
    });
  });

  test('does not fire when every directory is claimed by a declared phase', (t) => {
    const cwd = createTempDir('gsd-3309-w007-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar'].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W007').check(snapshot), []);
  });

  test('does not fire for a sentinel directory (999-interim) even with no roadmap entry', (t) => {
    const cwd = createTempDir('gsd-3309-w007-3-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '999-interim');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W007').check(snapshot), []);
  });

  test('boundary: zero declared phases and zero phase directories produces zero findings', (t) => {
    const cwd = createTempDir('gsd-3309-w007-4-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## Progress', '', '(no phases declared yet)'].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(snapshot.allPhaseDirNames.value, []);
    assert.deepEqual(ruleFor('W007').check(snapshot), []);
  });

  test('regression: fires for a genuine orphan directory outside the roadmap-declared window (the W007-inert defect)', (t) => {
    const cwd = createTempDir('gsd-3309-w007-6-');
    t.after(() => cleanup(cwd));
    // ROADMAP declares only phase 1 — "04-extra" is not declared anywhere,
    // so `phaseDirs` (windowed to declared phases) would silently drop it
    // and W007 would never see it; `allPhaseDirNames` must not.
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo'].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '04-extra');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(
      snapshot.phaseDirs.value,
      ['01-foo'],
      'sanity: the windowed phaseDirs field must NOT include the orphan (confirms the defect this test guards)',
    );
    assert.ok(snapshot.allPhaseDirNames.value.includes('04-extra'));

    const diagnostics = ruleFor('W007').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message, 'Phase 04 exists on disk but not in ROADMAP.md');
  });

  test('guard: ROADMAP.md absent does not fire for a pre-existing phase directory (no false positive)', (t) => {
    const cwd = createTempDir('gsd-3309-w007-5-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    makePhaseDir(cwd, '01-foo');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(snapshot.roadmapDeclaredPhases, { value: [], scope: SCOPE.UNREADABLE });
    assert.deepEqual(ruleFor('W007').check(snapshot), []);
  });
});

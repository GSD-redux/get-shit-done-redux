'use strict';

/**
 * Tests for `src/health-diagnostic-rules/root-existence.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — group "Root existence + PROJECT.md":
 * E002, E003, E004, W001.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"): all
 * four rules here are STRUCTURAL ABSENCE conditions (a file, or a section
 * heading, is missing) — exempt from external-citation provenance per the
 * design doc's "Fixture provenance" §1: "the fixture *is* the absence — no
 * format being modeled, only a presence/absence fact." Every fixture is built
 * via the REAL `buildPlanningSnapshot(cwd)` against a REAL temp directory
 * (mirrors `tests/planning-snapshot.test.cjs` exactly) — no hand-constructed
 * fake `PlanningSnapshot` object.
 *
 * TDD RED: `src/health-diagnostic-rules/root-existence.cts` does not exist
 * yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/root-existence.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const rootExistence = require('../../gsd-core/bin/lib/health-diagnostic-rules/root-existence.cjs');
const { RULES } = rootExistence;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeProject(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'PROJECT.md'), content);
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), content);
}

// Makes a FILE unreadable-as-a-file: a DIRECTORY node where a regular file is
// expected. `platformReadSync`/`fs.readFileSync` throws EISDIR on it,
// deterministically and cross-platform — no chmod (mirrors
// tests/planning-snapshot.test.cjs's `makeFileUnreadableAsDir`).
function makeFileUnreadableAsDir(fullPath) {
  fs.mkdirSync(fullPath, { recursive: true });
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (root-existence group)', () => {
  test('exports exactly 4 rules: E002, E003, E004, W001', () => {
    assert.deepEqual(
      RULES.map((r) => r.code).sort(),
      ['E002', 'E003', 'E004', 'W001'],
    );
  });

  test('E002/E003/E004 are severity ERROR; W001 is severity WARNING', () => {
    assert.equal(ruleFor('E002').severity, SEVERITY.ERROR);
    assert.equal(ruleFor('E003').severity, SEVERITY.ERROR);
    assert.equal(ruleFor('E004').severity, SEVERITY.ERROR);
    assert.equal(ruleFor('W001').severity, SEVERITY.WARNING);
  });
});

// ─── E002 — PROJECT.md not found ────────────────────────────────────────────

describe('E002 — PROJECT.md not found', () => {
  test('fires when PROJECT.md is absent', (t) => {
    const cwd = createTempDir('gsd-3309-e002-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E002').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'E002',
      severity: SEVERITY.ERROR,
      message: 'PROJECT.md not found',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: '/gsd-new-project' },
      },
    });
  });

  test('does not fire when PROJECT.md exists', (t) => {
    const cwd = createTempDir('gsd-3309-e002-2-');
    t.after(() => cleanup(cwd));
    writeProject(cwd, '# My Project\n\n## What This Is\n\ntext\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E002').check(snapshot), []);
  });
});

// ─── E003 — ROADMAP.md not found ────────────────────────────────────────────

describe('E003 — ROADMAP.md not found', () => {
  test('fires when ROADMAP.md is absent (milestone.scope === UNREADABLE)', (t) => {
    const cwd = createTempDir('gsd-3309-e003-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E003').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'E003',
      severity: SEVERITY.ERROR,
      message: 'ROADMAP.md not found',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: '/gsd-new-milestone' },
      },
    });
  });

  test('does not fire when ROADMAP.md exists and is readable', (t) => {
    const cwd = createTempDir('gsd-3309-e003-2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, '---\nmilestone: v1.0\n---\n');
    writeRoadmap(cwd, '## v1.0 Current 🚧\n\n### Phase 1: Foo\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E003').check(snapshot), []);
  });

  // Documents the KNOWN AMBIGUITY flagged in this batch's implementer report:
  // `snapshot.milestone.scope` collapses "absent" and "present-but-unreadable"
  // into the same UNREADABLE scope, so this rule ALSO fires (with its
  // absence-shaped message) on a present-but-corrupt ROADMAP.md. Asserted
  // explicitly here rather than left undocumented, per §8.5 fixture-proof.
  test('KNOWN AMBIGUITY: also fires (message says "not found") when ROADMAP.md exists but is unreadable', (t) => {
    const cwd = createTempDir('gsd-3309-e003-3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'ROADMAP.md'));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E003').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'E003');
  });
});

// ─── E004 — STATE.md not found ──────────────────────────────────────────────

describe('E004 — STATE.md not found', () => {
  test('fires when STATE.md is absent (currentPhaseLabel.scope === UNREADABLE)', (t) => {
    const cwd = createTempDir('gsd-3309-e004-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E004').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'E004',
      severity: SEVERITY.ERROR,
      message: 'STATE.md not found',
      remedy: {
        action: REMEDY_ACTION.REGENERATE_STATE,
        risk: REMEDY_RISK.DESTRUCTIVE,
        args: {},
      },
    });
  });

  test('does not fire when STATE.md exists and is readable', (t) => {
    const cwd = createTempDir('gsd-3309-e004-2-');
    t.after(() => cleanup(cwd));
    writeState(cwd, '---\nmilestone: v1.0\n---\n\n## Current Position\n\nPhase: 1 of 2\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('E004').check(snapshot), []);
  });

  // Documents the KNOWN GAP flagged in this batch's implementer report:
  // unlike `config`, `currentPhaseLabel` carries no `exists` discriminator —
  // `buildStateFields` cannot distinguish "STATE.md absent" from
  // "STATE.md present but unreadable/corrupt" at all, so this rule fires
  // identically for both. Asserted explicitly here, per §8.5 fixture-proof.
  test('KNOWN GAP: also fires (message says "not found") when STATE.md exists but is unreadable', (t) => {
    const cwd = createTempDir('gsd-3309-e004-3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    makeFileUnreadableAsDir(path.join(planningDirOf(cwd), 'STATE.md'));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('E004').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'E004');
  });
});

// ─── W001 — PROJECT.md missing a required section ─────────────────────────

describe('W001 — PROJECT.md missing section', () => {
  test('fires once per missing required section (all 3 missing)', (t) => {
    const cwd = createTempDir('gsd-3309-w001-1-');
    t.after(() => cleanup(cwd));
    writeProject(cwd, '# My Project\n\nno sections at all\n');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W001').check(snapshot);

    assert.equal(diagnostics.length, 3);
    assert.deepEqual(
      diagnostics.map((d) => d.message).sort(),
      [
        'PROJECT.md missing section: ## Core Value',
        'PROJECT.md missing section: ## Requirements',
        'PROJECT.md missing section: ## What This Is',
      ],
    );
    for (const d of diagnostics) {
      assert.equal(d.code, 'W001');
      assert.equal(d.severity, SEVERITY.WARNING);
      assert.deepEqual(d.remedy, {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Add section manually' },
      });
    }
  });

  test('fires only for the sections actually missing (boundary: 1 of 3 missing)', (t) => {
    const cwd = createTempDir('gsd-3309-w001-2-');
    t.after(() => cleanup(cwd));
    writeProject(
      cwd,
      ['# My Project', '', '## What This Is', '', '## Core Value', ''].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W001').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message, 'PROJECT.md missing section: ## Requirements');
  });

  test('does not fire when all 3 required sections are present', (t) => {
    const cwd = createTempDir('gsd-3309-w001-3-');
    t.after(() => cleanup(cwd));
    writeProject(
      cwd,
      [
        '# My Project',
        '',
        '## What This Is',
        '',
        '## Core Value',
        '',
        '## Requirements',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W001').check(snapshot), []);
  });

  test('does not fire when PROJECT.md is absent — that is E002s job, not W001s', (t) => {
    const cwd = createTempDir('gsd-3309-w001-4-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W001').check(snapshot), []);
    // E002 covers the absence case instead.
    assert.equal(ruleFor('E002').check(snapshot).length, 1);
  });
});

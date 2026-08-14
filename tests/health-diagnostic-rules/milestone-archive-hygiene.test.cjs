'use strict';

/**
 * Tests for `src/health-diagnostic-rules/milestone-archive-hygiene.cts`
 * (Phase 11, #3309, ADR-3180 §8.2/§8.3/§8.5) — W018, W019.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (CONTRIBUTING.md / repo rule): every case builds a real
 * `.planning/` tree in a temp dir and runs it through the REAL compiled
 * `buildPlanningSnapshot` (`src/planning-snapshot.cts`) — no hand-built
 * `PlanningSnapshot` mocks. W018's fixture is a mechanical mutation of a real
 * MILESTONES.md shape (one version's `## <version>` entry deliberately
 * omitted while its archive snapshot file is present). W019's fixture is a
 * real stray `.md` file dropped into `.planning/` root alongside the three
 * canonical `.md` files (PROJECT.md/ROADMAP.md/STATE.md), confirming those
 * three do not false-positive.
 *
 * TDD RED: `src/health-diagnostic-rules/milestone-archive-hygiene.cts` does
 * not exist yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/milestone-archive-hygiene.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/milestone-archive-hygiene.cjs');
const { REMEDY_ACTION, REMEDY_RISK, SEVERITY } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');

const checkW018 = RULES.find((r) => r.code === 'W018').check;
const checkW019 = RULES.find((r) => r.code === 'W019').check;

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeMinimalRoadmap(cwd) {
  writeFile(cwd, '.planning/ROADMAP.md', ['## v1.0 Current 🚧', '', '### Phase 1: Foo', ''].join('\n'));
}

// ─── W018 — MILESTONES.md missing archived milestone(s) ────────────────────

describe('W018 — archived milestone snapshot not documented in MILESTONES.md', () => {
  test('fires ONE aggregate diagnostic listing all missing versions, not one per version', () => {
    const cwd = createTempDir('gsd-w018-');
    try {
      writeMinimalRoadmap(cwd);
      // Real shape, mechanically mutated: MILESTONES.md documents v1.0 but is
      // MISSING the v0.9 entry, while the archive dir has snapshot files for
      // BOTH v0.9 and v1.0.
      writeFile(cwd, '.planning/MILESTONES.md', ['## v1.0', '', 'Shipped.', ''].join('\n'));
      writeFile(cwd, '.planning/milestones/v0.9-ROADMAP.md', '## v0.9 Archived\n');
      writeFile(cwd, '.planning/milestones/v1.0-ROADMAP.md', '## v1.0 Archived\n');

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(snapshot.milestoneArchiveStatus.value.archivedVersions.sort(), ['v0.9', 'v1.0']);
      assert.deepEqual(snapshot.milestoneArchiveStatus.value.documentedVersions, ['v1.0']);

      const diagnostics = checkW018(snapshot);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, 'W018');
      assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
      assert.equal(
        diagnostics[0].message,
        'MILESTONES.md missing 1 archived milestone(s): v0.9',
      );
      assert.deepEqual(diagnostics[0].remedy, {
        action: REMEDY_ACTION.BACKFILL_MILESTONES,
        risk: REMEDY_RISK.NONE,
        args: {},
      });
    } finally {
      cleanup(cwd);
    }
  });

  test('aggregates MULTIPLE missing versions into one message, not one diagnostic each', () => {
    const cwd = createTempDir('gsd-w018-multi-');
    try {
      writeMinimalRoadmap(cwd);
      // MILESTONES.md documents nothing at all; two archive snapshots exist.
      writeFile(cwd, '.planning/MILESTONES.md', '');
      writeFile(cwd, '.planning/milestones/v0.9-ROADMAP.md', '## v0.9 Archived\n');
      writeFile(cwd, '.planning/milestones/v1.0-ROADMAP.md', '## v1.0 Archived\n');

      const snapshot = buildPlanningSnapshot(cwd);
      const diagnostics = checkW018(snapshot);
      assert.equal(diagnostics.length, 1);
      assert.equal(
        diagnostics[0].message,
        'MILESTONES.md missing 2 archived milestone(s): v0.9, v1.0',
      );
    } finally {
      cleanup(cwd);
    }
  });

  test('does not fire when every archived version is documented', () => {
    const cwd = createTempDir('gsd-w018-clean-');
    try {
      writeMinimalRoadmap(cwd);
      writeFile(cwd, '.planning/MILESTONES.md', ['## v0.9', '## v1.0', ''].join('\n'));
      writeFile(cwd, '.planning/milestones/v0.9-ROADMAP.md', '## v0.9 Archived\n');
      writeFile(cwd, '.planning/milestones/v1.0-ROADMAP.md', '## v1.0 Archived\n');

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(checkW018(snapshot), []);
    } finally {
      cleanup(cwd);
    }
  });

  test('does not fire when the archive dir has zero recognized -ROADMAP.md snapshots', () => {
    const cwd = createTempDir('gsd-w018-noarchive-');
    try {
      writeMinimalRoadmap(cwd);
      fs.mkdirSync(planningDirOf(cwd), { recursive: true });

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(snapshot.milestoneArchiveStatus.value.archivedVersions, []);
      assert.deepEqual(checkW018(snapshot), []);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── W019 — Unrecognized .planning/ root file ───────────────────────────────

describe('W019 — unrecognized .planning/ root file', () => {
  test('fires one diagnostic for a genuinely stray .md file at .planning/ root', () => {
    const cwd = createTempDir('gsd-w019-');
    try {
      writeMinimalRoadmap(cwd);
      writeFile(cwd, '.planning/NOTES.md', '# scratch notes\n');

      const snapshot = buildPlanningSnapshot(cwd);
      assert.ok(snapshot.planningRootFiles.value.includes('NOTES.md'));

      const diagnostics = checkW019(snapshot);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, 'W019');
      assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
      assert.equal(
        diagnostics[0].message,
        'Unrecognized .planning/ file: NOTES.md — not a canonical GSD artifact',
      );
      assert.deepEqual(diagnostics[0].remedy, {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: {
          command:
            'Move to .planning/milestones/ archive subdir or delete if stale. See templates/README.md for the canonical artifact list.',
        },
      });
    } finally {
      cleanup(cwd);
    }
  });

  test('fires one diagnostic PER unrecognized file when multiple stray files exist', () => {
    const cwd = createTempDir('gsd-w019-multi-');
    try {
      writeMinimalRoadmap(cwd);
      writeFile(cwd, '.planning/NOTES.md', '# scratch\n');
      writeFile(cwd, '.planning/SCRATCH.md', '# scratch2\n');

      const snapshot = buildPlanningSnapshot(cwd);
      const diagnostics = checkW019(snapshot);
      assert.equal(diagnostics.length, 2);
      assert.deepEqual(diagnostics.map((d) => d.code), ['W019', 'W019']);
      assert.deepEqual(
        diagnostics.map((d) => d.message).sort(),
        [
          'Unrecognized .planning/ file: NOTES.md — not a canonical GSD artifact',
          'Unrecognized .planning/ file: SCRATCH.md — not a canonical GSD artifact',
        ],
      );
    } finally {
      cleanup(cwd);
    }
  });

  test('PROJECT.md, ROADMAP.md, and STATE.md do NOT false-positive as W019 findings', () => {
    const cwd = createTempDir('gsd-w019-canonical-');
    try {
      writeMinimalRoadmap(cwd);
      writeFile(cwd, '.planning/PROJECT.md', '# Project\n');
      writeFile(
        cwd,
        '.planning/STATE.md',
        ['---', 'status: in-progress', '---', ''].join('\n'),
      );

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(
        snapshot.planningRootFiles.value.filter((f) => f.endsWith('.md')).sort(),
        ['PROJECT.md', 'ROADMAP.md', 'STATE.md'],
      );
      assert.deepEqual(checkW019(snapshot), []);
    } finally {
      cleanup(cwd);
    }
  });

  test('non-.md root files are never considered by the rule (loop skips them before the predicate)', () => {
    const cwd = createTempDir('gsd-w019-nonmd-');
    try {
      writeMinimalRoadmap(cwd);
      writeFile(cwd, '.planning/config.json', '{}');
      writeFile(cwd, '.planning/random.txt', 'not markdown\n');

      const snapshot = buildPlanningSnapshot(cwd);
      assert.deepEqual(checkW019(snapshot), []);
    } finally {
      cleanup(cwd);
    }
  });
});

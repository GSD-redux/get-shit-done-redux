'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { computeMigrationPlan, applyMigration } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');

/**
 * Build a git project whose `.planning/` is GITIGNORED (commit_docs:false) —
 * the condition under which the old `git reset --hard` + `git clean -fd`
 * rollback restored nothing yet still reported "rolled back". #1542.
 */
function makeGitignoredPlanningProject() {
  const dir = createTempDir('m3-rollback-');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.planning/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# tracked\n');
  const git = (argv) => gitOrThrow(argv, { cwd: dir });
  git(['init']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);

  // .planning created AFTER the commit → untracked + gitignored.
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-foo'), { recursive: true });
  fs.mkdirSync(path.join(planning, 'phases', '02-bar'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'phases', '01-foo', 'PLAN.md'), 'foo plan\n');
  fs.writeFileSync(path.join(planning, 'phases', '02-bar', 'PLAN.md'), 'bar plan\n');
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    ['## v1.0: First Milestone', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'),
  );
  return dir;
}

function snapshotPlanning(dir) {
  const planning = path.join(dir, '.planning');
  return {
    phases: fs.readdirSync(path.join(planning, 'phases')).sort(),
    roadmap: fs.readFileSync(path.join(planning, 'ROADMAP.md'), 'utf8'),
    hasConfig: fs.existsSync(path.join(planning, 'config.json')),
  };
}

describe('roadmap upgrade rollback (#1542)', () => {
  test('a mid-migration failure restores .planning even when it is gitignored', (t) => {
    const dir = makeGitignoredPlanningProject();
    t.after(() => cleanup(dir));

    const plan = computeMigrationPlan(dir);
    assert.equal(plan.alreadyMigrated, false);
    assert.ok(plan.phases.length >= 1, 'fixture must produce phase renames');
    assert.ok(plan.roadmapEdits.length >= 1, 'fixture must produce roadmap edits');

    const before = snapshotPlanning(dir);
    assert.equal(before.hasConfig, false, 'precondition: no config.json yet');

    // Inject a failure on the LAST mutation step (the config.json write) so the
    // phase renames AND the ROADMAP rewrite have already happened when rollback
    // fires — exactly the half-migrated state the old git rollback could not undo.
    const realWrite = fs.writeFileSync;
    const writeMock = mock.method(fs, 'writeFileSync', function (target, data, opts) {
      if (String(target).endsWith('config.json')) {
        const err = new Error('EIO: simulated write failure');
        err.code = 'EIO';
        throw err;
      }
      return realWrite.call(fs, target, data, opts);
    });
    t.after(() => writeMock.mock.restore());

    assert.throws(() => applyMigration(dir, plan, { dryRun: false }), /Migration failed/);

    // The rollback must have actually restored the workspace — not just claimed to.
    const after = snapshotPlanning(dir);
    assert.deepEqual(after.phases, before.phases, 'phase dirs must be restored to their original names');
    assert.equal(after.roadmap, before.roadmap, 'ROADMAP.md must be restored to its original content');
    assert.equal(after.hasConfig, false, 'config.json created during migration must be removed on rollback');
  });

  test('a successful migration still applies (renames + roadmap rewrite + config), no rollback', (t) => {
    const dir = makeGitignoredPlanningProject();
    t.after(() => cleanup(dir));

    const plan = computeMigrationPlan(dir);
    const before = snapshotPlanning(dir);

    const result = applyMigration(dir, plan, { dryRun: false });

    assert.equal(result.applied, true);
    const after = snapshotPlanning(dir);
    assert.notDeepEqual(after.phases, before.phases, 'phase dirs renamed on success');
    assert.equal(after.hasConfig, true, 'config.json written on success');
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_id_convention, 'milestone-prefixed');
  });
});

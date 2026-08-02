/**
 * Regression tests for #2855: the phase-locator's archived-milestone fallback
 * hardcoded the project-root `.planning/milestones/` tree instead of routing
 * through the workstream-aware `planningDir(cwd)` helper. A pending phase in
 * workstream A, whose own `phases/` directory does not exist yet, would
 * silently resolve to a same-numbered phase archived under the ROOT tree
 * (an unrelated workstream's history, or a flat-mode project's archive) —
 * complete with stale plan/summary counts and an "archived" status for a
 * phase that is actually brand new.
 *
 * Root cause: src/phase-locator.cts:139 (`findPhaseInternal`) and
 * src/phase-locator.cts:167 (`getArchivedPhaseDirs`) both used
 * `path.join(cwd, '.planning', 'milestones')` instead of
 * `path.join(planningDir(cwd), 'milestones')` — the same seam the
 * active-phase search (line 132) and the archive-write path
 * (`archivePhaseDirectories`, src/milestone.cts) already use.
 *
 * Ambient-env hermeticity: GSD_WORKSTREAM/GSD_PROJECT are read directly from
 * process.env by planningDir() when omitted, so every test here explicitly
 * saves and restores both (pattern from
 * tests/fix-2297-resolve-model-ids-runtime-scoping.test.cjs) to avoid leaking
 * state across tests or picking up a developer's ambient shell env.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

let _origWorkstream;
let _origProject;

function isolateWorkstreamEnv() {
  _origWorkstream = process.env.GSD_WORKSTREAM;
  _origProject = process.env.GSD_PROJECT;
  delete process.env.GSD_WORKSTREAM;
  delete process.env.GSD_PROJECT;
}

function restoreWorkstreamEnv() {
  if (_origWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
  else process.env.GSD_WORKSTREAM = _origWorkstream;
  if (_origProject === undefined) delete process.env.GSD_PROJECT;
  else process.env.GSD_PROJECT = _origProject;
}

describe('#2855: findPhaseInternal does not leak cross-workstream archived phases', () => {
  let tmpDir;
  beforeEach(() => { isolateWorkstreamEnv(); });
  afterEach(() => {
    restoreWorkstreamEnv();
    if (tmpDir) { cleanup(tmpDir); tmpDir = null; }
  });

  test('does not leak root-tree archived phase into an unrelated workstream', () => {
    tmpDir = createTempProject('gsd-2855-');
    // Root archive holds phase 03 (unrelated workstream's / flat-mode history).
    const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '03-legacy');
    fs.mkdirSync(rootArchive, { recursive: true });
    fs.writeFileSync(path.join(rootArchive, 'SOME-SUMMARY.md'), '# stale');

    // Workstream "beta" exists with an empty phases/ dir — phase 03 is pending.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases'), { recursive: true });
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.strictEqual(result, null, 'pending workstream phase must not resolve to the root archive');
  });

  test('does not leak root archive when workstream phases dir is entirely absent', () => {
    tmpDir = createTempProject('gsd-2855-');
    const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v2.0-phases', '01-legacy');
    fs.mkdirSync(rootArchive, { recursive: true });

    // Brand-new workstream: no .planning/workstreams/gamma/ directory at all yet.
    process.env.GSD_WORKSTREAM = 'gamma';

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null, 'a workstream with no directory yet must not resolve to the root archive');
  });

  // Issue #2855 AC1: "...regardless of whether workstream A's roadmap already
  // lists the phase and when it doesn't yet." findPhaseInternal never reads
  // ROADMAP.md (it is a pure filesystem lookup), so this dimension cannot
  // change its behavior — demonstrated directly rather than left as an
  // inference from reading the source.
  for (const roadmapHasEntry of [true, false]) {
    test(`does not leak root archive whether or not the workstream's ROADMAP.md already lists the phase (roadmapHasEntry=${roadmapHasEntry})`, () => {
      tmpDir = createTempProject('gsd-2855-');
      const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '03-legacy');
      fs.mkdirSync(rootArchive, { recursive: true });

      const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'beta');
      fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
      if (roadmapHasEntry) {
        fs.writeFileSync(
          path.join(wsDir, 'ROADMAP.md'),
          ['# Roadmap', '', '### Phase 03: Pending Work', ''].join('\n'),
        );
      }
      process.env.GSD_WORKSTREAM = 'beta';

      const result = phaseLocator.findPhaseInternal(tmpDir, '3');
      assert.strictEqual(result, null, 'ROADMAP.md presence/absence must not affect the archive-leak guard');
    });
  }

  test('still finds a phase genuinely archived under the active workstream\'s own tree', () => {
    tmpDir = createTempProject('gsd-2855-');
    const ownArchive = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'milestones', 'v1.0-phases', '03-real');
    fs.mkdirSync(ownArchive, { recursive: true });
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(result !== null, 'workstream\'s own archived phase must still resolve');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.archived, 'v1.0');
    assert.strictEqual(
      result.directory,
      '.planning/workstreams/beta/milestones/v1.0-phases/03-real',
    );
  });

  test('flat/non-workstream project archive resolution is unchanged', () => {
    tmpDir = createTempProject('gsd-2855-');
    const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '03-flat');
    fs.mkdirSync(rootArchive, { recursive: true });
    // No GSD_WORKSTREAM / GSD_PROJECT set — flat mode.

    const result = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(result !== null, 'flat-mode archive lookup must be unaffected by the fix');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.archived, 'v1.0');
    assert.strictEqual(result.directory, '.planning/milestones/v1.0-phases/03-flat');
  });

  test('two workstreams with same-numbered archived phases never cross-resolve', () => {
    tmpDir = createTempProject('gsd-2855-');
    const alphaArchive = path.join(tmpDir, '.planning', 'workstreams', 'alpha', 'milestones', 'v1.0-phases', '03-alpha-work');
    const betaArchive = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'milestones', 'v1.0-phases', '03-beta-work');
    fs.mkdirSync(alphaArchive, { recursive: true });
    fs.mkdirSync(betaArchive, { recursive: true });

    process.env.GSD_WORKSTREAM = 'alpha';
    const alphaResult = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(alphaResult !== null);
    assert.strictEqual(alphaResult.phase_name, 'alpha-work');

    process.env.GSD_WORKSTREAM = 'beta';
    const betaResult = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(betaResult !== null);
    assert.strictEqual(betaResult.phase_name, 'beta-work');
  });

  test('project+workstream combination scopes the archive fallback', () => {
    tmpDir = createTempProject('gsd-2855-');
    const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '05-root-legacy');
    fs.mkdirSync(rootArchive, { recursive: true });

    const scopedArchive = path.join(tmpDir, '.planning', 'proj-x', 'workstreams', 'beta', 'milestones', 'v1.0-phases', '05-scoped');
    fs.mkdirSync(scopedArchive, { recursive: true });

    process.env.GSD_PROJECT = 'proj-x';
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.findPhaseInternal(tmpDir, '5');
    assert.ok(result !== null, 'project+workstream scoped archive must resolve');
    assert.strictEqual(result.phase_name, 'scoped');
    assert.strictEqual(
      result.directory,
      '.planning/proj-x/workstreams/beta/milestones/v1.0-phases/05-scoped',
    );
  });

  test('workstream-scoped archived directory is posix-style', () => {
    tmpDir = createTempProject('gsd-2855-');
    const ownArchive = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'milestones', 'v1.0-phases', '07-posix');
    fs.mkdirSync(ownArchive, { recursive: true });
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.findPhaseInternal(tmpDir, '7');
    assert.ok(result !== null);
    assert.ok(!result.directory.includes('\\'), 'directory must use forward slashes on every platform');
  });
});

describe('#2855: getArchivedPhaseDirs does not leak cross-workstream archived phases', () => {
  let tmpDir;
  beforeEach(() => { isolateWorkstreamEnv(); });
  afterEach(() => {
    restoreWorkstreamEnv();
    if (tmpDir) { cleanup(tmpDir); tmpDir = null; }
  });

  test('does not leak root-tree archive entries under an active workstream', () => {
    tmpDir = createTempProject('gsd-2855-');
    const rootArchive = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '03-legacy');
    fs.mkdirSync(rootArchive, { recursive: true });

    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'beta', 'phases'), { recursive: true });
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.deepEqual(result, [], 'getArchivedPhaseDirs must not surface the root archive for a workstream');
  });

  test('still finds phases genuinely archived under the active workstream\'s own tree', () => {
    tmpDir = createTempProject('gsd-2855-');
    const ownArchive = path.join(tmpDir, '.planning', 'workstreams', 'beta', 'milestones', 'v2.0-phases', '04-own');
    fs.mkdirSync(ownArchive, { recursive: true });
    process.env.GSD_WORKSTREAM = 'beta';

    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, '04-own');
    assert.strictEqual(result[0].milestone, 'v2.0');
    // basePath is posix-normalized (toPosixPath) — a forward-slash literal is
    // the correct cross-platform expectation, not path.join.
    assert.strictEqual(
      result[0].basePath,
      '.planning/workstreams/beta/milestones/v2.0-phases',
    );
  });

  test('flat/non-workstream project resolution is unchanged', () => {
    tmpDir = createTempProject('gsd-2855-');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v2.1.0-phases');
    fs.mkdirSync(path.join(archiveDir, '03-auth'), { recursive: true });
    // No GSD_WORKSTREAM / GSD_PROJECT set — flat mode.

    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.strictEqual(entry.name, '03-auth');
    assert.strictEqual(entry.milestone, 'v2.1.0');
    // basePath is posix-normalized (toPosixPath) — a forward-slash literal is
    // the correct cross-platform expectation, not path.join.
    assert.strictEqual(entry.basePath, '.planning/milestones/v2.1.0-phases');
    assert.strictEqual(entry.fullPath, path.join(archiveDir, '03-auth'));
  });
});

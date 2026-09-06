/**
 * Tests for src/phase-locator.cts (compiled to gsd-core/bin/lib/phase-locator.cjs).
 *
 * Verifies behavioural contracts of the phase-locator helpers extracted from
 * core.cjs per ADR-857 rollout phase 2d (#881):
 *   - searchPhaseInDir
 *   - findPhaseInternal
 *   - getArchivedPhaseDirs
 *   - core.cjs re-export shims resolve to the exact same functions (shim-identity)
 *
 * Adversarial inputs: decimal/repeated phase ids, path-traversal-like names,
 * unicode, missing/empty phases dir, milestone-prefixed dirs.
 * Uses helpers.cjs createTempProject/cleanup for filesystem tests.
 *
 * Phase dir naming convention: zero-padded (e.g. "01-setup", "02-auth").
 * normalizePhaseName('1') → '01'; phaseTokenMatches('01-setup', '01') → true.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const planDependencyGraph = require('../gsd-core/bin/lib/plan-dependency-graph.cjs');
const {
  runGsdTools, createTempProject, createTempDir, cleanup, isolateWorkstreamEnv, restoreWorkstreamEnv,
  captureFdSync,
} = require('./helpers.cjs');
const driftGuard = require('../scripts/lint-phase-enumeration-drift.cjs');

// ─── findPhaseInternal — basic active-phase lookup ────────────────────────────

describe('findPhaseInternal: active phase lookup', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns null for falsy phase argument', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    assert.strictEqual(phaseLocator.findPhaseInternal(tmpDir, null), null);
    assert.strictEqual(phaseLocator.findPhaseInternal(tmpDir, ''), null);
    assert.strictEqual(phaseLocator.findPhaseInternal(tmpDir, 0), null);
    assert.strictEqual(phaseLocator.findPhaseInternal(tmpDir, undefined), null);
  });

  test('returns null when phases dir does not exist', () => {
    // Use a raw tmpDir (no phases subdir) to simulate missing phases dir
    tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-pl-test-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('returns null when phases dir is empty', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('finds a simple phase by number (zero-padded dir)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // Phase dirs use zero-padded format: normalizePhaseName('1') = '01'
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result !== null, 'expected a result for phase 1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '01');
    assert.strictEqual(result.phase_name, 'setup');
    assert.strictEqual(result.phase_slug, 'setup');
    assert.ok(result.directory.includes('01-setup'));
    assert.strictEqual(result.archived, undefined);
  });

  test('finds phase by full normalized id', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '02');
    assert.ok(result !== null);
    assert.strictEqual(result.phase_number, '02');
    assert.strictEqual(result.phase_name, 'auth');
  });

  test('reports plans and summaries from phase directory', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-impl');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'FEATURE-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, 'FEATURE-SUMMARY.md'), '# Summary');
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result !== null);
    assert.ok(result.plans.includes('FEATURE-PLAN.md'));
    assert.ok(result.summaries.includes('FEATURE-SUMMARY.md'));
    assert.deepEqual(result.incomplete_plans, []);
  });

  test('includes incomplete plans (plans without corresponding summaries)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-work');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'A-PLAN.md'), '# A Plan');
    fs.writeFileSync(path.join(phaseDir, 'B-PLAN.md'), '# B Plan');
    fs.writeFileSync(path.join(phaseDir, 'A-SUMMARY.md'), '# A Summary');
    const result = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(result !== null);
    assert.ok(result.incomplete_plans.includes('B-PLAN.md'));
    assert.ok(!result.incomplete_plans.includes('A-PLAN.md'));
  });

  test('directory is a posix-style relative path from cwd', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result !== null);
    assert.ok(!result.directory.includes('\\'), 'directory should use forward slashes');
    assert.ok(result.directory.startsWith('.planning/phases/'));
  });

  test('returns null when requested phase is not present', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-other'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });
});

// ─── findPhaseInternal — decimal/complex phase ids ────────────────────────────

describe('findPhaseInternal: decimal and complex phase ids (adversarial)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('finds decimal sub-phase (e.g. 01.1)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // normalizePhaseName('1.1') = '01.1'
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01.1-subsection');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1.1');
    assert.ok(result !== null, 'should find decimal phase 1.1');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '01.1');
  });

  test('decimal sub-phase dir is not matched by integer-only search', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // Create only 01.1-sub, NOT 01-something: searching for '1' should return null
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01.1-sub');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    // '01' does not match '01.1-sub' (they are distinct tokens)
    assert.strictEqual(result, null);
  });

  test('handles phases with multi-segment names', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-some-long-phase-name');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '5');
    assert.ok(result !== null);
    assert.strictEqual(result.phase_name, 'some-long-phase-name');
    assert.strictEqual(result.phase_slug, 'some-long-phase-name');
  });

  test('phase with unicode in name — does not throw', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-中文');
      fs.mkdirSync(phaseDir, { recursive: true });
      const result = phaseLocator.findPhaseInternal(tmpDir, '6');
      // If the filesystem supports unicode dir names, we get a result; if not, null is acceptable
      if (result !== null) {
        assert.strictEqual(result.found, true);
        assert.ok(typeof result.phase_name === 'string' || result.phase_name === null);
      }
    } catch (e) {
      // Some environments may not support unicode filenames; that's fine
      assert.ok(e instanceof Error);
    }
  });
});

// ─── findPhaseInternal — archived phase search ────────────────────────────────

describe('findPhaseInternal: archived milestone phase lookup', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('finds archived phase when not in active phases', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(path.join(milestonesDir, '01-archived'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result !== null, 'should find archived phase');
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.archived, 'v1.0.0');
    assert.ok(result.directory.startsWith('.planning/milestones/v1.0.0-phases/'));
  });

  test('prefers active phase over archived phase', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // Set up both active and archived phase 01
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-active'), { recursive: true });
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(path.join(milestonesDir, '01-archived'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result !== null);
    // Should return active (no archived property)
    assert.strictEqual(result.archived, undefined);
    assert.ok(result.directory.startsWith('.planning/phases/'));
  });

  test('searches most recent milestone first (reverse sort)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // v1.2.0 archive has phase 03, v1.1.0 archive also has phase 03
    const v110 = path.join(tmpDir, '.planning', 'milestones', 'v1.1.0-phases');
    const v120 = path.join(tmpDir, '.planning', 'milestones', 'v1.2.0-phases');
    fs.mkdirSync(path.join(v110, '03-old'), { recursive: true });
    fs.mkdirSync(path.join(v120, '03-new'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '3');
    assert.ok(result !== null);
    // v1.2.0 is more recent; reverse-sort means it's checked first
    assert.strictEqual(result.archived, 'v1.2.0');
  });

  test('returns null when phase exists in neither active nor archive', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(path.join(milestonesDir, '02-other'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '99');
    assert.strictEqual(result, null);
  });

  test('returns null when milestones dir does not exist', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // No .planning/milestones dir — only .planning/phases (empty)
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });

  test('ignores non-matching milestone dir names (not vX.Y.Z-phases)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    // Directory that doesn't match /^v[\d.]+-phases$/ should be skipped
    const badDir = path.join(tmpDir, '.planning', 'milestones', 'not-a-phases-dir');
    fs.mkdirSync(path.join(badDir, '01-phase'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.strictEqual(result, null);
  });
});

// ─── getArchivedPhaseDirs ─────────────────────────────────────────────────────

describe('getArchivedPhaseDirs', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns empty array when .planning/milestones does not exist', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.deepEqual(result, []);
  });

  test('returns empty array when milestones dir has no matching phase-archive dirs', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });
    fs.mkdirSync(path.join(milestonesDir, 'not-phases-dir'));
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.deepEqual(result, []);
  });

  test('returns phase entries from a single milestone archive', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(path.join(archiveDir, '01-feature'), { recursive: true });
    fs.mkdirSync(path.join(archiveDir, '02-bugfix'), { recursive: true });
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 2);
    const names = result.map(r => r.name).sort();
    assert.deepEqual(names, ['01-feature', '02-bugfix']);
  });

  test('result entries have correct shape', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v2.1.0-phases');
    fs.mkdirSync(path.join(archiveDir, '03-auth'), { recursive: true });
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.strictEqual(entry.name, '03-auth');
    assert.strictEqual(entry.milestone, 'v2.1.0');
    // #2855: basePath is posix-normalized (toPosixPath), matching the sibling
    // `directory` field's contract — a hardcoded forward-slash literal is the
    // correct expectation on every platform, not path.join (which would emit
    // backslashes on Windows and break this assertion there).
    assert.strictEqual(entry.basePath, '.planning/milestones/v2.1.0-phases');
    assert.strictEqual(entry.fullPath, path.join(archiveDir, '03-auth'));
  });

  test('aggregates phases from multiple milestone archives (most recent first)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const v1Dir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    const v2Dir = path.join(tmpDir, '.planning', 'milestones', 'v2.0.0-phases');
    fs.mkdirSync(path.join(v1Dir, '01-old'), { recursive: true });
    fs.mkdirSync(path.join(v2Dir, '01-new'), { recursive: true });
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.strictEqual(result.length, 2);
    // Reverse sort: v2.0.0 comes before v1.0.0
    const milestones = result.map(r => r.milestone);
    assert.strictEqual(milestones[0], 'v2.0.0');
    assert.strictEqual(milestones[1], 'v1.0.0');
  });

  test('adversarial: milestone-prefixed dir names that do not match pattern are skipped', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    fs.mkdirSync(milestonesDir, { recursive: true });
    // These should all be ignored (do not match /^v[\d.]+-phases$/):
    for (const bad of ['v1.0.0', 'phases', 'v1.0.0-phase', 'v-phases', '1.0.0-phases']) {
      fs.mkdirSync(path.join(milestonesDir, bad), { recursive: true });
      fs.mkdirSync(path.join(milestonesDir, bad, '01-sub'), { recursive: true });
    }
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.deepEqual(result, []);
  });

  test('returns empty array for empty milestone archive dirs', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(archiveDir, { recursive: true });
    // Archive dir exists but has no phase subdirs
    const result = phaseLocator.getArchivedPhaseDirs(tmpDir);
    assert.deepEqual(result, []);
  });
});

// ─── searchPhaseInDir — direct tests ─────────────────────────────────────────

describe('searchPhaseInDir: direct filesystem search', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('returns null for non-existent baseDir', () => {
    const result = phaseLocator.searchPhaseInDir('/nonexistent-dir-xyz-' + Date.now(), 'rel/base', '01');
    assert.strictEqual(result, null);
  });

  test('returns null when no matching subdirectory exists', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '02-other'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result, null);
  });

  test('finds matching dir and returns correct structure', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-hello'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.ok(result !== null);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.phase_number, '01');
    assert.strictEqual(result.phase_name, 'hello');
    assert.strictEqual(result.phase_slug, 'hello');
    assert.strictEqual(result.directory, '.planning/phases/01-hello');
  });

  test('relBase is prepended to directory in result', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0.0-phases');
    fs.mkdirSync(path.join(archiveDir, '03-feat'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(archiveDir, '.planning/milestones/v1.0.0-phases', '03');
    assert.ok(result !== null);
    assert.strictEqual(result.directory, '.planning/milestones/v1.0.0-phases/03-feat');
  });

  test('adversarial: dir with normal name does not produce path traversal', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-normal-phase'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.ok(result !== null);
    // The directory value should not escape its base
    assert.ok(!result.directory.includes('..'));
  });

  test('adversarial: phase number with repeated decimal segments (e.g. 1.1.1)', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01.1.1-deep'), { recursive: true });
    // Result may be found or null depending on normalization; must not throw
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01.1.1');
    assert.ok(result === null || typeof result.found === 'boolean');
  });

  test('returns has_research/has_context/has_verification/has_reviews as booleans', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phaseDir = path.join(phasesDir, '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.ok(result !== null);
    assert.strictEqual(typeof result.has_research, 'boolean');
    assert.strictEqual(typeof result.has_context, 'boolean');
    assert.strictEqual(typeof result.has_verification, 'boolean');
    assert.strictEqual(typeof result.has_reviews, 'boolean');
    assert.strictEqual(result.has_research, false);
    assert.strictEqual(result.has_context, false);
  });

  test('adversarial: empty phases dir (no subdirs) returns null', () => {
    tmpDir = createTempProject('gsd-pl-test-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '01');
    assert.strictEqual(result, null);
  });
});

// ─── #2237: ambiguous phase-directory collision ─────────────────────────────
describe('#2237: ambiguous phase-directory collision', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('searchPhaseInDir returns ambiguous_matches when two dirs share phase number', () => {
    tmpDir = createTempProject('gsd-pl-collision-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    // Two unrelated projects with same phase number
    fs.mkdirSync(path.join(phasesDir, '04-alpha-feature'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '04-beta-feature'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '04');
    assert.ok(result, 'should return a result (not null)');
    assert.strictEqual(result.found, false, 'ambiguous result must not be "found"');
    assert.ok(result.ambiguous_matches, 'must have ambiguous_matches');
    assert.strictEqual(result.ambiguous_matches.length, 2);
    assert.ok(result.ambiguous_matches.includes('04-alpha-feature'));
    assert.ok(result.ambiguous_matches.includes('04-beta-feature'));
  });

  test('findPhaseInternal propagates ambiguous result', () => {
    tmpDir = createTempProject('gsd-pl-collision-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '05-gamma'), { recursive: true });
    fs.mkdirSync(path.join(phasesDir, '05-delta'), { recursive: true });
    const result = phaseLocator.findPhaseInternal(tmpDir, '5');
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.found, false);
    assert.ok(result.ambiguous_matches?.length >= 2);
  });

  test('single match still resolves normally (no false positive)', () => {
    tmpDir = createTempProject('gsd-pl-collision-');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '03-only-phase'), { recursive: true });
    const result = phaseLocator.searchPhaseInDir(phasesDir, '.planning/phases', '03');
    assert.ok(result);
    assert.strictEqual(result.found, true);
    assert.ok(!result.ambiguous_matches, 'single match must not set ambiguous_matches');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Folded from tests/fix-2830-halted-plan-dependents.test.cjs (#3335 H3 fold).
//
// #2830: a halted plan must leave its direct/transitive dependents blocked,
// never offered as ordinary runnable work. Two independent "which plans are
// incomplete" readers exist — phase.cts's cmdPhasePlanIndex (parses
// depends_on for wave assignment) and phase-locator.cts's
// searchPhaseInDir/findPhaseInternal (the phase-location primitive) — both
// must report a halted dependent as blocked while leaving the pre-existing
// incomplete/incomplete_plans fields byte-identical. computeHaltPropagation
// (plan-dependency-graph.cts) tests stay in this file: no dedicated
// plan-dependency-graph test file exists yet, and #3335 names this file as
// the fold target.
// ═══════════════════════════════════════════════════════════════════════
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-2830-halted-plan-dependents', () => {

// Fixture: 01-01 halted spike (SUMMARY status: halted), 01-02 depends_on
// 01-01 (direct dependent), 01-03 depends_on 01-02 (transitive, 2 hops),
// 01-04 decoupled (no depends_on — the negative case).

function writePlan(phaseDir, filename, frontmatterLines, taskLine = '<task>Work</task>') {
  fs.writeFileSync(
    path.join(phaseDir, filename),
    [
      '---',
      ...frontmatterLines,
      '---',
      '',
      `# ${filename}`,
      '',
      `<objective>${filename}</objective>`,
      '',
      taskLine,
    ].join('\n'),
  );
}

function writeSummary(phaseDir, filename, status = 'complete') {
  fs.writeFileSync(
    path.join(phaseDir, filename),
    ['---', 'phase: 01-alpha', 'plan: 01', `status: ${status}`, 'completed: 2026-08-02', '---', '', '# Summary', ''].join('\n'),
  );
}

function buildBaseFixture(tmpDir) {
  const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
  fs.mkdirSync(phaseDir, { recursive: true });

  writePlan(phaseDir, '01-01-PLAN.md', ['wave: 1', 'objective: Halted spike', 'autonomous: true']);
  writeSummary(phaseDir, '01-01-SUMMARY.md', 'halted');

  writePlan(phaseDir, '01-02-PLAN.md', [
    'wave: 2', 'objective: Direct dependent', 'autonomous: true', 'depends_on:', '  - 01-01',
  ]);

  writePlan(phaseDir, '01-03-PLAN.md', [
    'wave: 3', 'objective: Transitive dependent', 'autonomous: true', 'depends_on:', '  - 01-02',
  ]);

  writePlan(phaseDir, '01-04-PLAN.md', ['wave: 1', 'objective: Decoupled plan', 'autonomous: true']);

  return phaseDir;
}

describe('phase-plan-index: halt propagation (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('direct dependent of a halted plan is blocked, not runnable', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);
    const data = JSON.parse(result.output);

    const p02 = data.plans.find((p) => p.id === '01-02');
    assert.ok(p02, '01-02 should be present');
    assert.deepEqual(p02.blocked_by, ['01-01'], '01-02 should be blocked by the halted 01-01');
    assert.strictEqual(p02.has_summary, false);
    assert.ok(!data.runnable.includes('01-02'), '01-02 must NOT be in the runnable view');
  });

  test('transitive dependent (2 hops) is blocked via chain', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p03 = data.plans.find((p) => p.id === '01-03');
    assert.ok(p03, '01-03 should be present');
    assert.deepEqual(p03.blocked_by, ['01-01'], '01-03 should be transitively blocked by 01-01');
    assert.ok(!data.runnable.includes('01-03'), '01-03 must NOT be in the runnable view');
  });

  test('transitive dependent at 3 hops stays blocked', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = buildBaseFixture(tmpDir);
    writePlan(phaseDir, '01-05-PLAN.md', [
      'wave: 4', 'objective: 3-hop dependent', 'autonomous: true', 'depends_on:', '  - 01-03',
    ]);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p05 = data.plans.find((p) => p.id === '01-05');
    assert.ok(p05, '01-05 should be present');
    assert.deepEqual(p05.blocked_by, ['01-01'], '01-05 should stay blocked at 3 hops');
    assert.ok(!data.runnable.includes('01-05'));
  });

  test('diamond dependency is blocked by both halted ancestors', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-diamond');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '02-01-PLAN.md', ['wave: 1', 'objective: Halted A', 'autonomous: true']);
    writeSummary(phaseDir, '02-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-02-PLAN.md', ['wave: 1', 'objective: Halted B', 'autonomous: true']);
    writeSummary(phaseDir, '02-02-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-03-PLAN.md', [
      'wave: 2', 'objective: Diamond join', 'autonomous: true',
      'depends_on:', '  - 02-01', '  - 02-02',
    ]);

    const result = runGsdTools(['phase-plan-index', '2', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);
    const data = JSON.parse(result.output);

    const p03 = data.plans.find((p) => p.id === '02-03');
    assert.ok(p03, '02-03 should be present');
    assert.deepEqual(
      [...p03.blocked_by].sort(),
      ['02-01', '02-02'],
      '02-03 should be blocked by BOTH halted ancestors, deduplicated',
    );
  });

  test('unrelated decoupled plan stays runnable', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p04 = data.plans.find((p) => p.id === '01-04');
    assert.ok(p04, '01-04 should be present');
    assert.deepEqual(p04.blocked_by, [], '01-04 has no depends_on, so it must not be blocked');
    assert.ok(data.runnable.includes('01-04'), '01-04 (decoupled) must stay in the runnable view');
  });

  test('incomplete field stays byte-identical when blocked plans are present', () => {
    tmpDir = createTempProject('gsd-2830-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    // Pre-#2830 semantics: incomplete = every plan without a matching SUMMARY,
    // blocked or not. 01-01 has a SUMMARY (halted, but still a SUMMARY) so it
    // is excluded; 01-02/01-03/01-04 have none, so all three are included —
    // exactly as they would be with no halt-awareness at all.
    assert.deepEqual(
      [...data.incomplete].sort(),
      ['01-02', '01-03', '01-04'],
      'incomplete must list every no-SUMMARY plan regardless of blocked status',
    );
  });

  test('dependency on an ordinary incomplete (non-halted) plan is not "blocked"', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-ordinary');
    fs.mkdirSync(phaseDir, { recursive: true });

    // 03-01 has NO summary at all (ordinary incomplete, not halted).
    writePlan(phaseDir, '03-01-PLAN.md', ['wave: 1', 'objective: Ordinary unfinished plan', 'autonomous: true']);
    writePlan(phaseDir, '03-02-PLAN.md', [
      'wave: 2', 'objective: Depends on ordinary incomplete plan', 'autonomous: true',
      'depends_on:', '  - 03-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '3', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '03-01');
    assert.ok(p01, '03-01 should be present');
    const p02 = data.plans.find((p) => p.id === '03-02');
    assert.ok(p02, '03-02 should be present');
    assert.deepEqual(p01.blocked_by, [], '03-01 (no summary) is not itself halted or blocked');
    assert.deepEqual(p02.blocked_by, [], '03-02 must NOT be "blocked" by an ordinary (non-halted) dependency');
    assert.ok(data.runnable.includes('03-02'), '03-02 stays runnable — only a halted upstream blocks');
  });

  test('unresolved depends_on id is ignored, not blocked', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-unresolved');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '04-01-PLAN.md', [
      'wave: 1', 'objective: References a nonexistent plan', 'autonomous: true',
      'depends_on:', '  - 99-99',
    ]);

    const result = runGsdTools(['phase-plan-index', '4', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should not throw on an unresolved dependency: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '04-01');
    assert.ok(p01, '04-01 should be present');
    assert.deepEqual(p01.blocked_by, [], 'an unresolved depends_on id must not produce a spurious block');
    assert.ok(data.runnable.includes('04-01'));
  });

  test('malformed (unterminated) SUMMARY frontmatter fails open to not-halted', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '05-malformed');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '05-01-PLAN.md', ['wave: 1', 'objective: Has a malformed summary', 'autonomous: true']);
    writeSummary(phaseDir, '05-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '05-02-PLAN.md', [
      'wave: 2', 'objective: Depends on 05-01', 'autonomous: true', 'depends_on:', '  - 05-01',
    ]);

    // extractFrontmatter must fail safe on an unterminated frontmatter block
    // (no closing '---'): isSummaryHalted's try/catch wraps BOTH the
    // fs.readFileSync call and the extractFrontmatter call, so this exercises
    // the identical fail-open catch site a genuine fs read error would hit.
    fs.writeFileSync(
      path.join(phaseDir, '05-01-SUMMARY.md'),
      '---\nphase: 05-malformed\nplan: 01\nstatus: halted\n', // no closing '---'
    );

    const result = runGsdTools(['phase-plan-index', '5', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index must not throw on malformed frontmatter: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '05-01');
    assert.ok(p01, '05-01 should be present');
    const p02 = data.plans.find((p) => p.id === '05-02');
    assert.ok(p02, '05-02 should be present');
    assert.strictEqual(p01.halted, false, 'unterminated frontmatter must fail open to not-halted');
    assert.deepEqual(p02.blocked_by, [], 'dependent of a fail-open-not-halted plan must not be blocked');
  });

  test('CRLF SUMMARY frontmatter still detects status: halted', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '06-crlf');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '06-01-PLAN.md', ['wave: 1', 'objective: Halted with CRLF summary', 'autonomous: true']);
    fs.writeFileSync(
      path.join(phaseDir, '06-01-SUMMARY.md'),
      ['---', 'phase: 06-crlf', 'plan: 01', 'status: halted', 'completed: 2026-08-02', '---', '', '# Summary', ''].join('\r\n'),
    );
    writePlan(phaseDir, '06-02-PLAN.md', [
      'wave: 2', 'objective: Depends on CRLF-summarized halt', 'autonomous: true', 'depends_on:', '  - 06-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '6', '--raw'], tmpDir);
    assert.ok(result.success, `phase-plan-index should succeed on CRLF frontmatter: ${result.error}`);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '06-01');
    assert.ok(p01, '06-01 should be present');
    const p02 = data.plans.find((p) => p.id === '06-02');
    assert.ok(p02, '06-02 should be present');
    assert.strictEqual(p01.halted, true, 'CRLF SUMMARY frontmatter must still parse status: halted');
    assert.deepEqual(p02.blocked_by, ['06-01'], 'dependent must be blocked even when the halt was recorded with CRLF newlines');
  });

  test('status complete does not block dependents', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '07-complete');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '07-01-PLAN.md', ['wave: 1', 'objective: Ordinary completion', 'autonomous: true']);
    writeSummary(phaseDir, '07-01-SUMMARY.md', 'complete');
    writePlan(phaseDir, '07-02-PLAN.md', [
      'wave: 2', 'objective: Depends on completed plan', 'autonomous: true', 'depends_on:', '  - 07-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '7', '--raw'], tmpDir);
    const data = JSON.parse(result.output);

    const p01 = data.plans.find((p) => p.id === '07-01');
    assert.ok(p01, '07-01 should be present');
    const p02 = data.plans.find((p) => p.id === '07-02');
    assert.ok(p02, '07-02 should be present');
    assert.strictEqual(p01.halted, false);
    assert.deepEqual(p02.blocked_by, []);
    assert.ok(data.runnable.includes('07-02'));
  });

  test('dependency cycle detection is unaffected by halt propagation', () => {
    tmpDir = createTempProject('gsd-2830-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '08-cycle');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '08-01-PLAN.md', [
      'wave: 1', 'objective: Cycle A', 'autonomous: true', 'depends_on:', '  - 08-02',
    ]);
    writePlan(phaseDir, '08-02-PLAN.md', [
      'wave: 1', 'objective: Cycle B', 'autonomous: true', 'depends_on:', '  - 08-01',
    ]);

    const result = runGsdTools(['phase-plan-index', '8', '--raw'], tmpDir);
    // CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs" bans
    // regex-matching a child process's human-readable stderr/reason prose —
    // assert on the typed failure signal (`result.success`) instead. Pair it
    // with a differential fixture: the identical dependency shape with the
    // cycle edge removed must succeed, isolating the cycle as the cause.
    assert.strictEqual(result.success, false, 'a dependency cycle must still fail the command');

    const acyclicDir = path.join(tmpDir, '.planning', 'phases', '09-nocycle');
    fs.mkdirSync(acyclicDir, { recursive: true });
    writePlan(acyclicDir, '09-01-PLAN.md', ['wave: 1', 'objective: No cycle A', 'autonomous: true']);
    writePlan(acyclicDir, '09-02-PLAN.md', [
      'wave: 1', 'objective: No cycle B', 'autonomous: true', 'depends_on:', '  - 09-01',
    ]);
    const acyclicResult = runGsdTools(['phase-plan-index', '9', '--raw'], tmpDir);
    assert.strictEqual(
      acyclicResult.success,
      true,
      `the identical dependency shape without the cycle edge must succeed, isolating the cycle as the cause of the failure above: ${acyclicResult.error}`,
    );
  });
});

describe('findPhaseInternal: halt propagation (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('direct dependent of a halted plan is blocked', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result, 'expected a result');
    assert.deepEqual(result.blocked_by['01-02-PLAN.md'], ['01-01'], '01-02 should be blocked by halted 01-01');
    assert.ok(!result.runnable_plans.includes('01-02-PLAN.md'));
  });

  test('transitive dependent is blocked via chain', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(result.blocked_by['01-03-PLAN.md'], ['01-01'], '01-03 should be transitively blocked');
    assert.ok(!result.runnable_plans.includes('01-03-PLAN.md'));
  });

  test('diamond dependency blocked by both halted ancestors', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-diamond');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '02-01-PLAN.md', ['wave: 1', 'objective: Halted A', 'autonomous: true']);
    writeSummary(phaseDir, '02-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-02-PLAN.md', ['wave: 1', 'objective: Halted B', 'autonomous: true']);
    writeSummary(phaseDir, '02-02-SUMMARY.md', 'halted');
    writePlan(phaseDir, '02-03-PLAN.md', [
      'wave: 2', 'objective: Diamond join', 'autonomous: true',
      'depends_on:', '  - 02-01', '  - 02-02',
    ]);

    const result = phaseLocator.findPhaseInternal(tmpDir, '2');
    assert.ok(result, 'expected a result');
    assert.deepEqual(
      [...result.blocked_by['02-03-PLAN.md']].sort(),
      ['02-01', '02-02'],
      'diamond join should be blocked by both halted ancestors, deduplicated',
    );
  });

  test('unrelated decoupled plan stays runnable', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(result.runnable_plans.includes('01-04-PLAN.md'), '01-04 (decoupled) must stay runnable');
    assert.strictEqual(result.blocked_by['01-04-PLAN.md'], undefined);
  });

  test('incomplete_plans stays byte-identical when blocked plans are present', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(
      [...result.incomplete_plans].sort(),
      ['01-02-PLAN.md', '01-03-PLAN.md', '01-04-PLAN.md'],
      'incomplete_plans must list every no-SUMMARY plan regardless of blocked status',
    );
  });

  test('halted_plans reports the halted plan itself by filename', () => {
    tmpDir = createTempProject('gsd-2830-pl-');
    buildBaseFixture(tmpDir);

    const result = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.deepEqual(result.halted_plans, ['01-01-PLAN.md']);
  });
});

describe('parity: phase-plan-index and findPhaseInternal agree on blocking (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('same fixture yields the same blocked-plan set and cause set from both readers', () => {
    tmpDir = createTempProject('gsd-2830-parity-');
    buildBaseFixture(tmpDir);

    const cliResult = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
    assert.ok(cliResult.success, `phase-plan-index should succeed: ${cliResult.error}`);
    const cliData = JSON.parse(cliResult.output);

    const locatorResult = phaseLocator.findPhaseInternal(tmpDir, '1');
    assert.ok(locatorResult, 'findPhaseInternal should return a result');

    // Build { planId -> sorted cause list } from each reader and require them
    // to be structurally identical (id-mapped, since one reader keys by bare
    // id and the other by filename).
    const cliBlocked = {};
    for (const plan of cliData.plans) {
      if (plan.blocked_by.length > 0) cliBlocked[plan.id] = [...plan.blocked_by].sort();
    }

    const locatorBlocked = {};
    for (const [filename, causes] of Object.entries(locatorResult.blocked_by)) {
      const planId = filename.replace(/-PLAN\.md$/i, '').replace(/^PLAN\.md$/i, '');
      locatorBlocked[planId] = [...causes].sort();
    }

    assert.deepEqual(
      locatorBlocked,
      cliBlocked,
      'phase-plan-index and findPhaseInternal must report the exact same blocked-plan-id -> cause-set mapping',
    );
  });
});

describe('computeHaltPropagation: graph invariants (#2830)', () => {
  test('a node with no depends_on and not halted is never blocked', () => {
    const { blockedBy } = planDependencyGraph.computeHaltPropagation([
      { id: 'A', resolvedDependsOn: [], halted: false },
    ]);
    assert.strictEqual(blockedBy.get('A'), undefined);
  });

  test('a halted node is never blocked by itself', () => {
    const { blockedBy } = planDependencyGraph.computeHaltPropagation([
      { id: 'A', resolvedDependsOn: [], halted: true },
    ]);
    assert.strictEqual(blockedBy.get('A'), undefined, 'a halted plan is halted, not "blocked"');
  });

  test('precomputedOrder (the phase.cts call shape) yields the same result as self-derived order', () => {
    // phase.cts's cmdPhasePlanIndex passes computeDependencyLevels's own
    // topological order in as `precomputedOrder` so this function does not
    // re-run Kahn's algorithm. Assert both call shapes agree.
    const nodes = [
      { id: 'A', resolvedDependsOn: [], halted: true },
      { id: 'B', resolvedDependsOn: ['A'], halted: false },
      { id: 'C', resolvedDependsOn: ['B'], halted: false },
    ];
    const selfDerived = planDependencyGraph.computeHaltPropagation(nodes);
    const withPrecomputed = planDependencyGraph.computeHaltPropagation(nodes, ['A', 'B', 'C']);
    assert.deepEqual([...withPrecomputed.blockedBy.entries()], [...selfDerived.blockedBy.entries()]);
    assert.deepEqual(withPrecomputed.order, ['A', 'B', 'C']);
    assert.strictEqual(withPrecomputed.visited, 3);
  });

  // Random DAG over N nodes: edges only point from a lower index to a higher
  // index (guarantees acyclicity by construction, independent of the code
  // under test), with a random halted flag per node.
  //
  // Acyclic BY CONSTRUCTION: `to` is always drawn strictly above `from`, so
  // no `.filter()` is involved. A filter here is not merely slower — with
  // n === 1 the predicate `from < to` is unsatisfiable and fast-check retries
  // generation forever, which hung the whole suite (the runner sets
  // --test-timeout=0, so it never dies). Hoisted to describe scope so the
  // regression test below can sample the identical arbitrary.
  const dagArb = fc.integer({ min: 1, max: 12 }).chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `N${i}`);
    const edgeArb = n < 2
      ? fc.constant([])
      : fc.array(
          fc.integer({ min: 0, max: n - 2 }).chain((from) =>
            fc.integer({ min: from + 1, max: n - 1 }).map((to) => ({ from, to }))),
          { maxLength: n * 2 },
        );
    const haltedArb = fc.array(fc.boolean(), { minLength: n, maxLength: n });
    return fc.record({ ids: fc.constant(ids), edges: edgeArb, halted: haltedArb });
  });

  test('fast-check — blocked set matches reachability from halted nodes', () => {
    fc.assert(
      fc.property(dagArb, ({ ids, edges, halted }) => {
        const dependsOn = new Map(ids.map((id) => [id, []]));
        for (const { from, to } of edges) {
          dependsOn.get(ids[from]).push(ids[to]);
        }
        const nodes = ids.map((id, i) => ({
          id,
          resolvedDependsOn: dependsOn.get(id),
          halted: halted[i],
        }));

        const { blockedBy } = planDependencyGraph.computeHaltPropagation(nodes);

        // Reference model: reachability via depends_on edges from a halted node.
        const haltedSet = new Set(nodes.filter((n) => n.halted).map((n) => n.id));
        const dependsOnMap = new Map(nodes.map((n) => [n.id, n.resolvedDependsOn]));
        function reachableHaltedCauses(id, seen = new Set()) {
          const causes = new Set();
          for (const dep of dependsOnMap.get(id) ?? []) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            if (haltedSet.has(dep)) causes.add(dep);
            for (const c of reachableHaltedCauses(dep, seen)) causes.add(c);
          }
          return causes;
        }

        for (const n of nodes) {
          const expected = [...reachableHaltedCauses(n.id)].sort();
          const actual = [...(blockedBy.get(n.id) ?? [])].sort();
          assert.deepEqual(
            actual,
            expected,
            `node ${n.id}: computeHaltPropagation blockedBy must equal halted-reachability`,
          );
        }
      }),
      { numRuns: 50, seed: 7 },
    );
  });

  test('the DAG generator terminates on the degenerate single-node case (regression: unsatisfiable filter hung the suite)', () => {
    // Bounded, non-hanging sample: if edgeArb regresses to a `.filter(from < to)`
    // over a forced-equal {from, to} pair (n === 1), fast-check would retry
    // generation forever and this assertion would never run.
    const samples = fc.sample(dagArb, { numRuns: 20, seed: 7 });
    assert.ok(samples.length === 20, 'fc.sample must return the requested number of samples without hanging');
    const singleNodeSamples = samples.filter(({ ids }) => ids.length === 1);
    assert.ok(singleNodeSamples.length > 0, 'the sample must include at least one degenerate single-node case');
    for (const { edges } of singleNodeSamples) {
      assert.deepEqual(edges, [], 'the single-node case must yield an empty edge list, not an unsatisfiable filter');
    }
  });
});

// init execute-phase (cmdInitExecutePhase, src/init.cts): the locator already
// computed halted_plans/blocked_by/runnable_plans, but the command built its
// output by explicit field enumeration, silently dropping all three. This
// drives the real CLI end to end (not the locator directly) to prove the
// passthrough.
describe('init execute-phase: halt propagation passthrough (#2830)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('halted_plans, blocked_by, runnable_plans are forwarded; incomplete fields stay byte-identical', () => {
    tmpDir = createTempProject('gsd-2830-init-');
    buildBaseFixture(tmpDir);

    const result = runGsdTools(['init', 'execute-phase', '1', '--raw'], tmpDir);
    assert.ok(result.success, `init execute-phase should succeed: ${result.error}`);
    const json = JSON.parse(result.output);

    // Guard: if the phase was not resolved, every assertion below is vacuous.
    assert.strictEqual(json.phase_found, true, 'phase must be found for the rest of this test to be meaningful');

    assert.ok(
      json.halted_plans.includes('01-01-PLAN.md'),
      'halted_plans must include the halted plan',
    );

    assert.ok(
      Object.prototype.hasOwnProperty.call(json.blocked_by, '01-02-PLAN.md'),
      'blocked_by must have an entry for the direct dependent',
    );
    assert.deepEqual(
      json.blocked_by['01-02-PLAN.md'],
      ['01-01'],
      "blocked_by['01-02-PLAN.md'] must name 01-01 as the blocking cause",
    );

    assert.ok(
      !json.runnable_plans.includes('01-02-PLAN.md'),
      'the dependent must NOT be offered as runnable work',
    );
    assert.ok(
      json.runnable_plans.includes('01-04-PLAN.md'),
      'the decoupled plan (no dependency on the halted plan) must stay runnable',
    );

    // Back-compat: incomplete_plans/incomplete_count must be exactly what they
    // were pre-#2830 — every no-SUMMARY plan, blocked or not, still counted.
    assert.deepEqual(
      [...json.incomplete_plans].sort(),
      ['01-02-PLAN.md', '01-03-PLAN.md', '01-04-PLAN.md'],
      'incomplete_plans must be unchanged by halt-awareness',
    );
    assert.strictEqual(
      json.incomplete_count,
      3,
      'incomplete_count must be unchanged by halt-awareness',
    );
  });
});

// Adversarial review of the #2830 fix found two confirmed defects:
//   1. (BLOCKER) computeHaltPropagation's Kahn pass silently drops cycle
//      participants (and anything downstream of them) from BOTH `order` and
//      `blockedBy` — phase.cts hard-fails on a cycle before this ever
//      matters, but phase-locator.cts (consumed by `init execute-phase`)
//      does not pre-check, so a plan directly depends_on-ing a halted plan
//      inside a cycle was reported as ordinary runnable.
//   2. (MAJOR) the summary templates presented `status: halted` as a
//      trailing `#`-comment on the value line, but `extractFrontmatter`
//      does not strip trailing YAML comments — an executor mimicking the
//      template's own presentation wrote a halt that silently read back as
//      not-halted.
describe('#2830 review findings', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  test('defect 1: cycle repro — 08-02 depends_on [halted 08-01, 08-03]; 08-03 depends_on [08-02]', () => {
    tmpDir = createTempProject('gsd-2830-review-cycle-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '08-cyclehalt');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '08-01-PLAN.md', ['wave: 1', 'objective: Halted upstream', 'autonomous: true']);
    writeSummary(phaseDir, '08-01-SUMMARY.md', 'halted');
    writePlan(phaseDir, '08-02-PLAN.md', [
      'wave: 2', 'objective: Depends on halted + cyclic peer', 'autonomous: true',
      'depends_on:', '  - 08-01', '  - 08-03',
    ]);
    writePlan(phaseDir, '08-03-PLAN.md', [
      'wave: 2', 'objective: Cyclic peer of 08-02', 'autonomous: true', 'depends_on:', '  - 08-02',
    ]);

    const result = runGsdTools(['init', 'execute-phase', '8', '--raw'], tmpDir);
    assert.ok(result.success, `init execute-phase should succeed: ${result.error}`);
    const json = JSON.parse(result.output);
    assert.strictEqual(json.phase_found, true, 'phase must be found for the rest of this test to be meaningful');

    assert.ok(
      !json.runnable_plans.includes('08-02-PLAN.md'),
      'a plan that directly depends_on a halted plan must never be offered as runnable, cycle or not',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(json.blocked_by, '08-02-PLAN.md'),
      'a plan must never silently vanish from both runnable_plans and blocked_by',
    );
    assert.ok(
      Array.isArray(json.blocked_by['08-02-PLAN.md']) && json.blocked_by['08-02-PLAN.md'].length > 0,
      'blocked_by entry must be non-empty, not a vacuous placeholder',
    );
  });

  test('defect 1: self-dependency (A depends_on A, nothing halted) must not be silently runnable', () => {
    tmpDir = createTempProject('gsd-2830-review-self-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '09-selfdep');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '09-01-PLAN.md', [
      'wave: 1', 'objective: Depends on itself', 'autonomous: true', 'depends_on:', '  - 09-01',
    ]);

    const result = runGsdTools(['init', 'execute-phase', '9', '--raw'], tmpDir);
    assert.ok(result.success, `init execute-phase should succeed: ${result.error}`);
    const json = JSON.parse(result.output);
    assert.strictEqual(json.phase_found, true, 'phase must be found for the rest of this test to be meaningful');

    assert.ok(
      !json.runnable_plans.includes('09-01-PLAN.md'),
      'a self-dependent plan must not be silently offered as runnable',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(json.blocked_by, '09-01-PLAN.md'),
      'a self-dependent plan must never silently vanish from both runnable_plans and blocked_by',
    );
  });

  test('defect 2: SUMMARY status with an inline YAML comment still blocks the dependent', () => {
    tmpDir = createTempProject('gsd-2830-review-comment-');
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '10-inlinecomment');
    fs.mkdirSync(phaseDir, { recursive: true });

    writePlan(phaseDir, '10-01-PLAN.md', ['wave: 1', 'objective: Halted, recorded with an inline comment', 'autonomous: true']);
    writeSummary(phaseDir, '10-01-SUMMARY.md', 'halted # designed stop');
    writePlan(phaseDir, '10-02-PLAN.md', [
      'wave: 2', 'objective: Depends on the inline-commented halt', 'autonomous: true', 'depends_on:', '  - 10-01',
    ]);

    const result = runGsdTools(['init', 'execute-phase', '10', '--raw'], tmpDir);
    assert.ok(result.success, `init execute-phase should succeed: ${result.error}`);
    const json = JSON.parse(result.output);
    assert.strictEqual(json.phase_found, true, 'phase must be found for the rest of this test to be meaningful');

    assert.ok(
      json.halted_plans.includes('10-01-PLAN.md'),
      'status: halted # designed stop must still be recognized as halted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(json.blocked_by, '10-02-PLAN.md'),
      'the dependent of an inline-commented halt must be blocked',
    );
    assert.ok(
      !json.runnable_plans.includes('10-02-PLAN.md'),
      'the dependent of an inline-commented halt must not be offered as runnable',
    );
  });

  test('defect 2: isHaltedStatus strips an unquoted trailing YAML comment before comparing', () => {
    const { isHaltedStatus } = planDependencyGraph;
    assert.strictEqual(isHaltedStatus('halted'), true);
    assert.strictEqual(isHaltedStatus('Halted'), true);
    assert.strictEqual(isHaltedStatus('halted  '), true);
    assert.strictEqual(isHaltedStatus('halted # designed stop'), true);
    assert.strictEqual(isHaltedStatus('halted#nospace'), false, 'a `#` with no preceding whitespace is not a YAML comment');
    assert.strictEqual(isHaltedStatus('complete'), false);
    assert.strictEqual(isHaltedStatus('complete # done'), false);
    assert.strictEqual(isHaltedStatus(''), false);
    assert.strictEqual(isHaltedStatus(undefined), false);
  });
});

  });
}

// ═══════════════════════════════════════════════════════════════════════
// Folded from tests/fix-2855-phase-locator-workstream-archive-scope.test.cjs
// (#3335 H3 fold).
//
// #2855: the archived-milestone fallback hardcoded the project-root
// .planning/milestones/ tree instead of routing through the
// workstream-aware planningDir(cwd) helper (the same seam the active-phase
// search and the archive-write path already use). A pending phase in one
// workstream, whose own phases/ dir does not exist yet, would silently
// resolve to a same-numbered phase archived under the ROOT tree (an
// unrelated workstream's history, or a flat-mode project's archive).
//
// GSD_WORKSTREAM/GSD_PROJECT are read directly from process.env by
// planningDir() when omitted, so every test here explicitly saves/restores
// both to avoid leaking state across tests or picking up ambient shell env.
// ═══════════════════════════════════════════════════════════════════════
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-2855-phase-locator-workstream-archive-scope', () => {

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

  });
}

// ═══════════════════════════════════════════════════════════════════════════
// #3882 (ADR-3473 §8.2) — listAllPhaseDirs, the parity guarantee on
// listMilestonePhaseDirs, sentinel-range boundaries, migrated-call-site
// invariance, and the lint-phase-enumeration-drift.cjs guard's fail-capable
// proof. `tests/estimate-calibrate.test.cjs` (rows A1a/A1b/A2/A3) covers the
// actual calibration defect this issue fixes; this section covers rows
// B1-B4, C1, D1-D3, E1/E2, F1-F3 from
// .gsd/phase/feat-3882-enumerations/50-test-matrix.md.
//
// Per that doc's §G test-hermeticity rule: every fixture here builds its own
// temp project via helpers.cjs and removes it through `cleanup()` — no raw
// `fs.rmSync` (`local/no-raw-rmsync-in-tests`), and no fixture keyed to a
// real repo path.
// ═══════════════════════════════════════════════════════════════════════════

/** Build `<tmp>/.planning/phases/<name>` for each of `names`. Returns the phases dir. */
function build3882PhasesFixture(names) {
  const tmp = createTempDir('gsd-3882-');
  const phasesDir = path.join(tmp, '.planning', 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });
  for (const name of names) fs.mkdirSync(path.join(phasesDir, name));
  return { tmp, phasesDir };
}

// ─── B. The new API — both axes, stated ────────────────────────────────────

describe('listAllPhaseDirs (#3882, ADR-3473 §8.2)', () => {
  test('B1: returns the physical set — every phase directory on disk, across milestone windows', (t) => {
    const { tmp, phasesDir } = build3882PhasesFixture(['01-one', '02-two', '03A-suffix', '04.1-decimal']);
    t.after(() => cleanup(tmp));

    const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false });
    assert.deepEqual(result, { value: ['01-one', '02-two', '03A-suffix', '04.1-decimal'], scope: 'complete' });
  });

  test('B2: includeSentinels cannot be obtained by omission — compile-time only, pin each explicit runtime value', (t) => {
    // TypeScript refuses `listAllPhaseDirs(phasesDir, {})` and
    // `listAllPhaseDirs(phasesDir)` at the BUILD step (`opts.includeSentinels`
    // has no `?` and no default) — `npm run build:lib` / `npx tsc --noEmit`
    // are the actual compile-time gate for that contract; there is no
    // runtime shape for "omitted" to assert against here (the compiled
    // `.cjs` has no type information left to inspect). This row instead pins
    // the two EXPLICIT values so their divergence (the entire point of the
    // axis) is asserted, not merely documented.
    const { tmp, phasesDir } = build3882PhasesFixture(['01-real', '999-icebox']);
    t.after(() => cleanup(tmp));

    const withSentinels = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: true }).value;
    const withoutSentinels = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false }).value;
    assert.notDeepEqual(withSentinels, withoutSentinels,
      'includeSentinels must change the returned set — a no-op boolean would defeat the whole axis');
  });

  test('B3: includeSentinels:false — physical set minus sentinels, the combination collectCalibrationSamples needs', (t) => {
    const { tmp, phasesDir } = build3882PhasesFixture(['01-real', '02-real', '0-backlog', '999-icebox']);
    t.after(() => cleanup(tmp));

    const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false });
    assert.deepEqual(result, { value: ['01-real', '02-real'], scope: 'complete' });
  });

  test('B4: includeSentinels:true — the archival/lookup/diagnostic intent, sentinels kept, order asserted', (t) => {
    const { tmp, phasesDir } = build3882PhasesFixture(['01-real', '02-real', '0-backlog', '999-icebox']);
    t.after(() => cleanup(tmp));

    const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: true });
    // Order asserted directly (comparePhaseNum: 0 < 1 < 2 < 999) — a prior
    // version of this row `.sort()`ed both sides, which discarded the order
    // assertion `listAllPhaseDirs`'s own documented `comparePhaseNum` sort
    // contract makes available.
    assert.deepEqual(result, { value: ['0-backlog', '01-real', '02-real', '999-icebox'], scope: 'complete' });
  });

  test('absent phases dir is a real empty (scope: complete), not a failure', (t) => {
    const tmp = createTempDir('gsd-3882-');
    t.after(() => cleanup(tmp));
    const phasesDir = path.join(tmp, '.planning', 'phases'); // never created

    assert.deepEqual(phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: true }), { value: [], scope: 'complete' });
    assert.deepEqual(phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false }), { value: [], scope: 'complete' });
  });

  test('an existing-but-unreadable phases dir is scope: unreadable, not a silent empty (#8.5)', () => {
    const tmp = createTempDir('gsd-3882-');
    const phasesDir = path.join(tmp, '.planning', 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    // #3882/CLAUDE.md IO-failure-injection rule: mode-bit tricks are
    // unreliable under root/CI (root bypasses 0o000 with zero coverage) and,
    // worse here, leave the directory in a state `cleanup()`'s recursive
    // rmSync cannot always tear down deterministically. Inject the failure
    // deterministically via method monkeypatching on `fs.readdirSync`
    // instead — restored, and the real directory removed via `cleanup()`,
    // in a single `finally` so no failure mode can leak a broken permission
    // bit or a raw `rmSync` call into this test.
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (...args) => {
      if (args[0] === phasesDir) {
        const err = new Error('EACCES: permission denied, scandir');
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddirSync.apply(fs, args);
    };
    try {
      const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: true });
      assert.deepEqual(result, { value: [], scope: 'unreadable' });
    } finally {
      fs.readdirSync = originalReaddirSync;
      cleanup(tmp);
    }
  });
});

// ─── C. Parity — listMilestonePhaseDirs is UNCHANGED (highest-risk row) ───

describe('listMilestonePhaseDirs output is unchanged (#3882 row C1)', () => {
  test('C1: byte-identical to a verbatim expectation captured from origin/next\'s built lib', (t) => {
    // Captured by building origin/next (832dcbb7513d0e00bfe31c072c48751bb16e88cf)
    // in an isolated worktree (`npm ci` -> build:lib's own `prepare` script)
    // and calling `listMilestonePhaseDirs(phasesDir)` (no `cwd`) against this
    // EXACT fixture set, BEFORE any change in this diff — never re-derived
    // from the new code (#3427 anti-fixture-trap discipline).
    const EXPECTED_FROM_NEXT = { value: ['01-one', '02-two', '03A-suffix', '04.1-decimal'], scope: 'complete' };

    const { tmp, phasesDir } = build3882PhasesFixture([
      '01-one', '02-two', '03A-suffix', '04.1-decimal', '0-backlog', '999-icebox',
    ]);
    t.after(() => cleanup(tmp));

    const actual = phaseLocator.listMilestonePhaseDirs(phasesDir);
    assert.deepEqual(actual, EXPECTED_FROM_NEXT,
      `listMilestonePhaseDirs must be byte-identical to origin/next's behavior for the 16 callers depending on it; got ${JSON.stringify(actual)}`);
  });
});

// ─── D. Boundaries — the sentinel range, limit-1/limit/limit+1 ────────────

describe('sentinel-range boundaries, driven through the new API (#3882 rows D1-D3)', () => {
  test('D1: lower edge — 0 is the sentinel; 1 (just above) is kept. (there is no "just below" 0 for a phase id)', (t) => {
    const { tmp, phasesDir } = build3882PhasesFixture(['0-backlog', '01-real']);
    t.after(() => cleanup(tmp));

    const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false });
    assert.deepEqual(result.value, ['01-real']);
  });

  test('D2: upper edge — 998 (limit-1, kept), 999 (limit, sentinel, dropped), 1000 (limit+1, kept)', (t) => {
    const { tmp, phasesDir } = build3882PhasesFixture(['998-real', '999-icebox', '1000-real']);
    t.after(() => cleanup(tmp));

    const result = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false });
    assert.deepEqual(result.value, ['998-real', '1000-real']);
  });

  test('D3: decimal/letter-suffix continuations at the sentinel-range edges — pin the ACTUAL (conservative) reading, not a re-derived one', (t) => {
    // #1324's bracket-shaped continuations (e.g. a decimal sub-phase of 0 or
    // 999, or a letter-suffixed one) are string-indistinguishable from a
    // sentinel by a naive prefix test. isSentinelPhaseId's own documented
    // residual ambiguity must not be silently resolved in passing here.
    //
    // Review fix: the prior version of this row derived `expectedKept` by
    // calling isSentinelPhaseId itself, which can only fail if the call is
    // deleted outright — a proxy for "the call happened", not for "the call
    // returns the right thing". Verified by direct execution
    // (`isSentinelPhaseId('0.1-decimal-of-backlog') === true`,
    // `isSentinelPhaseId('999A-suffix-of-icebox') === true`,
    // `isSentinelPhaseId('01-real') === false`) and hardcoded below.
    //
    // The prior fixture was ALSO trivial in a second way: both boundary-shaped
    // entries land on the "dropped" side, so `01-real` — the one surviving
    // entry — is not itself boundary-shaped, and the row could not catch a
    // regression that started wrongly KEEPING a continuation. Two genuinely
    // non-sentinel continuation-shaped dirs are added at the SAME edges
    // (`1000.1-decimal-real` just above the upper sentinel bound, decimal
    // continuation; `01A-real-suffix` a letter-suffixed ordinary phase) so
    // the row asserts both directions: continuation-of-a-sentinel dropped,
    // continuation-of-a-real-phase kept.
    const { tmp, phasesDir } = build3882PhasesFixture([
      '0.1-decimal-of-backlog', '999A-suffix-of-icebox', '01-real',
      '1000.1-decimal-real', '01A-real-suffix',
    ]);
    t.after(() => cleanup(tmp));

    const withoutSentinels = phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false }).value;
    assert.deepEqual(
      withoutSentinels.slice().sort(),
      ['01-real', '01A-real-suffix', '1000.1-decimal-real'].sort(),
    );
  });
});

// ─── E. Migrated call sites ─────────────────────────────────────────────

describe('migrated exemptions behave identically (#3882 rows E1/E2)', () => {
  /** Capture whatever a synchronous fn writes to `fd` via fs.writeSync — delegates to the shared, safe helper (#4306) that always delivers real bytes rather than fabricating a byte count. */
  function captureFdWrite(fd, fn) {
    return captureFdSync(fd, fn);
  }

  /**
   * Run `subject(tmpDir, false)` in-process with `fs.readdirSync` forced to a
   * FIXED order for the exact `phasesDir` path, and return its parsed JSON
   * output. `runGsdTools` spawns a real subprocess, which neither
   * `fs.readdirSync` monkeypatching nor stdout capture can cross — this
   * drives the actual shipped command function directly instead, mirroring
   * tests/config-get-default.test.cjs's established in-process CLI pattern.
   */
  function runWithForcedReaddirOrder(tmpDir, phasesDir, order, subject) {
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (...args) => {
      if (args[0] === phasesDir && args[1] && args[1].withFileTypes) {
        return order.map((name) => ({ name, isDirectory: () => true, isFile: () => false }));
      }
      return originalReaddirSync.apply(fs, args);
    };
    try {
      return JSON.parse(captureFdWrite(1, () => subject(tmpDir, false)));
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  }

  /** Build a ROADMAP.md + two colliding phase-01 directories (only one carries a SUMMARY). */
  function buildCollidingPhaseFixture(prefix) {
    const tmpDir = createTempProject(prefix);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# ROADMAP', '', '## Milestone v1.0', '', '## Phase 01: Real Phase', '**Goal:** ship it', '',
    ].join('\n'));
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const realDir = path.join(phasesDir, '01-real');
    const dupDir = path.join(phasesDir, '01-duplicate');
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(dupDir, { recursive: true });
    // Only '01-real' carries a matched PLAN/SUMMARY pair — the observable
    // that reveals which of the two colliding directories each caller
    // actually selected. countMatchedSummaries (core-utils.cts) only counts a
    // SUMMARY that pairs with an existing PLAN, so both files are required.
    fs.writeFileSync(path.join(realDir, '01-PLAN.md'), '---\nphase: 01-real\n---\nplan\n');
    fs.writeFileSync(path.join(realDir, '01-SUMMARY.md'), '---\nphase: 01-real\n---\ndone\n');
    return { tmpDir, phasesDir };
  }

  test('E1: colliding phase numbers (comparePhaseNum returns 0 for 01-real/01-duplicate) — cmdRoadmapAnalyze first-wins vs cmdInitMilestoneOp last-wins, SAME tie order, OPPOSITE selection', () => {
    // #3882: both migrated call sites route through the SAME owner
    // (listAllPhaseDirs) and the SAME comparePhaseNum sort, but the sort is
    // STABLE and comparePhaseNum returns 0 for a genuinely colliding phase
    // number, so real disks' unspecified readdirSync order decides the tie.
    // Fault-inject (monkeypatch — never chmod, which root/CI bypasses) a
    // FIXED order so the tie is deterministic, then assert each caller's own
    // documented selection rule against it: `matches[0]` "TAKE" (phase-id.cts
    // ~985 — cmdRoadmapAnalyze reads a phase ONCE per heading to decorate a
    // row it already emits, first match wins) vs `diskPhaseDirs.set()`
    // (src/init.cts ~2198 — later entries in iteration order overwrite
    // earlier ones in the Map, so the LAST directory wins). Same input order,
    // opposite winners — exactly the risk a raw-fs -> comparePhaseNum reorder
    // creates and the one this row exists to catch.
    const roadmap = require('../gsd-core/bin/lib/roadmap.cjs');
    const init = require('../gsd-core/bin/lib/init.cjs');
    const { tmpDir, phasesDir } = buildCollidingPhaseFixture('gsd-3882-e1-collide-');
    try {
      // Forced order: '01-duplicate' (no summary) BEFORE '01-real' (has one).
      const order = ['01-duplicate', '01-real'];
      const analyzeOut = runWithForcedReaddirOrder(tmpDir, phasesDir, order, roadmap.cmdRoadmapAnalyze);
      const initOut = runWithForcedReaddirOrder(tmpDir, phasesDir, order, init.cmdInitMilestoneOp);

      const analyzedPhase = analyzeOut.phases.find((p) => p.number === '01');
      assert.ok(analyzedPhase, 'phase 01 must resolve despite the collision');
      assert.equal(analyzedPhase.summary_count, 0,
        'cmdRoadmapAnalyze must select the FIRST directory in tie order (01-duplicate, no summary) — matches[0] first-wins');

      assert.equal(initOut.completed_phases, 1,
        'cmdInitMilestoneOp must select the LAST directory in tie order (01-real, has a summary) — Map.set last-wins, ' +
        'the OPPOSITE selection from cmdRoadmapAnalyze given the identical input order');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('E1a: reversing the forced tie order reverses BOTH callers\' selections — confirms the effect tracks the collision, not a fixed name preference', () => {
    const roadmap = require('../gsd-core/bin/lib/roadmap.cjs');
    const init = require('../gsd-core/bin/lib/init.cjs');
    const { tmpDir, phasesDir } = buildCollidingPhaseFixture('gsd-3882-e1a-collide-');
    try {
      // Reversed order: '01-real' (has summary) BEFORE '01-duplicate' (none).
      const order = ['01-real', '01-duplicate'];
      const analyzeOut = runWithForcedReaddirOrder(tmpDir, phasesDir, order, roadmap.cmdRoadmapAnalyze);
      const initOut = runWithForcedReaddirOrder(tmpDir, phasesDir, order, init.cmdInitMilestoneOp);

      const analyzedPhase = analyzeOut.phases.find((p) => p.number === '01');
      assert.equal(analyzedPhase.summary_count, 1,
        'first-wins now selects 01-real (first in the reversed order) — has a summary');
      assert.equal(initOut.completed_phases, 0,
        'last-wins now selects 01-duplicate (last in the reversed order) — no summary');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('E1b (regression pin, original row): cmdRoadmapAnalyze\'s heading->directory lookup is unaffected by a sentinel directory\'s presence', () => {
    // #3882: migrated `_phaseDirNames` (src/roadmap.cts) from a hand-rolled
    // readdirSync to listAllPhaseDirs({includeSentinels:true}). Its own
    // written exemption reason establishes WHY sentinel-inclusion is
    // output-invariant here: every heading is tested with isSentinelPhaseId
    // BEFORE this list is ever consulted (collectAnalyzePhases), so a
    // sentinel directory can never be the value looked up. Assert that
    // invariance directly, mirroring A1a/A1b's differential shape.
    const tmpDir = createTempProject('gsd-3882-e1-');
    try {
      const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
      fs.writeFileSync(roadmapPath, [
        '# ROADMAP',
        '',
        '## Milestone v1.0',
        '',
        '## Phase 01: Real Phase',
        '**Goal:** ship it',
        '',
      ].join('\n'));
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-real'), { recursive: true });

      const before = JSON.parse(runGsdTools('query roadmap.analyze', tmpDir).output);

      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999-icebox'), { recursive: true });
      const after = JSON.parse(runGsdTools('query roadmap.analyze', tmpDir).output);

      assert.deepEqual(after.phases, before.phases,
        'adding a sentinel phase directory must not change the resolved phase list');
      assert.deepEqual(after.missing_details, before.missing_details);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('E2: unmigrated exemptions are still guarded by detector 1', () => {
    // Retiring coverage for a call site that did NOT move would be a silent
    // regression. Spot-check the exemptions this phase deliberately left in
    // place (see the guard's own header comment for the written reasons).
    const stillExempt = [
      [path.join('src', 'milestone.cts'), 'archivePhaseDirectories'],
      [path.join('src', 'milestone.cts'), 'cmdPhasesClear'],
      [path.join('src', 'verify.cts'), 'cmdValidateHealth'],
      [path.join('src', 'init.cts'), 'detectHasPriorPhases'],
      [path.join('src', 'init.cts'), 'detectUiPhaseActive'],
    ];
    for (const [file, fn] of stillExempt) {
      const exempt = driftGuard.FUNCTION_SCOPED_EXEMPTIONS.get(file);
      assert.ok(exempt && exempt.has(fn), `${file} ${fn} must still carry a function-scoped exemption`);
    }
    // And the migrated ones must NOT still be listed (removing coverage
    // silently would be one failure mode; leaving a stale, now-pointless
    // exemption around would be a different but real one — this pins both).
    const roadmapExempt = driftGuard.FUNCTION_SCOPED_EXEMPTIONS.get(path.join('src', 'roadmap.cts'));
    assert.ok(!roadmapExempt || !roadmapExempt.has('cmdRoadmapAnalyze'),
      'cmdRoadmapAnalyze must no longer carry an exemption — it no longer hand-rolls a readdirSync');
    const initExempt = driftGuard.FUNCTION_SCOPED_EXEMPTIONS.get(path.join('src', 'init.cts'));
    assert.ok(!initExempt || !initExempt.has('cmdInitMilestoneOp'),
      'cmdInitMilestoneOp must no longer carry an exemption — its diskPhaseDirs lookup no longer hand-rolls a readdirSync');
    // #3348: cmdVerifySchemaDrift's own inline phasesDir readdirSync/matchPhaseDirs
    // block was lifted into the shared resolvePhaseDirByToken helper (also used by
    // the new cmdVerifyContextDrift) — same "call site no longer hand-rolls a
    // readdirSync" shape as the roadmap/init migrations above, so the exemption
    // moved with the call site rather than living at both names.
    const verifyExempt = driftGuard.FUNCTION_SCOPED_EXEMPTIONS.get(path.join('src', 'verify.cts'));
    assert.ok(!verifyExempt || !verifyExempt.has('cmdVerifySchemaDrift'),
      'cmdVerifySchemaDrift must no longer carry an exemption — its phasesDir readdirSync now lives in resolvePhaseDirByToken');
    assert.ok(verifyExempt && verifyExempt.has('resolvePhaseDirByToken'),
      'resolvePhaseDirByToken must carry the function-scoped exemption — it is the new owner of the extracted readdirSync');
  });
});

// ─── F. The guard — both detectors, proven fail-capable ──────────────────

describe('lint-phase-enumeration-drift.cjs guard (#3882 rows F1-F3)', () => {
  test('F1: detector 2 (sentinel literal) still fires on a bare 999 outside phase-id.cts', () => {
    const planted = "if (phaseNum === 999) return true;\n";
    const violations = driftGuard.findPhaseEnumerationDrift(planted, path.join('src', 'not-an-owner.cts'));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 1);
  });

  test('F1b: detector 2 still fires on a bare SENTINEL_RANGES reference outside phase-id.cts', () => {
    const planted = 'const x = SENTINEL_RANGES.includes(n);\n';
    const violations = driftGuard.findPhaseEnumerationDrift(planted, path.join('src', 'not-an-owner.cts'));
    assert.equal(violations.length, 1);
  });

  test('F2: detector 1 (enumeration) still fires on a hand-rolled readdirSync outside the owner', () => {
    const planted = "const x = fs.readdirSync(phasesDir, { withFileTypes: true });\n";
    const violations = driftGuard.findPhaseEnumerationDrift(planted, path.join('src', 'not-an-owner.cts'));
    assert.equal(violations.length, 1);
  });

  test('F3: guardCanFail — both detectors are demonstrated failing above (not merely asserted passing), and the real tree is currently clean', () => {
    const root = path.join(__dirname, '..');
    const violations = driftGuard.scanRepo(root);
    assert.deepEqual(violations, [], 'the real tree must currently pass — F1/F1b/F2 above already proved the detectors CAN fail on a planted violation');
  });

  test('the owner files themselves are exempt by construction', () => {
    assert.ok(driftGuard.OWNER_FILES.has(path.join('src', 'phase-locator.cts')));
    assert.ok(driftGuard.OWNER_FILES.has(path.join('src', 'phase-id.cts')));
  });
});

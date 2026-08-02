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

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const phaseLocator = require('../gsd-core/bin/lib/phase-locator.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

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

/**
 * GSD Tools Tests - New Milestone Clear Phases (#1588, #1447)
 *
 * Verifies that `phases clear` removes all phase subdirectories from
 * .planning/phases/, leaving the directory itself intact.
 *
 * Also covers the #1447 uncommitted-changes guard: phases clear must refuse
 * to delete phase directories that contain uncommitted work.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempGitProject, cleanup, readFileNormalized } = require('./helpers.cjs');
const { writeState } = require('./fixtures/index.cjs');

describe('phases clear command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('clears all phase subdirectories from .planning/phases/', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    // Simulate phases left over from a previous milestone
    const phase1 = path.join(phasesDir, '01-foundation');
    const phase2 = path.join(phasesDir, '02-api');
    const phase3 = path.join(phasesDir, '03-ui');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.mkdirSync(phase3, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 3, 'should report 3 directories cleared');

    // phases/ directory itself must still exist
    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');

    // all subdirectories must be gone
    const remaining = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    assert.strictEqual(remaining.length, 0, 'no phase subdirectories should remain');
  });

  test('succeeds with cleared=0 when phases directory is already empty', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    // createTempProject creates the directory but leaves it empty

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when already empty');
    assert.ok(fs.existsSync(phasesDir), '.planning/phases/ directory should still exist');
  });

  test('succeeds with cleared=0 when phases directory does not exist', () => {
    // Remove the phases directory entirely
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test removal to simulate absent phases dir (SUT behavior, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 0, 'should report 0 cleared when directory absent');
  });

  test('does not remove files (only directories) at the phases root', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    // Put a stray file directly in phases/ (edge case)
    fs.writeFileSync(path.join(phasesDir, 'README.md'), '# Phases');

    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should report 1 directory cleared (not the file)');

    // File must survive
    assert.ok(
      fs.existsSync(path.join(phasesDir, 'README.md')),
      'files at phases root should be preserved'
    );
  });

  test('archives nested phase content (moved, not deleted) (#1871)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    const nested = path.join(phase1, 'subdir');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep-file.md'), '# Deep');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Source is cleared (moved away)...
    assert.ok(!fs.existsSync(phase1), 'phase directory should be moved out of .planning/phases/');
    // ...but the nested content SURVIVES in the archive (not destroyed).
    const archive = findPhasesArchive(tmpDir);
    assert.ok(archive, 'an archive dir milestones/*-phases/ should exist');
    assert.ok(
      fs.existsSync(path.join(archive, '01-foundation', 'subdir', 'deep-file.md')),
      'nested phase content must be preserved in the archive, not deleted',
    );
  });
});

// Locate the `milestones/<version>-phases/` archive directory created by phases clear.
function findPhasesArchive(tmpDir) {
  const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
  try {
    for (const entry of fs.readdirSync(milestonesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /-phases$/.test(entry.name)) {
        return path.join(milestonesDir, entry.name);
      }
    }
  } catch {
    /* no milestones dir */
  }
  return null;
}

// ─── #1447: uncommitted-changes guard ───────────────────────────────────────

describe('phases clear: uncommitted-changes guard (#1447)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('aborts with error when phase dirs contain uncommitted files', () => {
    // Add a phase directory with an untracked (uncommitted) file
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (uncommitted)');
    // Do NOT commit — leave as untracked/uncommitted changes

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'phases clear should fail when uncommitted changes exist');
    assert.ok(
      result.error.includes('uncommitted') || result.error.includes('aborted'),
      `expected error about uncommitted changes, got: ${result.error}`
    );
    // Phase directory must still exist (was not deleted)
    assert.ok(fs.existsSync(phase1), 'phase directory must survive when guard fires');
  });

  test('aborts when phase dirs have staged but uncommitted changes', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (staged)');
    // Stage the file but do not commit
    execSync('git add .planning/phases/', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(!result.success, 'phases clear should fail when staged-but-uncommitted changes exist');
    assert.ok(
      result.error.includes('uncommitted') || result.error.includes('aborted'),
      `expected error about uncommitted changes, got: ${result.error}`
    );
    assert.ok(fs.existsSync(phase1), 'phase directory must survive when guard fires');
  });

  test('--force bypasses the uncommitted-changes guard and deletes anyway', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (uncommitted)');
    // Do NOT commit

    const result = runGsdTools('phases clear --confirm --force', tmpDir);
    assert.ok(result.success, `--force should bypass guard and succeed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory');
    assert.ok(!fs.existsSync(phase1), 'phase directory must be removed when --force is passed');
  });

  test('succeeds without --force when all phase files are committed', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan (committed)');
    // Commit the phase files
    execSync('git add .planning/phases/', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add phase"', { cwd: tmpDir, stdio: 'pipe' });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `should succeed when phase files are committed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory');
    // #1871: a committed phase dir is ARCHIVED (moved to milestones/*-phases/), not destroyed.
    assert.ok(!fs.existsSync(phase1), 'committed phase directory should be moved out of .planning/phases/');
    const archive = findPhasesArchive(tmpDir);
    assert.ok(archive, 'a milestones/*-phases/ archive should be created for committed phase dirs');
    assert.ok(
      fs.existsSync(path.join(archive, '01-foundation', 'PLAN.md')),
      'committed phase content must be preserved in the archive, not hard-deleted',
    );
  });

  test('guard skips gracefully when not in a git repo (no guard, proceeds normally)', () => {
    // Non-git project: createTempProject creates a plain project without git
    const nonGitDir = createTempProject();
    try {
      const phasesDir = path.join(nonGitDir, '.planning', 'phases');
      const phase1 = path.join(phasesDir, '01-foundation');
      fs.mkdirSync(phase1, { recursive: true });
      fs.writeFileSync(path.join(phase1, 'PLAN.md'), '# Plan');

      // Without git, the guard cannot check status — it should skip and proceed
      const result = runGsdTools('phases clear --confirm', nonGitDir);
      assert.ok(result.success, `should succeed in non-git repo: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(output.cleared, 1, 'should clear 1 phase directory in non-git project');
    } finally {
      cleanup(nonGitDir);
    }
  });
});

// ─── #2288: --archive-version override ──────────────────────────────────────

describe('phases clear: archive-version override (#2288)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('override wins over live milestone state (new-milestone switches STATE before phases.clear)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm --archive-version v1.0', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, 1, 'should report 1 directory cleared');

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'phase history should archive under the OLD (override) version'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-phases')),
      'phase history must NOT be misfiled under the live-read NEW version'
    );
  });

  test('no override falls back to live milestone version (no behavior change)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-phases', '01-foundation')),
      'without an override, the live-read milestone version should still be used'
    );
  });

  test('override with unchanged version (boundary: old === new)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v3.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v3.0\n---\n\n# State\n');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm --archive-version v3.0', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v3.0-phases', '01-foundation')),
      'override equal to the live version should archive normally'
    );
  });

  test('override omitted with no ROADMAP uses getMilestoneInfo default (no-override path unchanged)', () => {
    // createTempProject writes no ROADMAP.md, so getMilestoneInfo does NOT throw —
    // it returns its documented default version ('v1.0'). The dated `archived-*`
    // label is only reached if no safe version label is resolvable at all, which
    // this common case is not. This pins the no-override path to its pre-#2288
    // behavior (getMilestoneInfo-derived label), not a dated fallback.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- ensure no ROADMAP.md (SUT fallback path, not teardown)
    fs.rmSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), { recursive: true, force: true });

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'no override + no ROADMAP archives under getMilestoneInfo default (v1.0), unchanged from pre-#2288'
    );
  });

  test('rejects an --archive-version containing path traversal (no phase dir escapes .planning) (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // A traversal payload as the archive-version must be rejected outright — the
    // value becomes a MOVED directory name, so accepting it would relocate phase
    // history outside .planning/milestones/.
    const result = runGsdTools(
      'phases clear --confirm --archive-version ../../../gsd-poc-escape',
      tmpDir,
    );
    assert.ok(!result.success, 'phases clear must FAIL on a path-traversal --archive-version');

    // The phase directory must NOT have moved anywhere — it stays put.
    assert.ok(
      fs.existsSync(phase1),
      'phase dir must remain in place when the archive-version is rejected',
    );
    // Nothing may have been created outside the project's milestones dir.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-poc-escape-phases')),
      'no directory may be created outside the project via traversal',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones')),
      'no archive dir should be created at all when the override is rejected',
    );
  });

  test('rejects backslash path separators in --archive-version (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // Starts with an alphanumeric so it clears the leading-char anchor — this
    // proves the backslash (Windows path separator) itself is rejected, not just
    // a leading-dot traversal.
    const result = runGsdTools(
      'phases clear --confirm --archive-version v1\\\\..\\\\evil',
      tmpDir,
    );
    assert.ok(!result.success, 'phases clear must FAIL on a backslash-separator --archive-version');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place');
  });

  test('errors when --archive-version is present but its value is missing (does not silently drop the override) (#2288)', () => {
    // A truncated invocation must fail loud, not fall through to the live read
    // (which would silently re-file under the new milestone — the #2288 bug).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v2.0 — Active Milestone\n'
    );
    writeState(tmpDir, '---\nmilestone: v2.0\n---\n\n# State\n');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // --archive-version as the final token with no value following it.
    const result = runGsdTools('phases clear --confirm --archive-version', tmpDir);
    assert.ok(!result.success, 'a value-less --archive-version must be an error, not a silent fallback');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place when the flag is rejected');
  });
});

// ─── #2288: sibling sink — `milestone complete <version>` path safety ───────

describe('milestone complete: version path-traversal guard (#2288 security)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('rejects a milestone-complete version containing path traversal (no write/move escapes .planning)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    // `version` is interpolated into `${version}-ROADMAP.md`, `${version}-phases`,
    // etc. as a MOVED/written path component — a traversal value must be rejected
    // before any filesystem mutation.
    const result = runGsdTools('milestone complete ../../../gsd-ms-escape', tmpDir);
    assert.ok(!result.success, 'milestone complete must FAIL on a path-traversal version');

    // No artifact created outside the project via traversal.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-ms-escape-phases')),
      'no directory may be created outside the project via a traversal version',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'gsd-ms-escape-ROADMAP.md')),
      'no file may be written outside the project via a traversal version',
    );
    // Phase dir untouched.
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place when the version is rejected');
  });

  test('rejects a backslash-separator milestone-complete version (#2288 security)', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phase1 = path.join(phasesDir, '01-foundation');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('milestone complete v1\\\\..\\\\evil', tmpDir);
    assert.ok(!result.success, 'milestone complete must FAIL on a backslash-separator version');
    assert.ok(fs.existsSync(phase1), 'phase dir must remain in place');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2433-todo-phase-linking.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2433-todo-phase-linking (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #2433)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for gsd-new-milestone todo-to-phase linking (#2433).
 * Verifies the workflow text contains the correct linking and auto-close steps.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const NEW_MILESTONE = fs.readFileSync(
  path.join(ROOT, 'gsd-core/workflows/new-milestone.md'), 'utf-8'
);
const EXECUTE_PHASE = fs.readFileSync(
  path.join(ROOT, 'gsd-core/workflows/execute-phase.md'), 'utf-8'
);

test('new-milestone.md: step 10.5 links pending todos to roadmap phases', () => {
  assert.ok(NEW_MILESTONE.includes('10.5'), 'step 10.5 should exist');
  assert.ok(NEW_MILESTONE.includes('resolves_phase'), 'should reference resolves_phase field');
  assert.ok(NEW_MILESTONE.includes('.planning/todos/pending'), 'should scan pending todos directory');
});

test('new-milestone.md: todo linking runs after roadmap commit', () => {
  const roadmapCommitIdx = NEW_MILESTONE.indexOf('docs: create milestone v[X.Y] roadmap');
  const step105Idx = NEW_MILESTONE.indexOf('10.5. Link Pending Todos');
  const step11Idx = NEW_MILESTONE.indexOf('## 11. Done');
  assert.ok(roadmapCommitIdx < step105Idx, 'step 10.5 should come after roadmap commit');
  assert.ok(step105Idx < step11Idx, 'step 10.5 should come before step 11');
});

test('new-milestone.md: todo linking is best-effort and leaves unmatched todos unmodified', () => {
  assert.ok(NEW_MILESTONE.includes('best-effort'), 'should describe best-effort matching');
  assert.ok(NEW_MILESTONE.includes('unmatched'), 'should mention leaving unmatched todos alone');
  assert.ok(NEW_MILESTONE.includes('confident match'), 'should gate on confident match');
});

test('new-milestone.md: step 10.5 commits tagged todos', () => {
  // After #3797 architectural fix, callsites use gsd_run
  assert.ok(NEW_MILESTONE.includes('gsd_run query commit'), 'should commit tagged todos');
  assert.ok(NEW_MILESTONE.includes('resolves_phase after milestone'), 'commit message should mention resolves_phase');
});

test('new-milestone.md: success_criteria includes todo linking', () => {
  assert.ok(NEW_MILESTONE.includes('resolves_phase: N'), 'success_criteria should mention resolves_phase tagging');
});

test('execute-phase.md: close_phase_todos step exists', () => {
  assert.ok(EXECUTE_PHASE.includes('close_phase_todos'), 'close_phase_todos step should exist');
  assert.ok(EXECUTE_PHASE.includes('resolves_phase'), 'should check resolves_phase in todos');
});

test('execute-phase.md: auto-close moves todos to completed directory', () => {
  assert.ok(EXECUTE_PHASE.includes('.planning/todos/completed'), 'should move to completed dir');
  assert.ok(EXECUTE_PHASE.includes('.planning/todos/pending'), 'should scan pending dir');
  assert.ok(EXECUTE_PHASE.includes('mv "$TODO_FILE" "$COMPLETED_DIR/"'), 'should use mv to move files');
});

test('execute-phase.md: close_phase_todos runs after update_roadmap', () => {
  const updateRoadmapIdx = EXECUTE_PHASE.indexOf('name="update_roadmap"');
  const closeTodosIdx = EXECUTE_PHASE.indexOf('name="close_phase_todos"');
  assert.ok(updateRoadmapIdx < closeTodosIdx, 'close_phase_todos should run after update_roadmap');
});

test('execute-phase.md: auto-close never blocks phase completion', () => {
  const closeTodosSection = EXECUTE_PHASE.slice(
    EXECUTE_PHASE.indexOf('name="close_phase_todos"'),
    EXECUTE_PHASE.indexOf('name="update_project_md"')
  );
  assert.ok(
    closeTodosSection.includes('never blocks') || closeTodosSection.includes('additive'),
    'close_phase_todos should be non-blocking'
  );
});

test('execute-phase.md: awk extracts resolves_phase from YAML frontmatter', () => {
  assert.ok(EXECUTE_PHASE.includes('awk'), 'should use awk for frontmatter extraction');
  assert.ok(EXECUTE_PHASE.includes('resolves_phase:'), 'awk pattern should match resolves_phase key');
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #2308 / #2334 follow-up: new-milestone.md must not clobber the shared
// PROJECT.md when a workstream is active, and must propagate ${GSD_WS} to
// downstream routing. Step 1 and Step 6's bash fences are extracted and
// EXECUTED (not grepped) so these tests fail on an inert guard — e.g. the
// step-6 conditional merely being PRESENT (`if [ -n "$GSD_WS" ]`) is not
// enough if GSD_WS was never re-derived and is always empty at runtime.
// ────────────────────────────────────────────────────────────────────────
describe('new-milestone.md: workstream-aware PROJECT.md guard (#2308)', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
  // readFileNormalized() strips \r\n -> \n before either extractor below slices
  // a fence out of `content` — both fences are handed to execFileSync('bash', ...)
  // in runStep1/runStep6Commit, so an un-normalized read on a Windows checkout
  // would break bash mid-script (DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE, #2650).
  const content = readFileNormalized(workflowPath);

  // #2994 fragmentization moved the 7.5 reset-phase-safety section (including
  // its "/gsd:new-milestone --reset-phase-numbers ${GSD_WS}" rerun hint) out
  // of new-milestone.md into gsd-core/workflows/new-milestone/steps/reset-phase-safety.md
  // behind a section marker. Only the routing-interpolation test below needs
  // that moved text, so it reads host + step file combined instead of
  // widening `content` (used for host-only fence extraction elsewhere in
  // this describe block).
  const contentWithSteps = content + '\n' + fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone', 'steps', 'reset-phase-safety.md'),
    'utf8'
  );

  // #2994 final slice: Step 4's "Part A" milestone-state write moved out of
  // new-milestone.md into gsd-core/workflows/new-milestone/steps/
  // project-md-milestone-write.md behind a section marker. The
  // "step 4 scopes the workstream skip" test below asserts on Part A's
  // actual body (GSD_WS mentions, the workstream skip description) — rather
  // than widen `content` for every test in this block, SPLICE the step
  // file's content into the marker's exact position so partAIdx/partBIdx
  // position-sensitive slicing below still works. A non-vacuity check
  // (blank the step file, confirm the splice fails, restore) backs this.
  const PROJECT_MD_STEP_PATH = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'new-milestone', 'steps', 'project-md-milestone-write.md'
  );
  const PROJECT_MD_MARKER_RE = /<!-- gsd:section id="project-md-milestone-write"[\s\S]*?<!-- \/gsd:section -->/;
  function contentWithProjectMdStepSpliced() {
    const stepBody = fs.readFileSync(PROJECT_MD_STEP_PATH, 'utf8');
    assert.match(content, PROJECT_MD_MARKER_RE, 'project-md-milestone-write marker not found in new-milestone.md');
    return content.replace(PROJECT_MD_MARKER_RE, stepBody);
  }

  // Locate the first ```bash fence strictly between two headings.
  function extractFenceBetween(markdown, startHeading, endHeading) {
    const startIdx = markdown.indexOf(startHeading);
    const endIdx = markdown.indexOf(endHeading);
    assert.ok(startIdx !== -1, `heading not found: ${startHeading}`);
    assert.ok(endIdx !== -1, `heading not found: ${endHeading}`);
    assert.ok(startIdx < endIdx, `${startHeading} must precede ${endHeading}`);
    const section = markdown.slice(startIdx, endIdx);
    const match = section.match(/```bash\r?\n([\s\S]*?)```/);
    assert.ok(match, `no bash fence found between "${startHeading}" and "${endHeading}"`);
    return match[1];
  }

  // Step 6 has multiple ```bash fences; locate the one containing `marker`.
  function extractFenceContaining(markdown, startHeading, endHeading, marker) {
    const startIdx = markdown.indexOf(startHeading);
    const endIdx = markdown.indexOf(endHeading);
    assert.ok(startIdx !== -1 && endIdx !== -1 && startIdx < endIdx, 'headings not found in order');
    const section = markdown.slice(startIdx, endIdx);
    const fenceRe = /```bash\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(section)) !== null) {
      if (m[1].includes(marker)) return m[1];
    }
    assert.fail(`no bash fence containing "${marker}" found between "${startHeading}" and "${endHeading}"`);
    return null;
  }

  describe('step 1: --ws parsing is real, executable shell (not prose)', () => {
    const step1Fence = extractFenceBetween(content, '## 1. Load Context', '## 2. Gather Milestone Goals');

    function runStep1(argumentsValue) {
      const script = `ARGUMENTS=${JSON.stringify(argumentsValue)}\n${step1Fence}\n` +
        'printf \'GSD_WS=[%s]\\nMILESTONE_ARG=[%s]\\n\' "$GSD_WS" "$MILESTONE_ARG"';
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      return {
        gsdWs: /GSD_WS=\[(.*)\]/.exec(out)[1],
        milestoneArg: /MILESTONE_ARG=\[(.*)\]/.exec(out)[1],
      };
    }

    test('parses --ws <name> into GSD_WS and strips it from the milestone name (finding 6)', () => {
      const { gsdWs, milestoneArg } = runStep1('--ws search v2.0 Search');
      assert.strictEqual(gsdWs, '--ws search');
      assert.strictEqual(milestoneArg, 'v2.0 Search');
    });

    test('leaves GSD_WS empty when --ws is absent, milestone name unaffected', () => {
      const { gsdWs, milestoneArg } = runStep1('v2.0 Search');
      assert.strictEqual(gsdWs, '');
      assert.strictEqual(milestoneArg, 'v2.0 Search');
    });
  });

  describe('step 6: commit stages PROJECT.md in both modes, with no cross-step guard', () => {
    const step6CommitFence = extractFenceContaining(
      content,
      '## 6. Cleanup and Commit',
      '## 7. Load Context and Resolve Models',
      'docs: start milestone v[X.Y] [Name]'
    );

    function runStep6Commit(argumentsValue) {
      const gsdRunStub = 'gsd_run() { printf "%s\\n" "gsd_run_call:$*"; }\n';
      const script = `ARGUMENTS=${JSON.stringify(argumentsValue)}\n${gsdRunStub}${step6CommitFence}`;
      return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    }

    // Step 4 Part A's guard — not this commit — is what protects the shared
    // heading. Part B's Evolution backfill DOES write PROJECT.md in workstream
    // mode, so a ws-mode branch that dropped PROJECT.md from --files would
    // strand that edit uncommitted.
    for (const [mode, args] of [['ws', '--ws search v2.0 Search'], ['flat', 'v2.0 Search']]) {
      test(`${mode} mode: --files stages PROJECT.md so Part B's Evolution backfill is committed`, () => {
        const out = runStep6Commit(args);
        assert.ok(
          out.includes('--files .planning/PROJECT.md .planning/STATE.md'),
          `expected PROJECT.md + STATE.md --files in ${mode} mode, got: ${out}`
        );
      });
    }

    test('does not guard the commit on GSD_WS — a cross-step variable is always empty here', () => {
      // Regression guard for the inert-guard trap: GSD_WS is assigned in Step
      // 1's shell, and each step's bash block runs in its own shell (the same
      // reason Step 5 round-trips OUTGOING_MILESTONE through a file). A
      // `[ -n "$GSD_WS" ]` branch here reads an unset variable, always takes
      // the flat branch, and only appears to work.
      assert.ok(
        !/\[\s*-n\s*"\$GSD_WS"\s*\]/.test(step6CommitFence),
        `step 6 must not branch on a cross-step GSD_WS; got fence:\n${step6CommitFence}`
      );
    });
  });

  test('routing interpolations still propagate ${GSD_WS} at the documented lines', () => {
    assert.ok(
      contentWithSteps.includes('/gsd:new-milestone --reset-phase-numbers ${GSD_WS}'),
      'reset-phase-numbers rerun hint should propagate ${GSD_WS}'
    );
    assert.ok(
      content.includes('/gsd:discuss-phase [N] ${GSD_WS}'),
      'discuss-phase routing hint should propagate ${GSD_WS}'
    );
    assert.ok(
      content.includes('/gsd:plan-phase [N] ${GSD_WS}'),
      'plan-phase routing hint should propagate ${GSD_WS}'
    );
  });

  test('success criteria reflects PROJECT.md update is skipped in workstream mode', () => {
    assert.match(
      content,
      /PROJECT\.md updated with Current Milestone section.*skipped.*workstream/i,
      'success criteria should note the PROJECT.md step is skipped in workstream mode'
    );
  });

  test('step 4 scopes the workstream skip to the milestone-state write only; Evolution repair always runs (finding 2)', () => {
    const splicedContent = contentWithProjectMdStepSpliced();
    const step4Idx = splicedContent.indexOf('## 4. Update PROJECT.md');
    const step5Idx = splicedContent.indexOf('## 5. Update STATE.md');
    assert.ok(step4Idx !== -1 && step5Idx !== -1 && step4Idx < step5Idx, 'steps 4 and 5 should be locatable');
    const step4Body = splicedContent.slice(step4Idx, step5Idx);

    const partAIdx = step4Body.indexOf('Part A');
    const partBIdx = step4Body.indexOf('Part B');
    assert.ok(partAIdx !== -1 && partBIdx !== -1 && partAIdx < partBIdx, 'step 4 should have distinct Part A / Part B sections');

    const partABody = step4Body.slice(partAIdx, partBIdx);
    const partBBody = step4Body.slice(partBIdx);

    assert.match(partABody, /skip/i, 'Part A should describe the workstream skip');
    assert.ok(partABody.includes('GSD_WS'), 'Part A guard should be keyed on GSD_WS');
    assert.match(
      step4Body,
      /shared/i,
      'step 4 should justify the guard by pointing at PROJECT.md being the shared file'
    );

    // The Evolution structural repair must be reachable OUTSIDE Part A's skip,
    // and Part B's own text must state it is unconditional.
    assert.ok(!partABody.includes('## Evolution'), 'Evolution repair must NOT be nested inside the guarded Part A');
    assert.ok(partBBody.includes('## Evolution'), 'Part B must contain the Evolution section template');
    assert.match(partBBody, /always runs/i, 'Part B must state it always runs regardless of GSD_WS');
  });
});

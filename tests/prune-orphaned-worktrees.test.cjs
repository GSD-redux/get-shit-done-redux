/**
 * Tests for pruneOrphanedWorktrees()
 *
 * Uses real temporary git repos (no mocks).
 * All 4 tests must fail (RED) before implementation is added.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Lazy-loaded so tests can fail clearly when the export doesn't exist yet.
function getPruneOrphanedWorktrees() {
  const { pruneOrphanedWorktrees } = require('../gsd-core/bin/lib/worktree-safety.cjs');
  return pruneOrphanedWorktrees;
}

// Create a minimal git repo with an initial commit on main.
function canonicalPath(p) {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function listedWorktreePaths(repoDir) {
  const out = gitOrThrow(['worktree', 'list', '--porcelain'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  return new Set(
    out
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonicalPath(line.slice('worktree '.length).trim()))
  );
}

function createGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  gitOrThrow(['init'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['commit', '-m', 'initial commit'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  // Rename to main if it isn't already (handles older git defaults)
  try {
    gitOrThrow(['branch', '-m', 'master', 'main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  } catch { /* already named main */ }
}

// --- Test suite ---------------------------------------------------------------

describe('pruneOrphanedWorktrees', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = createTempDir('prune-wt-test-');
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  // Test 1: keeps a merged worktree (destructive removal disabled by default)
  test('keeps a worktree whose branch is merged into main', () => {
    const repoDir = path.join(tmpBase, 'repo');
    const worktreeDir = path.join(tmpBase, 'wt-merged');

    createGitRepo(repoDir);

    // Create worktree on a new branch (main is checked out in repoDir)
    gitOrThrow(['worktree', 'add', worktreeDir, '-b', 'fix/old-work'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.ok(fs.existsSync(worktreeDir), 'worktree dir should exist before prune');

    // Add a commit in the worktree
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'work\n');
    gitOrThrow(['add', '-A'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'old work'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });

    // Merge the branch into main from repoDir
    gitOrThrow(['merge', 'fix/old-work', '--no-ff', '-m', 'merge old-work'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });

    // Act
    const pruneOrphanedWorktrees = getPruneOrphanedWorktrees();
    pruneOrphanedWorktrees(repoDir);

    // Assert: worktree directory still exists
    assert.ok(
      fs.existsSync(worktreeDir),
      'merged worktree should not be removed by default: ' + worktreeDir
    );

    // Assert: git worktree list still shows it
    const listed = listedWorktreePaths(repoDir);
    assert.ok(
      listed.has(canonicalPath(worktreeDir)),
      'git worktree list should still reference merged worktree'
    );
  });

  // Test 2: keeps a worktree whose branch has unmerged commits
  test('keeps a worktree whose branch has unmerged commits', () => {
    const repoDir = path.join(tmpBase, 'repo2');
    const worktreeDir = path.join(tmpBase, 'wt-active');

    createGitRepo(repoDir);

    // Create the worktree on a new branch (main is checked out in repoDir)
    gitOrThrow(['worktree', 'add', worktreeDir, '-b', 'fix/active-work'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });

    // Add a commit in the worktree (NOT merged into main)
    fs.writeFileSync(path.join(worktreeDir, 'active.txt'), 'active\n');
    gitOrThrow(['add', '-A'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'active work'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });
    // main stays at its original commit — no merge

    // Act
    const pruneOrphanedWorktrees = getPruneOrphanedWorktrees();
    pruneOrphanedWorktrees(repoDir);

    // Assert: worktree directory still exists
    assert.ok(
      fs.existsSync(worktreeDir),
      'worktree directory should NOT have been removed: ' + worktreeDir
    );
  });

  // Test 3: never removes the worktree at process.cwd()
  test('never removes the worktree at process.cwd()', () => {
    const repoDir = path.join(tmpBase, 'repo3');
    const wtDir = path.join(tmpBase, 'wt-cwd-test');

    createGitRepo(repoDir);

    // Create a worktree, add a commit, merge it into main
    gitOrThrow(['worktree', 'add', wtDir, '-b', 'fix/another-merged'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(wtDir, 'more.txt'), 'more\n');
    gitOrThrow(['add', '-A'], { cwd: wtDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'another merged'], { cwd: wtDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['checkout', 'main'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['merge', 'fix/another-merged', '--no-ff', '-m', 'merge another'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });

    // Run pruning
    const pruneOrphanedWorktrees = getPruneOrphanedWorktrees();
    const pruned = pruneOrphanedWorktrees(repoDir);

    // No destructive removals are performed by default
    assert.deepStrictEqual(pruned, []);

    // The main worktree (repoDir) itself must still exist
    assert.ok(
      fs.existsSync(repoDir),
      'main repo dir should still exist: ' + repoDir
    );
  });

  // Test 4: runs git worktree prune to clear stale references
  test('runs git worktree prune to clear stale references', () => {
    const repoDir = path.join(tmpBase, 'repo4');
    const worktreeDir = path.join(tmpBase, 'wt-stale');

    createGitRepo(repoDir);

    // Create a worktree
    gitOrThrow(['worktree', 'add', worktreeDir, '-b', 'fix/stale-ref'], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.ok(fs.existsSync(worktreeDir), 'worktree dir should exist before manual deletion');

    // Use the canonicalPath helper so Windows 8.3 short-name (RUNNER~1) vs
    // long-form (runneradmin) and slash-direction differences both collapse
    // to the same key before comparison. git stores the long-form path in
    // its administrative files; substring matching on the raw path fails.
    // Capture the canonical key BEFORE deletion since canonicalPath calls
    // realpathSync.native which fails on missing paths.
    const wantedKey = canonicalPath(worktreeDir);
    assert.ok(listedWorktreePaths(repoDir).has(wantedKey), 'worktree should appear in list before deletion');

    // Manually delete the worktree directory (simulate orphan)
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test fault injection: simulates an orphaned worktree dir that git still references
    fs.rmSync(worktreeDir, { recursive: true, force: true });

    // Act
    const pruneOrphanedWorktrees = getPruneOrphanedWorktrees();
    pruneOrphanedWorktrees(repoDir);

    // Assert: git worktree list no longer shows the stale entry.
    assert.ok(
      !listedWorktreePaths(repoDir).has(wantedKey),
      'git worktree list still shows stale entry after prune'
    );
  });
});

'use strict';

/**
 * gsd-quick-batch-merge-integration.test.cjs — real-git-fixture integration
 * tests connecting quick-batch's PURE merge routing (`routeMergeOutcome`,
 * `src/quick-batch-dispatch.cts`) to the REAL underlying bounded primitive
 * (`executeWorktreeWaveCleanupPlan`, `src/worktree-safety.cts`) it wraps.
 *
 * #3676 review pass 3 (Spec finding): rows 34/35 were previously asserted
 * only at the pure-function level (`routeMergeOutcome({kind:'merge_failed'})`
 * returns `preserveWorktree:true` as a field on an object) — never against a
 * REAL worktree directory or a REAL undeclared-deletion diff. This file
 * closes that gap using the SAME real-git-fixture pattern `tests/
 * worktree-safety.test.cjs` already establishes for `executeWorktreeWaveCleanupPlan`
 * (`initRepo`/`addWorktree`/`commitInWorktree`, real `git`, real
 * `fs.existsSync(wtDir)` assertions) — reimplemented locally since those
 * helpers are module-private there, never duplicating the underlying
 * primitive's OWN extensive test coverage (conflict isolation, deletion
 * declaration parsing, etc. — that stays exclusively in worktree-safety's
 * own suite).
 *
 * Named `gsd-quick-batch-*` (not `quick-batch-*`) so `scripts/
 * lint-test-file-count.cjs`'s longest-prefix bucketing does not fold this
 * cross-module integration test into any already-capped production-module
 * bucket.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { executeWorktreeWaveCleanupPlan } = require('../gsd-core/bin/lib/worktree-safety.cjs');
const { routeMergeOutcome } = require('../gsd-core/bin/lib/quick-batch-dispatch.cjs');

const SUBPROCESS_TIMEOUT_MS = 30_000;

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: SUBPROCESS_TIMEOUT_MS });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  try { git(['branch', '-m', 'master', 'main'], dir); } catch { /* already main */ }
}

function addWorktree(repoDir, wtDir, branchName) {
  git(['worktree', 'add', wtDir, '-b', branchName], repoDir);
}

describe('quick-batch merge routing — real worktree preserved on merge_failed (row 34)', () => {
  test('a genuine merge conflict blocks the entry AND leaves the real worktree directory on disk; routeMergeOutcome confirms preserveWorktree', () => {
    const tmpBase = createTempDir('qb-merge-fail-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      const wtDir = path.join(tmpBase, 'wt-conflict');
      const branchName = 'worktree-agent-conflict';

      initRepo(repoDir);
      addWorktree(repoDir, wtDir, branchName);

      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      // Diverge BOTH sides on the SAME file so the merge produces a real
      // conflict — not a refused merge, an actual MERGE_HEAD conflict.
      fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'main branch version\n');
      git(['add', '-A'], repoDir);
      git(['commit', '-m', 'main: edit shared.txt'], repoDir);

      fs.writeFileSync(path.join(wtDir, 'shared.txt'), 'worktree branch version\n');
      git(['add', '-A'], wtDir);
      git(['commit', '-m', 'worktree: edit shared.txt'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'conflict1',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);

      assert.equal(result.entries[0].status, 'blocked', `expected a blocked entry, got: ${JSON.stringify(result.entries[0])}`);
      assert.equal(result.entries[0].reason, 'merge_failed');

      // The REAL worktree directory must still exist — the primitive never
      // removed it for a blocked entry.
      assert.ok(fs.existsSync(wtDir), 'worktree directory must survive a real merge conflict');

      // quick-batch's own pure routing over this REAL result must agree:
      // fail, with preserveWorktree explicitly true.
      const routing = routeMergeOutcome({ kind: 'merge_failed', detail: result.entries[0].reason });
      assert.equal(routing.action, 'fail');
      assert.equal(routing.preserveWorktree, true);

      // Consistency check: quick-batch's routing decision and the real
      // primitive's own behavior agree — neither removed the worktree.
      assert.ok(fs.existsSync(wtDir), 'worktree directory still exists after routing — routeMergeOutcome never performs I/O, this reasserts the invariant held');
    } finally {
      cleanup(tmpBase);
    }
  });
});

describe('quick-batch merge routing — real undeclared-deletion detection (row 35)', () => {
  test('a real, undeclared file deletion blocks the merge and preserves the worktree; a declared one merges and removes it', () => {
    const tmpBase = createTempDir('qb-merge-deletion-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, 'legacy.txt'), 'to be deleted\n');
      git(['add', '-A'], repoDir);
      git(['commit', '-m', 'add legacy.txt'], repoDir);

      // ── Case 1: UNDECLARED deletion — must block, worktree preserved ─────
      const wtDirUndeclared = path.join(tmpBase, 'wt-undeclared');
      const branchUndeclared = 'worktree-agent-undeclared';
      addWorktree(repoDir, wtDirUndeclared, branchUndeclared);
      const baseCommit = git(['merge-base', 'HEAD', branchUndeclared], repoDir).trim();

      // A REAL deletion — actually remove the file and commit that removal.
      fs.unlinkSync(path.join(wtDirUndeclared, 'legacy.txt'));
      git(['add', '-A'], wtDirUndeclared);
      git(['commit', '-m', 'delete legacy.txt'], wtDirUndeclared);

      const undeclaredPlan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'undeclared1',
          worktree_path: wtDirUndeclared,
          branch: branchUndeclared,
          expected_base: baseCommit,
          // declared_deletions intentionally OMITTED — an undeclared deletion
          // is indistinguishable from a forgotten one, per the design doc's
          // own documented negative space; the guard blocks either way.
        }],
      };

      const undeclaredResult = executeWorktreeWaveCleanupPlan(undeclaredPlan);
      assert.equal(undeclaredResult.entries[0].status, 'blocked', `expected a blocked entry for the undeclared deletion, got: ${JSON.stringify(undeclaredResult.entries[0])}`);
      assert.equal(undeclaredResult.entries[0].reason, 'branch_contains_deletions');
      assert.ok(fs.existsSync(wtDirUndeclared), 'worktree with an undeclared real deletion must be preserved on disk');

      const scopeRouting = routeMergeOutcome({ kind: 'scope_violation', detail: undeclaredResult.entries[0].reason });
      assert.equal(scopeRouting.action, 'fail');
      assert.equal(scopeRouting.preserveWorktree, true);
      assert.match(scopeRouting.failureReason, /branch_contains_deletions/);

      // ── Case 2: DECLARED deletion of the SAME real change — must merge ───
      const wtDirDeclared = path.join(tmpBase, 'wt-declared');
      const branchDeclared = 'worktree-agent-declared';
      addWorktree(repoDir, wtDirDeclared, branchDeclared);
      const baseCommit2 = git(['merge-base', 'HEAD', branchDeclared], repoDir).trim();

      fs.unlinkSync(path.join(wtDirDeclared, 'legacy.txt'));
      git(['add', '-A'], wtDirDeclared);
      git(['commit', '-m', 'delete legacy.txt (declared)'], wtDirDeclared);

      const declaredPlan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'declared1',
          worktree_path: wtDirDeclared,
          branch: branchDeclared,
          expected_base: baseCommit2,
          declared_deletions: ['legacy.txt'],
        }],
      };

      const declaredResult = executeWorktreeWaveCleanupPlan(declaredPlan);
      assert.equal(declaredResult.entries[0].status, 'merged_removed', `expected a declared deletion to merge cleanly, got: ${JSON.stringify(declaredResult.entries[0])}`);
      assert.ok(!fs.existsSync(wtDirDeclared), 'worktree with a fully declared deletion must be removed after a successful merge');

      const mergedRouting = routeMergeOutcome({ kind: 'merged' });
      assert.equal(mergedRouting.action, 'complete');
    } finally {
      cleanup(tmpBase);
    }
  });
});

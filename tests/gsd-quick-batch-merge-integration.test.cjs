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

const { executeWorktreeWaveCleanupPlan, planWorktreeWaveCleanup } = require('../gsd-core/bin/lib/worktree-safety.cjs');
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

/**
 * #3677 Phase 5 (epic #3344) — closes the three coverage gaps identified in
 * `.gsd/phase/feat-3677-quick-batch-hardening-acceptance/40-design.md` §2/§3:
 * arbitrary-worktree ownership tampering (security AC), advisory scope drift
 * (scheduling AC), and a real-git submodule integration test (scheduling AC).
 * Same real-git-fixture discipline as the two describe blocks above — no new
 * mocks, no source-grep, real subprocess `git`.
 */

describe('quick-batch merge routing — arbitrary-worktree ownership tampering (Security AC)', () => {
  test('a manifest entry naming a non-agent branch (e.g. the repo\'s own primary branch) is silently dropped at normalization and NEVER reaches git execution', () => {
    const tmpBase = createTempDir('qb-ownership-tamper-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      initRepo(repoDir);
      const headBefore = git(['rev-parse', 'HEAD'], repoDir).trim();

      // A tampered/corrupt manifest naming the repo's OWN primary branch as
      // if it were a batch-owned worktree entry — the branch name fails
      // WORKTREE_AGENT_BRANCH_RE (`^((worktree-)?agent-|worktree-wf_)...`),
      // so it must never reach a git subprocess at all.
      const tamperedManifest = {
        worktrees: [{
          agent_id: 'tampered',
          worktree_path: repoDir,
          branch: 'main',
          expected_base: headBefore,
        }],
      };

      const plan = planWorktreeWaveCleanup(repoDir, tamperedManifest);
      assert.equal(plan.ok, false, `a non-agent branch name must be rejected before a plan is built, got: ${JSON.stringify(plan)}`);
      assert.equal(plan.reason, 'empty_manifest');
      assert.equal(plan.entries.length, 0);

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.ok, false);
      assert.equal(result.entries.length, 0, 'no entry may reach git execution for a rejected manifest');

      // repoRoot must be provably untouched — same HEAD, no merge commit.
      const headAfter = git(['rev-parse', 'HEAD'], repoDir).trim();
      assert.equal(headAfter, headBefore, 'repo HEAD must not move when the only manifest entry was rejected at normalization');
    } finally {
      cleanup(tmpBase);
    }
  });

  test('a manifest entry naming a plausible agent-branch that was never actually created by this repo\'s own worktree.create is blocked (base_mismatch), never merged', () => {
    const tmpBase = createTempDir('qb-ownership-foreign-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      const foreignDir = path.join(tmpBase, 'foreign');
      initRepo(repoDir);
      const headBefore = git(['rev-parse', 'HEAD'], repoDir).trim();

      // A completely separate repository — never created via `git worktree
      // add` against repoDir — whose HEAD branch happens to be named
      // plausibly (passes WORKTREE_AGENT_BRANCH_RE). This is the "arbitrary"
      // ownership-tampering case: the manifest ENTRY looks legitimate, but
      // nothing about worktree_path proves it is actually repoDir's own
      // worktree.
      fs.mkdirSync(foreignDir, { recursive: true });
      git(['init'], foreignDir);
      git(['config', 'user.email', 'test@test.com'], foreignDir);
      git(['config', 'user.name', 'Test'], foreignDir);
      git(['config', 'commit.gpgsign', 'false'], foreignDir);
      fs.writeFileSync(path.join(foreignDir, 'secret.txt'), 'not part of this batch\n');
      git(['add', '-A'], foreignDir);
      git(['commit', '-m', 'foreign repo initial commit'], foreignDir);
      git(['checkout', '-b', 'agent-hostile-1'], foreignDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'hostile',
          worktree_path: foreignDir,
          branch: 'agent-hostile-1',
          expected_base: headBefore,
          allowed_bases: [headBefore],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.ok, false);
      assert.equal(result.entries[0].status, 'blocked', `expected a blocked entry for a foreign worktree_path, got: ${JSON.stringify(result.entries[0])}`);
      // repoDir has no local ref named `agent-hostile-1` (it was only ever
      // created in the FOREIGN repo) — merge-base against it fails closed.
      assert.equal(result.entries[0].reason, 'base_mismatch');

      // Neither side was touched: the foreign repo's secret file is intact
      // and untouched by any merge/remove, and repoDir's HEAD never moved.
      assert.ok(fs.existsSync(path.join(foreignDir, 'secret.txt')), 'foreign repo must be left completely alone');
      const headAfter = git(['rev-parse', 'HEAD'], repoDir).trim();
      assert.equal(headAfter, headBefore, 'repoDir HEAD must not move for a blocked foreign entry');
    } finally {
      cleanup(tmpBase);
    }
  });

  // #3677 review pass 2 (Security finding): the two tests above prove
  // branch-shape rejection and a wholly-foreign, never-registered repo are
  // both handled — but neither exercises the scenario "arbitrary-worktree
  // ownership" actually names: a manifest entry whose worktree_path/branch
  // are SWAPPED to point at a DIFFERENT, GENUINELY-REGISTERED sibling
  // worktree of the SAME repoRoot (a concurrent batch's own agent worktree,
  // or a stale worktree from a prior crashed run), with a branch name that
  // passes WORKTREE_AGENT_BRANCH_RE's shape check and a base that is
  // legitimately in allowed_bases.
  //
  // Investigation conclusion (see
  // `.gsd/phase/feat-3677-quick-batch-hardening-acceptance/40-design.md`
  // §1's companion note): this is NOT a reachable gap in
  // `executeWorktreeWaveCleanupPlan` itself. Git enforces branch-per-
  // worktree uniqueness — the SAME branch cannot be checked out in two
  // worktrees of one repo at once — so `worktree_path`'s ACTUAL checked-out
  // branch (`git -C worktree_path rev-parse --abbrev-ref HEAD`,
  // `src/worktree-safety.cts:1047`) can only equal a swapped-in
  // `entry.branch` if that `entry.branch` is the SIBLING's own real,
  // uniquely-generated branch name — which manifest tampering confined to
  // ONE batch's own record has no way to know (branch names are
  // `agent-<quick_id>[-<timestamp>]`-shaped, and `quick_id` allocation is
  // collision-checked GLOBALLY across every existing quick task and batch,
  // `src/quick-batch.cts` `collectExistingBatchQuickIds`). This test proves
  // the boundary directly against TWO real, concurrently-alive sibling
  // worktrees of the SAME repo, both created via real `git worktree add`,
  // both with `WORKTREE_AGENT_BRANCH_RE`-passing names, both sharing the
  // SAME merge-base — so base/branch-shape checks ALONE could not
  // distinguish them if the primitive were naive; `branch_mismatch` is what
  // actually does.
  test('a manifest entry with one sibling worktree\'s real PATH but the OTHER sibling\'s real BRANCH name is blocked (branch_mismatch); both real, concurrently-alive worktrees survive untouched', () => {
    const tmpBase = createTempDir('qb-ownership-sibling-swap-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      const wt1Dir = path.join(tmpBase, 'wt-item1');
      const wt2Dir = path.join(tmpBase, 'wt-item2');
      const branch1 = 'agent-item1';
      const branch2 = 'agent-item2';

      initRepo(repoDir);
      const headBefore = git(['rev-parse', 'HEAD'], repoDir).trim();

      // TWO real, concurrently-alive sibling worktrees of the SAME repo —
      // e.g. two items in the same batch dispatch round, or one item's
      // worktree from THIS batch and a stale one left by a prior crashed
      // run. Both branch off the SAME base commit.
      addWorktree(repoDir, wt1Dir, branch1);
      addWorktree(repoDir, wt2Dir, branch2);
      fs.writeFileSync(path.join(wt2Dir, 'item2-own-work.txt'), 'item 2 real, uncommitted-to-main work\n');
      git(['add', '-A'], wt2Dir);
      git(['commit', '-m', 'item2: real work'], wt2Dir);
      const item2CommitBefore = git(['rev-parse', 'HEAD'], wt2Dir).trim();

      // Tampered/corrupted entry: intends item1's cleanup (branch1,
      // item1's own base), but worktree_path has been swapped to point at
      // item2's REAL, currently-in-use worktree.
      const swappedPathPlan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'agent-item1',
          worktree_path: wt2Dir,
          branch: branch1,
          expected_base: headBefore,
          allowed_bases: [headBefore],
        }],
      };
      const swappedPathResult = executeWorktreeWaveCleanupPlan(swappedPathPlan);
      assert.equal(swappedPathResult.ok, false);
      assert.equal(swappedPathResult.entries[0].status, 'blocked', `expected a blocked entry for a path/branch swap, got: ${JSON.stringify(swappedPathResult.entries[0])}`);
      assert.equal(swappedPathResult.entries[0].reason, 'branch_mismatch', 'wt2Dir is really checked out on branch2, not branch1 — the swap cannot pass the branch check');

      // The reverse swap is blocked the same way: item2's real path is
      // untouched here too, so re-verify with wt1Dir/branch2 sharing the
      // SAME base commit (no distinguishing signal except the branch
      // check itself).
      const reverseSwapPlan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'agent-item2',
          worktree_path: wt1Dir,
          branch: branch2,
          expected_base: headBefore,
          allowed_bases: [headBefore],
        }],
      };
      const reverseSwapResult = executeWorktreeWaveCleanupPlan(reverseSwapPlan);
      assert.equal(reverseSwapResult.entries[0].status, 'blocked');
      assert.equal(reverseSwapResult.entries[0].reason, 'branch_mismatch');

      // Both real, concurrently-alive sibling worktrees survive completely
      // untouched by either tampered attempt — no merge landed, no
      // worktree/branch removed, item2's real work is exactly as it was.
      const headAfter = git(['rev-parse', 'HEAD'], repoDir).trim();
      assert.equal(headAfter, headBefore, 'repoDir HEAD must not move for either blocked swap attempt');
      assert.ok(fs.existsSync(wt1Dir), 'sibling worktree 1 must survive untouched');
      assert.ok(fs.existsSync(wt2Dir), 'sibling worktree 2 must survive untouched');
      assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt1Dir).trim(), branch1, 'worktree 1 must still be on its own real branch, never repointed');
      assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt2Dir).trim(), branch2, 'worktree 2 must still be on its own real branch, never repointed');
      assert.equal(git(['rev-parse', 'HEAD'], wt2Dir).trim(), item2CommitBefore, 'item 2\'s real, uncommitted-to-main work must be exactly as it was — never merged, never lost, never attributed to item1');
    } finally {
      cleanup(tmpBase);
    }
  });
});

describe('quick-batch merge routing — advisory scope drift merges but warns (Scheduling AC)', () => {
  test('a committed path outside declared files_modified merges successfully with an advisory scope_out_of_declared warning, never blocked', () => {
    const tmpBase = createTempDir('qb-scope-drift-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      const wtDir = path.join(tmpBase, 'wt-drift');
      const branchName = 'worktree-agent-drift';

      initRepo(repoDir);
      addWorktree(repoDir, wtDir, branchName);
      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      // The plan declared ONLY declared.txt, but the executor's real commit
      // touches declared.txt AND an undeclared drifted.txt.
      fs.writeFileSync(path.join(wtDir, 'declared.txt'), 'in scope\n');
      fs.writeFileSync(path.join(wtDir, 'drifted.txt'), 'NOT declared\n');
      git(['add', '-A'], wtDir);
      git(['commit', '-m', 'touch declared.txt and drifted.txt'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'drift1',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
          files_modified: ['declared.txt'],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);

      // Advisory only: the merge still SUCCEEDS despite the drift.
      assert.equal(result.entries[0].status, 'merged_removed', `scope drift must be advisory, not blocking — got: ${JSON.stringify(result.entries[0])}`);
      assert.ok(!fs.existsSync(wtDir), 'worktree removed after a successful (advisory-only) merge');
      assert.ok(fs.existsSync(path.join(repoDir, 'drifted.txt')), 'the undeclared file is still merged in, not rejected');

      // But the drift is surfaced, not silently swallowed.
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'scope_out_of_declared');
      assert.equal(result.warnings[0].path, 'drifted.txt');
      assert.equal(result.warnings[0].branch, branchName);

      const routing = routeMergeOutcome({ kind: 'merged' });
      assert.equal(routing.action, 'complete', 'a scope-drift warning must not change merge routing to a failure');
    } finally {
      cleanup(tmpBase);
    }
  });

  test('a fully-declared commit (files_modified matches exactly) merges with zero warnings — boundary against the drift case above', () => {
    const tmpBase = createTempDir('qb-scope-nodrift-');
    try {
      const repoDir = path.join(tmpBase, 'repo');
      const wtDir = path.join(tmpBase, 'wt-nodrift');
      const branchName = 'worktree-agent-nodrift';

      initRepo(repoDir);
      addWorktree(repoDir, wtDir, branchName);
      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      fs.writeFileSync(path.join(wtDir, 'declared.txt'), 'in scope\n');
      git(['add', '-A'], wtDir);
      git(['commit', '-m', 'touch only declared.txt'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'nodrift1',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
          files_modified: ['declared.txt'],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.entries[0].status, 'merged_removed');
      assert.equal(result.warnings.length, 0, 'an exact declared-scope match must produce no advisory warnings');
    } finally {
      cleanup(tmpBase);
    }
  });
});

describe('quick-batch merge routing — real .gitmodules submodule integration (Scheduling AC)', () => {
  /**
   * Builds `<repoDir>/vendor/sub` as a REAL git submodule (local file://
   * remote, no network) pinned at `pinnedCommit`, committed on repoDir's
   * primary branch. Returns the two submodule commits so a test can bump
   * between them inside a worktree branch — the real "submodule-touch"
   * scenario #3344's AC names.
   */
  function buildRepoWithSubmodule(tmpBase) {
    const subDir = path.join(tmpBase, 'subsrc');
    fs.mkdirSync(subDir, { recursive: true });
    git(['init'], subDir);
    git(['config', 'user.email', 'test@test.com'], subDir);
    git(['config', 'user.name', 'Test'], subDir);
    git(['config', 'commit.gpgsign', 'false'], subDir);
    fs.writeFileSync(path.join(subDir, 'f.txt'), 'hello\n');
    git(['add', '-A'], subDir);
    git(['commit', '-m', 'sub commit 1'], subDir);
    const sub1 = git(['rev-parse', 'HEAD'], subDir).trim();
    fs.appendFileSync(path.join(subDir, 'f.txt'), 'world\n');
    git(['add', '-A'], subDir);
    git(['commit', '-m', 'sub commit 2'], subDir);
    const sub2 = git(['rev-parse', 'HEAD'], subDir).trim();

    const repoDir = path.join(tmpBase, 'repo');
    initRepo(repoDir);
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', subDir, 'vendor/sub'], repoDir);
    // Pin the just-added submodule checkout to sub1 so the worktree branch
    // below has a REAL pointer bump (sub1 -> sub2) to commit, not a no-op.
    git(['checkout', sub1], path.join(repoDir, 'vendor', 'sub'));
    git(['add', 'vendor/sub', '.gitmodules'], repoDir);
    git(['commit', '-m', 'add submodule pinned at sub1'], repoDir);

    return { repoDir, sub1, sub2 };
  }

  test('a repo with .gitmodules and a plan that never touches the submodule merges cleanly through the cleanup primitive', () => {
    const tmpBase = createTempDir('qb-submodule-untouched-');
    try {
      const { repoDir } = buildRepoWithSubmodule(tmpBase);
      const wtDir = path.join(tmpBase, 'wt-unrelated');
      const branchName = 'worktree-agent-sub-unrelated';
      addWorktree(repoDir, wtDir, branchName);
      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      fs.writeFileSync(path.join(wtDir, 'unrelated.txt'), 'nothing to do with the submodule\n');
      git(['add', '-A'], wtDir);
      git(['commit', '-m', 'touch unrelated.txt only'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'sub-unrelated',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
          files_modified: ['unrelated.txt'],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.entries[0].status, 'merged_removed', `a .gitmodules-bearing repo must not break an unrelated merge — got: ${JSON.stringify(result.entries[0])}`);
      assert.equal(result.warnings.length, 0);
    } finally {
      cleanup(tmpBase);
    }
  });

  test('a real submodule pointer bump (sub1 -> sub2) merges cleanly and the superproject tree reflects the new pinned commit', () => {
    const tmpBase = createTempDir('qb-submodule-bump-');
    try {
      const { repoDir, sub2 } = buildRepoWithSubmodule(tmpBase);
      const wtDir = path.join(tmpBase, 'wt-bump');
      const branchName = 'worktree-agent-sub-bump';
      addWorktree(repoDir, wtDir, branchName);
      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], wtDir);
      git(['checkout', sub2], path.join(wtDir, 'vendor', 'sub'));
      git(['add', 'vendor/sub'], wtDir);
      git(['commit', '-m', 'bump vendor/sub to sub2'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'sub-bump',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
          files_modified: ['vendor/sub'],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.entries[0].status, 'merged_removed', `a real gitlink pointer bump must merge like any other file change — got: ${JSON.stringify(result.entries[0])}`);
      assert.equal(result.warnings.length, 0, 'declaring vendor/sub in files_modified must suppress the scope-drift advisory for this exact bump');

      // The superproject's own tree now points at the new submodule commit —
      // the concrete, diagnosable outcome of a "submodule-touch" merge.
      const treeEntry = git(['ls-tree', 'HEAD', 'vendor/sub'], repoDir).trim();
      assert.match(treeEntry, /^160000 commit /, 'vendor/sub must remain a gitlink (mode 160000), never mis-parsed as a regular file');
      assert.match(treeEntry, new RegExp(sub2), 'the merged tree must point at the bumped submodule commit');
    } finally {
      cleanup(tmpBase);
    }
  });

  test('a submodule pointer bump NOT declared in files_modified still merges (advisory, not blocking) but surfaces a scope warning naming vendor/sub', () => {
    const tmpBase = createTempDir('qb-submodule-undeclared-');
    try {
      const { repoDir, sub2 } = buildRepoWithSubmodule(tmpBase);
      const wtDir = path.join(tmpBase, 'wt-bump-undeclared');
      const branchName = 'worktree-agent-sub-bump-undeclared';
      addWorktree(repoDir, wtDir, branchName);
      const baseCommit = git(['merge-base', 'HEAD', branchName], repoDir).trim();

      git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], wtDir);
      git(['checkout', sub2], path.join(wtDir, 'vendor', 'sub'));
      git(['add', 'vendor/sub'], wtDir);
      git(['commit', '-m', 'bump vendor/sub to sub2, undeclared'], wtDir);

      const plan = {
        ok: true,
        repoRoot: repoDir,
        action: 'cleanup_wave',
        discovery: 'manifest',
        entries: [{
          agent_id: 'sub-bump-undeclared',
          worktree_path: wtDir,
          branch: branchName,
          expected_base: baseCommit,
          files_modified: ['README.md'],
        }],
      };

      const result = executeWorktreeWaveCleanupPlan(plan);
      assert.equal(result.entries[0].status, 'merged_removed', 'an undeclared submodule touch is advisory-only, same as any other undeclared modification');
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'scope_out_of_declared');
      assert.equal(result.warnings[0].path, 'vendor/sub');
    } finally {
      cleanup(tmpBase);
    }
  });
});

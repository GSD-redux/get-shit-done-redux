'use strict';

/**
 * Worktree fail-open-guards regression tests (#3050).
 *
 * Covers three defects where a git TIMEOUT was silently collapsed into a
 * benign "not a git repo" / "current directory" outcome instead of failing
 * closed:
 *
 *   1. evaluateWorktreeBaseDegrade (worktree-base-ref.cjs) — a `rev-parse
 *      HEAD` timeout must degrade (shouldDegrade:true), not be treated the
 *      same as "not a git repository".
 *   2. resolveWorktreeContext (worktree-safety.cjs) — a `rev-parse
 *      --git-dir`/`--git-common-dir` timeout must be distinguishable from
 *      the genuine not-a-git-repo case, not silently fall back to
 *      current_directory with an identical reason.
 *   3. cmdWorktreeCreate (worktree-safety.cjs) — root confinement must not
 *      be skippable by omitting `--root`; it must fail closed.
 *
 * All tests drive the real production functions through the injected
 * execGit/deps seam — no real filesystem or git subprocess is touched.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BASE_REF_MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'
);
const WORKTREE_SAFETY_MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'
);

const { evaluateWorktreeBaseDegrade } = require(BASE_REF_MODULE_PATH);
const {
  resolveWorktreeContext,
  cmdWorktreeCreate,
} = require(WORKTREE_SAFETY_MODULE_PATH);

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock execGit result mirroring the real shape spawnSync-derived
 * results carry: {exitCode, stdout, stderr, signal, error}.
 */
function gitResult({ exitCode = 0, stdout = '', stderr = '', signal = null, error = null } = {}) {
  return { exitCode, stdout, stderr, signal, error };
}

/** A timed-out git result: SIGTERM + ETIMEDOUT, per the established idiom. */
function timedOutResult() {
  const err = new Error('spawnSync git ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return gitResult({ exitCode: null, signal: 'SIGTERM', error: err });
}

/** A genuine "not a git repository" result (git exits 128). */
function notAGitRepoResult() {
  return gitResult({ exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
}

// ─── DEFECT 1: evaluateWorktreeBaseDegrade must fail closed on HEAD timeout ──

describe('evaluateWorktreeBaseDegrade — HEAD resolution timeout (#3050 DEFECT 1)', () => {
  test('rev-parse HEAD TIMES OUT → shouldDegrade:true (fail closed, distinct reason)', () => {
    const execGit = (args) => {
      assert.deepStrictEqual(args, ['rev-parse', 'HEAD']);
      return timedOutResult();
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: null, cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, true);
    assert.notStrictEqual(result.reason, 'no-head');
    assert.ok(result.message, 'a fail-closed degrade must carry a non-null explanatory message');
    assert.strictEqual(result.headSha, null);
  });

  test('genuine not-a-git-repo (exit 128) → shouldDegrade:false, reason "no-head" (regression guard — unchanged)', () => {
    const execGit = () => notAGitRepoResult();
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: null, cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.message, null);
  });

  test('HEAD resolves but fork ref is unresolvable → reason "fork-ref-unknown" (regression guard — unchanged)', () => {
    const execGit = (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return gitResult({ stdout: 'aaaa111\n' });
      // origin/HEAD direct rev-parse and symbolic-ref fallback both fail.
      return gitResult({ exitCode: 1 });
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: null, cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
    assert.strictEqual(result.headSha, 'aaaa111');
  });

  test('HEAD == fork sha → shouldDegrade:false, reason "head-matches-fork" (regression guard — unchanged)', () => {
    const sha = 'deadbeef00000000000000000000000000000000';
    const execGit = (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return gitResult({ stdout: `${sha}\n` });
      if (args.includes('origin/HEAD')) return gitResult({ stdout: `${sha}\n` });
      return gitResult({ exitCode: 1 });
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: null, cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
  });

  test('HEAD diverged from fork → shouldDegrade:true, reason "head-diverged-from-fork" (regression guard — unchanged)', () => {
    const headSha = 'aaaaaaaa00000000000000000000000000000000';
    const forkSha = 'bbbbbbbb00000000000000000000000000000000';
    const execGit = (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return gitResult({ stdout: `${headSha}\n` });
      if (args.includes('origin/HEAD')) return gitResult({ stdout: `${forkSha}\n` });
      return gitResult({ exitCode: 1 });
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: null, cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
  });

  test('baseRef:"head" short-circuits before any git call → shouldDegrade:false (regression guard — unchanged)', () => {
    const execGit = () => { throw new Error('execGit must not be called when baseRef is "head"'); };
    const result = evaluateWorktreeBaseDegrade({ execGit, effectiveBaseRef: 'head', cwd: '/repo' });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
  });
});

// ─── DEFECT 2: resolveWorktreeContext must distinguish timeout from not-a-repo ──

describe('resolveWorktreeContext — git-dir resolution timeout (#3050 DEFECT 2)', () => {
  test('git rev-parse --git-dir TIMES OUT → reason is distinguishable from not_git_repo', () => {
    const execGit = (args) => {
      if (args.includes('--git-dir')) return { ...timedOutResult(), timedOut: true };
      return { ...notAGitRepoResult(), timedOut: false };
    };
    const context = resolveWorktreeContext('/repo', { execGit, existsSync: () => false });
    assert.notStrictEqual(context.reason, 'not_git_repo');
  });

  test('genuine not-a-git-repo (both calls exit 128, no timeout) → reason "not_git_repo" (regression guard — unchanged)', () => {
    const execGit = () => ({ ...notAGitRepoResult(), timedOut: false });
    const context = resolveWorktreeContext('/repo', { execGit, existsSync: () => false });
    assert.strictEqual(context.effectiveRoot, '/repo');
    assert.strictEqual(context.mode, 'current_directory');
    assert.strictEqual(context.reason, 'not_git_repo');
  });
});

// ─── DEFECT 3: worktree create root confinement must not be skippable ───────

describe('cmdWorktreeCreate — root confinement is mandatory (#3050 DEFECT 3)', () => {
  test('omitting --root fails closed instead of silently skipping confinement', () => {
    const deps = {
      readFile: () => JSON.stringify({ orchestrator_root: '/repo', worktrees: [] }),
      writeFile: () => { throw new Error('writeFile must not be called — confinement must fail before any write'); },
      execGit: () => { throw new Error('execGit must not be called — confinement must fail before any git side effect'); },
      write: () => {},
      writeErr: () => {},
    };
    const result = cmdWorktreeCreate('/repo', [
      '--manifest', 'manifest.json',
      '--agent-id', 'agent-1',
      '--path', '/repo/.claude/worktrees/agent-1',
      '--branch', 'worktree-agent-agent-1',
      '--base', 'abc1234',
    ], deps);
    assert.strictEqual(result.ok, false);
    assert.notStrictEqual(result.reason, 'created');
  });
});

'use strict';

/**
 * Tests for hooks/lib/isolation-sentinel.js's resolveSentinelRoot() — specifically
 * the #3582 self-heal call it makes before resolving a linked-worktree/ancestor
 * project root. That call is reached ONLY when '.planning' is NOT directly under
 * the cwd passed in (the early return at the top of the function fires first
 * otherwise).
 *
 * #3582 review finding 1a: every existing #3582 cold-tree fixture
 * (tests/helpers/cold-runtime-lib-fixture.cjs) puts '.planning' directly under
 * the fixture project root, so none of them ever reach this branch — deleting
 * the seam call would fail nothing in those suites. The one existing test that
 * DOES pass a cwd whose '.planning' is not directly present
 * (tests/gsd-agent-isolation-guard.test.cjs's "#3045 MINOR" linked-worktree
 * test) runs against the REAL, already-built dev tree, where
 * ensureRuntimeBuild() is a fast successful no-op — removing the seam call
 * there would not change that test's outcome either, since the next require
 * (worktree-safety.cjs) would resolve identically either way.
 *
 * This file closes that gap. Rather than a real tsc build (which would need
 * this repo's own node_modules/typescript to be reachable from a throwaway
 * fixture root, or a directory symlink into it — the latter a privileged,
 * CI-unsafe operation on Windows per tests/ensure-runtime-build.test.cjs's own
 * comment), it substitutes the THREE modules resolveSentinelRoot requires
 * (the seam itself, worktree-safety.cjs, project-root.cjs) via require.cache,
 * keyed by their real resolved absolute paths. This directly OBSERVES whether
 * the seam call ran (a spy counter), rather than inferring it from a return
 * value that a missing call could coincidentally also produce — and never
 * touches gsd-core/bin/lib on disk. Injected cache entries are restored (or
 * deleted, if absent beforehand) in `t.after()` so no other test sharing this
 * worker process ever observes the substitution.
 *
 * Mutation check performed while authoring this test (not re-run on every CI
 * pass — see the assertions' own doc comments): removing the two-line seam
 * call from resolveSentinelRoot makes `seamCalls` stay 0 and
 * `worktreeSafetyCalls` become 1 (the fake, reachable stub now answers), so
 * this test fails exactly when the fix regresses.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SENTINEL_MODULE_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'isolation-sentinel.js');
const SEAM_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'));
const WORKTREE_SAFETY_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'));
const PROJECT_ROOT_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'project-root.cjs'));
const SENTINEL_RESOLVED = require.resolve(SENTINEL_MODULE_PATH);

/** Minimal shape Node's Module cache expects; only `.exports` is read by require(). */
function fakeModule(filename, exportsObj) {
  return { id: filename, filename, loaded: true, exports: exportsObj, children: [], paths: [] };
}

describe('hooks/lib/isolation-sentinel.js: resolveSentinelRoot self-heal reachability (#3582 review finding 1a)', () => {
  test('the seam call fires — and short-circuits the downstream requires — when .planning is not directly under cwd', (t) => {
    const savedSeam = require.cache[SEAM_PATH];
    const savedWorktreeSafety = require.cache[WORKTREE_SAFETY_PATH];
    const savedProjectRoot = require.cache[PROJECT_ROOT_PATH];
    const savedSentinel = require.cache[SENTINEL_RESOLVED];

    t.after(() => {
      const restore = (key, saved) => { if (saved) require.cache[key] = saved; else delete require.cache[key]; };
      restore(SEAM_PATH, savedSeam);
      restore(WORKTREE_SAFETY_PATH, savedWorktreeSafety);
      restore(PROJECT_ROOT_PATH, savedProjectRoot);
      restore(SENTINEL_RESOLVED, savedSentinel);
    });

    let seamCalls = 0;
    let worktreeSafetyCalls = 0;
    let projectRootCalls = 0;

    class FakeRuntimeBuildError extends Error {}
    require.cache[SEAM_PATH] = fakeModule(SEAM_PATH, {
      RuntimeBuildError: FakeRuntimeBuildError,
      ensureRuntimeBuild: () => {
        seamCalls += 1;
        throw new FakeRuntimeBuildError('fake cold-tree build failure (#3582 reachability test)');
      },
    });
    require.cache[WORKTREE_SAFETY_PATH] = fakeModule(WORKTREE_SAFETY_PATH, {
      resolveWorktreeRoot: () => {
        worktreeSafetyCalls += 1;
        return { root: 'SHOULD-NOT-BE-REACHED' };
      },
    });
    require.cache[PROJECT_ROOT_PATH] = fakeModule(PROJECT_ROOT_PATH, {
      findProjectRoot: () => {
        projectRootCalls += 1;
        return 'SHOULD-NOT-BE-REACHED';
      },
    });
    // Fresh require of isolation-sentinel.js itself — not strictly required
    // (its own three requires live inside the function body and are
    // re-evaluated on every call regardless of module-cache state), but keeps
    // this test independent of whatever load order other files in the same
    // worker already forced.
    delete require.cache[SENTINEL_RESOLVED];
    const { resolveSentinelRoot } = require(SENTINEL_MODULE_PATH);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-iso-sentinel-reach-'));
    t.after(() => cleanup(cwd));
    assert.equal(
      fs.existsSync(path.join(cwd, '.planning')),
      false,
      'precondition: no .planning directly under cwd, so the early return must NOT fire',
    );

    const result = resolveSentinelRoot(cwd);

    assert.equal(seamCalls, 1, 'ensureRuntimeBuild() must be called exactly once when .planning is not directly under cwd');
    assert.equal(worktreeSafetyCalls, 0, 'a thrown RuntimeBuildError must short-circuit before resolveWorktreeRoot is ever reached');
    assert.equal(projectRootCalls, 0, 'a thrown RuntimeBuildError must short-circuit before findProjectRoot is ever reached');
    assert.equal(result, cwd, 'resolveSentinelRoot degrades to the raw cwd on a build failure, same as any other resolution failure');
  });
});

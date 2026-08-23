'use strict';

/**
 * Failing-first (RED) coverage for issue #3108.
 *
 * Two independent gaps around `hooks/dist` tolerance:
 *
 *  A. `placeVanishableLeaf` (tests/helpers/overlay-repo.cjs) tolerates a
 *     SINGLE ENOENT on the first attempt via one unguarded retry — but if the
 *     retry ALSO throws ENOENT (the leaf vanished a second time, e.g. two
 *     concurrent `build:hooks` runs racing an atomic replace), the bare retry
 *     escapes as an uncaught exception instead of being treated as "left the
 *     tree" like the first-attempt case.
 *
 *  B. `ensureHooksDist` (tests/helpers/hooks-dist.cjs) only rebuilds when
 *     hooks/dist is absent or has zero `.js` files. `scripts/build-hooks.js`
 *     also ships `.sh` files (HOOKS_TO_COPY), so a dist dir missing every
 *     `.sh` entry is extension-blind-accepted as "populated" and never
 *     rebuilt. The fix is a pure, exported `isHooksDistStale(dir)` predicate
 *     driven off the expected set (HOOKS_TO_COPY), not one extension's count.
 *     That export does not exist yet — requiring it is itself part of the RED
 *     state.
 *
 * Group 3 (the skipped-leaf warning naming `npm run build:hooks`) is SKIPPED
 * here: asserting on it would require either an expensive real
 * `buildOverlayRepo` race (not reproducible deterministically without the
 * `chmod`/source-grep tricks this repo bans) or reading overlay-repo.cjs as
 * text and matching against it, which `local/no-source-grep` forbids. See the
 * skip below.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');

const {
  placeVanishableLeaf,
} = require('./helpers/overlay-repo.cjs');
const { HOOKS_TO_COPY, HOOKS_SUBDIRS_TO_COPY } = require('../scripts/build-hooks.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ── Group 1: placeVanishableLeaf ────────────────────────────────────────────

describe('placeVanishableLeaf: vanish tolerance', () => {
  test('a leaf that never vanishes is placed on the first attempt', () => {
    let calls = 0;
    const attempt = () => { calls += 1; };
    const placed = placeVanishableLeaf('/does/not/matter', attempt);
    assert.strictEqual(placed, true);
    assert.strictEqual(calls, 1);
  });

  test('a leaf replaced once mid-walk is placed by the single retry', () => {
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-does-not-exist');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
    };
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => (p === srcPath ? true : originalExistsSync(p));
    try {
      const placed = placeVanishableLeaf(srcPath, attempt);
      assert.strictEqual(placed, true);
      assert.strictEqual(calls, 2);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  test('a leaf that leaves the tree is skipped, not fatal', () => {
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-gone');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => (p === srcPath ? false : originalExistsSync(p));
    try {
      const placed = placeVanishableLeaf(srcPath, attempt);
      assert.strictEqual(placed, false);
      assert.strictEqual(calls, 1);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  // Deliverable — fails today: the bare retry call in placeVanishableLeaf
  // throws an uncaught ENOENT instead of returning false when the leaf
  // vanishes AGAIN during the retry.
  test('a leaf that vanishes again during the retry is skipped, not a bare ENOENT', () => {
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-double-vanish');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => (p === srcPath ? true : originalExistsSync(p));
    try {
      let placed;
      assert.doesNotThrow(() => {
        placed = placeVanishableLeaf(srcPath, attempt);
      });
      assert.strictEqual(placed, false);
      assert.strictEqual(calls, 2);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  test('a non-ENOENT error is never swallowed by the vanish tolerance', () => {
    const attempt = () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    };
    assert.throws(() => placeVanishableLeaf('/irrelevant', attempt), /EACCES/);
  });

  test('a non-ENOENT error on the retry still propagates', () => {
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-retry-eacces');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    };
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (p) => (p === srcPath ? true : originalExistsSync(p));
    try {
      assert.throws(() => placeVanishableLeaf(srcPath, attempt), /EACCES/);
      assert.strictEqual(calls, 2);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  // EACCES is exercised standalone above; the sweep below only adds codes
  // not already covered, so it does not re-test EACCES a second time.
  for (const code of ['EMFILE', 'EPERM']) {
    test(`a non-ENOENT error (${code}) is never swallowed by the vanish tolerance`, () => {
      const attempt = () => {
        const err = new Error(`${code}: synthetic failure`);
        err.code = code;
        throw err;
      };
      assert.throws(() => placeVanishableLeaf('/irrelevant-not-a-link-path', attempt), new RegExp(code));
    });
  }
});

// ── Group 2: ensureHooksDist staleness predicate ────────────────────────────

describe('isHooksDistStale: extension-agnostic staleness predicate', () => {
  // Does not exist yet — this require is expected to fail until the
  // implementation step adds the named export. Deferred inside each test
  // (rather than at module scope) so the other groups in this file can still
  // run and report their own pass/fail independently.
  function loadPredicate() {
    const mod = require('./helpers/hooks-dist.cjs');
    return mod.isHooksDistStale;
  }

  function mkTmpDir() {
    return createTempDir('gsd-3108-hooks-dist-');
  }

  function rmTmpDir(dir) {
    cleanup(dir);
  }

  function writeExpectedSet(dir, { includeJs = true, includeSh = true, extra = false, includeSubdirs = true } = {}) {
    for (const name of HOOKS_TO_COPY) {
      if (name.endsWith('.js') && !includeJs) continue;
      if (name.endsWith('.sh') && !includeSh) continue;
      fs.writeFileSync(path.join(dir, name), '// fixture\n');
    }
    if (includeSubdirs) {
      for (const name of HOOKS_SUBDIRS_TO_COPY) {
        const subdir = path.join(dir, name);
        fs.mkdirSync(subdir, { recursive: true });
        // A non-empty subdir — an empty dir does not count as "populated"
        // (see the dedicated empty-subdir test below).
        fs.writeFileSync(path.join(subdir, 'fixture-leaf.txt'), '// fixture\n');
      }
    }
    if (extra) {
      fs.writeFileSync(path.join(dir, 'zz-unexpected.txt'), 'not a hook\n');
    }
  }

  test('an absent hooks/dist triggers the build', () => {
    const isHooksDistStale = loadPredicate();
    const dir = path.join(os.tmpdir(), 'gsd-3108-hooks-dist-absent-does-not-exist');
    assert.strictEqual(isHooksDistStale(dir), true);
  });

  test('an empty hooks/dist triggers the build', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      assert.strictEqual(isHooksDistStale(dir), true);
    } finally {
      rmTmpDir(dir);
    }
  });

  // Deliverable — fails today: no isHooksDistStale export exists, and the
  // current inline predicate in ensureHooksDist only counts .js files, so a
  // dist missing every .sh entry would be (wrongly) accepted as populated.
  test('a hooks/dist missing every .sh is not considered populated', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeJs: true, includeSh: false });
      assert.strictEqual(isHooksDistStale(dir), true);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('a hooks/dist missing every .js is not considered populated', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeJs: false, includeSh: true });
      assert.strictEqual(isHooksDistStale(dir), true);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('a complete hooks/dist does not trigger a rebuild', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir);
      assert.strictEqual(isHooksDistStale(dir), false);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('an unexpected extra file does not force a rebuild', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { extra: true });
      assert.strictEqual(isHooksDistStale(dir), false);
    } finally {
      rmTmpDir(dir);
    }
  });

  // Deliverable — fails today: HOOKS_SUBDIRS_TO_COPY entries (e.g. `lib`,
  // which carries gsd-graphify-rebuild.sh, #3579) are not checked at all, so
  // a dist with every top-level file but no `lib/` reads as fully populated —
  // the exact blindness the old `.js`-count predicate had, one level down.
  test('a hooks/dist missing the lib subdirectory is not considered populated', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeSubdirs: false });
      assert.strictEqual(isHooksDistStale(dir), true);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('a complete hooks/dist including lib is not stale', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeSubdirs: true });
      assert.strictEqual(isHooksDistStale(dir), false);
    } finally {
      rmTmpDir(dir);
    }
  });

  // Deliverable — presence in the top-level readdir Set alone is not
  // enough: an empty `lib/` (missing e.g. gsd-graphify-rebuild.sh) is the
  // exact missing-file-class case the subdir check exists to catch, and a
  // bare membership check cannot see it.
  test('an empty lib subdirectory is not considered populated', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeSubdirs: false });
      for (const name of HOOKS_SUBDIRS_TO_COPY) {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
      }
      assert.strictEqual(isHooksDistStale(dir), true);
    } finally {
      rmTmpDir(dir);
    }
  });

  // Deliverable — a stray regular FILE named `lib` also satisfies bare
  // top-level Set membership; readdirSync on it must throw ENOTDIR, which
  // is caught and treated as stale, not left to escape uncaught.
  test('a regular file named lib is not considered populated', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    try {
      writeExpectedSet(dir, { includeSubdirs: false });
      for (const name of HOOKS_SUBDIRS_TO_COPY) {
        fs.writeFileSync(path.join(dir, name), 'i am a file, not a dir\n');
      }
      let stale;
      assert.doesNotThrow(() => {
        stale = isHooksDistStale(dir);
      });
      assert.strictEqual(stale, true);
    } finally {
      rmTmpDir(dir);
    }
  });

  // Deliverable — fails today: readdirSync throws ENOTDIR when `dir` is a
  // regular file, and isHooksDistStale lets that escape uncaught, failing
  // every suite's before() on a condition it cannot act on. Unreadable is
  // indistinguishable from unusable here; treating it as stale (safe,
  // rebuild-triggering) is the correct outcome, not a throw.
  test('a hooks/dist path that is a regular file is treated as stale, not thrown', () => {
    const isHooksDistStale = loadPredicate();
    const dir = mkTmpDir();
    const filePath = path.join(dir, 'not-a-directory');
    fs.writeFileSync(filePath, 'i am a file, not a dir\n');
    try {
      let stale;
      assert.doesNotThrow(() => {
        stale = isHooksDistStale(filePath);
      });
      assert.strictEqual(stale, true);
    } finally {
      rmTmpDir(dir);
    }
  });
});

// ── Group 2b: ensureHooksDist build-seam wiring ─────────────────────────────
//
// Group 2 above only exercises the pure predicate `isHooksDistStale` — none
// of it calls `ensureHooksDist`, so restoring the OLD inline `.js`-count
// check inside `ensureHooksDist` (while leaving `isHooksDistStale` exported
// and correct) would keep every Group-2 test green. These two tests drive
// `ensureHooksDist` itself and assert on the build seam, without running a
// real `build-hooks.js` subprocess: `fs.existsSync`/`fs.readdirSync` are
// monkeypatched (scoped to `HOOKS_DIST_DIR` only, restored in `finally`) to
// fake staleness/freshness with ZERO mutation of the worktree's real
// `hooks/dist`, and `processSeam.runNode` — the module OBJECT
// `hooks-dist.cjs` now calls through (`processSeam.runNode(...)`) rather
// than a destructured reference — is monkeypatched to observe whether the
// build seam was invoked, without ever spawning `build-hooks.js`.

describe('ensureHooksDist: build-seam wiring', () => {
  const { ensureHooksDist, HOOKS_DIST_DIR } = require('./helpers/hooks-dist.cjs');
  const processSeam = require('./helpers/process-seam.cjs');

  function withFakeDistState({ stale }, run) {
    const originalExistsSync = fs.existsSync;
    const originalReaddirSync = fs.readdirSync;
    if (stale) {
      // Absent is the simplest, unambiguous stale signal — short-circuits
      // isHooksDistStale before it ever calls readdirSync.
      fs.existsSync = (p) => (p === HOOKS_DIST_DIR ? false : originalExistsSync(p));
    } else {
      fs.existsSync = (p) => (p === HOOKS_DIST_DIR ? true : originalExistsSync(p));
      fs.readdirSync = (p, ...rest) => {
        if (p === HOOKS_DIST_DIR) return [...HOOKS_TO_COPY, ...HOOKS_SUBDIRS_TO_COPY];
        for (const name of HOOKS_SUBDIRS_TO_COPY) {
          if (p === path.join(HOOKS_DIST_DIR, name)) return ['fixture-leaf.txt'];
        }
        return originalReaddirSync(p, ...rest);
      };
    }
    try {
      run();
    } finally {
      fs.existsSync = originalExistsSync;
      fs.readdirSync = originalReaddirSync;
    }
  }

  function fakeSuccessfulRun() {
    return {
      outcome: 'exited',
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: null,
      killed: false,
      code: null,
    };
  }

  test('ensureHooksDist runs the build when the dist is stale', () => {
    const originalRunNode = processSeam.runNode;
    let calls = 0;
    processSeam.runNode = () => {
      calls += 1;
      return fakeSuccessfulRun();
    };
    try {
      withFakeDistState({ stale: true }, () => {
        ensureHooksDist();
      });
      assert.strictEqual(calls, 1);
    } finally {
      processSeam.runNode = originalRunNode;
    }
  });

  // Deliverable — the discriminating case: a rewiring regression that drops
  // (or bypasses) the `isHooksDistStale` guard and unconditionally invokes
  // the build seam would pass the STALE test above but FAIL this one, since
  // it would call the seam even against a fresh, fully-populated dist. The
  // STALE test alone cannot catch that shape of revert; this one does.
  test('ensureHooksDist does not run the build when the dist is complete', () => {
    const originalRunNode = processSeam.runNode;
    let calls = 0;
    processSeam.runNode = () => {
      calls += 1;
      return fakeSuccessfulRun();
    };
    try {
      withFakeDistState({ stale: false }, () => {
        ensureHooksDist();
      });
      assert.strictEqual(calls, 0);
    } finally {
      processSeam.runNode = originalRunNode;
    }
  });
});

// ── Group 3: skipped-leaf warning text ──────────────────────────────────────

describe('buildOverlayRepo: skipped-leaf warning', () => {
  test('names the build:hooks remedy in its warning text', (t) => {
    // Exercising this behaviorally would require reproducing a real TOCTOU
    // race against buildOverlayRepo's live filesystem walk (no exported seam
    // to inject the warning string directly), and reading overlay-repo.cjs as
    // text to assert on its message is exactly what local/no-source-grep
    // forbids. Skipped rather than written as an expensive/flaky or
    // source-grep test — see the module doc above.
    t.skip('no non-source-grep, non-flaky seam to assert the warning text against');
  });
});

// ── Group 4: property coverage ──────────────────────────────────────────────

describe('placeVanishableLeaf: property coverage', () => {
  test('property: never throws ENOENT, and returns true iff the attempt ultimately succeeds', () => {
    fc.assert(
      fc.property(
        // vanishCount === 0 never consults existsSync at all (the first
        // attempt succeeds outright), so presentAtFinalAttempt can never
        // change that case's outcome — the filter below drops the redundant
        // half of those samples (both flag values reduce to one behavior)
        // instead of letting them silently pad the run count. For every
        // vanishCount >= 1, existsSync IS consulted and the flag is wired
        // to change an observable outcome below (either `placed`, or —
        // for vanishCount >= 2, where `placed` is false either way — the
        // number of `attempt` calls), so no other combination is dropped.
        fc.tuple(fc.integer({ min: 0, max: 3 }), fc.boolean()).filter(
          ([vanishCount, presentAtFinalAttempt]) => vanishCount !== 0 || presentAtFinalAttempt === true,
        ),
        ([vanishCount, presentAtFinalAttempt]) => {
          const srcPath = path.join(os.tmpdir(), `gsd-3108-fc-fixture-${vanishCount}-${presentAtFinalAttempt}`);
          let calls = 0;
          // Throws ENOENT on every call up to and including `vanishCount`,
          // succeeds thereafter. placeVanishableLeaf only ever calls
          // `attempt` twice (first try + one retry), so only calls 1 and 2
          // are ever observed.
          const attempt = () => {
            calls += 1;
            if (calls <= vanishCount) {
              const err = new Error('ENOENT: no such file or directory');
              err.code = 'ENOENT';
              throw err;
            }
          };
          // existsSync is consulted only when the first attempt threw
          // (vanishCount >= 1), gating whether the retry is even attempted.
          // For vanishCount === 1 it decides whether the retry succeeds.
          // For vanishCount >= 2 the source is present-but-about-to-vanish
          // again on the retry (modelling the double-vanish case) when the
          // flag is true, or already gone (no retry attempted) when false —
          // both reach `placed === false`, but the flag still changes the
          // observed call count, so it is never a no-op here.
          const existsAnswer = presentAtFinalAttempt;
          const originalExistsSync = fs.existsSync;
          fs.existsSync = (p) => (p === srcPath ? existsAnswer : originalExistsSync(p));
          try {
            let placed;
            assert.doesNotThrow(() => {
              placed = placeVanishableLeaf(srcPath, attempt);
            }, 'placeVanishableLeaf must never let an ENOENT escape');

            if (vanishCount === 0) {
              assert.strictEqual(placed, true);
              assert.strictEqual(calls, 1);
            } else if (vanishCount === 1 && presentAtFinalAttempt) {
              assert.strictEqual(placed, true);
              assert.strictEqual(calls, 2);
            } else if (presentAtFinalAttempt) {
              // vanishCount >= 2: the retry is attempted (existsSync said
              // present) but vanishes again, so it still fails.
              assert.strictEqual(placed, false);
              assert.strictEqual(calls, 2);
            } else {
              // vanishCount === 1 && !presentAtFinalAttempt (gone for good
              // before the retry), or vanishCount >= 2 && !presentAtFinalAttempt
              // (existsSync already reports it gone, so the retry is never
              // attempted).
              assert.strictEqual(placed, false);
              assert.strictEqual(calls, 1);
            }
          } finally {
            fs.existsSync = originalExistsSync;
          }
        },
      ),
      { seed: 3108, numRuns: 200 },
    );
  });
});

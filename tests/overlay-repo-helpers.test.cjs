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
 * Group 3 (the skipped-leaf warning naming `npm run build:hooks`) asserts on
 * the warning text directly, via `buildOverlayRepo`'s injectable `opts.warn`
 * (defaulting to `console.warn`, byte-identical for every existing caller) —
 * no TOCTOU race or source-grep needed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');

const {
  placeVanishableLeaf,
  linkOrCopyFile,
  buildOverlayRepo,
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

  // Regression pin for #3108's review finding: linkOrCopyFile's attempt can
  // throw ENOENT because the DEST parent is missing (Windows MAX_PATH, a
  // concurrently-removed dest subtree), which has nothing to do with the
  // source tree. `fs.existsSync(srcPath)` and `err.path` both fail to
  // discriminate this from a genuine vanished-source ENOENT (see the doc
  // comment on `placeVanishableLeaf` in tests/helpers/overlay-repo.cjs), so
  // this is driven through `linkOrCopyFile` with a REAL source file and a
  // dest whose parent directory does not exist — the actual mechanism,
  // rather than a source-existence mock that cannot tell the two apart.
  test('a dest-side ENOENT is not mistaken for a vanished source', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3108-dest-side-'));
    const src = path.join(tmpBase, 'real-source-leaf.txt');
    const dest = path.join(tmpBase, 'missing-parent-dir', 'leaf.txt');
    fs.writeFileSync(src, 'content\n');
    try {
      assert.throws(() => linkOrCopyFile(src, dest), /ENOENT/);
    } finally {
      cleanup(tmpBase);
    }
  });

  // Pins that the guard keys ONLY on the dest parent, not on source
  // existence: the dest parent is present, so an ENOENT on both the attempt
  // and the retry is still treated as a vanished source (returns false),
  // never a throw.
  test('an ENOENT with the dest parent present is treated as a vanished source', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3108-dest-present-'));
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-dest-present-src');
    const destPath = path.join(tmpBase, 'leaf.txt');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    try {
      let placed;
      assert.doesNotThrow(() => {
        placed = placeVanishableLeaf(srcPath, attempt, destPath);
      });
      assert.strictEqual(placed, false);
      assert.strictEqual(calls, 2);
    } finally {
      cleanup(tmpBase);
    }
  });

  test('a real vanished source is still tolerated after the fix', () => {
    const srcPath = path.join(os.tmpdir(), 'gsd-3108-fixture-real-double-vanish');
    let calls = 0;
    const attempt = () => {
      calls += 1;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    };
    const originalExistsSync = fs.existsSync;
    // Source is genuinely gone at the re-check, both times.
    fs.existsSync = (p) => (p === srcPath ? false : originalExistsSync(p));
    try {
      let placed;
      assert.doesNotThrow(() => {
        placed = placeVanishableLeaf(srcPath, attempt);
      });
      assert.strictEqual(placed, false);
      assert.strictEqual(calls, 1);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  test('linkOrCopyFile throws (not skips) when the source is real but the dest parent is missing', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3108-linkorcopy-'));
    const src = path.join(tmpBase, 'real-source-leaf.txt');
    const dest = path.join(tmpBase, 'missing-parent-dir', 'leaf.txt');
    fs.writeFileSync(src, 'content\n');
    try {
      assert.throws(() => linkOrCopyFile(src, dest), /ENOENT/);
    } finally {
      cleanup(tmpBase);
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

  // Replaces fs.existsSync/fs.readdirSync process-wide for the duration of
  // `run`. Safe ONLY because this file's tests execute sequentially — adding
  // `{ concurrency: true }` to this file (or running it alongside another
  // suite in the same process) would let a concurrently-running test observe
  // these faked responses and cross-contaminate unrelated assertions.
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
  test('fires the build:hooks warning when a leaf vanishes mid-walk', () => {
    // `opts.warn` (defaulting to console.warn) is a trivially injectable seam
    // for this — no TOCTOU race or source-grep needed. Force a single real
    // top-level source file (package.json) to appear to have genuinely
    // vanished from the source tree: `fs.linkSync` ENOENTs for it on both the
    // attempt and the retry, and `fs.existsSync` reports it as gone at the
    // re-check, so `placeVanishableLeaf` reaches the tolerated "vanished mid-
    // walk" branch and `buildOverlayRepo` records it in `skipped`.
    //
    // Monkeypatching `fs.linkSync`/`fs.existsSync` process-wide here is safe
    // only because this file's tests run sequentially (node:test's default
    // for this repo, never `{ concurrency: true }`) — see the same caveat on
    // `withFakeDistState` above. Concurrency would let another in-flight test
    // in this process observe the faked path.
    const REPO_ROOT_PKG = path.join(__dirname, '..', 'package.json');
    const originalExistsSync = fs.existsSync;
    const originalLinkSync = fs.linkSync;
    fs.existsSync = (p) => (p === REPO_ROOT_PKG ? false : originalExistsSync(p));
    fs.linkSync = (src, dest) => {
      if (src === REPO_ROOT_PKG) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return originalLinkSync(src, dest);
    };

    const warnCalls = [];
    let overlayPath;
    try {
      overlayPath = buildOverlayRepo({}, { warn: (msg) => warnCalls.push(msg) });
    } finally {
      fs.existsSync = originalExistsSync;
      fs.linkSync = originalLinkSync;
      if (overlayPath) cleanup(overlayPath);
    }
    assert.strictEqual(warnCalls.length, 1);
    assert.match(warnCalls[0], /npm run build:hooks/);
    assert.match(warnCalls[0], /package\.json/);
  });

  test('does not warn on a clean walk', () => {
    const warnCalls = [];
    const overlayPath = buildOverlayRepo(
      { 'CONTRIBUTING.md': 'fixture override content\n' },
      { warn: (msg) => warnCalls.push(msg) },
    );
    try {
      assert.strictEqual(warnCalls.length, 0);
    } finally {
      cleanup(overlayPath);
    }
  });
});

// ── Group 4: property coverage ──────────────────────────────────────────────

describe('placeVanishableLeaf: property coverage', () => {
  // Monkeypatches fs.existsSync process-wide for the duration of each fc run
  // below — safe only because this file's tests execute sequentially; see
  // the same caveat on withFakeDistState in Group 2b above.
  test('property: an ENOENT is tolerated only when the source is confirmed gone', () => {
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
          // For vanishCount >= 2 the retry ALSO throws ENOENT, and existsSync
          // is consulted a SECOND time (post-fix) to decide whether that is a
          // genuinely vanished source (tolerated, placed=false) or a dest-side
          // ENOENT masquerading behind a source that is actually still there
          // (must propagate, since only a confirmed-absent source is ever
          // tolerated — see #3108's dest-side-ENOENT fix).
          const existsAnswer = presentAtFinalAttempt;
          const originalExistsSync = fs.existsSync;
          fs.existsSync = (p) => (p === srcPath ? existsAnswer : originalExistsSync(p));
          try {
            if (vanishCount === 0) {
              const placed = placeVanishableLeaf(srcPath, attempt);
              assert.strictEqual(placed, true);
              assert.strictEqual(calls, 1);
            } else if (vanishCount === 1 && presentAtFinalAttempt) {
              const placed = placeVanishableLeaf(srcPath, attempt);
              assert.strictEqual(placed, true);
              assert.strictEqual(calls, 2);
            } else if (vanishCount === 1 && !presentAtFinalAttempt) {
              // Gone for good before the retry is ever attempted.
              const placed = placeVanishableLeaf(srcPath, attempt);
              assert.strictEqual(placed, false);
              assert.strictEqual(calls, 1);
            } else if (presentAtFinalAttempt) {
              // vanishCount >= 2: the retry is attempted (existsSync said
              // present at the first check) and throws ENOENT again. With no
              // destPath supplied, the retry's ENOENT is tolerated
              // unconditionally (source existence is not re-consulted for
              // the retry outcome — see the doc comment on
              // placeVanishableLeaf): this is the double-vanish race the
              // function exists to tolerate, so it is skipped, not thrown.
              const placed = placeVanishableLeaf(srcPath, attempt);
              assert.strictEqual(placed, false);
              assert.strictEqual(calls, 2);
            } else {
              // vanishCount >= 2 && !presentAtFinalAttempt: existsSync
              // already reports the source gone on the FIRST check, so the
              // retry is never even attempted.
              const placed = placeVanishableLeaf(srcPath, attempt);
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

// ─── #3900: non-regular working-tree files are not repository content ────────

describe('buildOverlayRepo: non-regular files are skipped (#3900)', () => {
  // A unix socket under the repo root (an MCP server, a language-server
  // daemon, a watcher) made every suite built on the overlay fail in its
  // before() hook: the walker classified anything not-a-directory as a file,
  // and copyFileSync on a socket throws ENXIO (a FIFO would block). The
  // reporter measured 32 failures across 6 files — none about the code under
  // test. Unix-domain sockets bind only on POSIX; the Windows lane keeps the
  // equivalence via a FIFO-shaped skip is impractical, so it verifies only
  // the regular-file path.
  const isPosix = process.platform !== 'win32';

  test('a unix socket anywhere under the repo root does not break the overlay', { skip: !isPosix }, async () => {
    const net = require('node:net');
    const probeDir = path.join(__dirname, '..', '.gsd-3900-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    const sockPath = path.join(probeDir, 'daemon.sock');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(sockPath, resolve));
    try {
      let overlay;
      try {
        overlay = buildOverlayRepo({});
        // The socket must not be mirrored into the overlay.
        assert.equal(
          fs.existsSync(path.join(overlay, '.gsd-3900-probe', 'daemon.sock')),
          false,
          'the socket is not repository content — it must not be copied',
        );
        // And the repository's own files still are.
        assert.equal(fs.existsSync(path.join(overlay, 'package.json')), true);
      } finally {
        if (overlay) cleanup(overlay);
      }
    } finally {
      server.close();
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  test('regular files under the probe directory still copy (control)', () => {
    const probeDir = path.join(__dirname, '..', '.gsd-3900-probe-ctrl');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'note.txt'), 'x');
    try {
      const overlay = buildOverlayRepo({});
      try {
        assert.equal(fs.existsSync(path.join(overlay, '.gsd-3900-probe-ctrl', 'note.txt')), true);
      } finally {
        cleanup(overlay);
      }
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

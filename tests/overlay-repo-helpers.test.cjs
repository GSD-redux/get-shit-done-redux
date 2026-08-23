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
const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');
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

  for (const code of ['EACCES', 'EMFILE', 'EPERM']) {
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

  function writeExpectedSet(dir, { includeJs = true, includeSh = true, extra = false } = {}) {
    for (const name of HOOKS_TO_COPY) {
      if (name.endsWith('.js') && !includeJs) continue;
      if (name.endsWith('.sh') && !includeSh) continue;
      fs.writeFileSync(path.join(dir, name), '// fixture\n');
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
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (vanishCount, presentAtFinalAttempt) => {
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
          // existsSync is consulted only when the first attempt threw. For
          // vanishCount === 1 it decides whether the retry succeeds
          // (presentAtFinalAttempt) or the leaf is genuinely gone. For
          // vanishCount >= 2 the source is present but about to vanish
          // again on the retry, modelling the double-vanish case.
          const existsAnswer = vanishCount === 1 ? presentAtFinalAttempt : true;
          const originalExistsSync = fs.existsSync;
          fs.existsSync = (p) => (p === srcPath ? existsAnswer : originalExistsSync(p));
          try {
            let placed;
            assert.doesNotThrow(() => {
              placed = placeVanishableLeaf(srcPath, attempt);
            }, 'placeVanishableLeaf must never let an ENOENT escape');

            if (vanishCount === 0) {
              assert.strictEqual(placed, true);
            } else if (vanishCount === 1 && presentAtFinalAttempt) {
              assert.strictEqual(placed, true);
            } else {
              // vanishCount === 1 && !presentAtFinalAttempt (gone for good),
              // or vanishCount >= 2 (vanishes again on the retry too).
              assert.strictEqual(placed, false);
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

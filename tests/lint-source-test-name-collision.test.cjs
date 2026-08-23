'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  checkSourceTestNameCollisions,
} = require('../scripts/lint-source-test-name-collision.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function writeFile(root, relPath, content = '// fixture\n') {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function violationFiles(result) {
  return result.violations.map((v) => v.file);
}

describe('lint-source-test-name-collision', () => {
  test('the real repo tree passes (post-rename)', () => {
    const result = checkSourceTestNameCollisions({ root: REPO_ROOT });
    assert.equal(
      result.ok,
      true,
      `expected 0 violations, got: ${JSON.stringify(result.violations, null, 2)}`
    );
    // Not vacuous: the scan must have actually walked a nontrivial number of
    // files, or "0 violations" would mean nothing.
    assert.ok(
      result.scanned.length > 50,
      `expected the scan to cover a substantial file count, got ${result.scanned.length}`
    );
  });

  test('a deliberately-colliding fixture DOES fail (proves the lint can fail)', () => {
    const root = createTempDir('lint-collision-fail-');
    try {
      writeFile(root, 'src/test-oops.cts');
      const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
      assert.equal(result.ok, false);
      assert.deepEqual(violationFiles(result), ['src/test-oops.cts']);
    } finally {
      cleanup(root);
    }
  });

  test('regression pin: test-home-guard.cts under a source dir is flagged', () => {
    // Incident: unmodified `next` tip 622f43353 ran 37199 passed / 1 failed,
    // `throw · src/test-home-guard.cts` — a SOURCE module collected and
    // executed as a test by the remote push-gate runner. Two further live
    // instances found by this same trap before they were renamed:
    //   scripts/test-failure-reasons.cjs (now scripts/gsd-test-gate-reasons.cjs)
    //   scripts/lint-fix-has-regression-test.cjs (now
    //     scripts/lint-fix-has-regression-tests.cjs)
    const root = createTempDir('lint-collision-incident-');
    try {
      writeFile(root, 'src/test-home-guard.cts');
      const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
      assert.equal(result.ok, false);
      assert.deepEqual(violationFiles(result), ['src/test-home-guard.cts']);
    } finally {
      cleanup(root);
    }
  });

  test('a colliding basename under an EXEMPT dir (tests/) passes', () => {
    const root = createTempDir('lint-collision-exempt-');
    try {
      writeFile(root, 'tests/test-oops.cts');
      // Only 'src' is scanned — tests/ is never a configured scan dir, exactly
      // as in the real DEFAULT_SCAN_DIRS.
      const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);
    } finally {
      cleanup(root);
    }
  });

  test('the identical basename under a SOURCE dir fails (contrast case)', () => {
    const root = createTempDir('lint-collision-source-');
    try {
      writeFile(root, 'src/test-oops.cts');
      const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
      assert.equal(result.ok, false);
      assert.deepEqual(violationFiles(result), ['src/test-oops.cts']);
    } finally {
      cleanup(root);
    }
  });

  describe('boundary coverage: test-*.EXT', () => {
    test('test-foo.cts FAILS', () => {
      const root = createTempDir('lint-b1-');
      try {
        writeFile(root, 'src/test-foo.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, false);
      } finally {
        cleanup(root);
      }
    });

    test('testfoo.cts PASSES', () => {
      const root = createTempDir('lint-b2-');
      try {
        writeFile(root, 'src/testfoo.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, true);
      } finally {
        cleanup(root);
      }
    });
  });

  describe('boundary coverage: *-test.EXT', () => {
    test('foo-test.cts FAILS', () => {
      const root = createTempDir('lint-b3-');
      try {
        writeFile(root, 'src/foo-test.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, false);
      } finally {
        cleanup(root);
      }
    });

    test('footest.cts PASSES', () => {
      const root = createTempDir('lint-b4-');
      try {
        writeFile(root, 'src/footest.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, true);
      } finally {
        cleanup(root);
      }
    });
  });

  describe('boundary coverage: *.test.EXT', () => {
    test('foo.test.cts FAILS', () => {
      const root = createTempDir('lint-b5-');
      try {
        writeFile(root, 'src/foo.test.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, false);
      } finally {
        cleanup(root);
      }
    });

    test('foo.tests.cts PASSES', () => {
      const root = createTempDir('lint-b6-');
      try {
        writeFile(root, 'src/foo.tests.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, true);
      } finally {
        cleanup(root);
      }
    });
  });

  describe('boundary coverage: test.EXT (bare)', () => {
    test('test.cts FAILS', () => {
      const root = createTempDir('lint-b7-');
      try {
        writeFile(root, 'src/test.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, false);
      } finally {
        cleanup(root);
      }
    });

    test('tests.cts PASSES', () => {
      const root = createTempDir('lint-b8-');
      try {
        writeFile(root, 'src/tests.cts');
        const result = checkSourceTestNameCollisions({ root, dirs: ['src'] });
        assert.equal(result.ok, true);
      } finally {
        cleanup(root);
      }
    });
  });

  test('an unreadable scan directory fails closed, not silently green', () => {
    const root = createTempDir('lint-unreadable-');
    try {
      // No 'src' dir created at all under a DIFFERENT configured dir name so
      // fs.existsSync short-circuits it (not this lint's problem, per its own
      // contract) — instead force a real read failure by pointing `dirs` at a
      // path that exists as a FILE, not a directory, so readdirSync throws.
      writeFile(root, 'not-a-dir', '// not a directory\n');
      const result = checkSourceTestNameCollisions({ root, dirs: ['not-a-dir'] });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => /cannot read scan directory/.test(v.reason)),
        `expected an unreadable-dir violation, got: ${JSON.stringify(result.violations)}`
      );
    } finally {
      cleanup(root);
    }
  });
});

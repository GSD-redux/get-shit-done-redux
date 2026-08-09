/**
 * GSD Tools Test Helpers – cleanup() behavioral tests
 *
 * Three deterministic, cross-platform tests that verify cleanup()'s
 * observable contract at the seam rather than probing its internals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');

const { cleanup, createTempDir, tmpRootCandidates } = require('./helpers.cjs');

// ─── Test 1: Real-FS happy path ──────────────────────────────────────────────

test('cleanup removes a real temp dir with nested subdirs and files', () => {
  const dir = createTempDir('gsd-cleanup-test-');
  const nested = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'file.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'root.txt'), 'world');

  cleanup(dir);

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});

// ─── Test 2: Retry-budget contract ───────────────────────────────────────────

test('cleanup passes recursive/force/maxRetries/retryDelay options to fs.rmSync', () => {
  // Use a real temp dir as the target so cleanup() has a valid path argument.
  // We chdir AWAY from it first so cleanup() does not try to chdir either.
  const dir = createTempDir('gsd-cleanup-opts-test-');

  // Capture original cwd and shift away from the target.
  const originalCwd = process.cwd();
  // Chdir to the parent of the target so cleanup's cwd-guard is a no-op.
  process.chdir(path.dirname(dir));

  let capturedOptions = null;
  const realRmSync = fs.rmSync;

  try {
    // Replace fs.rmSync with a probe that captures options then does nothing.
    // This is an assignment expression (not a CallExpression) so it satisfies
    // the ESLint rule that bans raw fs.rmSync(...) call expressions in tests.
    fs.rmSync = (targetPath, opts) => {
      capturedOptions = opts;
      // Do NOT call through — we don't want the dir actually removed here;
      // we're only testing the options shape.
    };

    cleanup(dir);
  } finally {
    fs.rmSync = realRmSync;
    process.chdir(originalCwd);
    // Remove the dir with the real rmSync now that we restored it.
    cleanup(dir);
  }

  assert.ok(capturedOptions !== null, 'fs.rmSync should have been called');
  assert.strictEqual(capturedOptions.recursive, true, 'recursive must be true');
  assert.strictEqual(capturedOptions.force, true, 'force must be true');
  assert.ok(
    typeof capturedOptions.maxRetries === 'number' && capturedOptions.maxRetries > 0,
    'maxRetries must be a positive number'
  );
  assert.ok(
    typeof capturedOptions.retryDelay === 'number' && capturedOptions.retryDelay > 0,
    'retryDelay must be a positive number'
  );
});

// ─── Test 3: cwd-guard ───────────────────────────────────────────────────────

test('cleanup does not throw when cwd is inside the target dir, and removes the dir', () => {
  const dir = createTempDir('gsd-cleanup-cwd-test-');
  const nested = path.join(dir, 'deep', 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const originalCwd = process.cwd();

  try {
    // Step INTO the nested subdir so cwd is inside the cleanup target.
    process.chdir(nested);

    assert.doesNotThrow(() => {
      cleanup(dir);
    }, 'cleanup should not throw even when cwd is inside the target');
  } finally {
    // Restore original cwd. cleanup() will have chdir'd to dirname(dir),
    // so we always restore explicitly regardless.
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  }

  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should not exist after cleanup');
});

// ─── Test 4: out-of-tmpdir refusal ───────────────────────────────────────────

test('cleanup throws and does not chdir or delete when target is outside os.tmpdir()', () => {
  // __dirname (this repo's tests/ directory) must never be deleted. Whether
  // it is actually outside os.tmpdir() is environment-dependent: on Linux
  // os.tmpdir() is /tmp, and a CI container that checks the repo out under
  // /tmp would put __dirname INSIDE tmpdir, in which case a correctly-working
  // cleanup() would not refuse it -- it would delete this directory. The
  // precondition assertion below verifies the "outside tmpdir" assumption
  // before cleanup() is ever called, so that situation fails loudly and
  // safely instead of destructively. No scratch directory is created, so
  // there is nothing to tear down.
  const outsideDir = __dirname;
  const knownFile = path.join(outsideDir, 'helpers-cleanup.test.cjs');

  // Use cleanup()'s own tmpRootCandidates() as the single source of truth
  // for "is this path inside tmpdir" instead of a hand-mirrored predicate.
  // The old copy here checked only path.resolve(os.tmpdir()), one of
  // SEVERAL root spellings cleanup() actually accepts (it also accepts the
  // realpath'd and native-realpath'd forms) — a repo checked out under a
  // root this precondition didn't know about would compute "outside, safe"
  // while cleanup() computed "inside, delete", turning this refusal test
  // into the very destructive scenario it exists to prevent. Importing the
  // real function removes that drift class entirely.
  const resolvedOutsideDir = path.resolve(outsideDir);
  const roots = tmpRootCandidates();
  const isWindows = process.platform === 'win32';
  const outsideDirForCompare = isWindows ? resolvedOutsideDir.toLowerCase() : resolvedOutsideDir;
  const isInsideTmpdir = roots.some((root) => {
    const rootForCompare = isWindows ? root.toLowerCase() : root;
    return (
      outsideDirForCompare === rootForCompare ||
      outsideDirForCompare.startsWith(`${rootForCompare}${path.sep}`)
    );
  });
  assert.strictEqual(
    isInsideTmpdir,
    false,
    `this test cannot run safely when the repo lives under any tmpdir root ` +
      `cleanup() accepts: outsideDir (${resolvedOutsideDir}) is inside one of ${JSON.stringify(roots)}`
  );

  const cwdBefore = process.cwd();

  assert.throws(
    () => cleanup(outsideDir),
    (err) => err instanceof Error && err.message.includes(outsideDir),
    'cleanup must throw an Error whose message names the offending path'
  );

  assert.strictEqual(
    process.cwd(),
    cwdBefore,
    'cleanup must refuse before chdir, so cwd is unchanged'
  );
  assert.strictEqual(fs.existsSync(outsideDir), true, 'target directory must still exist after refusal');
  assert.strictEqual(
    fs.existsSync(knownFile),
    true,
    'a known file inside the target must still exist, proving the dir was not emptied'
  );
});

// ─── Test 5: control — a real os.tmpdir()-rooted path still cleans up ───────

test('cleanup still removes a real os.tmpdir()-rooted directory (control)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-control-'));

  cleanup(dir);

  assert.strictEqual(fs.existsSync(dir), false, 'os.tmpdir()-rooted directory should be removed');
});

// ─── Test 6b: accepted-roots set always accepts a freshly-minted tmpdir ─────

test('cleanup accepts a freshly-created os.tmpdir()-rooted dir on any platform (accepted-roots invariant)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-roots-'));
  t.after(() => {
    if (fs.existsSync(dir)) cleanup(dir);
  });

  assert.doesNotThrow(
    () => cleanup(dir),
    'cleanup must accept a directory created directly under os.tmpdir(), regardless of platform-specific canonical spelling (8.3 short/long names, /var symlink, drive-letter case)'
  );
  assert.strictEqual(fs.existsSync(dir), false, 'temp dir should be removed, not refused');
});

// ─── Test 6: realpath'd os.tmpdir() form is not refused (regression) ────────

test('cleanup accepts a realpath()d temp dir even when it differs from the raw path (macOS /var -> /private/var)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-realpath-'));
  const realPath = fs.realpathSync(dir);

  if (realPath !== dir) {
    // macOS (and any other symlinked-tmpdir platform): the realpath'd form
    // diverges from the raw mkdtempSync() path. This is exactly the shape a
    // caller gets from fs.realpathSync() or from process.cwd() after
    // chdir-ing into a realpath'd dir — assert the guard does NOT refuse it.
    cleanup(realPath);
    assert.strictEqual(fs.existsSync(realPath), false, 'realpath()d form should be removed, not refused');
    assert.strictEqual(fs.existsSync(dir), false, 'raw path should also be gone (same directory)');
  } else {
    // Linux and any platform with no tmpdir symlink indirection: realpath()
    // equals the raw path, so this branch exercises the ordinary path and
    // keeps the test meaningful (non-vacuous) on both platforms.
    t.after(() => {
      if (fs.existsSync(dir)) cleanup(dir);
    });
    cleanup(dir);
    assert.strictEqual(fs.existsSync(dir), false, 'temp dir should be removed');
  }
});

// ─── Test 7: tmpRootCandidates() shape invariants (platform-independent) ────
//
// Test 6 above is coverage-identical to Test 5's control on any platform
// where fs.realpathSync(tmpdir) does not diverge from the raw path (Linux,
// notably — the platform the remote matrix actually runs on), so it cannot
// verify the macOS-specific fix there. These assertions hold the exported
// tmpRootCandidates() to a contract that is meaningful on every platform.

test('tmpRootCandidates() returns a well-formed, deduplicated list of absolute paths', () => {
  const roots = tmpRootCandidates();

  assert.ok(Array.isArray(roots) && roots.length > 0, 'must return a non-empty array');

  for (const root of roots) {
    assert.strictEqual(path.isAbsolute(root), true, `root must be absolute: ${root}`);
  }

  const isWindows = process.platform === 'win32';
  const keys = roots.map((r) => (isWindows ? r.toLowerCase() : r));
  const uniqueKeys = new Set(keys);
  assert.strictEqual(uniqueKeys.size, keys.length, `roots must be deduplicated: ${JSON.stringify(roots)}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cleanup-roots-contract-'));
  try {
    const resolvedDir = path.resolve(dir);
    const dirForCompare = isWindows ? resolvedDir.toLowerCase() : resolvedDir;
    const isUnderSomeRoot = roots.some((root) => {
      const rootForCompare = isWindows ? root.toLowerCase() : root;
      return (
        dirForCompare === rootForCompare ||
        dirForCompare.startsWith(`${rootForCompare}${path.sep}`)
      );
    });
    assert.strictEqual(
      isUnderSomeRoot,
      true,
      `a freshly mkdtempSync'd dir under os.tmpdir() must be under at least one returned root: ` +
        `${resolvedDir} vs ${JSON.stringify(roots)}`
    );
  } finally {
    cleanup(dir);
  }
});


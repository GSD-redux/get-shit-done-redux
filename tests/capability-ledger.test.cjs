/**
 * Unit tests for the capability ledger module (ADR-1244 Phase 3, Decision D4).
 *
 * Tests are hermetic: each uses its own tmpdir created by createTempDir and
 * cleaned up in t.after(). No shared state between tests.
 */

'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const capLedger = require('../gsd-core/bin/lib/capability-ledger.cjs');
const {
  readLedger,
  writeLedger,
  recordInstall,
  removeEntry,
  reconcile,
  LEDGER_FILE_NAME,
} = capLedger;
// Destructure optional exports (new in this patch) — will be undefined until implemented.
const { LedgerIOError, isValidLedgerEntry, readLedgerStrict, readSmallRegularFile } = capLedger;

const { runHook } = require('./helpers/process-seam.cjs');
// A single `mkfifo` system call creating a fixture FIFO — no install or build.
const MKFIFO_TIMEOUT_MS = 15000;
/** POSIX-only: make a FIFO at `p` (skips/returns false where mkfifo is unavailable). */
function tryMkfifo(p) {
  if (process.platform === 'win32') return false;
  const res = runHook(p, [], { interpreter: 'mkfifo', timeoutMs: MKFIFO_TIMEOUT_MS });
  return res.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid LedgerEntry. */
function makeEntry(id = 'test-cap', overrides = {}) {
  return {
    id,
    version: '1.0.0',
    source: 'registry:test',
    integrity: 'sha256-abc123',
    files: [],
    sharedEdits: [],
    ...overrides,
  };
}

/** Build a minimal valid LedgerFile. */
function makeLedger(overrides = {}) {
  return {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {},
    ...overrides,
  };
}

/** Return all tmp files left in dir (matches <filename>.tmp.<pid>-<nonce> pattern). */
function orphanTmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  // Temp names are <ledger>.tmp.<pid>-<nonce> — the nonce suffix after the pid is required
  // to avoid treating the bare .tmp.<pid> form as a hit (finding 17).
  return fs.readdirSync(dir).filter((n) => /\.tmp\.\d+-[0-9a-f]+$/.test(n));
}

// ---------------------------------------------------------------------------
// readLedger — missing file
// ---------------------------------------------------------------------------

test('readLedger returns null for a missing file (no throw)', (t) => {
  const dir = createTempDir('ledger-missing-');
  t.after(() => cleanup(dir));

  const result = readLedger(dir);
  assert.equal(result, null, 'must return null for a missing ledger file');
});

// ---------------------------------------------------------------------------
// readLedger — corrupt JSON
// ---------------------------------------------------------------------------

test('readLedger returns null for corrupt JSON (no throw)', (t) => {
  const dir = createTempDir('ledger-corrupt-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), 'NOT { valid JSON }\n');

  const result = readLedger(dir);
  assert.equal(result, null, 'must return null for corrupt JSON');
});

// ---------------------------------------------------------------------------
// writeLedger / readLedger round-trip
// ---------------------------------------------------------------------------

test('writeLedger then readLedger round-trips a valid ledger', (t) => {
  const dir = createTempDir('ledger-roundtrip-');
  t.after(() => cleanup(dir));

  const ledger = makeLedger({
    entries: {
      'my-cap': makeEntry('my-cap', { files: ['commands/gsd/my-cap.md'] }),
    },
  });

  writeLedger(dir, ledger);
  const readBack = readLedger(dir);

  assert.ok(readBack !== null, 'readLedger must return the written ledger');
  assert.equal(readBack.version, '1');
  assert.equal(typeof readBack.updatedAt, 'string');
  assert.ok('my-cap' in readBack.entries, 'entry must survive the round-trip');
  assert.deepEqual(readBack.entries['my-cap'].files, ['commands/gsd/my-cap.md']);
});

// ---------------------------------------------------------------------------
// writeLedger — no orphan .tmp file
// ---------------------------------------------------------------------------

test('writeLedger leaves no orphan .tmp file after a successful write', (t) => {
  const dir = createTempDir('ledger-no-orphan-');
  t.after(() => cleanup(dir));

  writeLedger(dir, makeLedger());

  const orphans = orphanTmpFiles(dir);
  assert.deepEqual(orphans, [], 'must leave no .tmp.<pid> orphan after write');
  // The real ledger file must exist.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), true);
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM): the directory fsync in writeLedger (fsyncContainingDir)
// must NOT swallow ALL errors. It tolerates ONLY EISDIR/EPERM/EINVAL/EBADF
// (platforms that disallow directory fsync); any other errno (e.g. EIO) must
// RETHROW (durability could not be confirmed). The dir fd must still be closed.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with fs.fsyncSync mocked to throw `errno` ONLY for the directory fd
 * (the fd openSync returned for a path opened with the 'r' flag — writeLedger
 * opens the containing dir with 'r'). File-fd fsync (the write fd) passes through.
 */
function withDirFsyncError(t, errno, fn) {
  const dirFds = new Set();
  const realOpen = fs.openSync.bind(fs);
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (flags === 'r') dirFds.add(fd); // writeLedger opens the containing DIR with 'r'
    return fd;
  });
  const realClose = fs.closeSync.bind(fs);
  const closed = [];
  const closeMock = mock.method(fs, 'closeSync', function (fd) {
    // Remove the fd from the tracked set BEFORE closing: once closed the OS may reuse the same
    // fd NUMBER for an unrelated open, which must NOT be treated as the directory fd.
    if (dirFds.has(fd)) { closed.push(fd); dirFds.delete(fd); }
    return realClose(fd);
  });
  const realFsync = fs.fsyncSync.bind(fs);
  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd) {
    if (dirFds.has(fd)) { const e = new Error(`${errno}: injected`); e.code = errno; throw e; }
    return realFsync(fd);
  });
  t.after(() => { openMock.mock.restore(); closeMock.mock.restore(); fsyncMock.mock.restore(); });
  return fn({ dirFds, closed });
}

// Revert-fails: restore the swallow-all behavior (no rethrow for non-tolerated
// errnos) → writeLedger completes silently on an EIO dir-fsync, so this
// assert.throws sees no throw and fails.
test('finding-4: writeLedger RETHROWS a NON-tolerated dir-fsync errno (EIO) — durability not silently claimed', (t) => {
  const dir = createTempDir('ledger-finding4-eio-');
  t.after(() => cleanup(dir));
  withDirFsyncError(t, 'EIO', ({ closed }) => {
    assert.throws(
      () => writeLedger(dir, makeLedger()),
      (err) => {
        assert.match(String(err && err.message), /durab/i,
          'the rethrown error must indicate durability could not be confirmed');
        return true;
      },
      'an EIO directory-fsync error must NOT be swallowed',
    );
    assert.ok(closed.length >= 1, 'the directory fd must still be closed (finally)');
  });
});

// Revert-fails: if the tolerated-errno allowlist is removed (rethrow EVERYTHING),
// EISDIR would throw and this "does not throw" assertion fails.
test('finding-4: writeLedger TOLERATES an EISDIR dir-fsync errno (platform disallows dir fsync)', (t) => {
  const dir = createTempDir('ledger-finding4-eisdir-');
  t.after(() => cleanup(dir));
  withDirFsyncError(t, 'EISDIR', ({ closed }) => {
    assert.doesNotThrow(() => writeLedger(dir, makeLedger()),
      'an EISDIR directory-fsync error must be tolerated (best-effort)');
    assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), true, 'ledger still written');
    assert.ok(closed.length >= 1, 'the directory fd must still be closed (finally)');
  });
});

// ---------------------------------------------------------------------------
// recordInstall — idempotent (same id twice → one entry, replaced)
// ---------------------------------------------------------------------------

test('recordInstall is idempotent: same id twice yields one entry with the latest data', (t) => {
  const dir = createTempDir('ledger-idempotent-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-a', { version: '1.0.0' }));
  recordInstall(dir, makeEntry('cap-a', { version: '2.0.0' }));

  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  const ids = Object.keys(ledger.entries);
  assert.equal(ids.length, 1, 'must have exactly one entry');
  assert.equal(ledger.entries['cap-a'].version, '2.0.0', 'entry must reflect the last write');
});

// ---------------------------------------------------------------------------
// recordInstall — __proto__ injection rejected
// ---------------------------------------------------------------------------

test('recordInstall rejects a __proto__ id without polluting Object.prototype (now THROWS — ROOT FIX 3)', (t) => {
  const dir = createTempDir('ledger-proto-');
  t.after(() => cleanup(dir));

  // Capture the prototype BEFORE calling recordInstall.
  const preBefore = Object.prototype['injected'];

  // ROOT FIX 3: recordInstall now THROWS (not silently returns) for unsafe ids.
  // This is correct behavior — silent return allowed callers to assume success.
  assert.throws(
    () => recordInstall(dir, makeEntry('__proto__', { integrity: 'evil' })),
    (err) => err instanceof Error,
    'recordInstall must throw for __proto__ id (ROOT FIX 3: throw not silent return)',
  );

  // Prototype must not have been polluted.
  assert.equal(Object.prototype['injected'], preBefore);
  assert.equal(({}).__proto__['injected'], preBefore);

  // The ledger file must not exist (thrown before any write).
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false,
    '__proto__ id must not produce a ledger file');
});

test('recordInstall rejects "constructor" and "prototype" ids (now THROWS — ROOT FIX 3)', (t) => {
  const dir = createTempDir('ledger-proto2-');
  t.after(() => cleanup(dir));

  // ROOT FIX 3: must throw, not silently return.
  assert.throws(
    () => recordInstall(dir, makeEntry('constructor')),
    (err) => err instanceof Error,
    'must throw for constructor id',
  );
  assert.throws(
    () => recordInstall(dir, makeEntry('prototype')),
    (err) => err instanceof Error,
    'must throw for prototype id',
  );

  // No ledger file must exist.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false,
    'no ledger must exist after throws for unsafe ids');
});

// ---------------------------------------------------------------------------
// Finding 3 (MEDIUM): recordInstall must validate the WHOLE entry (via isValidLedgerEntry),
// not only entry.id — so it can never write a ledger that readLedger would then reject as
// corrupt (e.g. files:[123]). It must THROW on a structurally-invalid entry and write nothing.
// ---------------------------------------------------------------------------

test('finding-3: recordInstall THROWS on a structurally-invalid entry (files:[123]) and writes nothing', (t) => {
  const dir = createTempDir('ledger-record-badentry-');
  t.after(() => cleanup(dir));

  // Valid kebab id, but files[] holds a non-string — readLedger would reject this as corrupt.
  const badEntry = makeEntry('cap-bad', { files: [123] });

  assert.throws(
    () => recordInstall(dir, badEntry),
    (err) => err instanceof Error,
    'recordInstall must throw on a structurally-invalid entry (files:[123])',
  );

  // It must NOT have written a self-corrupting ledger.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false,
    'recordInstall must write nothing when the entry is structurally invalid');
});

test('finding-3: recordInstall THROWS on an entry whose sharedEdits member is missing marker (writes nothing)', (t) => {
  const dir = createTempDir('ledger-record-badedit-');
  t.after(() => cleanup(dir));

  const badEntry = makeEntry('cap-bad2', { sharedEdits: [{ file: 'settings.json' }] });

  assert.throws(
    () => recordInstall(dir, badEntry),
    (err) => err instanceof Error,
    'recordInstall must throw on an entry with a malformed sharedEdits member',
  );
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false,
    'recordInstall must write nothing for a malformed entry');
});

test('finding-3: recordInstall whole-entry validation does NOT reject a valid entry (non-regression)', (t) => {
  const dir = createTempDir('ledger-record-valid-');
  t.after(() => cleanup(dir));

  assert.doesNotThrow(
    () => recordInstall(dir, makeEntry('cap-ok', {
      files: ['commands/gsd/cap-ok.md'],
      sharedEdits: [{ file: 'settings.json', marker: 'cap-ok' }],
    })),
    'a fully-valid entry must still record cleanly',
  );
  const ledger = readLedger(dir);
  assert.ok(ledger && ledger.entries['cap-ok'], 'valid entry must be recorded');
});

// ---------------------------------------------------------------------------
// removeEntry — removes target + returns true/false
// ---------------------------------------------------------------------------

test('removeEntry removes only the target entry and returns true', (t) => {
  const dir = createTempDir('ledger-remove-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-x'));
  recordInstall(dir, makeEntry('cap-y'));

  const removed = removeEntry(dir, 'cap-x');
  assert.equal(removed, true, 'must return true when the entry existed');

  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  assert.ok(!('cap-x' in ledger.entries), 'cap-x must be gone');
  assert.ok('cap-y' in ledger.entries, 'cap-y must remain');
});

test('removeEntry returns false when the id does not exist', (t) => {
  const dir = createTempDir('ledger-remove-miss-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-z'));

  const removed = removeEntry(dir, 'nonexistent');
  assert.equal(removed, false, 'must return false when the entry is absent');

  // The remaining entry must be untouched.
  const ledger = readLedger(dir);
  assert.ok(ledger !== null);
  assert.ok('cap-z' in ledger.entries);
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM): removeEntry must be fail-closed on a corrupt-but-present ledger
// — it must NOT return false (which would masquerade as "not installed") but instead
// THROW (use readLedgerStrict) so a corrupt ledger cannot hide a recorded entry.
// ---------------------------------------------------------------------------

test('finding-4: removeEntry THROWS on a corrupt-but-present ledger (fail-closed, never returns false)', (t) => {
  const dir = createTempDir('ledger-remove-corrupt-');
  t.after(() => cleanup(dir));

  // First record a valid entry, then corrupt the on-disk ledger.
  recordInstall(dir, makeEntry('cap-corrupt'));
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  const corrupt = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corrupt);

  // removeEntry must FAIL CLOSED — throw (CorruptLedgerError), never silently return false.
  let threw = false;
  let ret;
  try {
    ret = removeEntry(dir, 'cap-corrupt');
  } catch (err) {
    threw = true;
    assert.ok(/corrupt|invalid/i.test(err.message),
      `error must name corruption; got: "${err.message}"`);
  }
  assert.equal(threw, true,
    `removeEntry must THROW on a corrupt-present ledger, not return ${JSON.stringify(ret)} ` +
    `(returning false would masquerade as "not installed")`);

  // Non-destructive: the corrupt file is left in place untouched.
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), corrupt,
    'corrupt ledger must be left in place untouched');
});

test('finding-4: removeEntry on a genuinely MISSING ledger still returns false (non-regression)', (t) => {
  const dir = createTempDir('ledger-remove-missing-');
  t.after(() => cleanup(dir));

  // No ledger file written at all.
  const removed = removeEntry(dir, 'nope');
  assert.equal(removed, false,
    'removeEntry on a missing ledger must return false (missing != corrupt)');
});

// ---------------------------------------------------------------------------
// reconcile — orphans when recorded files are missing
// ---------------------------------------------------------------------------

test('reconcile reports orphans when a recorded file is missing on disk', (t) => {
  const dir = createTempDir('ledger-reconcile-miss-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('cap-missing', {
    files: ['commands/gsd/cap-missing.md', 'agents/gsd-cap.md'],
  }));

  const result = reconcile(dir);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.orphans.length, 1, 'must report one orphan entry');
  assert.equal(result.orphans[0].id, 'cap-missing');
  assert.deepEqual(
    result.orphans[0].missing.sort(),
    ['agents/gsd-cap.md', 'commands/gsd/cap-missing.md'].sort(),
  );
});

// ---------------------------------------------------------------------------
// reconcile — empty result when all files are present
// ---------------------------------------------------------------------------

test('reconcile returns empty orphans when all recorded files exist on disk', (t) => {
  const dir = createTempDir('ledger-reconcile-ok-');
  t.after(() => cleanup(dir));

  // Create the files that will be recorded.
  const subdir = path.join(dir, 'commands', 'gsd');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'cap-present.md'), '# cap\n');

  recordInstall(dir, makeEntry('cap-present', {
    files: ['commands/gsd/cap-present.md'],
  }));

  const result = reconcile(dir);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.orphans, [], 'must report no orphans when files exist');
  assert.deepEqual(result.stale, []);
});

// ---------------------------------------------------------------------------
// reconcile — warning for corrupt ledger (file exists but not parseable)
// ---------------------------------------------------------------------------

test('reconcile issues a warning when the ledger file is corrupt', (t) => {
  const dir = createTempDir('ledger-reconcile-corrupt-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), '<<<not json>>>');

  const result = reconcile(dir);
  assert.equal(result.orphans.length, 0, 'no orphans for unreadable ledger');
  assert.ok(result.warnings.length > 0, 'must emit at least one warning');
  assert.ok(
    result.warnings[0].includes('could not be parsed') || result.warnings[0].includes(dir),
    'warning must reference the ledger file or describe the parse failure',
  );
});

// ---------------------------------------------------------------------------
// Finding 5 (LOW): read-only reconcile() must detect a DANGLING-SYMLINK ledger via lstat,
// not existsSync. existsSync follows the symlink → returns false for a broken symlink →
// reports the ledger "missing" (no warning) when it is actually an unreadable IO problem.
// ---------------------------------------------------------------------------

test('finding-5: reconcile() WARNS for a dangling-symlink ledger (lstat, not existsSync)', (t) => {
  const dir = createTempDir('ledger-reconcile-dangling-');
  t.after(() => cleanup(dir));

  // Create the ledger path as a symlink to a non-existent target (dangling/broken symlink).
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  const missingTarget = path.join(dir, 'does-not-exist-target.json');
  try {
    fs.symlinkSync(missingTarget, ledgerPath);
  } catch (err) {
    // Some CI filesystems (e.g. restrictive Windows) cannot create symlinks; skip cleanly.
    if (err && (err.code === 'EPERM' || err.code === 'ENOSYS')) {
      t.skip('symlink creation not permitted on this filesystem');
      return;
    }
    throw err;
  }

  const result = reconcile(dir);
  // UNCONDITIONAL: a dangling-symlink ledger entry must NOT be silently treated as "missing".
  assert.equal(result.orphans.length, 0, 'no orphans for an unreadable ledger');
  assert.ok(result.warnings.length > 0,
    'reconcile() must emit a warning for a dangling-symlink ledger (lstat detects the entry; ' +
    'existsSync would follow the broken link and report it missing with NO warning)');
});

// ---------------------------------------------------------------------------
// fs fault-injection — writeLedger now uses local atomic write (tmp+rename, no
// truncating fallback). A renameSync failure propagates as an error (LEDGER-2).
// ---------------------------------------------------------------------------

test('writeLedger throws when renameSync fails (no silent truncating fallback, LEDGER-2)', (t) => {
  const dir = createTempDir('ledger-fault-');
  t.after(() => cleanup(dir));

  let renameCalls = 0;

  const renameMock = mock.method(fs, 'renameSync', (_src, _dest) => {
    renameCalls++;
    // Simulate a cross-device rename failure.
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  const ledger = makeLedger({
    entries: { 'fault-cap': makeEntry('fault-cap') },
  });

  // The new writeLedger has no truncating fallback — it must throw on renameSync
  // failure rather than silently writing a potentially corrupt direct file.
  assert.throws(
    () => writeLedger(dir, ledger),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.code === 'EXDEV' || err.message.includes('EXDEV'),
        `expected EXDEV error; got: ${err.message}`);
      return true;
    },
    'writeLedger must propagate renameSync errors (no truncating fallback)',
  );

  assert.ok(renameCalls >= 1, 'renameSync must have been invoked');

  // No ledger file must exist (write was rejected) — the real ledger is safe.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  assert.equal(
    fs.existsSync(ledgerPath),
    false,
    'no ledger file must be written when renameSync fails',
  );

  // Any .tmp file must NOT remain as an orphan (finding 18).
  // writeLedger's try/catch around renameSync unlinks the temp file before rethrowing,
  // so no orphan is left behind — this is an enforced invariant, not merely acceptable.
  const orphansAfterRename = fs.readdirSync(dir).filter((n) => n.includes('.tmp.') || n.includes('.tmp-'));
  assert.deepEqual(orphansAfterRename, [], `no orphan tmp file must remain after renameSync failure; found: ${orphansAfterRename.join(', ')}`);
});

// ---------------------------------------------------------------------------
// LEDGER-1 regression: recordInstall on corrupt-but-present ledger must throw
// and leave the corrupt file IN PLACE (no quarantine/move — finding 1, core redesign).
// ---------------------------------------------------------------------------

test('recordInstall throws on a corrupt-but-present ledger and leaves the file IN PLACE (LEDGER-1 / finding-1)', (t) => {
  const dir = createTempDir('ledger-corrupt-guard-');
  t.after(() => cleanup(dir));

  // 1. Write a valid ledger with entry "A".
  const entryA = makeEntry('cap-a', {
    files: ['commands/gsd/cap-a.md'],
    sharedEdits: [{ file: 'settings.json', marker: 'cap-a' }],
  });
  recordInstall(dir, entryA);

  // 2. Corrupt the ledger file on disk.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  const corruptContent = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corruptContent);

  // 3. Attempting recordInstall for "B" must throw (not silently overwrite).
  assert.throws(
    () => recordInstall(dir, makeEntry('cap-b')),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error instance');
      assert.ok(
        err.message.includes('corrupt') || err.message.includes(ledgerPath),
        `error message must mention corruption or the path; got: ${err.message}`,
      );
      return true;
    },
    'recordInstall must throw when the ledger file is present but corrupt',
  );

  // 4. The corrupt file must still be at its ORIGINAL PATH (not moved/renamed/quarantined).
  //    This is the key invariant: leaving it in place means every subsequent op also blocks
  //    until the user resolves it (finding 1 — no "succeeds fresh on 2nd run").
  assert.ok(fs.existsSync(ledgerPath),
    'the corrupt ledger file must remain at its original path (not moved/quarantined)');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), corruptContent,
    'the corrupt content must be intact (file not altered)');

  // 5. No quarantine files must exist (no auto-move behavior).
  const dirContents = fs.readdirSync(dir);
  const quarantineFiles = dirContents.filter((n) => n.includes(LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.deepEqual(quarantineFiles, [],
    `no quarantine files must exist; dir contents: ${dirContents.join(', ')}`);

  // 6. A SECOND recordInstall attempt must ALSO throw (not silently succeed on fresh state).
  //    This proves finding 1 is fixed: repeated ops keep blocking.
  assert.throws(
    () => recordInstall(dir, makeEntry('cap-c')),
    (err) => err instanceof Error && (err.message.includes('corrupt') || err.message.includes(ledgerPath)),
    'second recordInstall must also throw — the corrupt file blocks persistently',
  );
});

// ---------------------------------------------------------------------------
// LEDGER-1 regression: recordInstall on a MISSING ledger still creates a fresh one
// ---------------------------------------------------------------------------

test('recordInstall on a genuinely missing ledger creates a fresh ledger and succeeds (LEDGER-1 non-regression)', (t) => {
  const dir = createTempDir('ledger-missing-fresh-');
  t.after(() => cleanup(dir));

  // No ledger file exists yet.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  assert.equal(fs.existsSync(ledgerPath), false, 'pre-condition: no ledger file');

  // recordInstall must succeed and create a fresh ledger.
  assert.doesNotThrow(
    () => recordInstall(dir, makeEntry('cap-fresh', { files: ['commands/gsd/cap-fresh.md'] })),
    'recordInstall must not throw for a missing ledger',
  );

  const ledger = readLedger(dir);
  assert.ok(ledger !== null, 'ledger must exist after first recordInstall');
  assert.ok('cap-fresh' in ledger.entries, 'cap-fresh entry must be present');
});

// ---------------------------------------------------------------------------
// Finding 1 (persistence): corrupt-present ledger blocks ALL subsequent operations,
// not just the first one. The file stays in place so no "succeeds fresh on 2nd run".
// ---------------------------------------------------------------------------

test('recordInstall: corrupt-present ledger blocks ALL subsequent calls persistently (finding-1 persistence)', (t) => {
  const dir = createTempDir('ledger-persistent-block-');
  t.after(() => cleanup(dir));

  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  const corruptContent = '{ broken json ---';
  fs.writeFileSync(ledgerPath, corruptContent);

  // Every successive call must throw with the same corruption message.
  for (let i = 0; i < 3; i++) {
    assert.throws(
      () => recordInstall(dir, makeEntry(`cap-${i}`)),
      (err) => err instanceof Error && (err.message.includes('corrupt') || err.message.includes(ledgerPath)),
      `call ${i + 1} must also throw — corrupt file blocks persistently`,
    );
  }

  // The file must still be at its original path and content after all throws.
  assert.ok(fs.existsSync(ledgerPath), 'corrupt file must remain in place after repeated throws');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), corruptContent, 'content unchanged');

  // No quarantine files must exist.
  const quarantineFiles = fs.readdirSync(dir).filter((n) => n.includes(LEDGER_FILE_NAME) && n.includes('.corrupt.'));
  assert.deepEqual(quarantineFiles, [], 'no auto-quarantine files must exist');
});

// ---------------------------------------------------------------------------
// Finding 2 (non-destructive): multiple corrupt-ledger calls across different
// dirs each block and leave the original file intact (no move/rename/delete).
// ---------------------------------------------------------------------------

test('recordInstall: two corrupt-ledger calls produce distinct errors but leave each corrupt file in place (non-destructive)', (t) => {
  const dirA = createTempDir('ledger-nd-a-');
  const dirB = createTempDir('ledger-nd-b-');
  t.after(() => { cleanup(dirA); cleanup(dirB); });

  const corruptA = '{ broken json --- A';
  const corruptB = '{ broken json --- B';
  fs.writeFileSync(path.join(dirA, LEDGER_FILE_NAME), corruptA);
  fs.writeFileSync(path.join(dirB, LEDGER_FILE_NAME), corruptB);

  let errA, errB;
  try { recordInstall(dirA, makeEntry('a')); } catch (e) { errA = e; }
  try { recordInstall(dirB, makeEntry('b')); } catch (e) { errB = e; }

  assert.ok(errA instanceof Error, 'call A must throw');
  assert.ok(errB instanceof Error, 'call B must throw');

  // Both original corrupt files must still exist with their original content.
  assert.equal(fs.readFileSync(path.join(dirA, LEDGER_FILE_NAME), 'utf8'), corruptA,
    'dirA corrupt file must remain intact');
  assert.equal(fs.readFileSync(path.join(dirB, LEDGER_FILE_NAME), 'utf8'), corruptB,
    'dirB corrupt file must remain intact');

  // No quarantine files in either dir.
  assert.deepEqual(
    fs.readdirSync(dirA).filter((n) => n.includes('.corrupt.')), [],
    'no quarantine files in dirA',
  );
  assert.deepEqual(
    fs.readdirSync(dirB).filter((n) => n.includes('.corrupt.')), [],
    'no quarantine files in dirB',
  );
});

// ---------------------------------------------------------------------------
// Finding 3: writeLedger tmp path must use exclusive create (O_EXCL / wx) so
// a pre-existing symlink at the tmp path cannot redirect the write.
//
// Scope note (test-quality): this test verifies the MECHANISM — that writeLedger
// opens the tmp file with an exclusive flag (wx / O_EXCL) and writes the ledger
// without clobbering a file outside the dir. It does NOT plant a symlink; the
// actual pre-planted-symlink-throws behavior is covered by the finding-15 test
// just below (which forces a known nonce and a real symlink at the tmp path).
// (Renamed from a misleading "...causes a throw" title that asserted only the flag.)
// ---------------------------------------------------------------------------

test('writeLedger opens the tmp file with an exclusive flag (wx / O_EXCL) and does not clobber an outside file (finding-3)', (t) => {
  const dir = createTempDir('ledger-excl-');
  const outside = createTempDir('ledger-excl-outside-');
  t.after(() => { cleanup(dir); cleanup(outside); });

  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'precious', 'utf8');

  // Intercept openSync to capture flags used for tmp files.
  // We use a wrapper that delegates to the real openSync.
  const realOpenSync = fs.openSync.bind(fs);
  let sawExclusiveFlag = false;
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (typeof flags === 'string' && flags.includes('x')) sawExclusiveFlag = true;
    if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) sawExclusiveFlag = true;
    return realOpenSync(p, flags, ...rest);
  });
  t.after(() => openMock.mock.restore());

  writeLedger(dir, makeLedger());
  assert.ok(sawExclusiveFlag, 'writeLedger must open the tmp file with an exclusive flag (wx / O_EXCL)');

  // The real ledger must exist and be valid.
  const back = readLedger(dir);
  assert.ok(back !== null, 'ledger must be written successfully');

  // victim.txt must be untouched.
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious', 'victim outside dir must not be clobbered');
});

// ---------------------------------------------------------------------------
// Finding 15: writeLedger: pre-existing symlink at known tmp path causes throw.
// This test is made REAL by intercepting crypto.randomBytes to force a known
// nonce and openSync to throw EEXIST for that specific tmp path (simulating a
// pre-planted symlink), verifying O_EXCL defense works.
// ---------------------------------------------------------------------------

test('writeLedger: O_EXCL prevents write through a pre-planted symlink at the tmp path (finding-15)', (t) => {
  const dir = createTempDir('ledger-symlink-excl-');
  const outside = createTempDir('ledger-symlink-outside-');
  t.after(() => { cleanup(dir); cleanup(outside); });

  const ledgerFilePath = path.join(dir, LEDGER_FILE_NAME);
  const knownNonce = 'deadbeef';
  const tmpPath = `${ledgerFilePath}.tmp.${process.pid}-${knownNonce}`;
  const victimFile = path.join(outside, 'victim.txt');
  fs.writeFileSync(victimFile, 'precious', 'utf8');

  // Pre-plant a symlink at the exact tmp path pointing to our victim.
  fs.symlinkSync(victimFile, tmpPath);

  // Mock randomBytes to return the known nonce so we know exactly what tmp path
  // writeLedger will compute (finding 15: make the test non-vacuous).
  const crypto = require('node:crypto');
  const randomBytesMock = mock.method(crypto, 'randomBytes', (_n) => {
    return Buffer.from(knownNonce, 'hex');
  });
  t.after(() => randomBytesMock.mock.restore());

  // writeLedger must throw because openSync with 'wx' (O_EXCL) fails on the symlink.
  assert.throws(
    () => writeLedger(dir, makeLedger()),
    (err) => {
      // EEXIST is thrown by open(O_EXCL) when the path already exists.
      assert.ok(err instanceof Error);
      assert.ok(err.code === 'EEXIST', `expected EEXIST; got: ${err.code}`);
      return true;
    },
    'writeLedger must throw EEXIST when a symlink pre-exists at the tmp path (O_EXCL defense)',
  );

  // The victim file must be intact — the symlink was NOT followed for writing.
  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'precious', 'victim file must not be clobbered');
  // The ledger must NOT have been written.
  assert.equal(fs.existsSync(ledgerFilePath), false, 'ledger must not exist after the throw');
});

// ---------------------------------------------------------------------------
// Finding 4: writeLedger cleans up the tmp file when renameSync fails
// (no orphan .tmp file left behind after a rename error).
// ---------------------------------------------------------------------------

test('writeLedger cleans up the tmp file when renameSync fails (finding-4)', (t) => {
  const dir = createTempDir('ledger-orphan-');
  t.after(() => cleanup(dir));

  // Mock renameSync to fail with EXDEV (after the tmp write has already succeeded).
  const renameMock = mock.method(fs, 'renameSync', (_src, _dest) => {
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  });
  t.after(() => renameMock.mock.restore());

  const ledger = makeLedger({ entries: { 'orphan-cap': makeEntry('orphan-cap') } });

  // writeLedger must throw (propagate the rename error).
  assert.throws(
    () => writeLedger(dir, ledger),
    (err) => err.code === 'EXDEV' || err.message.includes('EXDEV'),
    'writeLedger must rethrow after cleanup',
  );

  // No orphan .tmp file must remain.
  const orphans = fs.readdirSync(dir).filter((n) => n.includes('.tmp.') || n.includes('.tmp-'));
  assert.deepEqual(orphans, [], `no orphan tmp file must remain; found: ${orphans.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Issue 1 (HIGH): readLedger must deeply validate files[] and sharedEdits[] members.
// A ledger with wrong-shape members must be treated as corrupt (readLedger → null,
// readLedgerStrict → quarantine+throw), so upgradeCapability/removeCapability never
// reach prior.sharedEdits.map() with non-object members.
// ---------------------------------------------------------------------------

test('readLedger returns null when files[] contains a non-string member (deep validation)', (t) => {
  const dir = createTempDir('ledger-deep-files-');
  t.after(() => cleanup(dir));

  const ledger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'bad-cap': {
        id: 'bad-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-x',
        files: [123],  // non-string member — must fail deep validation
        sharedEdits: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify(ledger, null, 2));

  const result = readLedger(dir);
  assert.equal(result, null, 'readLedger must return null when files[] has a non-string member');
});

test('readLedger returns null when sharedEdits[] contains null (deep validation)', (t) => {
  const dir = createTempDir('ledger-deep-edits-null-');
  t.after(() => cleanup(dir));

  const ledger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'bad-cap': {
        id: 'bad-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-x',
        files: [],
        sharedEdits: [null],  // null member — must fail deep validation
      },
    },
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify(ledger, null, 2));

  const result = readLedger(dir);
  assert.equal(result, null, 'readLedger must return null when sharedEdits[] contains null');
});

test('readLedger returns null when sharedEdits[] member is missing required string fields (deep validation)', (t) => {
  const dir = createTempDir('ledger-deep-edits-shape-');
  t.after(() => cleanup(dir));

  const ledger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'bad-cap': {
        id: 'bad-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-x',
        files: [],
        sharedEdits: [{ file: 'settings.json' }],  // missing 'marker' field
      },
    },
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify(ledger, null, 2));

  const result = readLedger(dir);
  assert.equal(result, null, 'readLedger must return null when sharedEdits[] member lacks required fields');
});

test('readLedger returns null when sharedEdits[] member has non-string file field (deep validation)', (t) => {
  const dir = createTempDir('ledger-deep-edits-nonstr-');
  t.after(() => cleanup(dir));

  const ledger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'bad-cap': {
        id: 'bad-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-x',
        files: [],
        sharedEdits: [{ file: 42, marker: 'GSD cap-bad' }],  // non-string file field
      },
    },
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify(ledger, null, 2));

  const result = readLedger(dir);
  assert.equal(result, null, 'readLedger must return null when sharedEdits[] member has non-string file');
});

test('readLedger still accepts a valid ledger with populated files[] and sharedEdits[] (deep validation non-regression)', (t) => {
  const dir = createTempDir('ledger-deep-valid-');
  t.after(() => cleanup(dir));

  const ledger = {
    version: '1',
    updatedAt: new Date().toISOString(),
    entries: {
      'good-cap': {
        id: 'good-cap', version: '1.0.0', source: 'registry:test', integrity: 'sha256-x',
        files: ['commands/gsd/good-cap.md'],
        // marker is a non-empty string (finding-5: relaxed — need not match the entry key)
        sharedEdits: [{ file: 'settings.json', marker: 'good-cap' }],
      },
    },
  };
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify(ledger, null, 2));

  const result = readLedger(dir);
  assert.ok(result !== null, 'readLedger must accept a valid ledger with populated arrays');
  assert.ok('good-cap' in result.entries);
});

// ---------------------------------------------------------------------------
// Issue 2 (MEDIUM): writeLedger must clean up the orphan tmp file when the full
// write call (fs.writeFileSync on the fd) fails — not just when renameSync fails.
// ---------------------------------------------------------------------------

test('writeLedger cleans up the tmp file when the write to the fd fails (issue-2)', (t) => {
  const dir = createTempDir('ledger-writesync-fail-');
  t.after(() => cleanup(dir));

  // writeLedger now uses fs.writeFileSync(fd, content) which is a full-buffer write.
  // Mock writeFileSync to throw when called with a number fd (the tmp file fd).
  const realWriteFileSync = fs.writeFileSync.bind(fs);
  const writeFileSyncMock = mock.method(fs, 'writeFileSync', function (fdOrPath, content, ...rest) {
    if (typeof fdOrPath === 'number') {
      // This is the fd-based write inside writeLedger — simulate ENOSPC.
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    return realWriteFileSync(fdOrPath, content, ...rest);
  });
  t.after(() => writeFileSyncMock.mock.restore());

  const ledger = makeLedger({ entries: { 'ws-cap': makeEntry('ws-cap') } });

  // writeLedger must throw.
  assert.throws(
    () => writeLedger(dir, ledger),
    (err) => err.code === 'ENOSPC' || err.message.includes('ENOSPC'),
    'writeLedger must rethrow write errors',
  );

  // No orphan .tmp file must remain after the failure.
  const orphans = fs.readdirSync(dir).filter((n) => n.includes('.tmp.') || n.includes('.tmp-'));
  assert.deepEqual(orphans, [], `no orphan tmp file must remain after write failure; found: ${orphans.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Issue 3 (redesigned): readLedgerStrict on a corrupt ledger leaves the file
// IN PLACE (non-destructive) and throws CorruptLedgerError with the ledgerPath.
// Multiple calls all throw with the same path (persistent blocking).
// ---------------------------------------------------------------------------

test('readLedgerStrict: corrupt ledger is left in place and throws CorruptLedgerError with ledgerPath (issue-3)', (t) => {
  const dir = createTempDir('ledger-strict-inplace-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  const corruptContent = '{ broken json --- iteration 1';
  fs.writeFileSync(ledgerPath, corruptContent);

  // First call: must throw CorruptLedgerError with the ledger path.
  try {
    readLedgerStrict(dir);
    assert.fail('readLedgerStrict must throw on corrupt ledger');
  } catch (err) {
    assert.ok(err instanceof CorruptLedgerError, 'must be CorruptLedgerError');
    assert.ok(err.ledgerPath, 'must have ledgerPath property');
    assert.ok(err.message.includes('corrupt') || err.message.includes(ledgerPath),
      `message must mention corruption or the path; got: ${err.message}`);
  }

  // The original file must still be at its original path and content.
  assert.ok(fs.existsSync(ledgerPath), 'corrupt file must remain in place');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), corruptContent, 'content unchanged');

  // No quarantine files must have been created.
  const dirContents = fs.readdirSync(dir);
  assert.deepEqual(
    dirContents.filter((n) => n.includes('.corrupt.')), [],
    `no quarantine files must exist; dir: ${dirContents.join(', ')}`,
  );

  // Second call: must ALSO throw — not silently succeed (persistent blocking).
  assert.throws(
    () => readLedgerStrict(dir),
    (err) => err instanceof CorruptLedgerError,
    'second readLedgerStrict must also throw — file still in place',
  );
});

// ---------------------------------------------------------------------------
// Finding 11: tightened schema validation (version='1' required, key===id,
// unsafe keys rejected, sharedEdits[].marker must match entry id).
// ---------------------------------------------------------------------------

test('readLedger returns null when schema version is not the expected value (finding-11)', (t) => {
  const dir = createTempDir('ledger-ver-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '2', updatedAt: new Date().toISOString(), entries: {},
  }));
  assert.equal(readLedger(dir), null, 'must reject a non-expected version string');
});

test('readLedger returns null when entry key does not match entry.id (finding-11)', (t) => {
  const dir = createTempDir('ledger-key-id-mismatch-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'cap-a': { id: 'cap-b', version: '1.0.0', source: 's', integrity: 'x', files: [], sharedEdits: [] },
    },
  }));
  assert.equal(readLedger(dir), null, 'must reject entry where key != id');
});

test('readLedger returns null when entry key is an unsafe prototype-pollution key (finding-11)', (t) => {
  const dir = createTempDir('ledger-unsafe-key-');
  t.after(() => cleanup(dir));
  // We cannot produce a JSON object with literal __proto__ key via JSON.stringify due to
  // browser quirks, but we CAN produce one via JSON.parse (which bypasses the setter):
  const raw = '{"version":"1","updatedAt":"2026-01-01T00:00:00.000Z","entries":{"__proto__":{"id":"__proto__","version":"1","source":"s","integrity":"x","files":[],"sharedEdits":[]}}}';
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), raw);
  assert.equal(readLedger(dir), null, 'must reject a ledger with an unsafe key like __proto__');
});

test('readLedger ACCEPTS sharedEdits[].marker !== entry id (finding-5: over-strict check reverted, finding-11 update)', (t) => {
  const dir = createTempDir('ledger-marker-mismatch-');
  t.after(() => cleanup(dir));
  // Finding-5: requiring marker === id was over-strict and diverged from the loader, risking
  // false-corrupt lockout. The validation now only requires marker to be a non-empty string.
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'my-cap': {
        id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [],
        sharedEdits: [{ file: 'settings.json', marker: 'WRONG-marker' }],
      },
    },
  }));
  const result = readLedger(dir);
  assert.ok(result !== null,
    'must ACCEPT sharedEdits[].marker !== entry id (finding-5: relaxed — only requires non-empty string)');
});

test('readLedger returns null when _pending has an invalid kind (finding-11)', (t) => {
  const dir = createTempDir('ledger-pending-kind-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'my-cap': {
        id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [], sharedEdits: [],
        _pending: { kind: 'unknown-kind', backupName: null, sharedFiles: [] },
      },
    },
  }));
  assert.equal(readLedger(dir), null, 'must reject entry with invalid _pending.kind');
});

// ---------------------------------------------------------------------------
// Finding 12: IO errors (EACCES/EISDIR/EPERM) must produce a CorruptLedgerError
// with the original OS message, not be silently swallowed as corruption.
// ---------------------------------------------------------------------------

test('readLedgerStrict: a ledger file that cannot be read (EISDIR) throws LedgerIOError (not CorruptLedgerError) with the OS message (finding-12/finding-4)', (t) => {
  const dir = createTempDir('ledger-ioerr-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;

  // Create a DIRECTORY at the ledger path — readFileSync will throw EISDIR.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  fs.mkdirSync(ledgerPath); // this IS the directory

  // Finding 4: IO errors (EISDIR, EACCES, EPERM) must surface as LedgerIOError,
  // NOT as CorruptLedgerError — they are a permissions/IO problem, not content corruption.
  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      // Must be LedgerIOError (IO problem, not content corruption).
      assert.ok(
        LedgerIOError !== undefined && err instanceof LedgerIOError,
        `must be LedgerIOError; got: ${err?.constructor?.name}`,
      );
      assert.ok(!(err instanceof CorruptLedgerError),
        'must NOT be CorruptLedgerError for an IO error');
      // The message must contain an OS-level description.
      assert.ok(
        err.message.includes('EISDIR') || err.message.includes('unreadable') || err.message.includes('Cannot read'),
        `message must mention IO error; got: ${err.message}`,
      );
      return true;
    },
    'readLedgerStrict must throw LedgerIOError with OS message for an EISDIR error',
  );
});

// ---------------------------------------------------------------------------
// ADR-1244 D4 (adversarial re-review): a ledger whose files[] contains hostile members
// (non-string like { toString: null }, "..", absolute) must FAIL CLOSED and never become
// an existence-oracle for paths outside runtimeDir.
//
// CURRENT BEHAVIOR (corrected — the prior assertion was VACUOUS): isValidLedgerEntry now
// rejects a non-string files[] member, so readLedger (which validates every entry) returns
// NULL for this ledger. reconcile therefore reports the file as "exists but could not be
// parsed" and NEVER reaches its per-member hostile-path loop. The op fails closed: no
// orphans, no oracle, and the warning names a parse failure. (The previous test claimed
// "reconcile skips hostile members" but readLedger rejected the ledger BEFORE the loop, so
// the per-member skip branch was never exercised — vacuous.)
test('reconcile fails closed on a hostile-files[] ledger: readLedger rejects it → parse warning, no oracle, no orphans', () => {
  const dir = createTempDir('gsd-ledger-hostile-');
  try {
    // Hand-write a ledger whose files[] contains hostile members (a non-string forces rejection).
    const ledger = {
      version: '1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: {
        evil: {
          id: 'evil', version: '1.0.0', source: 'overlay-global', integrity: 'x',
          files: [{ toString: null, valueOf: null }, '../../../etc/passwd', '/etc/shadow', '', 123],
          sharedEdits: [],
        },
      },
    };
    writeLedger(dir, ledger);

    // readLedger must REJECT this ledger (the non-string member fails isValidLedgerEntry).
    assert.strictEqual(readLedger(dir), null,
      'a ledger with a non-string files[] member must be rejected by readLedger (fail closed)');

    let result;
    assert.doesNotThrow(() => { result = reconcile(dir); }, 'reconcile must not throw');
    // Because readLedger rejected it, reconcile reports a parse failure for the present-but-invalid
    // file — NOT the per-member "invalid file path; skipped" warning (that loop is never reached).
    assert.ok(
      result.warnings.some((w) => /could not be parsed/.test(w)),
      `reconcile must warn the present ledger could not be parsed; got: ${JSON.stringify(result.warnings)}`,
    );
    // CRITICAL: no hostile member is ever treated as a real file, and nothing leaks as an orphan
    // (no existence-oracle for "../../../etc/passwd" or "/etc/shadow").
    assert.deepEqual(result.orphans, [], 'no hostile member may become a real (missing) file / oracle');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Finding 1 (CRITICAL): reconcileCapabilities must RETURN IMMEDIATELY on corrupt
// ledger — no filesystem mutations (no backup sweep, no staging cleanup).
// ---------------------------------------------------------------------------

test('finding-1: reconcile with corrupt ledger + backup dir → backup still exists (no filesystem mutation)', (t) => {
  const dir = createTempDir('ledger-f1-reconcile-corrupt-');
  t.after(() => cleanup(dir));

  // Create a backup dir that reconcile would normally sweep.
  const capRoot = path.join(dir, '.gsd', 'capabilities');
  fs.mkdirSync(capRoot, { recursive: true });
  const backupDir = path.join(capRoot, 'mycap.upgrading-999-111');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'capability.json'), '{"id":"mycap"}', 'utf8');

  // Write a corrupt ledger file.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  fs.writeFileSync(ledgerPath, '{ broken json ---');

  // Must not throw. Use the lifecycle module which wraps reconcileCapabilities.
  const lifecycle = require('../gsd-core/bin/lib/capability-lifecycle.cjs');
  let report;
  assert.doesNotThrow(
    () => { report = lifecycle.reconcileCapabilities({ runtimeDir: dir }); },
    'reconcileCapabilities must not throw on a corrupt ledger',
  );

  // The warning must be present.
  assert.ok(report.warnings.length > 0, 'must surface a warning for corrupt ledger');

  // CRITICAL: the backup dir must NOT have been deleted.
  assert.ok(
    fs.existsSync(backupDir),
    'backup dir must still exist — reconcile must not mutate when ledger is corrupt',
  );

  // The corrupt file must be in place.
  assert.ok(fs.existsSync(ledgerPath), 'corrupt ledger must remain in place');
});

// ---------------------------------------------------------------------------
// Finding 2 (HIGH): writeLedger — closeSync EIO → throw, no orphan temp, no rename.
// ---------------------------------------------------------------------------

test('finding-2: writeLedger throws when closeSync fails (EIO) and leaves no orphan temp, original unchanged', (t) => {
  const dir = createTempDir('ledger-f2-close-eio-');
  t.after(() => cleanup(dir));

  // Write a valid ledger first so we can verify the original is unchanged.
  writeLedger(dir, makeLedger({ entries: { 'orig-cap': makeEntry('orig-cap') } }));
  const origContent = fs.readFileSync(path.join(dir, LEDGER_FILE_NAME), 'utf8');

  // Mock closeSync to throw EIO once (for the tmp-fd call from writeLedger).
  let closeCalls = 0;
  const realCloseSync = fs.closeSync.bind(fs);
  const closeMock = mock.method(fs, 'closeSync', function (fd, ...rest) {
    closeCalls++;
    if (closeCalls === 1) {
      // Simulate a delayed-writeback failure on first close (the tmp file fd).
      const err = new Error('EIO: i/o error');
      err.code = 'EIO';
      throw err;
    }
    return realCloseSync(fd, ...rest);
  });
  t.after(() => closeMock.mock.restore());

  // writeLedger must throw (the close error surfaces).
  assert.throws(
    () => writeLedger(dir, makeLedger({ entries: { 'new-cap': makeEntry('new-cap') } })),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.code === 'EIO' || err.message.includes('EIO'),
        `expected EIO error; got: ${err.message}`);
      return true;
    },
    'writeLedger must throw when closeSync fails with EIO',
  );

  // No orphan tmp file must remain.
  const orphans = orphanTmpFiles(dir);
  assert.deepEqual(orphans, [], `no orphan tmp file after EIO close; found: ${orphans.join(', ')}`);

  // Original ledger must be unchanged.
  const nowContent = fs.readFileSync(path.join(dir, LEDGER_FILE_NAME), 'utf8');
  assert.equal(nowContent, origContent, 'original ledger must not be modified when closeSync fails');
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM): LedgerIOError must be exported; EISDIR must throw
// LedgerIOError (not CorruptLedgerError) from readLedgerStrict.
// ---------------------------------------------------------------------------

test('finding-4: LedgerIOError is exported from capability-ledger', () => {
  assert.ok(LedgerIOError !== undefined, 'LedgerIOError must be exported');
  // Verify it is a constructor (class).
  const e = new LedgerIOError('test', 'EACCES');
  assert.ok(e instanceof Error, 'LedgerIOError must be an Error subclass');
  assert.equal(e.name, 'LedgerIOError');
  assert.equal(e.code, 'EACCES');
});

test('finding-4: readLedgerStrict throws LedgerIOError (not CorruptLedgerError) for EISDIR (IO error, not corrupt)', (t) => {
  const dir = createTempDir('ledger-f4-eisdir-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;

  // Create a DIRECTORY at the ledger path — readFileSync will throw EISDIR.
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  fs.mkdirSync(ledgerPath);

  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      // Must be LedgerIOError, not CorruptLedgerError.
      assert.ok(err instanceof LedgerIOError,
        `must throw LedgerIOError for EISDIR; got: ${err?.constructor?.name}`);
      assert.ok(!(err instanceof CorruptLedgerError),
        'must NOT be CorruptLedgerError for an IO error');
      assert.ok(
        err.code === 'EISDIR' || err.message.includes('EISDIR') || err.message.includes('unreadable'),
        `message must mention IO error; got: ${err.message}`,
      );
      return true;
    },
    'readLedgerStrict must throw LedgerIOError with OS message for EISDIR',
  );
});

// ---------------------------------------------------------------------------
// Finding 5 (MEDIUM): sharedEdits[].marker !== id must be ACCEPTED (not corrupt).
// A member missing 'marker' (e.g. {file, path}) must be REJECTED.
// ---------------------------------------------------------------------------

test('finding-5: sharedEdits[].marker !== entry id is ACCEPTED (over-strict check reverted)', (t) => {
  const dir = createTempDir('ledger-f5-marker-accept-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'my-cap': {
        id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [],
        // marker is a non-empty string but NOT equal to 'my-cap'.
        sharedEdits: [{ file: 'settings.json', marker: 'some-other-id' }],
      },
    },
  }));

  const result = readLedger(dir);
  assert.ok(result !== null,
    'readLedger must ACCEPT a sharedEdits entry with marker !== entry id (finding-5: relaxed validation)');
  assert.ok('my-cap' in result.entries);
});

test('finding-5: sharedEdits[] member missing marker (e.g. {file, path}) is REJECTED', (t) => {
  const dir = createTempDir('ledger-f5-marker-reject-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'my-cap': {
        id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [],
        // old ADR shape — 'path' instead of 'marker' — no 'marker' key at all.
        sharedEdits: [{ file: 'settings.json', path: 'hooks.PostToolUse[0]' }],
      },
    },
  }));

  const result = readLedger(dir);
  assert.equal(result, null,
    'readLedger must REJECT a sharedEdits entry missing the marker field');
});

test('finding-5: sharedEdits[] member with non-string marker is REJECTED', (t) => {
  const dir = createTempDir('ledger-f5-marker-nonstr-');
  t.after(() => cleanup(dir));

  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'my-cap': {
        id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [],
        sharedEdits: [{ file: 'settings.json', marker: 42 }],
      },
    },
  }));

  const result = readLedger(dir);
  assert.equal(result, null,
    'readLedger must REJECT a sharedEdits entry with a non-string marker');
});

// ---------------------------------------------------------------------------
// Finding 6 (MEDIUM): isValidLedgerEntry exported from capability-ledger.
// ---------------------------------------------------------------------------

test('finding-6: isValidLedgerEntry is exported and validates entries correctly', () => {
  assert.ok(typeof isValidLedgerEntry === 'function',
    'isValidLedgerEntry must be exported as a function');

  // Valid entry.
  assert.equal(
    isValidLedgerEntry('my-cap', {
      id: 'my-cap', version: '1.0.0', source: 'registry:x', integrity: 'sha512-abc',
      files: ['commands/gsd/my-cap.md'],
      sharedEdits: [{ file: 'settings.json', marker: 'my-cap' }],
    }),
    true,
    'must return true for a valid entry',
  );

  // Wrong id.
  assert.equal(
    isValidLedgerEntry('other-cap', { id: 'my-cap', version: '1.0.0', source: 's', integrity: 'x', files: [], sharedEdits: [] }),
    false,
    'must return false when entry id does not match the key',
  );

  // Non-string file in files[].
  assert.equal(
    isValidLedgerEntry('bad', { id: 'bad', version: '1.0.0', source: 's', integrity: 'x', files: [123], sharedEdits: [] }),
    false,
    'must return false when files[] has a non-string member',
  );

  // sharedEdits member missing marker.
  assert.equal(
    isValidLedgerEntry('e', { id: 'e', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [{ file: 'f.json' }] }),
    false,
    'must return false when sharedEdits member is missing marker',
  );
});

// ---------------------------------------------------------------------------
// Finding 7 (LOW): recordInstall must validate id against VALID_ID_RE before
// writing — a non-kebab id must throw, not poison the ledger.
// ---------------------------------------------------------------------------

test('finding-7: recordInstall throws for a non-kebab id (e.g. "Bad Cap!") before writing', (t) => {
  const dir = createTempDir('ledger-f7-bad-id-');
  t.after(() => cleanup(dir));

  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
  assert.equal(fs.existsSync(ledgerPath), false, 'pre-condition: no ledger');

  assert.throws(
    () => recordInstall(dir, makeEntry('Bad Cap!')),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.ok(
        err.message.toLowerCase().includes('invalid') || err.message.includes('Bad Cap!'),
        `error must mention invalid id; got: ${err.message}`,
      );
      return true;
    },
    'recordInstall must throw for a non-kebab id',
  );

  // No ledger must have been written.
  assert.equal(fs.existsSync(ledgerPath), false, 'no ledger must be written for an invalid id');
});

test('finding-7: recordInstall throws for an id starting with a digit ("0cap")', (t) => {
  const dir = createTempDir('ledger-f7-digit-id-');
  t.after(() => cleanup(dir));

  assert.throws(
    () => recordInstall(dir, makeEntry('0cap')),
    (err) => err instanceof Error,
    'must throw for id starting with digit',
  );
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false,
    'no ledger written for invalid id starting with digit');
});

test('finding-7: recordInstall still succeeds for a valid kebab id ("my-cap-2")', (t) => {
  const dir = createTempDir('ledger-f7-valid-id-');
  t.after(() => cleanup(dir));

  assert.doesNotThrow(
    () => recordInstall(dir, makeEntry('my-cap-2')),
    'recordInstall must succeed for a valid kebab id',
  );
  const ledger = readLedger(dir);
  assert.ok(ledger !== null && 'my-cap-2' in ledger.entries);
});

// ---------------------------------------------------------------------------
// ROOT FIX 1: isValidLedgerEntry — single validator, matches readLedger exactly.
// Table-driven: same verdict from isValidLedgerEntry AND from readLedger round-trip.
// ---------------------------------------------------------------------------

test('root-fix-1: isValidLedgerEntry and readLedger round-trip give identical verdicts (single source of truth)', (t) => {
  const dir = createTempDir('ledger-rf1-parity-');
  t.after(() => cleanup(dir));

  const { CorruptLedgerError: _CLE } = capLedger;

  const cases = [
    // [description, id-key, entry-object, expectedValid]
    ['valid entry', 'good-cap', {
      id: 'good-cap', version: '1.0.0', source: 'reg:x', integrity: 'sha512-abc',
      files: ['commands/gsd/good-cap.md'],
      sharedEdits: [{ file: 'settings.json', marker: 'good-cap' }],
    }, true],
    ['valid entry with _pending', 'p-cap', {
      id: 'p-cap', version: '1.0.0', source: 's', integrity: 'x',
      files: [], sharedEdits: [],
      _pending: { kind: 'install', backupName: null, sharedFiles: [] },
    }, true],
    ['wrong id (key != entry.id)', 'cap-a', {
      id: 'cap-b', version: '1.0.0', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
    ['missing version', 'no-ver', {
      id: 'no-ver', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
    ['non-string in files[]', 'bad-files', {
      id: 'bad-files', version: '1', source: 's', integrity: 'x', files: [42], sharedEdits: [],
    }, false],
    ['missing marker in sharedEdits', 'no-marker', {
      id: 'no-marker', version: '1', source: 's', integrity: 'x', files: [],
      sharedEdits: [{ file: 'f.json' }],
    }, false],
    ['_pending with invalid kind', 'bad-pend', {
      id: 'bad-pend', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
      _pending: { kind: 'destroy', backupName: null, sharedFiles: [] },
    }, false],
    ['_pending with non-null/non-string backupName', 'pend-bn', {
      id: 'pend-bn', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
      _pending: { kind: 'upgrade', backupName: 123, sharedFiles: [] },
    }, false],
    ['unsafe id __proto__', '__proto__', {
      id: '__proto__', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
    ['unsafe id constructor', 'constructor', {
      id: 'constructor', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
    ['unsafe id prototype', 'prototype', {
      id: 'prototype', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
    ['invalid kebab id (starts with digit)', '0cap', {
      id: '0cap', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
    }, false],
  ];

  for (const [desc, key, entry, expected] of cases) {
    // Check isValidLedgerEntry directly.
    const fromValidator = isValidLedgerEntry(key, entry);
    assert.equal(fromValidator, expected,
      `isValidLedgerEntry: ${desc} → expected ${expected}, got ${fromValidator}`);

    // Skip round-trip test for entries with unsafe or invalid keys — writeLedger
    // / JSON round-trip cannot faithfully represent them.
    const isSafeKey = /^[a-z][a-z0-9-]*$/.test(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
    if (!isSafeKey) continue;

    // Write a synthetic ledger with this single entry and read it back.
    const ledgerRaw = JSON.stringify({
      version: '1',
      updatedAt: new Date().toISOString(),
      entries: { [key]: entry },
    });
    fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), ledgerRaw);
    const read = readLedger(dir);
    const fromRoundTrip = read !== null && key in read.entries;
    assert.equal(fromRoundTrip, expected,
      `readLedger round-trip: ${desc} → expected ${expected}, got ${fromRoundTrip}`);
  }
});

test('root-fix-1: isValidLedgerEntry rejects unsafe ids (prototype-safe, inline checks)', () => {
  assert.equal(isValidLedgerEntry('__proto__', { id: '__proto__', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }), false,
    '__proto__ id must be rejected by isValidLedgerEntry');
  assert.equal(isValidLedgerEntry('constructor', { id: 'constructor', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }), false,
    'constructor id must be rejected by isValidLedgerEntry');
  assert.equal(isValidLedgerEntry('prototype', { id: 'prototype', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }), false,
    'prototype id must be rejected by isValidLedgerEntry');
  assert.equal(isValidLedgerEntry('0starts-digit', { id: '0starts-digit', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }), false,
    'non-kebab id must be rejected by isValidLedgerEntry');
  // Valid id still passes.
  assert.equal(isValidLedgerEntry('valid-cap', { id: 'valid-cap', version: '1.0.0', source: 's', integrity: 'x', files: [], sharedEdits: [] }), true,
    'valid kebab id must still be accepted');
});

test('root-fix-1: isValidLedgerEntry validates _pending shape when present', () => {
  const base = { version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] };
  // Valid _pending with install kind.
  assert.equal(isValidLedgerEntry('cap', { id: 'cap', ...base, _pending: { kind: 'install', backupName: null, sharedFiles: [] } }), true);
  // Valid _pending with upgrade kind + backupName string.
  assert.equal(isValidLedgerEntry('cap', { id: 'cap', ...base, _pending: { kind: 'upgrade', backupName: 'cap.upgrading-1-2', sharedFiles: [] } }), true);
  // Invalid kind.
  assert.equal(isValidLedgerEntry('cap', { id: 'cap', ...base, _pending: { kind: 'delete', backupName: null, sharedFiles: [] } }), false);
  // Non-array sharedFiles.
  assert.equal(isValidLedgerEntry('cap', { id: 'cap', ...base, _pending: { kind: 'install', backupName: null, sharedFiles: 'x' } }), false);
  // Non-null/non-string backupName.
  assert.equal(isValidLedgerEntry('cap', { id: 'cap', ...base, _pending: { kind: 'upgrade', backupName: 42, sharedFiles: [] } }), false);
});

// ---------------------------------------------------------------------------
// ROOT FIX 3: isUnsafeCapabilityId exported; recordInstall THROWS (not silent)
// on unsafe ids. Tests for __proto__, constructor, prototype.
// ---------------------------------------------------------------------------

test('root-fix-3: recordInstall THROWS (not silently returns) for __proto__ id', (t) => {
  const dir = createTempDir('ledger-rf3-throw-proto-');
  t.after(() => cleanup(dir));

  assert.throws(
    () => recordInstall(dir, { id: '__proto__', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.ok(
        err.message.toLowerCase().includes('invalid') || err.message.includes('__proto__'),
        `error must mention invalid id; got: ${err.message}`,
      );
      return true;
    },
    'recordInstall must THROW for __proto__ id (not silently ignore)',
  );
  // No ledger must exist.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false);
});

test('root-fix-3: recordInstall THROWS for "constructor" and "prototype" ids', (t) => {
  const dir = createTempDir('ledger-rf3-throw-ctor-');
  t.after(() => cleanup(dir));

  assert.throws(
    () => recordInstall(dir, { id: 'constructor', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }),
    (err) => err instanceof Error,
    'must throw for constructor id',
  );
  assert.throws(
    () => recordInstall(dir, { id: 'prototype', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] }),
    (err) => err instanceof Error,
    'must throw for prototype id',
  );
});

// ---------------------------------------------------------------------------
// ROOT FIX 4: broken-symlink detection — readLedgerStrict and readLedger
// treat a dangling symlink as an IO failure, not as "missing" (lstat-based).
// ---------------------------------------------------------------------------

test('root-fix-4: readLedgerStrict throws LedgerIOError for a broken symlink at the ledger path', (t) => {
  const dir = createTempDir('ledger-rf4-symlink-strict-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);

  // Plant a dangling symlink (target does not exist).
  fs.symlinkSync('/nonexistent/target-that-does-not-exist', ledgerPath);

  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      // Must throw LedgerIOError (IO problem), not CorruptLedgerError (content problem),
      // and NOT silently return null (which would treat it as "missing").
      assert.ok(
        err instanceof LedgerIOError,
        `must throw LedgerIOError; got: ${err?.constructor?.name}: ${err?.message}`,
      );
      assert.ok(!(err instanceof CorruptLedgerError), 'must NOT be CorruptLedgerError');
      return true;
    },
    'readLedgerStrict must throw LedgerIOError for a dangling symlink (not treat as missing)',
  );
});

test('root-fix-4: reconcileCapabilities returns warning (no mutation) when ledger is a broken symlink', (t) => {
  const dir = createTempDir('ledger-rf4-symlink-reconcile-');
  t.after(() => cleanup(dir));

  const lifecycle = require('../gsd-core/bin/lib/capability-lifecycle.cjs');
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);

  // Create a backup that reconcile would normally sweep.
  const capRoot = path.join(dir, '.gsd', 'capabilities');
  fs.mkdirSync(capRoot, { recursive: true });
  const backupDir = path.join(capRoot, 'somecap.upgrading-111-222');
  fs.mkdirSync(backupDir);

  // Plant a dangling symlink (broken) at the ledger path.
  fs.symlinkSync('/nonexistent/absent-target', ledgerPath);

  let report;
  assert.doesNotThrow(
    () => { report = lifecycle.reconcileCapabilities({ runtimeDir: dir }); },
    'reconcileCapabilities must not throw on a broken-symlink ledger',
  );

  // Must warn — it's not "missing", it's an IO problem.
  assert.ok(report.warnings.length > 0,
    'must surface a warning when ledger is a broken symlink');

  // CRITICAL: the backup dir must NOT have been deleted (no mutation on IO error).
  assert.ok(fs.existsSync(backupDir),
    'backup dir must still exist — reconcile must not mutate when ledger is a broken symlink');
});

test('root-fix-4: installCapability blocks when ledger is a broken symlink (not treats as missing → fresh install)', async (t) => {
  const dir = createTempDir('ledger-rf4-symlink-install-');
  t.after(() => cleanup(dir));

  const lifecycle = require('../gsd-core/bin/lib/capability-lifecycle.cjs');
  const ledgerPath = path.join(dir, LEDGER_FILE_NAME);

  // Plant a dangling symlink at the ledger path.
  fs.symlinkSync('/nonexistent/absent-target', ledgerPath);

  // installCapability must block (fail closed), not silently proceed as a "fresh install".
  const result = await lifecycle.installCapability('./x', {
    runtimeDir: dir, hostVersion: '1.6.0',
    _resolve: async (spec, opts) => {
      const root = path.join(opts.gsdHome, '.gsd', 'capabilities', '.staging');
      fs.mkdirSync(root, { recursive: true });
      const staged = path.join(root, 'x-symlink-test');
      fs.mkdirSync(staged, { recursive: true });
      fs.writeFileSync(path.join(staged, 'capability.json'), JSON.stringify({
        id: 'x', role: 'feature', version: '1.0.0', title: 'x',
        description: 'x', tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
      }), 'utf8');
      return { id: 'x', version: '1.0.0', stagedDir: staged, integrity: null, source: spec };
    },
  });

  assert.strictEqual(result.status, 'blocked',
    `installCapability must be blocked by a broken-symlink ledger; got: ${result.status}`);
  assert.ok(result.blockReasons && result.blockReasons.length > 0, 'must have blockReasons');
});

// ---------------------------------------------------------------------------
// DUR-1 (HIGH): writeLedger must fsync the file fd BEFORE closeSync BEFORE
// renameSync, so a power-loss after a successful rename cannot leave a
// zero/partial ledger.
// Revert-fails: remove the fs.fsyncSync(fd) call → this test fails because the
// recorded call order no longer contains fsyncSync before closeSync.
// ---------------------------------------------------------------------------

test('DUR-1: writeLedger fsyncs the file fd before closeSync before renameSync (durable write order)', (t) => {
  const dir = createTempDir('ledger-dur1-order-');
  t.after(() => cleanup(dir));

  // Record the order of fsyncSync / closeSync / renameSync calls. We tag the file-fd fsync
  // distinctly from any directory fsync (DUR-2) by checking whether the fd belongs to the
  // tmp write (the first closeSync after a write is the tmp fd).
  const order = [];
  const realFsync = fs.fsyncSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const realRename = fs.renameSync.bind(fs);

  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd, ...rest) {
    order.push({ op: 'fsync', fd });
    return realFsync(fd, ...rest);
  });
  const closeMock = mock.method(fs, 'closeSync', function (fd, ...rest) {
    order.push({ op: 'close', fd });
    return realClose(fd, ...rest);
  });
  const renameMock = mock.method(fs, 'renameSync', function (src, dest, ...rest) {
    order.push({ op: 'rename' });
    return realRename(src, dest, ...rest);
  });
  t.after(() => { fsyncMock.mock.restore(); closeMock.mock.restore(); renameMock.mock.restore(); });

  writeLedger(dir, makeLedger({ entries: { 'dur-cap': makeEntry('dur-cap') } }));

  // There must be at least one fsync, one close, and one rename.
  const firstFsync = order.findIndex((e) => e.op === 'fsync');
  const firstClose = order.findIndex((e) => e.op === 'close');
  const firstRename = order.findIndex((e) => e.op === 'rename');
  assert.ok(firstFsync !== -1, 'writeLedger must call fsyncSync on the file fd');
  assert.ok(firstClose !== -1, 'writeLedger must call closeSync');
  assert.ok(firstRename !== -1, 'writeLedger must call renameSync');

  // The file fd fsync (and close) must both precede the rename.
  assert.ok(firstFsync < firstRename,
    `fsyncSync must be called before renameSync; order: ${JSON.stringify(order)}`);

  // The fsync of a given fd must precede the close of that SAME fd.
  const fileFd = order[firstFsync].fd;
  const closeOfSameFd = order.findIndex((e) => e.op === 'close' && e.fd === fileFd);
  assert.ok(closeOfSameFd !== -1, 'the fsynced fd must also be closed');
  assert.ok(firstFsync < closeOfSameFd,
    `fsyncSync(fd) must precede closeSync(fd); order: ${JSON.stringify(order)}`);
  assert.ok(closeOfSameFd < firstRename,
    `closeSync(fd) must precede renameSync; order: ${JSON.stringify(order)}`);

  // Ledger must be readable after the durable write.
  const read = readLedger(dir);
  assert.ok(read !== null && 'dur-cap' in read.entries, 'ledger must round-trip after durable write');
});

// DUR-1: when fsyncSync throws, writeLedger must unlink the temp + rethrow (treated as
// a write failure), never rename a possibly-unflushed file live and never orphan a temp.
// Revert-fails: drop the fsync try/catch-unlink-rethrow and a thrown fsync would
// fall through to rename — this test would see the live ledger overwritten and/or an
// orphan temp, failing the unchanged-original and no-orphan assertions.
test('DUR-1: writeLedger unlinks temp and rethrows when fsyncSync fails; no rename, original unchanged', (t) => {
  const dir = createTempDir('ledger-dur1-fsync-throw-');
  t.after(() => cleanup(dir));

  // Seed a valid original ledger we can prove is unchanged.
  writeLedger(dir, makeLedger({ entries: { 'orig-cap': makeEntry('orig-cap') } }));
  const origContent = fs.readFileSync(path.join(dir, LEDGER_FILE_NAME), 'utf8');

  let renameCalled = false;
  const realRename = fs.renameSync.bind(fs);
  const renameMock = mock.method(fs, 'renameSync', function (src, dest, ...rest) {
    renameCalled = true;
    return realRename(src, dest, ...rest);
  });
  // Make the FIRST fsyncSync (the file-fd fsync) throw EIO.
  let fsyncCalls = 0;
  const fsyncMock = mock.method(fs, 'fsyncSync', function () {
    fsyncCalls++;
    const err = new Error('EIO: i/o error on fsync');
    err.code = 'EIO';
    throw err;
  });
  t.after(() => { renameMock.mock.restore(); fsyncMock.mock.restore(); });

  assert.throws(
    () => writeLedger(dir, makeLedger({ entries: { 'new-cap': makeEntry('new-cap') } })),
    (err) => err.code === 'EIO' || err.message.includes('EIO'),
    'writeLedger must rethrow when fsyncSync fails',
  );

  assert.ok(fsyncCalls >= 1, 'fsyncSync must have been invoked');
  assert.equal(renameCalled, false, 'renameSync must NOT run after an fsync failure');

  // No orphan temp file must remain.
  const orphans = orphanTmpFiles(dir);
  assert.deepEqual(orphans, [], `no orphan tmp after fsync failure; found: ${orphans.join(', ')}`);

  // Original ledger must be unchanged.
  assert.equal(fs.readFileSync(path.join(dir, LEDGER_FILE_NAME), 'utf8'), origContent,
    'original ledger must be unchanged when fsyncSync fails');
});

// ---------------------------------------------------------------------------
// DUR-2 (MED): after the rename succeeds, writeLedger must fsync the CONTAINING
// directory so the rename itself is durable. EISDIR/EPERM on platforms that
// disallow dir fsync must be tolerated.
// Revert-fails: remove the directory-fsync block → no openSync(dirname,'r') is
// performed, so the asserted dir-open never happens and this test fails.
// ---------------------------------------------------------------------------

test('DUR-2: writeLedger fsyncs the containing directory after a successful rename', (t) => {
  const dir = createTempDir('ledger-dur2-dirfsync-');
  t.after(() => cleanup(dir));

  let dirOpened = false;
  let dirFsynced = false;
  const realOpen = fs.openSync.bind(fs);
  const realFsync = fs.fsyncSync.bind(fs);
  // Track which fds correspond to a directory open ('r' on the runtimeDir).
  const dirFds = new Set();
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (path.resolve(p) === path.resolve(dir) && flags === 'r') {
      dirOpened = true;
      dirFds.add(fd);
    }
    return fd;
  });
  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd, ...rest) {
    if (dirFds.has(fd)) dirFsynced = true;
    return realFsync(fd, ...rest);
  });
  t.after(() => { openMock.mock.restore(); fsyncMock.mock.restore(); });

  writeLedger(dir, makeLedger({ entries: { 'd2-cap': makeEntry('d2-cap') } }));

  assert.ok(dirOpened, 'writeLedger must open the containing directory for fsync (DUR-2)');
  assert.ok(dirFsynced, 'writeLedger must fsync the containing directory fd (DUR-2)');
});

test('DUR-2: writeLedger tolerates EPERM from the directory fsync (still writes the ledger)', (t) => {
  const dir = createTempDir('ledger-dur2-dirfsync-eperm-');
  t.after(() => cleanup(dir));

  const realFsync = fs.fsyncSync.bind(fs);
  const realOpen = fs.openSync.bind(fs);
  const dirFds = new Set();
  const openMock = mock.method(fs, 'openSync', function (p, flags, ...rest) {
    const fd = realOpen(p, flags, ...rest);
    if (path.resolve(p) === path.resolve(dir) && flags === 'r') dirFds.add(fd);
    return fd;
  });
  const fsyncMock = mock.method(fs, 'fsyncSync', function (fd, ...rest) {
    if (dirFds.has(fd)) {
      const err = new Error('EPERM: operation not permitted, fsync');
      err.code = 'EPERM';
      throw err;
    }
    return realFsync(fd, ...rest);
  });
  t.after(() => { openMock.mock.restore(); fsyncMock.mock.restore(); });

  assert.doesNotThrow(
    () => writeLedger(dir, makeLedger({ entries: { 'd2e-cap': makeEntry('d2e-cap') } })),
    'writeLedger must tolerate EPERM from the directory fsync',
  );
  const read = readLedger(dir);
  assert.ok(read !== null && 'd2e-cap' in read.entries, 'ledger must still be written despite dir-fsync EPERM');
});

// ---------------------------------------------------------------------------
// W-1 (MED): renameSync can transiently fail on Windows (AV lock: EPERM/EBUSY/
// EACCES). writeLedger must retry the rename a few times before failing.
// Revert-fails: remove the rename retry loop → the first EPERM propagates and
// writeLedger throws, failing the doesNotThrow assertion.
// ---------------------------------------------------------------------------

test('W-1: writeLedger retries a transient EPERM/EBUSY renameSync before succeeding', (t) => {
  const dir = createTempDir('ledger-w1-rename-retry-');
  t.after(() => cleanup(dir));

  // Fail the rename twice with EBUSY, then succeed on the third attempt.
  let renameCalls = 0;
  const realRename = fs.renameSync.bind(fs);
  const renameMock = mock.method(fs, 'renameSync', function (src, dest, ...rest) {
    renameCalls++;
    if (renameCalls <= 2) {
      const err = new Error('EBUSY: resource busy or locked, rename');
      err.code = 'EBUSY';
      throw err;
    }
    return realRename(src, dest, ...rest);
  });
  t.after(() => renameMock.mock.restore());

  assert.doesNotThrow(
    () => writeLedger(dir, makeLedger({ entries: { 'w1-cap': makeEntry('w1-cap') } })),
    'writeLedger must retry a transient rename failure',
  );
  assert.ok(renameCalls >= 3, `renameSync must have been retried; calls=${renameCalls}`);
  const read = readLedger(dir);
  assert.ok(read !== null && 'w1-cap' in read.entries, 'ledger must be written after rename retries');
});

// ---------------------------------------------------------------------------
// W-2 (NIT): the CorruptLedgerError recovery hint must be platform-aware — a
// POSIX `mv` command is wrong on Windows.
// Revert-fails: hardcode the message back to `mv "..."` → the win32-branch
// assertion for `ren`/`Move-Item` fails when process.platform is forced to win32.
// ---------------------------------------------------------------------------

test('W-2: CorruptLedgerError recovery hint is platform-aware (win32 uses ren/Move-Item, not mv)', (t) => {
  const dir = createTempDir('ledger-w2-msg-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), '{ broken json ---');

  // Force win32 to check the recovery hint branch.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', realPlatform));

  try {
    readLedgerStrict(dir);
    assert.fail('must throw on corrupt ledger');
  } catch (err) {
    assert.ok(err instanceof CorruptLedgerError, 'must be CorruptLedgerError');
    assert.ok(
      /\bren\b/.test(err.message) || /Move-Item/.test(err.message),
      `win32 recovery hint must reference ren/Move-Item, not mv; got: ${err.message}`,
    );
    assert.ok(!/\bmv "/.test(err.message),
      `win32 message must not embed the POSIX mv command; got: ${err.message}`);
  }
});

test('W-2: CorruptLedgerError recovery hint uses mv on non-win32 platforms', (t) => {
  const dir = createTempDir('ledger-w2-msg-posix-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict, CorruptLedgerError } = capLedger;
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), '{ broken json ---');

  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', realPlatform));

  try {
    readLedgerStrict(dir);
    assert.fail('must throw on corrupt ledger');
  } catch (err) {
    assert.ok(err instanceof CorruptLedgerError, 'must be CorruptLedgerError');
    assert.ok(/\bmv\b/.test(err.message), `posix recovery hint must reference mv; got: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// DOS-3 (LOW): isValidLedgerEntry must reject entries whose files[] or
// sharedEdits[] are oversized (DoS via a huge array).
// Revert-fails: remove the length caps → an oversized files[] passes validation,
// so isValidLedgerEntry returns true and these assertions fail.
// ---------------------------------------------------------------------------

test('DOS-3: isValidLedgerEntry rejects an oversized files[] (>10000) and sharedEdits[] (>256)', () => {
  // Finding 5(a): the caps are GENEROUS DoS backstops (files <= 10000, sharedEdits <= 256),
  // not product limits — no legitimate capability hits them, but a hostile 100k+ array is stopped.
  // Oversized files[].
  const bigFiles = {
    id: 'big', version: '1', source: 's', integrity: 'x',
    files: Array.from({ length: 10001 }, (_, i) => `f${i}.md`),
    sharedEdits: [],
  };
  assert.equal(isValidLedgerEntry('big', bigFiles), false,
    'must reject an entry with files.length > 10000 (DoS guard)');

  // Oversized sharedEdits[].
  const bigShared = {
    id: 'bigs', version: '1', source: 's', integrity: 'x',
    files: [],
    sharedEdits: Array.from({ length: 257 }, (_, i) => ({ file: `s${i}.json`, marker: 'bigs' })),
  };
  assert.equal(isValidLedgerEntry('bigs', bigShared), false,
    'must reject an entry with sharedEdits.length > 256 (DoS guard)');

  // At-the-cap entries are still valid.
  const atCap = {
    id: 'at-cap', version: '1', source: 's', integrity: 'x',
    files: Array.from({ length: 10000 }, (_, i) => `f${i}.md`),
    sharedEdits: Array.from({ length: 256 }, (_, i) => ({ file: `s${i}.json`, marker: 'at-cap' })),
  };
  assert.equal(isValidLedgerEntry('at-cap', atCap), true,
    'must accept an entry exactly at the caps (10000 files, 256 sharedEdits)');
});

test('DOS-3: readLedger returns null for a ledger with an oversized files[] entry', (t) => {
  const dir = createTempDir('ledger-dos3-readledger-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'big': { id: 'big', version: '1', source: 's', integrity: 'x', files: Array.from({ length: 10001 }, (_, i) => `f${i}`), sharedEdits: [] },
    },
  }));
  assert.equal(readLedger(dir), null, 'readLedger must reject an oversized files[] entry');
});

// ---------------------------------------------------------------------------
// Finding 3 (HIGH): _pending.sharedFiles was only Array.isArray-checked, so a
// hostile ledger with a huge _pending.sharedFiles array (or non-string members)
// was accepted and later spread into a Set + iterated in reconcile (DoS bypass).
// isValidLedgerEntry must validate every member is a string AND cap its length.
// ---------------------------------------------------------------------------

const base35 = { version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [] };

// Revert-fails: remove the per-member string check on _pending.sharedFiles →
// the non-string member passes (only Array.isArray is checked), so
// isValidLedgerEntry returns true and this assertion fails.
test('finding-3: isValidLedgerEntry rejects a _pending.sharedFiles with a NON-STRING member', () => {
  const entry = { id: 'p', ...base35, _pending: { kind: 'install', backupName: null, sharedFiles: ['ok.json', 123] } };
  assert.equal(isValidLedgerEntry('p', entry), false,
    'must reject _pending.sharedFiles containing a non-string member');
});

// Revert-fails: remove the length cap on _pending.sharedFiles → the oversized
// array passes validation, so isValidLedgerEntry returns true and this fails.
// (257 is just over the 256 generous cap — the cap VALUE is what's under test, not
// the absolute hostile size, so the array stays small enough to avoid OOM.)
test('finding-3: isValidLedgerEntry rejects an OVERSIZED _pending.sharedFiles array (DoS guard)', () => {
  const entry = {
    id: 'p', ...base35,
    _pending: { kind: 'install', backupName: null, sharedFiles: Array.from({ length: 257 }, (_, i) => `f${i}.json`) },
  };
  assert.equal(isValidLedgerEntry('p', entry), false,
    'must reject an oversized _pending.sharedFiles array (>256 cap)');
  // The at-cap (256) all-string array must remain valid.
  const atCap = {
    id: 'p', ...base35,
    _pending: { kind: 'install', backupName: null, sharedFiles: Array.from({ length: 256 }, (_, i) => `f${i}.json`) },
  };
  assert.equal(isValidLedgerEntry('p', atCap), true,
    'an at-cap (256) all-string _pending.sharedFiles must remain valid');
});

// Revert-fails: if the cap is set so low a legitimate _pending is rejected, OR
// the all-strings path is broken, this in-bounds all-string _pending fails.
test('finding-3: isValidLedgerEntry ACCEPTS a small all-string _pending.sharedFiles', () => {
  const entry = { id: 'p', ...base35, _pending: { kind: 'install', backupName: null, sharedFiles: ['a.json', 'b.json'] } };
  assert.equal(isValidLedgerEntry('p', entry), true,
    'a small all-string _pending.sharedFiles must remain valid');
});

// Revert-fails: remove the _pending.sharedFiles member validation → readLedger
// would accept the hostile entry instead of returning null, so this fails.
test('finding-3: readLedger returns null for a ledger whose _pending.sharedFiles is oversized', (t) => {
  const dir = createTempDir('ledger-finding3-readledger-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '1', updatedAt: new Date().toISOString(),
    entries: {
      'p': { id: 'p', version: '1', source: 's', integrity: 'x', files: [], sharedEdits: [],
        _pending: { kind: 'install', backupName: null, sharedFiles: Array.from({ length: 257 }, (_, i) => `f${i}`) } },
    },
  }));
  assert.equal(readLedger(dir), null, 'readLedger must reject an oversized _pending.sharedFiles entry');
});

// ---------------------------------------------------------------------------
// BC-1 (MED): a ledger whose version is a string but not '1' must surface a
// DISTINCT "unsupported ledger schema version" error from readLedgerStrict,
// not a generic corrupt error.
// Revert-fails: remove the unsupported-version branch → readLedgerStrict throws
// the generic CorruptLedgerError whose message lacks "unsupported"/"schema
// version", failing the distinct-message assertion.
// ---------------------------------------------------------------------------

test('BC-1: readLedgerStrict surfaces a distinct "unsupported schema version" error for version "2"', (t) => {
  const dir = createTempDir('ledger-bc1-version-');
  t.after(() => cleanup(dir));

  const { readLedgerStrict } = capLedger;
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({
    version: '2', updatedAt: new Date().toISOString(), entries: {},
  }));

  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      assert.ok(/unsupported/i.test(err.message) && /schema version/i.test(err.message),
        `must mention unsupported schema version; got: ${err.message}`);
      assert.ok(/\b2\b/.test(err.message), `must name the offending version; got: ${err.message}`);
      return true;
    },
    'readLedgerStrict must surface a distinct unsupported-version error for version "2"',
  );
});

// ---------------------------------------------------------------------------
// DOS-4 (LOW): recordInstall accepts an optional in-lock baseLedger to avoid a
// redundant strict re-read. A provided base is used as the write base; omitting
// it preserves the strict-read default; a non-object base falls back to strict.
// ---------------------------------------------------------------------------

test('DOS-4: recordInstall(baseLedger) writes against the SUPPLIED base, not a re-read of disk', (t) => {
  const dir = createTempDir('ledger-dos4-base-');
  t.after(() => cleanup(dir));

  // DISK has NO ledger. The supplied base carries a pre-existing OTHER entry. If recordInstall
  // ignored the base and strict-read the (empty) disk, that other entry would be ABSENT from the
  // result. Its presence proves the supplied base was used as the write base (no redundant re-read).
  // Revert-fails: ignore opts.baseLedger → recordInstall strict-reads the empty disk, so
  // 'pre-existing' is dropped and the survival assertion fails.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false, 'pre-condition: no ledger on disk');
  const base = makeLedger({ entries: { 'pre-existing': makeEntry('pre-existing') } });

  recordInstall(dir, makeEntry('dos4-cap'), { baseLedger: base });

  const ledger = readLedger(dir);
  assert.ok(ledger !== null, 'ledger must be written');
  assert.ok('dos4-cap' in ledger.entries, 'the new entry must be recorded');
  assert.ok('pre-existing' in ledger.entries,
    'the supplied base entry must survive — proving recordInstall wrote against the base, not a disk re-read (DOS-4)');
});

test('DOS-4: recordInstall WITHOUT baseLedger reads disk (a pre-existing disk entry is preserved)', (t) => {
  const dir = createTempDir('ledger-dos4-nobase-');
  t.after(() => cleanup(dir));

  // Seed a ledger on disk with one entry, then recordInstall a second WITHOUT a base. The default
  // strict read must pick up the on-disk entry and preserve it alongside the new one.
  recordInstall(dir, makeEntry('on-disk'));
  recordInstall(dir, makeEntry('dos4-default'));
  const ledger = readLedger(dir);
  assert.ok(ledger !== null && 'on-disk' in ledger.entries && 'dos4-default' in ledger.entries,
    'without a base, recordInstall must strict-read disk and preserve the existing entry (default unchanged)');
});

test('DOS-4: recordInstall ignores a non-object baseLedger and falls back to strict read', (t) => {
  const dir = createTempDir('ledger-dos4-badbase-');
  t.after(() => cleanup(dir));
  // A garbage base must not be trusted; recordInstall must fall back to the strict read.
  assert.doesNotThrow(
    () => recordInstall(dir, makeEntry('dos4-fallback'), { baseLedger: /** intentionally bad */ 'not-a-ledger' }),
    'a non-object baseLedger must be ignored, not crash',
  );
  const ledger = readLedger(dir);
  assert.ok(ledger !== null && 'dos4-fallback' in ledger.entries);
});

// ---------------------------------------------------------------------------
// Finding 3 (MEDIUM): unbounded ledger read. readLedgerRaw must statSync the file
// BEFORE reading and refuse an oversized ledger (fail-closed) without materializing
// it; and it must cap the entry COUNT (MAX_ENTRIES) during validation.
// ---------------------------------------------------------------------------

// Revert-fails: drop the statSync size-cap in readLedgerRaw → the oversized file is read whole and
// (being valid JSON with one valid entry) parses fine, so readLedger returns non-null and
// readLedgerStrict does NOT throw — both assertions here then fail.
test('finding-3: an OVERSIZED ledger file is refused without being read whole (fail closed)', (t) => {
  const dir = createTempDir('ledger-f3-oversized-');
  t.after(() => cleanup(dir));

  // A VALID ledger structurally — but padded past the 8 MiB cap via a long (valid) string field that
  // JSON.parse would accept. The size cap, not a parse failure, must block it: proving the bound.
  const filePath = path.join(dir, LEDGER_FILE_NAME);
  const entry = makeEntry('big-cap', { source: 'registry:' + 'p'.repeat(9 * 1024 * 1024) });
  fs.writeFileSync(filePath, JSON.stringify({ version: '1', updatedAt: new Date().toISOString(), entries: { 'big-cap': entry } }));
  assert.ok(fs.statSync(filePath).size > 8 * 1024 * 1024, 'pre-condition: file must exceed the 8 MiB cap');

  // readLedger (non-throwing) must return null (it cannot read an oversized file).
  assert.strictEqual(readLedger(dir), null, 'readLedger must refuse an oversized ledger (returns null)');
  // readLedgerStrict must fail closed (throw) so every subsequent op blocks until resolved.
  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.ok(LedgerIOError !== undefined && err instanceof LedgerIOError,
        `oversized ledger must be a LedgerIOError (cannot-read), not corruption; got: ${err?.constructor?.name}`);
      assert.ok(/exceeds the maximum|oversized/i.test(err.message), `message must name the size limit; got: ${err.message}`);
      return true;
    },
    'readLedgerStrict must throw a fail-closed IO error for an oversized ledger',
  );
});

// Revert-fails: drop the `keys.length > MAX_ENTRIES` reject in readLedgerRaw → a ledger with 4097
// valid entries is accepted, so readLedger returns non-null and this strictEqual(null) fails.
test('finding-3: a ledger with more than MAX_ENTRIES entries is rejected (entry-count DoS cap)', (t) => {
  const dir = createTempDir('ledger-f3-maxentries-');
  t.after(() => cleanup(dir));

  const entries = {};
  for (let i = 0; i <= 4096; i++) { // 4097 entries → one over the 4096 cap
    const id = `cap-${i}`;
    entries[id] = makeEntry(id);
  }
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({ version: '1', updatedAt: new Date().toISOString(), entries }));

  assert.strictEqual(readLedger(dir), null,
    'a ledger exceeding MAX_ENTRIES must be rejected (returns null) — entry-count DoS backstop');
});

// Guard the boundary so the cap can't be quietly tightened below a generous value: exactly
// MAX_ENTRIES (4096) entries must still be ACCEPTED. Revert-fails: lower MAX_ENTRIES below 4096 →
// this 4096-entry ledger is wrongly rejected and the non-null assertion fails.
test('finding-3: a ledger with exactly MAX_ENTRIES entries is still accepted (cap is generous)', (t) => {
  const dir = createTempDir('ledger-f3-atcap-');
  t.after(() => cleanup(dir));

  const entries = {};
  for (let i = 0; i < 4096; i++) { const id = `cap-${i}`; entries[id] = makeEntry(id); }
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), JSON.stringify({ version: '1', updatedAt: new Date().toISOString(), entries }));

  const ledger = readLedger(dir);
  assert.ok(ledger !== null, 'a ledger at exactly MAX_ENTRIES must still be accepted');
  assert.strictEqual(Object.keys(ledger.entries).length, 4096, 'all MAX_ENTRIES entries must be present');
});

// ---------------------------------------------------------------------------
// Finding 5 (LOW): recordInstall(.,{baseLedger}) must NOT trust an INVALID base.
// It validated only the NEW entry, then wrote the supplied base verbatim → a caller
// passing an invalid base (bad version/updatedAt/entries) wrote a self-corrupting
// ledger. The base is now usable ONLY when it passes the SAME validation a strict
// read would; an invalid base is ignored and recordInstall falls back to the strict
// read (so the on-disk truth — not the bad base — is the write basis).
// ---------------------------------------------------------------------------

// Revert-fails: restore the shallow `typeof base.entries === 'object'` acceptance → the base with a
// BAD version is written verbatim, producing a ledger whose `version` !== '1', so readLedger rejects
// it (null) and this "still valid + on-disk preserved" assertion fails.
test('finding-5: recordInstall IGNORES a baseLedger with a bad schema version (falls back to strict disk read)', (t) => {
  const dir = createTempDir('ledger-f5-badversion-');
  t.after(() => cleanup(dir));

  // Seed a VALID ledger on disk so the strict-read fallback has real prior state to preserve.
  recordInstall(dir, makeEntry('on-disk-cap'));

  // A base that LOOKS like a ledger (has an entries object) but is structurally INVALID: wrong
  // schema version. The old shallow check accepted it; the fix must reject it and fall back to disk.
  const badBase = { version: '999', updatedAt: new Date().toISOString(), entries: { 'ghost': makeEntry('ghost') } };
  recordInstall(dir, makeEntry('new-cap'), { baseLedger: badBase });

  const ledger = readLedger(dir);
  assert.ok(ledger !== null, 'the written ledger must remain VALID (bad base must not corrupt it)');
  assert.strictEqual(ledger.version, '1', 'the written ledger version must be the supported "1", not the bad base\'s "999"');
  assert.ok('new-cap' in ledger.entries, 'the new entry must be recorded');
  assert.ok('on-disk-cap' in ledger.entries, 'the strict-read disk entry must be preserved (fallback used)');
  assert.ok(!('ghost' in ledger.entries), 'the invalid base\'s entry must NOT be written (base ignored)');
});

// Revert-fails: same shallow acceptance → a base carrying a structurally-invalid ENTRY (files:[123])
// is written verbatim, so the resulting ledger fails validation on the next read and this "still
// valid" assertion fails.
test('finding-5: recordInstall IGNORES a baseLedger that contains a structurally-invalid entry', (t) => {
  const dir = createTempDir('ledger-f5-badentry-');
  t.after(() => cleanup(dir));

  recordInstall(dir, makeEntry('on-disk-cap'));

  // entries map is an object (passes the OLD shallow check) but one entry is malformed (files: [123]).
  const badBase = {
    version: '1', updatedAt: new Date().toISOString(),
    entries: { 'bad': { id: 'bad', version: '1.0.0', source: 's', integrity: 'x', files: [123], sharedEdits: [] } },
  };
  recordInstall(dir, makeEntry('new-cap'), { baseLedger: badBase });

  const ledger = readLedger(dir);
  assert.ok(ledger !== null, 'a base with a malformed entry must not corrupt the written ledger');
  assert.ok('new-cap' in ledger.entries, 'the new entry must be recorded');
  assert.ok('on-disk-cap' in ledger.entries, 'the strict-read disk entry must be preserved (base ignored, fallback used)');
  assert.ok(!('bad' in ledger.entries), 'the invalid base entry must NOT be written');
});

// Positive control: a VALID base is still honored (the fast-path is not broken by the new gate).
// Revert-fails: tighten isValidLedgerFile to reject a valid base → this base entry would be dropped
// and the survival assertion fails.
test('finding-5: recordInstall still USES a fully-valid baseLedger (fast-path preserved)', (t) => {
  const dir = createTempDir('ledger-f5-goodbase-');
  t.after(() => cleanup(dir));

  // No ledger on disk; a VALID base carrying a prior entry must be used as the write base.
  assert.equal(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), false, 'pre-condition: no ledger on disk');
  const goodBase = makeLedger({ entries: { 'prior': makeEntry('prior') } });
  recordInstall(dir, makeEntry('new-cap'), { baseLedger: goodBase });

  const ledger = readLedger(dir);
  assert.ok(ledger !== null && 'new-cap' in ledger.entries && 'prior' in ledger.entries,
    'a fully-valid base must be honored (prior entry preserved without a disk re-read)');
});

// ---------------------------------------------------------------------------
// Finding 2 (HIGH): read-size caps must be enforced via an fd-based stat (fstat
// AFTER open), not a path-stat that a FIFO / device / symlink-to-device / stat-then-
// read swap can bypass. A single shared `readSmallRegularFile(path, maxBytes)` helper
// must: openSync('r') → fstatSync(fd) → require isFile() (reject FIFO/device/dir/
// symlink-target-nonregular) → require size <= maxBytes → read exactly size bytes →
// closeSync in finally. readLedgerRaw + the unsupported-version reparse use it (fail
// closed → LedgerIOError) and a normal small ledger still reads fine.
// ---------------------------------------------------------------------------

test('finding-2: readSmallRegularFile is exported (shared bounded fd reader)', () => {
  assert.equal(typeof readSmallRegularFile, 'function',
    'readSmallRegularFile must be exported for both lifecycle + ledger to share one bounded reader');
});

// Revert-fails: replace the fstat(fd).isFile() guard with a path statSync+readFileSync → the FIFO
// read blocks forever (no writer) OR (if a writer existed) bypasses the cap; with the fd helper the
// non-regular fstat is rejected immediately, so this assertion (throws fast, does not hang) holds.
test('finding-2: readSmallRegularFile rejects a FIFO (non-regular) — fail closed, no hang', (t) => {
  const dir = createTempDir('ledger-f2-fifo-');
  t.after(() => cleanup(dir));
  const fifo = path.join(dir, 'fifo');
  if (!tryMkfifo(fifo)) { t.skip('mkfifo unavailable on this platform'); return; }

  assert.throws(
    () => readSmallRegularFile(fifo, 64 * 1024),
    (err) => {
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.ok(/regular|unreadable|not a regular/i.test(err.message),
        `must reject a non-regular file with a clear reason; got: ${err.message}`);
      return true;
    },
    'readSmallRegularFile must fail closed on a FIFO (not block/read-unbounded)',
  );
});

// Revert-fails: same as above — a path-stat helper would follow the symlink to /dev/zero (a char
// DEVICE that is INFINITE) and read until OOM; the fd-fstat isFile() guard rejects the non-regular
// target, so this "throws" assertion holds. (POSIX-only; /dev/zero is the device.)
test('finding-2: readSmallRegularFile rejects a symlink to /dev/zero (char device, infinite)', (t) => {
  const dir = createTempDir('ledger-f2-devzero-');
  t.after(() => cleanup(dir));
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) { t.skip('no /dev/zero on this platform'); return; }
  const link = path.join(dir, 'zerolink');
  fs.symlinkSync('/dev/zero', link);

  assert.throws(
    () => readSmallRegularFile(link, 64 * 1024),
    (err) => {
      assert.ok(/regular|unreadable|not a regular/i.test(err.message),
        `must reject a symlink to a char device; got: ${err.message}`);
      return true;
    },
    'readSmallRegularFile must fail closed on a symlink to /dev/zero (not read unbounded)',
  );
});

// Revert-fails: drop the `fstat.size > maxBytes` reject → the oversized regular file is read whole,
// so readSmallRegularFile returns its content instead of throwing and this assertion fails.
test('finding-2: readSmallRegularFile rejects an OVERSIZED regular file (size cap on the fd stat)', (t) => {
  const dir = createTempDir('ledger-f2-oversize-');
  t.after(() => cleanup(dir));
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(70 * 1024)); // > 64 KiB

  assert.throws(
    () => readSmallRegularFile(big, 64 * 1024),
    (err) => {
      assert.ok(/exceeds|maximum|oversized|too large/i.test(err.message),
        `must reject an oversized file naming the cap; got: ${err.message}`);
      return true;
    },
    'readSmallRegularFile must fail closed on an oversized regular file',
  );
});

// Positive control: a normal small regular file reads byte-for-byte. Revert-fails: an over-tight cap
// or a broken read would change the returned content, so this exact-content assertion fails.
test('finding-2: readSmallRegularFile reads a normal small regular file byte-for-byte', (t) => {
  const dir = createTempDir('ledger-f2-small-');
  t.after(() => cleanup(dir));
  const f = path.join(dir, 'small.txt');
  const content = JSON.stringify({ hello: 'world', n: 42 });
  fs.writeFileSync(f, content);

  assert.strictEqual(readSmallRegularFile(f, 64 * 1024), content,
    'a normal small regular file must read back exactly');
});

// Revert-fails: route readLedgerRaw back through statSync(path)+readFileSync(path) → a FIFO ledger
// would block / bypass the cap; with the fd helper readLedgerStrict fails closed (LedgerIOError),
// so this assertion holds. (Repo-plantable project-scope ledger → repo-borne DoS.)
test('finding-2: a ledger path that is a FIFO fails closed via readLedgerStrict (LedgerIOError, no hang)', (t) => {
  const dir = createTempDir('ledger-f2-fifoledger-');
  t.after(() => cleanup(dir));
  const fifo = path.join(dir, LEDGER_FILE_NAME);
  if (!tryMkfifo(fifo)) { t.skip('mkfifo unavailable on this platform'); return; }

  // readLedger (non-throwing) must return null rather than hanging.
  assert.strictEqual(readLedger(dir), null, 'readLedger must refuse a FIFO ledger (returns null, no hang)');
  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      assert.ok(err instanceof LedgerIOError,
        `a FIFO ledger must fail closed as LedgerIOError; got: ${err?.constructor?.name}`);
      return true;
    },
    'readLedgerStrict must fail closed (LedgerIOError) for a FIFO ledger',
  );
});

// Revert-fails: route the unsupported-version reparse (capability-ledger ~385) back through
// readFileSync(path) → a FIFO/oversized swapped in after the first read would block / bypass the cap
// on the reparse. With the fd helper the reparse can't be exploited; this verifies the normal
// unsupported-version message still surfaces (the helper path is taken for the reparse too).
test('finding-2: unsupported-version reparse still surfaces a clear schema-version error (uses the bounded reader)', (t) => {
  const dir = createTempDir('ledger-f2-reparse-');
  t.after(() => cleanup(dir));
  // A structurally-fine ledger but with an UNSUPPORTED version → readLedgerRaw returns null, and the
  // strict reader reparses (via the bounded reader) to produce the distinct "unsupported version" msg.
  fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME),
    JSON.stringify({ version: '2', updatedAt: new Date().toISOString(), entries: {} }));
  assert.throws(
    () => readLedgerStrict(dir),
    (err) => {
      assert.ok(/unsupported ledger schema version/i.test(err.message),
        `must name the unsupported version; got: ${err.message}`);
      return true;
    },
    'readLedgerStrict must reparse (bounded) and surface the unsupported-version message',
  );
});

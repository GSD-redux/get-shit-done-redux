'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');

// Built lib is the test target (same surface the rest of the suite imports).
const capabilityLock = require('../gsd-core/bin/lib/capability-lock.cjs');
const { acquireLock } = capabilityLock;

// ─────────────────────────────────────────────────────────────────────────────
// #3987 (same class as #1884/PR #3472): acquireLock swallows the mkdirSync
// failure creating the lock directory. The subsequent `fs.openSync(lockPath,
// 'wx')` then throws ENOENT (parent missing), and ENOENT is NOT 'EEXIST', so
// `if (code !== 'EEXIST') return null;` laundered a genuine EACCES/EROFS
// filesystem error into an ordinary "lock unavailable" (null) result —
// indistinguishable from another live process legitimately holding the lock.
//
// Fix (matching #1884's approach in 0c43d853e): stop swallowing — let the
// mkdir failure propagate immediately with its real errno. These tests pin
// the corrected contract: a permission/space failure creating the lock
// directory throws, it is never folded into a "null" (lock unavailable)
// result.
//
// IO failure is forced via t.mock.method(fs, 'mkdirSync', ...), which
// auto-restores per-test (never chmod 0o000 — root bypasses mode bits,
// leaking coverage).
// ─────────────────────────────────────────────────────────────────────────────

const realMkdirSync = fs.mkdirSync;

function failMkdirFor(t, targetDir, code) {
  t.mock.method(fs, 'mkdirSync', (p, opts) => {
    if (typeof p === 'string' && (p === targetDir || p.startsWith(targetDir + path.sep))) {
      const err = new Error(`${code}: permission denied, mkdir '${p}'`);
      err.code = code;
      throw err;
    }
    return realMkdirSync.call(fs, p, opts);
  });
}

describe('acquireLock surfaces mkdir failure fast (#3987, same class as #1884)', () => {
  test('EACCES creating the lock directory is surfaced immediately, not laundered into a "lock unavailable" null', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-caplock-mkdir-fail-'));
    t.after(() => cleanup(tmpDir));

    const lockDir = path.join(tmpDir, 'nested', 'sub');
    const lockPath = path.join(lockDir, '.lock');
    failMkdirFor(t, lockDir, 'EACCES');

    assert.throws(
      () => acquireLock(lockPath),
      (err) => err && err.code === 'EACCES',
      'a genuine EACCES creating the lock directory must surface as EACCES, not return null'
    );
  });

  test('ENOSPC creating the lock directory is surfaced immediately', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-caplock-mkdir-fail-'));
    t.after(() => cleanup(tmpDir));

    const lockDir = path.join(tmpDir, 'nested', 'sub');
    const lockPath = path.join(lockDir, '.lock');
    failMkdirFor(t, lockDir, 'ENOSPC');

    assert.throws(
      () => acquireLock(lockPath),
      (err) => err && err.code === 'ENOSPC',
      'a genuine ENOSPC creating the lock directory must surface immediately, not return null'
    );
  });

  test('the thrown mkdir-failure error is never returned as a lock handle or null', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-caplock-mkdir-fail-'));
    t.after(() => cleanup(tmpDir));

    const lockDir = path.join(tmpDir, 'nested', 'sub');
    const lockPath = path.join(lockDir, '.lock');
    failMkdirFor(t, lockDir, 'EACCES');

    let returned;
    let threw = false;
    try {
      returned = acquireLock(lockPath);
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, true, 'acquireLock must throw on a genuine mkdir failure, not return');
    assert.strictEqual(returned, undefined, 'no value should be returned when the mkdir failure is surfaced');
  });

  test('normal path is unaffected: a creatable lock directory still acquires a lock', (t) => {
    // No monkeypatch — the lock directory is creatable in the writable tmpDir.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-caplock-mkdir-ok-'));
    t.after(() => cleanup(tmpDir));

    const lockPath = path.join(tmpDir, 'nested', 'sub', '.lock');
    const handle = acquireLock(lockPath);
    assert.ok(handle && typeof handle.token === 'string', 'a creatable lock directory must still yield a lock handle');
    capabilityLock.releaseLock(handle);
  });
});

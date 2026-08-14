const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');

// Built lib is the test target (same surface the rest of the suite imports).
const planningWorkspaceDirect = require('../gsd-core/bin/lib/planning-workspace.cjs');
const { withPlanningLock } = planningWorkspaceDirect;

// ─────────────────────────────────────────────────────────────────────────────
// Epic #1879 / F16 (#1884): withPlanningLock swallows platformEnsureDir failure.
//
// A mkdir failure (EACCES/ENOSPC/EROFS) creating `.planning/` was swallowed by a
// `catch { /* ok */ }`; the subsequent lock write then threw ENOENT (parent
// missing), and ENOENT is in PLANNING_LOCK_RETRY_ERRNOS (for the Docker
// overlay-fs race), so the loop spun the full 10s budget and reported a PHANTOM
// "held by a live process" contention pointing at a nonexistent holder.
//
// Fix: stop swallowing — surface the real FS errno immediately. These tests pin
// the new contract: a corrupt/permission mkdir is surfaced fast, not folded into
// a lock-contention retry.
//
// IO failure is forced via t.mock.method(fs, 'mkdirSync', ...), which auto-restores
// per-test (never chmod 0o000 — root bypasses mode bits, leaking coverage). The fake
// clock proves fail-fast with no wall-clock assertion.
// ─────────────────────────────────────────────────────────────────────────────

const realMkdirSync = fs.mkdirSync;

describe('withPlanningLock surfaces mkdir failure fast (epic #1879 / F16, #1884)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-mkdir-fail-'));
    // Deliberately do NOT pre-create tmpDir/.planning — the scenario under test
    // is "the dir cannot be created."
  });

  afterEach(() => {
    if (typeof planningWorkspaceDirect._resetLockProbes === 'function') {
      planningWorkspaceDirect._resetLockProbes();
    }
    if (typeof planningWorkspaceDirect._resetPlanningLockTestHooks === 'function') {
      planningWorkspaceDirect._resetPlanningLockTestHooks();
    }
    cleanup(tmpDir);
  });

  function failMkdirFor(t, targetDir, code) {
    // Mock the shared fs.mkdirSync that platformEnsureDir calls dynamically.
    // Re-throw the requested errno only for the planning dir; pass through everything
    // else so unrelated test machinery keeps working. t.mock auto-restores after the test.
    t.mock.method(fs, 'mkdirSync', (p, opts) => {
      if (typeof p === 'string' && (p === targetDir || p.startsWith(targetDir + path.sep))) {
        const err = new Error(code + ': permission denied, mkdir \'' + p + '\'');
        err.code = code;
        throw err;
      }
      return realMkdirSync.call(fs, p, opts);
    });
  }

  test('EACCES creating .planning/ is surfaced immediately, not folded into a phantom lock timeout', (t) => {
    const planningPath = path.join(tmpDir, '.planning');
    failMkdirFor(t, planningPath, 'EACCES');

    const clock = makeFakeClock(0);
    let ran = false;
    assert.throws(
      () => withPlanningLock(tmpDir, () => { ran = true; return 'should-not-run'; }, clock),
      (err) => err && err.code === 'EACCES',
      'mkdir EACCES must surface as EACCES, not be swallowed into a phantom lock contention'
    );
    assert.strictEqual(ran, false, 'critical section must not run when the planning dir cannot be created');
    assert.ok(clock.nowValue < 10000,
      'must fail fast — clock must NOT spin to the 10s lockTimeout budget (nowValue=' + clock.nowValue + 'ms)');
  });

  test('ENOSPC creating .planning/ is surfaced immediately', (t) => {
    failMkdirFor(t, path.join(tmpDir, '.planning'), 'ENOSPC');
    const clock = makeFakeClock(0);
    assert.throws(
      () => withPlanningLock(tmpDir, () => 'x', clock),
      (err) => err && err.code === 'ENOSPC',
      'mkdir ENOSPC must surface as ENOSPC immediately'
    );
    assert.ok(clock.nowValue < 10000, 'must fail fast on ENOSPC (nowValue=' + clock.nowValue + 'ms)');
  });

  test('the thrown mkdir-failure error is NOT branded as a lock timeout (no phantom contention)', (t) => {
    failMkdirFor(t, path.join(tmpDir, '.planning'), 'EACCES');
    const clock = makeFakeClock(0);
    let captured;
    try {
      withPlanningLock(tmpDir, () => 'x', clock);
    } catch (err) {
      captured = err;
    }
    assert.ok(captured, 'withPlanningLock must throw on mkdir EACCES');
    assert.notStrictEqual(captured && captured.lockTimeout, true,
      'a mkdir failure must NOT carry lockTimeout=true (that brands a phantom contention)');
  });

  test('normal path is unaffected: creatable .planning/ still runs the critical section', () => {
    // No monkeypatch — .planning/ is creatable in the writable tmpDir.
    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'ran-ok', clock);
    assert.strictEqual(result, 'ran-ok', 'fn() must run and return when the planning dir is creatable');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', '.lock')) === false,
      'lock is released after the critical section');
  });

  test('a transient ENOENT on the lock WRITE (not mkdir) is still retried, not surfaced immediately', (t) => {
    // Distinguishes this fix's target (mkdir failure, surfaced immediately) from the
    // Docker overlay-fs race PLANNING_LOCK_RETRY_ERRNOS exists for (a transient ENOENT
    // on the lock FILE write, with .planning/ already present) — that race must still
    // retry and eventually succeed, not regress into fail-fast.
    let writeAttempts = 0;
    const realWriteFileSync = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (p, data, opts) => {
      if (typeof p === 'string' && p.endsWith(path.join('.planning', '.lock')) && writeAttempts === 0) {
        writeAttempts++;
        const err = new Error('ENOENT: transient overlay-fs race, open \'' + p + '\'');
        err.code = 'ENOENT';
        throw err;
      }
      return realWriteFileSync.call(fs, p, data, opts);
    });

    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'survived-the-race', clock);
    assert.strictEqual(result, 'survived-the-race', 'the critical section must still run after the transient race resolves');
    assert.strictEqual(writeAttempts, 1, 'the race must have been hit exactly once (sanity check on the mock)');
    assert.ok(clock.nowValue > 0, 'a genuine retry must have consumed at least one sleep cycle (nowValue=' + clock.nowValue + 'ms)');
  });
});

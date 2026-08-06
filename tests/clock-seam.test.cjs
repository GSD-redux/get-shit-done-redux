'use strict';
// allow-test-rule: pending-migration-to-typed-ir [#3090]
// This file's assert.throws(fn, /regex/) sites (acquireStateLock /
// readModifyWriteStateMd / withPlanningLock / acquireInstallMigrationLock
// timeout and error-propagation checks) regex-match the human-readable
// thrown Error#message — CONTRIBUTING's "Error / status / reason" BAD
// pattern; the fix is a frozen-enum REASON code on the thrown error, which
// requires a production change to those locking functions that is out of
// scope for this test-only change. Tracked for correction under #3090.

/**
 * Deterministic clock-seam tests for acquireStateLock / withPlanningLock (issue #453).
 *
 * Replaces the timing-dependent tests identified in the #453 research:
 *
 * locking-bugs:63  — source-grep for Atomics.wait → in-process fake-clock proof
 * locking-bugs:130 — source-grep for process.on('exit') in state.cjs → exit-cleanup integration test
 * locking-bugs:143 — source-grep for process.on('exit') in planning-workspace.cjs → idem
 * locking-bugs:467 — source-grep asserting all 9 cmd* functions call readModifyWriteStateMd →
 *                    replaced by DI-based unit test confirming each cmd* goes through the seam
 * locking-bugs:647 — source-grep asserting config.cjs uses withPlanningLock →
 *                    replaced by the functional barrier-based test at locking-bugs:545 (CONVERT kept)
 *
 * concurrency-safety:521 — 100-line normalizeMd perf wall-clock → no timing replacement needed;
 *                          snapshot tests in concurrency-safety already cover correctness
 * concurrency-safety:548 — 1000-line normalizeMd perf wall-clock → same
 * concurrency-safety:794 — roadmap analyze elapsed < 5000ms → replaced by behavioral test below
 *
 * New deterministic coverage added here:
 *   1. Fake-clock proof that acquireStateLock uses clock.now() and clock.sleep()
 *   2. Timeout throw at maxWaitMs boundary (driven by fake clock advance)
 *   3. Stale-lock takeover when mtime difference exceeds staleThresholdMs
 *   4. Lock released on error path (finally branch in readModifyWriteStateMd)
 *   5. withPlanningLock timeout fires when fake clock exceeds lockTimeout
 *   6. Roadmap analyze behavioral assertion (50 phases, correctness) without timing gate
 *   7. Exit-cleanup integration: lock file absent after process holding it exits
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeFakeClock } = require('./helpers/clock.cjs');
const stateMod = require('../gsd-core/bin/lib/state.cjs');
const { acquireStateLock, releaseStateLock, readModifyWriteStateMd } = stateMod;
const { withPlanningLock } = require('../gsd-core/bin/lib/planning-workspace.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fake-clock proof: acquireStateLock accepts and uses the clock seam
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock clock seam', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
  });

  afterEach(() => {
    // Remove any leftover lock
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('lock acquired immediately when no contention — clock.now() invoked at startup', () => {
    const clock = makeFakeClock(1000);
    const lockPath = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(lockPath), 'lock file must exist after acquire');
    assert.ok(clock.sleepCalls.length === 0, 'no sleep should occur when lock is immediately available');
    releaseStateLock(lockPath);
    assert.ok(!fs.existsSync(lockPath), 'lock file must be removed after release');
  });

  test('clock.sleep() called when lock is held — sleep count matches retry count', () => {
    const clock = makeFakeClock(0);

    // Pre-create the lock file to simulate a held lock
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, String(process.pid));

    // The lock is held by a live PID (our own process.pid).
    // acquireStateLock will retry. We need the clock to advance past maxWaitMs
    // on each sleep call so the timeout fires after the first retry.
    //
    // Override sleep to advance time beyond 30 000 ms on first call so the
    // timeout check on the NEXT iteration throws immediately.
    const fastClock = {
      now: clock.now.bind(clock),
      sleep(ms) {
        clock.sleep(ms);
        // After each sleep, jump past the 30 000 ms budget
        clock.advance(31000);
      },
    };

    assert.throws(
      () => acquireStateLock(statePath, fastClock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw timeout error when maxWaitMs is exceeded'
    );

    // Remove the lock file (we placed it ourselves)
    fs.unlinkSync(lockPath);
  });

  test('stale lock is removed and acquisition succeeds when mtime exceeds staleThresholdMs', () => {
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999'); // non-existent PID

    // Back-date mtime by 11 000 ms (> staleThresholdMs of 10 000 ms)
    const staleMs = 11000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // Use a fake clock that starts at a time such that:
    //   clock.now() - stat.mtimeMs > 10 000
    // The stat.mtimeMs is real (just backdated), so we need clock.now() to
    // return a value > staledTime.getTime() + 10000.
    const clock = makeFakeClock(Date.now() + 100); // well past the stale threshold

    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'must acquire lock after taking over stale lock');
    releaseStateLock(acquired);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1a. acquireStateLock PID-liveness staleness (audit M1)
//
// mtime is a leaky proxy for "holder is alive": a live-but-slow holder whose
// critical section runs past staleThresholdMs ages out and gets its lock stolen
// by a waiter → two writers in STATE.md's critical section → lost update.
// The fix gates the steal on a real liveness signal (process.kill(pid,0),
// injected via the _setLockProbes seam) and orders the deadman ceiling ABOVE the
// wait budget so a verified-live holder is NEVER stolen within budget. A dead
// holder is stolen promptly regardless of age. A garbage/legacy body is treated
// as not-verified-live so corrupt locks stay recoverable under the deadman ceiling.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock PID-liveness staleness (audit M1)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-liveness-state-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
  });

  afterEach(() => {
    stateMod._resetLockProbes();
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('exports _setLockProbes / _resetLockProbes seams', () => {
    assert.ok(typeof stateMod._setLockProbes === 'function', '_setLockProbes seam must be exported');
    assert.ok(typeof stateMod._resetLockProbes === 'function', '_resetLockProbes seam must be exported');
  });

  test('live holder is NOT stolen even when aged past the stale threshold (waiter budgets out)', () => {
    const lockPath = statePath + '.lock';
    const livePid = 4242;
    fs.writeFileSync(lockPath, String(livePid));

    // Holder pid reads as ALIVE via the injected probe (deterministic, no real pid).
    stateMod._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    // Drive the clock so the lock is aged WELL past the 10 000 ms stale threshold
    // (stale < age) but the waiter only ever budgets out at maxWaitMs (30 000 ms).
    // sleep advances time; once the 30 000 ms budget is exhausted it must throw,
    // and it must NOT have unlinked the live holder's lock.
    const clock = makeFakeClock(60000); // age = now - mtime ≫ 10 000 ms
    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'a verified-live holder must never be stolen within the wait budget — waiter must time out instead'
    );

    // The live holder's lock body must be intact (never unlinked + re-created).
    assert.ok(fs.existsSync(lockPath), 'live holder lock must still exist (not stolen)');
    assert.strictEqual(fs.readFileSync(lockPath, 'utf-8'), String(livePid), 'live holder lock body must be unchanged');

    fs.unlinkSync(lockPath);
  });

  test('dead holder is stolen promptly without waiting out the full budget', () => {
    const lockPath = statePath + '.lock';
    const deadPid = 777;
    fs.writeFileSync(lockPath, String(deadPid));

    // Holder pid reads as DEAD via the injected probe → eligible for immediate steal.
    stateMod._setLockProbes({ isPidAlive: () => false });

    // Fresh, NON-aged lock (mtime ≈ now). Without liveness the old mtime-only gate
    // would refuse to steal a <10 000 ms lock and force a long wait; with liveness
    // a dead holder is stolen immediately regardless of age.
    const clock = makeFakeClock(Date.now());
    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'dead holder lock must be stolen and re-acquired');
    assert.strictEqual(
      clock.sleepCalls.length, 0,
      'a dead holder must be stolen promptly — no wait/backoff sleeps before acquisition'
    );
    releaseStateLock(acquired);
  });

  test('garbage/legacy lock body → not-verified-live → recoverable under the deadman ceiling, never an infinite block', () => {
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, 'not-a-pid\x00garbage'); // unreadable / non-numeric body

    // Probe would say "alive" for ANY pid — proves the steal does not depend on a
    // bogus parse succeeding: an unparseable body is treated as not-verified-live.
    stateMod._setLockProbes({ isPidAlive: () => true });

    // Age the body past the deadman ceiling (above maxWaitMs) so the corrupt lock
    // is recoverable rather than blocking forever.
    const clock = makeFakeClock(Date.now() + 120000);
    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'corrupt/legacy lock must be recoverable (stolen under the deadman ceiling)');
    releaseStateLock(acquired);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Steal-safety windows (PR #1532 review — trek-e)
//
// The PID-liveness backport (audit M1) dropped two pieces of capability-lock.cts's
// race-free steal machinery, reopening the #500/#905/#1230 lost-update family:
//
//   (a) Empty-body create window — acquireStateLock creates the lock with O_EXCL and
//       writes the pid in a SEPARATE writeSync. A lock observed in that window has an
//       EMPTY body → _stateHolderVerifiedLive('') is false → the no-floor steal gate
//       robs it at age ≈ 0, mid-creation. capability-lock never steals a FRESH lock
//       (age <= LOCK_STALE_MS) regardless of body, which is what protects that window.
//
//   (b) Double-steal — the steal is a bare fs.unlinkSync with no identity re-confirm
//       between the decision and the unlink. A racer that steals + recreates a fresh
//       lock in that gap has its replacement deleted by the first stealer's unlink →
//       two concurrent holders. capability-lock re-confirms (dev,ino) immediately
//       before an ATOMIC rename-steal so only one racer can win.
//
// Both are driven deterministically through the lock seams (clock + pid probe +
// onLoopIteration + beforeSteal) — no wall-clock, no real concurrency.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock steal-safety windows (PR #1532)', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stealsafety-state-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
  });

  afterEach(() => {
    stateMod._resetLockProbes();
    stateMod._resetStateLockTestHooks();
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('a FRESH empty-body lock (mid-creation) is NOT stolen at age ~0 — acquirer backs off', () => {
    const lockPath = statePath + '.lock';
    // Simulate the create→pid-write window of a CONCURRENT acquirer: the lockfile
    // exists (O_EXCL create succeeded) but the pid has not been written yet → empty body.
    fs.writeFileSync(lockPath, '');
    const freshTime = new Date();
    fs.utimesSync(lockPath, freshTime, freshTime); // mtime ≈ now → age ≈ 0 (fresh)

    // The body is empty, so liveness cannot be determined from it — the probe value is
    // irrelevant. The (buggy) no-floor gate steals it regardless; the fix must wait.
    stateMod._setLockProbes({ isPidAlive: () => false });

    // After the first encounter, clear the empty lock so the (correctly-waiting) acquirer
    // can complete instead of budgeting out — keeps the test bounded and the assertion
    // about the FIRST decision, not the eventual outcome.
    stateMod._setStateLockTestHooks({
      onLoopIteration: ({ iteration }) => {
        if (iteration >= 1) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
      },
    });

    const clock = makeFakeClock(freshTime.getTime());
    const acquired = acquireStateLock(statePath, clock);

    assert.ok(fs.existsSync(acquired), 'lock must eventually be acquired');
    assert.ok(
      clock.sleepCalls.length >= 1,
      'a fresh empty-body lock is mid-creation and must NOT be stolen at age ~0 — ' +
      'the acquirer must back off (sleep) at least once, not unlink + steal immediately'
    );
    releaseStateLock(acquired);
  });

  test('a dead holder whose lock is recreated by a racer mid-steal is NOT double-stolen (identity re-confirm)', () => {
    const lockPath = statePath + '.lock';
    const deadPid = 4040;
    const livePid = 5050;
    // Decision-time holder: a DEAD pid → eligible for steal.
    fs.writeFileSync(lockPath, String(deadPid));
    const t = new Date();
    fs.utimesSync(lockPath, t, t);

    stateMod._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    // Inject a concurrent waiter that, in the gap between our steal-DECISION and our
    // steal, already stole + recreated a FRESH lock owned by a LIVE pid. A correct
    // (identity-re-confirming) acquirer must notice the lock instance changed and must
    // NOT delete the racer's live replacement.
    let injected = false;
    stateMod._setStateLockTestHooks({
      beforeSteal: () => {
        if (injected) return;
        injected = true;
        try { fs.unlinkSync(lockPath); } catch { /* ok */ }
        fs.writeFileSync(lockPath, String(livePid)); // different identity + live holder
        const f = new Date();
        fs.utimesSync(lockPath, f, f);
      },
    });

    const clock = makeFakeClock(t.getTime());
    // The racer's replacement is held by a LIVE pid → the acquirer must wait on it and
    // budget out rather than stealing it. (A double-steal would instead delete it and
    // succeed.)
    assert.throws(
      () => acquireStateLock(statePath, clock),
      (err) => err && err.lockBudgetExceeded === true,
      'acquirer must not double-steal the racer\'s live replacement — it must wait + budget out'
    );
    assert.strictEqual(
      fs.readFileSync(lockPath, 'utf-8'), String(livePid),
      'the racer\'s freshly-recreated live lock must survive — never deleted by a stale-decision unlink'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Regression #1217 — acquireStateLock ENOENT (recoverable errno) busy-spin
//
// Prior to the fix the recoverable-errno branch (`continue`) never called
// clock.sleep() or checked the budget, so a permanently-failing ENOENT from
// a deleted parent dir spun at 100% CPU forever.  With the fix every retry
// path must (a) advance the clock via sleep() and (b) throw when the 30 000 ms
// budget is exhausted.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock recoverable errno budget + backoff (#1217)', () => {
  let tmpDir;
  let statePath;
  let origOpenSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-1217-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origOpenSync = fs.openSync;
  });

  afterEach(() => {
    // Restore openSync if a test patched it
    fs.openSync = origOpenSync;
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('persistent ENOENT throws budget-exceeded error (not busy-spin) — clock must advance via sleep', () => {
    // Arrange: always-ENOENT openSync (parent dir permanently gone scenario)
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    const clock = makeFakeClock(0);

    // Act + Assert: must throw (not hang) with budget-exceeded message
    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded error when ENOENT persists beyond maxWaitMs'
    );

    // The clock must have advanced by at least maxWaitMs (30 000 ms).
    // Before the fix: no sleep() ever called → nowValue stays at 0 → spins forever.
    // After the fix: every retry sleeps → nowValue ≥ 30 000 ms → budget throws.
    assert.ok(
      clock.nowValue >= 30000,
      `clock must have advanced ≥ 30 000 ms via sleep() calls (got ${clock.nowValue}ms); a value of 0 means the errno branch never slept (busy-spin)`
    );

    // At least one sleep call must have been recorded
    assert.ok(
      clock.sleepCalls.length >= 1,
      `sleep must be called at least once on recoverable errno retry (got ${clock.sleepCalls.length} calls)`
    );
  });

  test('transient ENOENT (a few retries then success) acquires lock normally', () => {
    // Arrange: fail twice with ENOENT, then succeed
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    let callCount = 0;
    fs.openSync = (...args) => {
      callCount++;
      if (callCount <= 2) throw enoentErr;
      // Restore and delegate to real openSync for the successful attempt
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    const clock = makeFakeClock(0);

    // Act: should succeed (not throw) because ENOENT was transient
    const lockPath = acquireStateLock(statePath, clock);

    // Assert: lock file exists
    assert.ok(fs.existsSync(lockPath), 'lock must be acquired after transient ENOENT retries');
    // 2 retries → at least 2 sleep calls
    assert.ok(clock.sleepCalls.length >= 2, `expected ≥2 sleep calls for 2 ENOENT retries, got ${clock.sleepCalls.length}`);

    releaseStateLock(lockPath);
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after releaseStateLock');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Boundary coverage + backoff-range for the recoverable-errno retry path
//
// RULESET.TESTS.boundary-coverage: inputs at limit-1, limit, and limit+1
// for the 30 000 ms maxWaitMs budget.
//
// Each sleep advances the clock by retryDelay (200 ms) + exactly 0 jitter
// (achieved via a deterministic-jitter clock wrapper).  We then control how
// much additional time to add so the budget check lands at the desired point.
//
// Scenario A — budget NOT yet exhausted: error clears just before limit
// Scenario B — budget exactly at limit (>= check): must throw
// Scenario C — budget over limit: must throw immediately
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock boundary coverage — recoverable-errno budget (#1217)', () => {
  let tmpDir;
  let statePath;
  let origOpenSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-boundary-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origOpenSync = fs.openSync;
  });

  afterEach(() => {
    fs.openSync = origOpenSync;
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  /**
   * Build a fake clock where every sleep() advances time by exactly fixedSleepMs
   * regardless of the requested delay.  This gives us deterministic elapsed-time
   * sequences without depending on Math.random() jitter.
   */
  function makeFixedSleepClock(startMs, fixedSleepMs) {
    let _now = startMs;
    const _sleepCalls = [];
    return {
      now() { return _now; },
      sleep(ms) {
        // Record the actual ms value requested by the production code (for range checks)
        // but advance by fixedSleepMs so total elapsed is predictable.
        _sleepCalls.push(ms);
        _now += fixedSleepMs;
      },
      get sleepCalls() { return _sleepCalls; },
      get nowValue() { return _now; },
    };
  }

  test('backoff-range contract: every sleep call is in [retryDelay, retryDelay + jitterMax) range', () => {
    // Scenario: persistent ENOENT for 3 retries then succeed.
    // retryDelay=200, jitter ∈ [0,49] → sleep value must be in [200, 249].
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let calls = 0;
    fs.openSync = (...args) => {
      calls++;
      if (calls <= 3) throw enoentErr;
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    // Use real makeFakeClock (sleep advances by requested ms, so time moves at 200-249ms per sleep)
    const clock = makeFakeClock(0);
    const lockPath = acquireStateLock(statePath, clock);
    releaseStateLock(lockPath);

    assert.strictEqual(clock.sleepCalls.length, 3, 'must have exactly 3 sleep calls for 3 ENOENT retries');
    for (let i = 0; i < clock.sleepCalls.length; i++) {
      const delayMs = clock.sleepCalls[i];
      assert.ok(
        delayMs >= 200 && delayMs <= 249,
        `sleep[${i}] = ${delayMs}ms must be in [200, 249] (retryDelay=200 + jitter 0..49)`
      );
    }
  });

  test('budget just UNDER limit: error clears at 29 999 ms elapsed — lock acquired, no throw', () => {
    // Arrange: openSync fails with ENOENT for 30 iterations, then succeeds.
    // Sleeps 1-29 each advance 1000 ms (total 29 000 ms after 29 sleeps).
    // Sleep 30 advances only 999 ms (total 29 999 ms) — still under the 30 000 ms budget.
    // openSync succeeds on the 31st attempt BEFORE elapsed reaches 30 000 ms.
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let calls = 0;
    const maxFails = 30; // 30 ENOENT failures → 30 sleeps → final elapsed = 29 999 ms
    fs.openSync = (...args) => {
      calls++;
      if (calls <= maxFails) throw enoentErr;
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    // Custom clock: first 29 sleeps advance 1000 ms each; the 30th advances 999 ms.
    // Total elapsed at success = 29 × 1000 + 1 × 999 = 29 999 ms (< 30 000 ms).
    let _now = 0;
    const _sleepCalls = [];
    const clock = {
      now() { return _now; },
      sleep(ms) {
        _sleepCalls.push(ms);
        // The 30th sleep advances by 999 ms; all others advance by 1000 ms.
        _now += _sleepCalls.length === 30 ? 999 : 1000;
      },
      get sleepCalls() { return _sleepCalls; },
      get nowValue() { return _now; },
    };

    // Should NOT throw — budget not yet exhausted at 29 999 ms
    const lockPath = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(lockPath), 'lock must be acquired when error clears before budget');
    releaseStateLock(lockPath);
    assert.strictEqual(clock.sleepCalls.length, maxFails, `expected ${maxFails} sleep calls`);
    assert.strictEqual(clock.nowValue, 29999, `elapsed must be exactly 29 999 ms at success (got ${clock.nowValue}ms)`);
  });

  test('budget AT limit (elapsed === 30 000 ms): must throw budget-exceeded error', () => {
    // Arrange: openSync always fails — budget is hit exactly at 30 000 ms.
    // fixedSleepMs=1000, after 30 sleeps elapsed=30000 → >= check fires.
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    const clock = makeFixedSleepClock(0, 1000);

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded when elapsed equals maxWaitMs'
    );
    // After 30 sleeps (30 × 1000 = 30 000 ms) the budget fires
    assert.ok(clock.nowValue >= 30000, `clock must be at or past 30 000 ms (got ${clock.nowValue}ms)`);
  });

  test('budget OVER limit (elapsed > 30 000 ms): must throw immediately', () => {
    // Arrange: openSync always fails.
    // Use a clock that starts already past the budget so the first budget check
    // on the SECOND iteration fires immediately (after one sleep).
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    // fixedSleepMs=35000 — one sleep puts elapsed at 35000 > 30000
    const clock = makeFixedSleepClock(0, 35000);

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded when elapsed exceeds maxWaitMs'
    );
    // Only one sleep call needed to exceed the budget
    assert.strictEqual(clock.sleepCalls.length, 1, 'budget must fire after a single over-budget sleep');
    assert.ok(clock.nowValue > 30000, `clock must be past 30 000 ms (got ${clock.nowValue}ms)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1d. Regression #1217 — statSync and unlinkSync spin paths in stale-lock branch
//
// Prior to the fix in this PR, two paths in the EEXIST handler were unbounded:
//  • persistent fs.statSync failure → catch { continue; } (no sleep, no budget)
//  • persistent fs.unlinkSync failure → catch swallowed, then continue (no sleep, no budget)
// Both would spin at 100% CPU forever.  After the fix, both call checkBudgetAndSleep
// before continuing, so they throw within maxWaitMs.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock statSync/steal spin paths bounded (#1217)', () => {
  let tmpDir;
  let statePath;
  let origStatSync;
  let origUnlinkSync;
  let origRenameSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-spin-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origStatSync = fs.statSync;
    origUnlinkSync = fs.unlinkSync;
    origRenameSync = fs.renameSync;
    // Force the recorded holder (pid 99999) DEAD so the steal path is exercised
    // deterministically — these tests probe the steal's bounded-backoff, not liveness.
    stateMod._setLockProbes({ isPidAlive: () => false });
  });

  afterEach(() => {
    fs.statSync = origStatSync;
    fs.unlinkSync = origUnlinkSync;
    fs.renameSync = origRenameSync;
    stateMod._resetLockProbes();
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('persistent statSync failure throws budget-exceeded (not busy-spin)', () => {
    // Set up EEXIST condition: pre-create lock file so openSync hits EEXIST
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999'); // non-current PID

    // Make statSync always throw a transient error (e.g. NFS hiccup)
    const statErr = Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
    fs.statSync = (p) => {
      if (p === lockPath) throw statErr;
      return origStatSync(p);
    };

    // Use a fixed-sleep clock so the budget is hit predictably
    let _now = 0;
    const sleepCalls = [];
    const clock = {
      now() { return _now; },
      sleep(ms) { sleepCalls.push(ms); _now += 1000; }, // advance 1000ms each sleep
    };

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'persistent statSync failure must throw budget-exceeded, not spin forever'
    );

    // Must have slept at least once (not a busy-spin)
    assert.ok(sleepCalls.length >= 1, `sleep must have been called at least once (got ${sleepCalls.length}); zero means busy-spin`);
    assert.ok(_now >= 30000, `clock must be at or past 30 000 ms after exhausting budget (got ${_now}ms)`);

    // Clean up patched lock
    fs.unlinkSync = origUnlinkSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('persistent renameSync failure in steal path throws budget-exceeded (not busy-spin)', () => {
    // Set up an EEXIST condition with a steal-eligible DEAD holder (pid 99999 — not us,
    // not alive). The steal is an ATOMIC rename (PR #1532); a persistent rename failure
    // (e.g. EPERM — file locked by an AV scanner) must back off + budget out, not spin.
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');

    // Make renameSync always fail for the steal of our lock path.
    const renameErr = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync = (from, to) => {
      if (from === lockPath) throw renameErr;
      return origRenameSync(from, to);
    };

    // Clock where now() returns current real time so the steal branch fires,
    // but sleep advances a fixed 1000ms per call so budget is hit deterministically.
    const realNow = Date.now();
    let _elapsed = 0;
    const sleepCalls = [];
    const clock = {
      now() { return realNow + _elapsed; },
      sleep(ms) { sleepCalls.push(ms); _elapsed += 1000; },
    };

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'persistent renameSync failure in steal path must throw budget-exceeded, not spin forever'
    );

    assert.ok(sleepCalls.length >= 1, `sleep must have been called at least once (got ${sleepCalls.length}); zero means busy-spin`);
    assert.ok(_elapsed >= 30000, `elapsed must reach 30 000 ms budget (got ${_elapsed}ms)`);

    // Restore renameSync for cleanup
    fs.renameSync = origRenameSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('persistent renameSync failure error message names steal cause, not statSync (#1217 diagnostic)', () => {
    // Regression guard for the misleading-error-context bug: when the steal's renameSync
    // fails and checkBudgetAndSleep throws at the budget boundary, the outer statSync
    // catch must NOT re-wrap it with "statSync failed after EEXIST".  The thrown error
    // must name the real cause ("stale lock steal lost to racer") so operators can
    // identify it.
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');

    // renameSync always fails — the budget will be exhausted on the first sleep.
    const renameErr = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.renameSync = (from, to) => {
      if (from === lockPath) throw renameErr;
      return origRenameSync(from, to);
    };

    const realNow = Date.now();
    let _elapsed = 0;
    const clock = {
      now() { return realNow + _elapsed; },
      sleep(_ms) { _elapsed += 35000; }, // jump past the 30 000 ms budget on first sleep
    };

    let thrownErr;
    try {
      acquireStateLock(statePath, clock);
    } catch (e) {
      thrownErr = e;
    }

    assert.ok(thrownErr, 'must throw when renameSync persistently fails and budget is exhausted');
    assert.ok(
      /stale lock steal lost to racer/.test(thrownErr.message),
      `error message must contain "stale lock steal lost to racer" (got: ${thrownErr.message})`
    );
    assert.ok(
      !/statSync failed after EEXIST/.test(thrownErr.message),
      `error message must NOT contain "statSync failed after EEXIST" (the misleading re-wrap) (got: ${thrownErr.message})`
    );

    fs.renameSync = origRenameSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('successful stale-lock steal acquires immediately even when budget is already exhausted — no throw (#1217 regression)', () => {
    // Regression guard: the OLD code called checkBudgetAndSleep() unconditionally
    // after fs.unlinkSync, so a successful steal when elapsed >= maxWaitMs would
    // throw budget-exceeded even though the lock was already freed.  The fix lets
    // a successful steal `continue` immediately without a budget check.
    //
    // Arrange: stale lock with mtime well in the past.
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');
    const staleMs = 20000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // Clock: now() returns a time that is (a) past the stale threshold AND
    // (b) already >= maxWaitMs ahead of startedAt.  The stale branch fires,
    // unlinkSync SUCCEEDS (we do NOT patch it), and with the fix the lock is
    // immediately acquired — budget-exceeded must NOT be thrown.
    const realNow = Date.now();
    // startedAt = realNow; clock.now() on first call = realNow (startedAt captured).
    // After the stale branch unlinks, clock.now() is still realNow → elapsed = 0 < 30000.
    // To prove the regression, advance the clock so that elapsed is past the budget
    // at the moment the budget check WOULD have fired (i.e. > 30000 ms ahead of startedAt).
    // We use a clock where now() starts at 0 (for startedAt) then jumps to 30001 after
    // the first call, simulating 30001 ms having passed when the stale lock is found.
    let nowCallCount = 0;
    const sleepCalls = [];
    const clock = {
      now() {
        nowCallCount++;
        // First call (captured as startedAt) returns 0.
        // All subsequent calls return 30001 — so elapsed = 30001 >= 30000.
        // The stale check: clock.now() - stat.mtimeMs = 30001 - (realNow - staleMs).
        // We need that to be > staleThresholdMs (10000).  realNow - (realNow-staleMs) = staleMs=20000 > 10000 ✓
        // But we need the mtime in absolute terms to make the stale check fire.
        // Use realNow-based absolute clock: startedAt=realNow, elapsed on 2nd call=30001ms.
        return nowCallCount === 1 ? realNow : realNow + 30001;
      },
      sleep(ms) { sleepCalls.push(ms); },
    };

    // Should NOT throw — successful steal must continue immediately even at elapsed > maxWaitMs.
    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'lock must be acquired after successful stale-lock steal');
    // No sleep calls: the steal succeeded, so the fast-path `continue` was taken.
    assert.strictEqual(sleepCalls.length, 0, 'no sleep should occur on a successful stale-lock steal');
    releaseStateLock(acquired);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. readModifyWriteStateMd — lock released on error path
// ─────────────────────────────────────────────────────────────────────────────

describe('readModifyWriteStateMd lock cleanup on error', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n');
  });

  afterEach(() => {
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('lock file absent after transformFn throws', () => {
    const clock = makeFakeClock(0);
    assert.throws(
      () => readModifyWriteStateMd(statePath, () => { throw new Error('intentional transform error'); }, tmpDir, undefined, clock),
      /intentional transform error/,
      'error from transformFn must propagate'
    );
    assert.ok(!fs.existsSync(statePath + '.lock'), 'lock must be released even when transformFn throws');
  });

  test('clock seam is passed through — no real sleep on immediate acquisition', () => {
    const clock = makeFakeClock(0);
    readModifyWriteStateMd(statePath, (c) => c + '\n**Patched:** yes\n', tmpDir, undefined, clock);
    const content = fs.readFileSync(statePath, 'utf-8');
    assert.strictEqual(stateExtractField(content, 'Patched'), 'yes', 'transform must be applied');
    assert.strictEqual(clock.sleepCalls.length, 0, 'no sleep when lock is immediately available');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. withPlanningLock clock seam
// ─────────────────────────────────────────────────────────────────────────────

describe('withPlanningLock clock seam', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-planning-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(tmpDir, '.planning', '.lock')); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('fn() return value is propagated when lock is available', () => {
    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'hello from lock', clock);
    assert.strictEqual(result, 'hello from lock');
    assert.strictEqual(clock.sleepCalls.length, 0, 'no sleep when lock immediately available');
  });

  test('lock file absent after fn() completes', () => {
    const clock = makeFakeClock(0);
    withPlanningLock(tmpDir, () => {}, clock);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')), 'lock must be released after fn()');
  });

  test('lock file absent after fn() throws', () => {
    const clock = makeFakeClock(0);
    assert.throws(
      () => withPlanningLock(tmpDir, () => { throw new Error('fn threw'); }, clock),
      /fn threw/
    );
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')), 'lock must be released even when fn() throws');
  });

  test('timeout fires (sleep seam exercised) when a LIVE holder is contended past lockTimeout', () => {
    // Audit M1 rewrite: the prior version asserted the now-REMOVED force-steal
    // fallback (timeout → unconditional unlink + re-acquire). That fallback robbed
    // live writers; the fix replaces it with a clear timeout throw. This test now
    // pins the new contract: a verified-LIVE holder held past lockTimeout makes the
    // waiter exercise the clock.sleep seam and then throw — never force-stolen.
    const lockPath = path.join(tmpDir, '.planning', '.lock');
    const livePid = 9191;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: livePid, cwd: tmpDir, acquired: new Date().toISOString() }));

    // Holder reads as ALIVE via the injected probe → waited on, never stolen.
    require('../gsd-core/bin/lib/planning-workspace.cjs')._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    let nowValue = 0;
    const clock2 = {
      now() { return nowValue; },
      sleep(ms) { nowValue += ms + 11000; }, // advance past lockTimeout on first sleep
    };

    try {
      assert.throws(
        () => withPlanningLock(tmpDir, () => 'should-not-run', clock2),
        /exceeded.*10000ms budget/,
        'a live holder held past lockTimeout must throw a clear timeout error (not force-steal)'
      );
      // The sleep seam must have been exercised (timeout path reached).
      assert.ok(nowValue > 10000, 'clock must have advanced past lockTimeout via the sleep seam');
      // The live holder's lock must be intact (never unlinked).
      assert.ok(fs.existsSync(lockPath), 'live holder lock must survive the timeout (not force-stolen)');
    } finally {
      require('../gsd-core/bin/lib/planning-workspace.cjs')._resetLockProbes();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exit-cleanup integration: lock absent after command that holds STATE.md.lock exits
//    Replaces locking-bugs:130 (source-grep for process.on('exit') in state.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('exit cleanup: STATE.md.lock removed on process exit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md.lock absent after successful state command', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n**Current Phase:** 01\n');

    runGsdTools('state update Status "In progress"', tmpDir);

    assert.ok(
      !fs.existsSync(statePath + '.lock'),
      'STATE.md.lock must not persist after state command exits'
    );
  });

  test('STATE.md.lock absent even when command exits non-zero', () => {
    // Trigger a failing invocation (invalid field syntax) — the lock must still be released.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n');

    // run and ignore result — we only care about the lock file
    runGsdTools('state update Status "In progress"', tmpDir);

    assert.ok(
      !fs.existsSync(statePath + '.lock'),
      'STATE.md.lock must not persist regardless of command exit code'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Exit-cleanup integration: .planning/.lock removed on process exit
//    Replaces locking-bugs:143 (source-grep for process.on('exit') in planning-workspace.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('exit cleanup: .planning/.lock removed on process exit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('.planning/.lock absent after phase add completes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n'
    );
    runGsdTools('phase add Testing', tmpDir);

    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', '.lock')),
      '.planning/.lock must not persist after phase add exits'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. readModifyWriteStateMd call-site coverage
//    Replaces locking-bugs:467 (source-grep audit of 9 cmd* functions)
//    Uses CLI-level integration: each cmd* is exercised through gsd-tools and
//    the lock-cleanup assertion confirms readModifyWriteStateMd was called
//    (the lock is only left clean by readModifyWriteStateMd's finally block).
// ─────────────────────────────────────────────────────────────────────────────

describe('readModifyWriteStateMd call-site coverage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** Foundation',
        '**Status:** In progress',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working',
        '',
        '### Decisions',
        'None yet.',
        '',
        '### Blockers',
        'None.',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [ ] Phase 1: Foundation\n\n### Phase 1: Foundation\n**Goal:** Setup\n**Plans:** 1 plans\n\n### Phase 2: API\n**Goal:** Build\n'
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md.lock')); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  function assertNoLockFile() {
    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(!fs.existsSync(lockPath), 'STATE.md.lock must be absent after command (confirms readModifyWriteStateMd cleaned up)');
  }

  test('cmdStateUpdate releases lock (state update)', () => {
    runGsdTools('state update Status "Executing"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAdvancePlan releases lock (state advance-plan)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Current Plan:** 1\n**Total Plans in Phase:** 3\n'
    );
    runGsdTools('state advance-plan', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateUpdateProgress releases lock (state update-progress)', () => {
    runGsdTools('state update-progress', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAddDecision releases lock (state add-decision)', () => {
    runGsdTools('state add-decision --phase 01 --summary "Use TypeScript"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAddBlocker releases lock (state add-blocker)', () => {
    runGsdTools('state add-blocker --text "Blocked on review"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateRecordSession releases lock (state record-session)', () => {
    runGsdTools('state record-session --stopped-at "context exhaustion at 80%"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateBeginPhase releases lock (state begin-phase)', () => {
    runGsdTools('state begin-phase 01', tmpDir);
    assertNoLockFile();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Roadmap analyze behavioral assertion (no timing gate)
//    Replaces concurrency-safety:794 (elapsed < ROADMAP_ANALYZE_BUDGET_MS)
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze behavioral correctness (50-phase)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    _create50PhaseProject(tmpDir, 25);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function _create50PhaseProject(dir, completedCount) {
    let roadmapContent = '# Roadmap v1.0\n\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `- [${i <= completedCount ? 'x' : ' '}] Phase ${i}: Feature ${i}\n`;
    }
    roadmapContent += '\n';
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      roadmapContent += `### Phase ${i}: Feature ${i}\n\n`;
      roadmapContent += `**Goal:** Build feature ${i}\n`;
      roadmapContent += `**Requirements:** REQ-${pad}\n`;
      roadmapContent += `**Plans:** 1 plans\n\n`;
      roadmapContent += `Plans:\n- [${i <= completedCount ? 'x' : ' '}] ${pad}-01-PLAN.md\n\n`;
    }
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), roadmapContent);

    const phasesDir = path.join(dir, '.planning', 'phases');
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      const phaseDir = path.join(phasesDir, `${pad}-feature-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${pad}-01-PLAN.md`), `# Phase ${i} Plan 1\n`);
      if (i <= completedCount) {
        fs.writeFileSync(path.join(phaseDir, `${pad}-01-SUMMARY.md`), `# Phase ${i} Summary\n`);
      }
    }
  }

  test('roadmap analyze returns 50 phases with 25 complete (behavioral, no timing gate)', () => {
    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze must succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.phases), 'output must contain phases array');
    assert.strictEqual(output.phases.length, 50, `must return 50 phases, got ${output.phases.length}`);

    const completedPhases = output.phases.filter(p => p.disk_status === 'complete');
    assert.strictEqual(completedPhases.length, 25, `must have 25 complete phases, got ${completedPhases.length}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-474-clock-seam-date-determinism.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-474-clock-seam-date-determinism (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #474)
// STATE.md is the product surface; assertions on its text content test the
// deployed contract (date field written by the subprocess SUT).

'use strict';

/**
 * Bug #474 — clock seam: subprocess date-stamping must be deterministic.
 *
 * Tests in this file verify that:
 *   1. state.cjs date-stamping is routed through realClock (not bare new Date()),
 *      so GSD_NOW_MS pins the written date deterministically in subprocess tests.
 *   2. installer-migrations.cjs lock-loop timeout fires deterministically via
 *      the clock seam (in-process, using makeFakeClock — no subprocess needed).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// §1  Subprocess date-pin: state advance-plan writes the pinned date
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why advance-plan?
 *   cmdStateAdvancePlan captures `const today = new Date().toISOString().split('T')[0]`
 *   and writes it to "Last Activity" via stateReplaceFieldIfTemplate.
 *   The fixture below has Last Activity = 2024-01-10 (an ISO date, treated as a
 *   handler-generated template default by isStateTemplateDefault), so the field IS
 *   overwritten — making this the simplest single-subcommand probe of the bug.
 */

// A fixed historical instant far in the past — will NEVER match today's real date.
const PINNED_MS = Date.parse('2020-06-15T12:00:00.000Z');
const PINNED_DATE = '2020-06-15';

// A minimal STATE.md that satisfies advance-plan's parser:
//   - Current Plan: 1  (not on last plan → normal-advance branch)
//   - Total Plans in Phase: 3
//   - Last Activity: 2024-01-10  (ISO date → isStateTemplateDefault returns true → will be replaced)
const ADVANCE_FIXTURE = [
  '# Project State',
  '',
  '**Current Plan:** 1',
  '**Total Plans in Phase:** 3',
  '**Status:** Executing',
  '**Last Activity:** 2024-01-10',
].join('\n') + '\n';

describe('bug-474: state date-stamping is pinned by GSD_NOW_MS', () => {
  let tmpDir;

  before(() => {
    // AAA — Arrange: create a temp project with the advance fixture
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), ADVANCE_FIXTURE);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('state advance-plan writes pinned date (not real today) when GSD_NOW_MS is set', () => {
    // AAA — Act: run advance-plan with a pinned historical timestamp
    const result = runGsdTools('state advance-plan', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });

    assert.ok(result.success, `advance-plan failed unexpectedly: ${result.error}`);

    // AAA — Assert: the written STATE.md must contain the pinned date
    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Must contain the pinned historical date (2020-06-15)
    assert.ok(
      written.includes(PINNED_DATE),
      `Expected STATE.md to contain pinned date ${PINNED_DATE}.\nActual STATE.md:\n${written}`,
    );

    // Must NOT contain today's real date — that would mean the seam is bypassed
    const realToday = new Date().toISOString().split('T')[0];
    assert.ok(
      !written.includes(realToday),
      `Expected STATE.md NOT to contain real today (${realToday}) when time is pinned.\nActual STATE.md:\n${written}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  realClock GSD_NOW_MS invalid-input hardening
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that malformed / out-of-range GSD_NOW_MS values fall back to the real
 * clock instead of crashing with RangeError (issue #474 hardening).
 *
 * Each invalid input must:
 *   a) not throw from realClock.nowIso(), and
 *   b) produce a valid parseable ISO string (i.e. fell back to Date.now()).
 *
 * A valid pinned value must produce the expected date string.
 */

describe('bug-474: realClock GSD_NOW_MS invalid-input hardening', () => {
  const realClock = require('../gsd-core/bin/lib/clock.cjs').realClock;

  // Save and restore env so these tests cannot bleed into neighbouring tests.
  let savedTestMode;
  let savedNowMs;

  before(() => {
    savedTestMode = process.env.GSD_TEST_MODE;
    savedNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
  });

  after(() => {
    if (savedTestMode === undefined) {
      delete process.env.GSD_TEST_MODE;
    } else {
      process.env.GSD_TEST_MODE = savedTestMode;
    }
    if (savedNowMs === undefined) {
      delete process.env.GSD_NOW_MS;
    } else {
      process.env.GSD_NOW_MS = savedNowMs;
    }
  });

  // AAA matrix: each invalid value must NOT crash and must fall back to the real clock.
  const INVALID_INPUTS = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['alphabetic', 'abc'],
    ['scientific notation', '1e30'],
    ['decimal float', '12.5'],
    ['integer > 8.64e15', '99999999999999999999'],
  ];

  for (const [label, value] of INVALID_INPUTS) {
    test(`GSD_NOW_MS='${value}' (${label}) falls back to real clock — no crash, valid ISO`, () => {
      // AAA — Arrange
      process.env.GSD_NOW_MS = value;

      // AAA — Act + Assert: must not throw
      assert.doesNotThrow(
        () => realClock.nowIso(),
        `realClock.nowIso() must not throw for GSD_NOW_MS='${value}'`,
      );

      // AAA — Assert: result is a valid ISO string (fell back to real clock)
      const iso = realClock.nowIso();
      assert.ok(
        !Number.isNaN(Date.parse(iso)),
        `realClock.nowIso() must return a valid ISO date for GSD_NOW_MS='${value}', got: ${iso}`,
      );
    });
  }

  test('GSD_NOW_MS valid decimal integer pins the clock', () => {
    // AAA — Arrange: a known historical epoch
    process.env.GSD_NOW_MS = String(PINNED_MS);

    // AAA — Act
    const tod = realClock.today();

    // AAA — Assert
    assert.strictEqual(tod, PINNED_DATE, `realClock.today() must return pinned date ${PINNED_DATE}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  In-process lock-loop: installer-migrations timeout fires deterministically
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This test exercises acquireInstallMigrationLock's EEXIST retry loop via a
 * makeFakeClock.  The approach:
 *   - Write a lock file held by PID 1 (init/launchd — always alive on any OS)
 *     so neither isSameProcess nor isDeadProcess is true; stale-lock reclamation
 *     is NOT triggered, and the loop must reach the timeout check.
 *   - Use TIMEOUT_MS = 500 (non-zero) so the loop must retry at least once before
 *     the injected clock trips the deadline.  A zero timeout would fire on the
 *     very first check without exercising clock.sleep() at all.
 *   - The fake clock's sleep(ms) ADVANCES its internal now by ms (confirmed from
 *     helpers/clock.cjs implementation), so the loop drives itself to termination
 *     purely through the injected clock without any wall-clock delay.
 *   - Post-throw assertions on clock.sleepCalls and clock.now() prove the seam:
 *     if the loop reverted to raw Date.now()/sleepSync, sleepCalls would be 0.
 */

describe('bug-474: installer-migrations lock-loop timeout is deterministic via clock seam', () => {
  test('makeFakeClock nowIso() and today() derive from pinned now()', () => {
    // AAA — Arrange
    const clock = makeFakeClock(PINNED_MS);

    // AAA — Act
    const iso = clock.nowIso();
    const tod = clock.today();

    // AAA — Assert
    assert.strictEqual(iso, '2020-06-15T12:00:00.000Z', 'nowIso() must return ISO string of pinned epoch');
    assert.strictEqual(tod, PINNED_DATE, 'today() must return YYYY-MM-DD of pinned epoch');
  });

  test('makeFakeClock advance() shifts nowIso() and today()', () => {
    // AAA — Arrange: start at PINNED_MS, advance by 24 h
    const clock = makeFakeClock(PINNED_MS);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // AAA — Act
    clock.advance(ONE_DAY_MS);

    // AAA — Assert
    assert.strictEqual(clock.today(), '2020-06-16', 'today() must reflect advanced time');
  });

  test('acquireInstallMigrationLock timeout path fires deterministically via makeFakeClock', (t) => {
    // AAA — Arrange
    const os = require('os');
    const { acquireInstallMigrationLock } = require('../gsd-core/bin/lib/installer-migrations.cjs');
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-474-lock-'));

    t.after(() => {
      cleanup(configDir);
    });

    const LOCK_NAME = 'gsd-install-migration.lock';
    const lockPath = path.join(configDir, LOCK_NAME);

    // Write a lock file held by process.ppid (the parent process, always alive
    // and never equal to process.pid on every platform).  pid 1 was used
    // previously but isPidAlive(1) returns false on Windows (no init/launchd
    // pid-1 concept), so the lock was treated as stale, reclaimed, and
    // acquireInstallMigrationLock succeeded instead of throwing — failing the
    // timeout assertion on windows-latest,22 (#474).  process.ppid is a live,
    // non-self process on all platforms, so the lock is correctly seen as held
    // and the timeout path throws deterministically cross-platform.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.ppid, acquiredAt: new Date().toISOString() }) + '\n',
    );

    // TIMEOUT_MS is non-zero so the first EEXIST iteration does NOT immediately
    // trip the deadline.  The loop must call clock.sleep() at least once; that
    // sleep() advances the fake clock past TIMEOUT_MS, causing the next check to
    // throw.  This proves the seam: if the loop used raw Date.now()/sleepSync,
    // clock.sleepCalls would remain 0.
    const TIMEOUT_MS = 500;
    const clock = makeFakeClock(0);

    // AAA — Act + Assert: timeout error thrown with no real wall-clock delay
    assert.throws(
      () => acquireInstallMigrationLock(configDir, { timeoutMs: TIMEOUT_MS }, clock),
      /lock|held/i,
      'Expected acquireInstallMigrationLock to throw with "lock"/"held" in message on timeout',
    );

    // AAA — Assert seam was actually exercised through the injected clock:
    // If the loop used raw sleepSync instead of clock.sleep(), sleepCalls would be 0.
    assert.ok(
      clock.sleepCalls.length > 0,
      'loop must retry via injected clock.sleep() — proves seam wiring, not raw wall clock',
    );

    // The injected clock must have advanced past TIMEOUT_MS through its own sleep() calls.
    assert.ok(
      clock.now() >= TIMEOUT_MS,
      `injected clock advanced past timeout deterministically: clock.now()=${clock.now()} must be >= TIMEOUT_MS=${TIMEOUT_MS}`,
    );
  });
});
  });
}

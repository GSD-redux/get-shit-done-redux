'use strict';

/**
 * Regression tests for #3772 — acquireStateLock silently returned false-success
 * on non-EEXIST openSync errors (EMFILE / EINTR / ENOSPC under load).
 *
 * Extended in #3776 to cover Docker overlay-fs and NFS transient errno codes,
 * and in #3057 (B2) to cover the steal-decision fault path for an unreadable
 * lock body (merged in from tests/state-lock-body-unreadable.test.cjs, which
 * this file absorbed — same acquireStateLock surface, see lint-test-file-count).
 *
 * Every test in this file actually CALLS acquireStateLock (never regexes the
 * built .cjs source) and injects errno faults via `withFaultyFs` on the exact
 * fs.openSync call the lock-create path makes (src/state.cts, the
 * `fs.openSync(lockPath, O_CREAT|O_EXCL|O_WRONLY)` line inside
 * acquireStateLock's retry loop) — never chmod/subprocess tricks.
 *
 * Contract under test:
 *   C1. A fatal non-EEXIST error (EACCES) propagates/throws — not swallowed
 *       as EEXIST contention and not retried.
 *   C2. Success path (openSync succeeds) → returns lockPath and writes this
 *       process's pid into the lock body.
 *   C4/C7. ACQUIRE_LOCK_RETRY_ERRNOS codes (EAGAIN/EINTR/EINVAL/EIO/ENOENT/
 *       ESTALE/EPERM/EBUSY) are retried — the open eventually succeeds and
 *       exactly one contention-style backoff (clock.sleep) occurs first.
 *   C5/C6. Fatal codes (EMFILE/ENOSPC/EROFS) and unknown codes propagate
 *       immediately — zero backoff, the error is thrown on the first attempt.
 *   (C8 — "uses a Set, not an inline literal" — is an implementation-shape
 *   assertion with no independent runtime signature; it is subsumed by C4c-f
 *   above, since a regression to the old inline EPERM||EBUSY check would fail
 *   those newer-errno retry assertions.)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeFakeClock } = require('./helpers/clock.cjs');
const { withFaultyFs } = require('./helpers/faulty-deps.cjs');
const { cleanup } = require('./helpers.cjs');
const { acquireStateLock, releaseStateLock } = require('../gsd-core/bin/lib/state.cjs');

const originalOpenSync = fs.openSync;
const originalReadFileSync = fs.readFileSync;

/** Fresh temp project dir with a STATE.md, for a single test. */
function makeTempState() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lock-non-eexist-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  const statePath = path.join(tmpDir, '.planning', 'STATE.md');
  fs.writeFileSync(statePath, '# State\n');
  return { tmpDir, statePath };
}

/** Back-date `lockPath`'s mtime by `ageMs` (real fs time, not fake-clock). */
function backdateMtime(lockPath, ageMs) {
  const staled = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, staled, staled);
}

/**
 * Build a `t`-taking test body that faults fs.openSync for `lockPath` ONCE
 * with `code`, then lets the retried open succeed for real — proving the
 * errno is retried (not thrown) and exactly one backoff occurs.
 */
function assertOpenSyncErrorIsRetried(code) {
  return (t) => {
    const { tmpDir, statePath } = makeTempState();
    t.after(() => cleanup(tmpDir));
    const lockPath = statePath + '.lock';
    const clock = makeFakeClock(0);
    let calls = 0;
    const acquired = withFaultyFs(
      {
        openSync: (p, ...rest) => {
          if (String(p) === lockPath) {
            calls++;
            if (calls === 1) {
              throw Object.assign(new Error(code + ': injected transient error'), { code });
            }
          }
          return originalOpenSync(p, ...rest);
        },
      },
      () => acquireStateLock(statePath, clock),
    );
    t.after(() => releaseStateLock(acquired));
    assert.equal(
      acquired, lockPath,
      code + ' must be retried and the retried open must succeed, not be thrown immediately',
    );
    assert.equal(
      clock.sleepCalls.length, 1,
      code + ' must trigger exactly one contention-style backoff before the retried open succeeds',
    );
  };
}

/**
 * Build a `t`-taking test body that faults fs.openSync for `lockPath` on
 * EVERY call with `code` — proving the errno propagates on the first attempt
 * with zero backoff (fatal, not retried).
 */
function assertOpenSyncErrorIsFatal(code) {
  return (t) => {
    const { tmpDir, statePath } = makeTempState();
    t.after(() => cleanup(tmpDir));
    const lockPath = statePath + '.lock';
    const clock = makeFakeClock(0);
    assert.throws(
      () => withFaultyFs(
        {
          openSync: (p, ...rest) => {
            if (String(p) === lockPath) {
              throw Object.assign(new Error(code + ': injected fatal error'), { code });
            }
            return originalOpenSync(p, ...rest);
          },
        },
        () => acquireStateLock(statePath, clock),
      ),
      (err) => err.code === code,
      code + ' must propagate to the caller rather than being retried or swallowed',
    );
    assert.equal(
      clock.sleepCalls.length, 0,
      code + ' must not trigger a contention/backoff retry before throwing',
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1. Non-EEXIST fatal error → must throw, not be swallowed as contention
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock: non-EEXIST openSync errors (#3772)', () => {
  test(
    'C1: a fatal non-EEXIST error (EACCES) propagates — not swallowed as EEXIST contention',
    assertOpenSyncErrorIsFatal('EACCES'),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C2. Success path → returns lockPath and writes this process's pid
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock: success path still returns lockPath', () => {
  test('C2: openSync succeeding returns the lock path and writes this process pid', (t) => {
    const { tmpDir, statePath } = makeTempState();
    t.after(() => cleanup(tmpDir));

    const acquired = acquireStateLock(statePath);
    t.after(() => releaseStateLock(acquired));

    assert.equal(acquired, statePath + '.lock', 'acquireStateLock must return the lock path on success');
    assert.ok(fs.existsSync(acquired), 'the lock file must exist on disk after a successful acquire');
    assert.equal(
      fs.readFileSync(acquired, 'utf8'), String(process.pid),
      'the lock body must contain this process pid on the success path',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C4 / C7. Transient errno codes are retried (#3776 / #3773 regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock: transient errno codes are retried, not thrown (#3776)', () => {
  test('C4a: EAGAIN is retried (resource temporarily unavailable)', assertOpenSyncErrorIsRetried('EAGAIN'));
  test('C4b: EINTR is retried (syscall interrupted)', assertOpenSyncErrorIsRetried('EINTR'));
  test('C4c: EINVAL is retried (Docker overlay-fs transient)', assertOpenSyncErrorIsRetried('EINVAL'));
  test('C4d: EIO is retried (Docker overlay-fs / NFS transient)', assertOpenSyncErrorIsRetried('EIO'));
  test('C4e: ENOENT is retried (Docker overlay-fs parent dir transient)', assertOpenSyncErrorIsRetried('ENOENT'));
  test('C4f: ESTALE is retried (NFS stale file handle)', assertOpenSyncErrorIsRetried('ESTALE'));
});

describe('acquireStateLock: EPERM/EBUSY still retried (regression guard, #3773)', () => {
  test('C7a: EPERM is retried (Windows / macOS AV scanner)', assertOpenSyncErrorIsRetried('EPERM'));
  test('C7b: EBUSY is retried (Windows file in use)', assertOpenSyncErrorIsRetried('EBUSY'));
});

// ─────────────────────────────────────────────────────────────────────────────
// C5 / C6. Fatal and unknown errno codes propagate immediately, never retried
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock: fatal errno codes propagate without retry (#3776)', () => {
  test('C5a: EMFILE propagates immediately (fd limit exhausted — fatal)', assertOpenSyncErrorIsFatal('EMFILE'));
  test('C5b: ENOSPC propagates immediately (disk full — fatal)', assertOpenSyncErrorIsFatal('ENOSPC'));
  test('C5c: EROFS propagates immediately (read-only fs — fatal)', assertOpenSyncErrorIsFatal('EROFS'));
  // EACCES is covered by C1 above (the canonical non-EEXIST-fatal case).
});

describe('acquireStateLock: unknown errno codes not retried (conservative default, #3776)', () => {
  test(
    'C6: an unrecognized errno (ESOMETHING) propagates rather than being retried',
    assertOpenSyncErrorIsFatal('ESOMETHING'),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #3057 B2 — an unreadable STATE.md lock body must not get the same
// fresh-create-floor stealable treatment as a genuinely empty one.
//
// `_stateLockBodyPid` used to collapse two different situations to the same
// `null`: a lock body that reads back empty/garbage (the create→write
// window — expected, benign) and a lock body that could not be READ at all
// (an I/O fault — permission error, transient NFS/overlay-fs hiccup, etc.).
// Both got the SAME 1-second (`freshCreateFloorMs`) steal-eligibility
// window, so a transient read fault could rob an actively-held lock exactly
// as fast as a lock that is merely mid-creation.
//
// The fix (`_stateLockBodyStatus`, state.cts) makes the steal decision
// four-way: an unreadable body is now held to the SAME conservative
// `deadmanCeilingMs` ceiling as a verified-live holder, not the short
// fresh-create floor.
//
// These two tests are a pair by construction: identical lock age (past the
// fresh-create floor, nowhere near the deadman ceiling), identical clock
// rig — the ONLY variable is whether the body read throws (fault-injected
// via `withFaultyFs`, never chmod/subprocess) or genuinely reads back empty.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3057 B2: acquireStateLock steal decision — unreadable lock body vs. genuinely empty', () => {
  test('FAILURE path: an unreadable lock body is NOT stolen at the fresh-create-floor age — the acquire budget is exhausted instead', (t) => {
    const { tmpDir, statePath } = makeTempState();
    t.after(() => cleanup(tmpDir));

    const lockPath = statePath + '.lock';
    // Content is irrelevant — the fault-injected read throws before it is ever parsed.
    fs.writeFileSync(lockPath, '12345');
    t.after(() => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } });

    // Age the lock past freshCreateFloorMs (1000ms) but nowhere near
    // deadmanCeilingMs (60000ms) — this is EXACTLY the age at which a
    // genuinely-empty body would already be stolen (see the paired test below).
    backdateMtime(lockPath, 5000);

    const baseClock = makeFakeClock(Date.now() + 100); // ageMs ≈ 5100ms at start
    // Jump the virtual clock past the 30 000ms acquire budget on the very
    // first retry sleep, so the test proves "never stolen within budget"
    // deterministically without hundreds of synchronous retry iterations.
    const fastClock = {
      now: baseClock.now.bind(baseClock),
      sleep(ms) {
        baseClock.sleep(ms);
        baseClock.advance(31000);
      },
    };

    assert.throws(
      () => withFaultyFs(
        {
          readFileSync: (p, ...rest) => {
            if (String(p) === lockPath) {
              throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
            }
            return originalReadFileSync(p, ...rest);
          },
        },
        () => acquireStateLock(statePath, fastClock),
      ),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'an unreadable lock body past the fresh-create-floor age must NOT be stolen — it must hit the acquire-budget timeout',
    );
  });

  test('BENIGN path: a genuinely empty lock body at the SAME age IS stolen (fresh-create-floor path unaffected by the fix)', (t) => {
    const { tmpDir, statePath } = makeTempState();
    t.after(() => cleanup(tmpDir));

    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, ''); // genuinely empty — mid-creation window, not an I/O fault

    backdateMtime(lockPath, 5000); // identical age to the FAILURE test above

    const clock = makeFakeClock(Date.now() + 100); // ageMs ≈ 5100ms, identical rig to the FAILURE test above

    const acquired = acquireStateLock(statePath, clock);
    t.after(() => releaseStateLock(acquired));
    assert.ok(fs.existsSync(acquired),
      'a genuinely empty lock body past the fresh-create-floor age must still be stolen and re-acquired');
  });
});

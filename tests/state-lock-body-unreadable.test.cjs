'use strict';

/**
 * #3057 B2 — an unreadable STATE.md lock body must not get the same
 * fresh-create-floor stealable treatment as a genuinely empty one.
 *
 * `_stateLockBodyPid` used to collapse two different situations to the same
 * `null`: a lock body that reads back empty/garbage (the create→write
 * window — expected, benign) and a lock body that could not be READ at all
 * (an I/O fault — permission error, transient NFS/overlay-fs hiccup, etc.).
 * Both got the SAME 1-second (`freshCreateFloorMs`) steal-eligibility
 * window, so a transient read fault could rob an actively-held lock exactly
 * as fast as a lock that is merely mid-creation.
 *
 * The fix (`_stateLockBodyStatus`, state.cts) makes the steal decision
 * four-way: an unreadable body is now held to the SAME conservative
 * `deadmanCeilingMs` ceiling as a verified-live holder, not the short
 * fresh-create floor.
 *
 * These two tests are a pair by construction: identical lock age (past the
 * fresh-create floor, nowhere near the deadman ceiling), identical clock
 * rig — the ONLY variable is whether the body read throws (fault-injected
 * via `withFaultyFs`, never chmod/subprocess) or genuinely reads back empty.
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

/** Fresh temp project dir with a STATE.md, for a single test. */
function makeTempState() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lock-unreadable-'));
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

    const originalReadFileSync = fs.readFileSync;
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

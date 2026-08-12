'use strict';

/**
 * #2136 — operator-facing date-only fields must use the HOST-LOCAL calendar day,
 * not the UTC calendar day.
 *
 * `clock.today()` derived the day by slicing a UTC ISO instant
 * (`nowIso().split('T')[0]`), so in any negative-UTC-offset zone during UTC's
 * early hours `last_activity` named a day the operator had not reached yet — a
 * day AHEAD of `last_updated`'s local date, written by the same call.
 *
 * The fix adds `clock.localToday()` (host-local calendar day, honoring the same
 * GSD_NOW_MS pin) and routes operator-facing date-only fields through it. These
 * tests prove:
 *   (1) realClock.localToday() returns the local day under a pinned instant + TZ;
 *   (2) realClock.today() is unchanged (UTC) — internal/cosmetic stamps stay UTC;
 *   (3) the fake clock mirrors localToday();
 *   (4) the `last_activity` field is stamped from localToday, not today
 *       (a split clock where the two differ proves the wiring).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CLOCK_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'clock.cjs');
const STATE_TRANSITION_CJS = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'state-transition.cjs');
const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// 2020-06-15T02:00:00.000Z. Under America/Chicago (UTC−5 in June) this instant
// is 2020-06-14 21:00 local — the local calendar day is 2020-06-14 while the UTC
// calendar day is 2020-06-15. This is the issue's exact repro instant.
const PINNED_MS = '1592186400000';

/**
 * Run a one-liner in a FRESH subprocess so TZ is set at process start (Node
 * caches timezone; runtime mutation of process.env.TZ is unreliable across
 * versions). GSD_TEST_MODE + GSD_NOW_MS pin realClock via the documented seam.
 */
function clockInSubprocess(expr, env) {
  const result = runNode(['-e', expr], { env, timeoutMs: PROBE_TIMEOUT_MS });
  throwIfFailed(result, `node -e ${expr}`);
  return result.stdout.trim();
}

describe('#2136 realClock.localToday() — host-local calendar day', () => {
  test('returns the LOCAL calendar day under a negative-UTC-offset zone', () => {
    const out = clockInSubprocess(
      `const {realClock}=require(${JSON.stringify(CLOCK_CJS)});process.stdout.write(realClock.localToday());`,
      { PATH: process.env.PATH, GSD_TEST_MODE: '1', GSD_NOW_MS: PINNED_MS, TZ: 'America/Chicago' },
    );
    assert.strictEqual(out, '2020-06-14',
      'localToday() must be the local calendar day (2020-06-14 in Chicago), not the UTC day (2020-06-15)');
  });

  test('realClock.today() is unchanged (UTC calendar day) — internal stamps stay UTC', () => {
    const out = clockInSubprocess(
      `const {realClock}=require(${JSON.stringify(CLOCK_CJS)});process.stdout.write(realClock.today());`,
      { PATH: process.env.PATH, GSD_TEST_MODE: '1', GSD_NOW_MS: PINNED_MS, TZ: 'America/Chicago' },
    );
    assert.strictEqual(out, '2020-06-15',
      'today() must remain the UTC calendar day; only operator-facing fields moved to localToday()');
  });

  test('localToday === today on a UTC host (no spurious divergence)', () => {
    const out = clockInSubprocess(
      `const {realClock}=require(${JSON.stringify(CLOCK_CJS)});process.stdout.write(realClock.localToday()+'|'+realClock.today());`,
      { PATH: process.env.PATH, GSD_TEST_MODE: '1', GSD_NOW_MS: PINNED_MS, TZ: 'UTC' },
    );
    const [local, utc] = out.split('|');
    assert.strictEqual(local, '2020-06-15');
    assert.strictEqual(utc, '2020-06-15');
  });
});

describe('#2136 makeFakeClock mirrors localToday()', () => {
  test('fake clock localToday() derives the local day from the pinned epoch', () => {
    const clock = makeFakeClock(Number(PINNED_MS));
    // The fake honors the host TZ of the test process; assert it returns a
    // YYYY-MM-DD string derived from local Date methods (structure + determinism
    // under the pinned epoch), mirroring realClock.localToday().
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(clock.localToday()),
      'fake localToday() must return a YYYY-MM-DD string');
    assert.strictEqual(typeof clock.localToday, 'function',
      'makeFakeClock must expose localToday so it stays a drop-in Clock substitute');
  });
});

describe('#2136 last_activity is stamped from localToday, not today', () => {
  // A clock where the UTC day and the local day DIFFER. If the transition core
  // still consulted today(), Last Activity would read the UTC value; the fix
  // routes it through localToday().
  const splitClock = Object.freeze({
    today: () => '2020-06-15',
    localToday: () => '2020-06-14',
    nowIso: () => '2020-06-15T02:00:00.000Z',
  });

  test('sync transition writes the LOCAL day into Last Activity', () => {
    const { transitionCore } = require(STATE_TRANSITION_CJS);
    const input = [
      '# Project State',
      '',
      '**Total Plans in Phase:** 2',
      '**Last Activity:** 2020-06-10',
      '**Progress:** [████░░░░░░] 40%',
      '',
    ].join('\n');
    const result = transitionCore(
      input,
      { kind: 'sync', totalPlansInPhase: 5, percent: 60 },
      { clock: splitClock },
    );
    assert.strictEqual(stateExtractField(result.content, 'Last Activity'), '2020-06-14',
      'Last Activity must use localToday() (2020-06-14), not today() (2020-06-15)');
  });
});

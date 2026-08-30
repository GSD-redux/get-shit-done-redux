'use strict';

/**
 * scripts/lib/ci-job-timing.cjs — pure budget-percentage arithmetic (#4036).
 *
 * This module is shared by the in-job near-cap check
 * (scripts/ci-check-job-near-cap.cjs) and the scheduled trending report
 * (scripts/ci-timeout-report.cjs). Both surfaces need to agree on exactly
 * what "elapsed" and "near-cap" mean, so the arithmetic is factored out here
 * and tested once, at every boundary the two callers depend on: zero
 * elapsed, exactly-at-cap, just-under-threshold, exactly-at-threshold,
 * just-over-threshold, and past-cap. It also covers the invalid-input
 * failure modes (bad timeoutMinutes, malformed timestamps, completedAt
 * before startedAt) that both callers need to fail loudly on rather than
 * silently misreport.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  THRESHOLD_PCT,
  computeElapsedPct,
  isNearCap,
  formatNearCapNotice,
} = require('../scripts/lib/ci-job-timing.cjs');

test('computeElapsedPct', async (t) => {
  await t.test('zero elapsed yields pct exactly 0', () => {
    const result = computeElapsedPct({
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
      timeoutMinutes: 15,
    });
    assert.equal(result.pct, 0);
    // Deterministic arithmetic over a fixed literal fixture (not a measured
    // wall-clock duration); elapsedMs is part of the function's public
    // return-shape contract that formatNearCapNotice reads directly.
    // eslint-disable-next-line local/no-elapsed-assertion -- deterministic arithmetic, not measured timing
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.capMs, 900000);
  });

  await t.test('elapsed exactly equal to cap yields pct exactly 1 and is near-cap', () => {
    const result = computeElapsedPct({
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:15:00.000Z',
      timeoutMinutes: 15,
    });
    assert.equal(result.pct, 1);
    assert.equal(isNearCap(result.pct), true);
  });

  await t.test('elapsed at 89.99% of cap is NOT near-cap', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const completedAt = new Date(startedAt.getTime() + 809910);
    const result = computeElapsedPct({
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      timeoutMinutes: 15,
    });
    assert.equal(isNearCap(result.pct), false);
  });

  await t.test('elapsed at exactly 90% of cap IS near-cap (threshold is inclusive)', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const completedAt = new Date(startedAt.getTime() + 810000);
    const result = computeElapsedPct({
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      timeoutMinutes: 15,
    });
    assert.equal(result.pct, 0.9);
    assert.equal(isNearCap(result.pct), true);
  });

  await t.test('elapsed at 90.01% of cap is near-cap', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const completedAt = new Date(startedAt.getTime() + 810090);
    const result = computeElapsedPct({
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      timeoutMinutes: 15,
    });
    assert.equal(isNearCap(result.pct), true);
  });

  await t.test('elapsed beyond the cap does not throw, pct > 1, near-cap', () => {
    const result = computeElapsedPct({
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:20:00.000Z',
      timeoutMinutes: 15,
    });
    assert.ok(result.pct > 1);
    assert.equal(isNearCap(result.pct), true);
  });

  await t.test('timeoutMinutes of 0 throws', () => {
    assert.throws(
      () =>
        computeElapsedPct({
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:15:00.000Z',
          timeoutMinutes: 0,
        }),
      /timeoutMinutes must be a positive finite number/,
    );
  });

  await t.test('negative timeoutMinutes throws', () => {
    assert.throws(
      () =>
        computeElapsedPct({
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:15:00.000Z',
          timeoutMinutes: -5,
        }),
      /timeoutMinutes must be a positive finite number/,
    );
  });

  await t.test('malformed startedAt throws', () => {
    assert.throws(
      () =>
        computeElapsedPct({
          startedAt: 'not-a-date',
          completedAt: '2026-01-01T00:15:00.000Z',
          timeoutMinutes: 15,
        }),
      /startedAt is not a valid timestamp/,
    );
  });

  await t.test('completedAt before startedAt throws', () => {
    assert.throws(
      () =>
        computeElapsedPct({
          startedAt: '2026-01-01T01:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          timeoutMinutes: 15,
        }),
      /completedAt .* is before startedAt/,
    );
  });
});

test('formatNearCapNotice', async (t) => {
  await t.test('produces a warningLine and summaryMarkdown containing label and pct', () => {
    const { warningLine, summaryMarkdown } = formatNearCapNotice({
      label: 'test (ubuntu-latest, 24, shard 1/3)',
      pct: 0.92,
      elapsedMs: 828000,
      capMs: 900000,
    });

    assert.ok(warningLine.startsWith('::warning'));
    assert.ok(warningLine.includes('test (ubuntu-latest, 24, shard 1/3)'));
    assert.ok(warningLine.includes('92%'));

    assert.ok(summaryMarkdown.includes('test (ubuntu-latest, 24, shard 1/3)'));
    assert.ok(summaryMarkdown.includes('92%'));
  });
});

test('computeElapsedPct / isNearCap — property: pct matches direct division and threshold predicate agrees', () => {
  fc.assert(
    fc.property(
      fc.record({
        timeoutMinutes: fc.integer({ min: 1, max: 500 }),
        // Expressed as thousandths of the cap so elapsedMs stays a whole
        // number of ms in [0, 10 * capMs] without generating capMs first.
        fractionOfCapMilli: fc.integer({ min: 0, max: 10000 }),
      }),
      ({ timeoutMinutes, fractionOfCapMilli }) => {
        const capMs = timeoutMinutes * 60000;
        const elapsedMs = Math.floor((capMs * fractionOfCapMilli) / 1000);

        const startedAt = new Date('2026-01-01T00:00:00.000Z');
        const completedAt = new Date(startedAt.getTime() + elapsedMs);

        const result = computeElapsedPct({
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          timeoutMinutes,
        });

        // elapsedMs/capMs here are deterministically constructed by this test
        // from fast-check inputs (see above), not a measured wall-clock
        // duration; this is the core invariant under test.
        // eslint-disable-next-line local/no-elapsed-assertion -- deterministic arithmetic, not measured timing
        assert.equal(result.pct, elapsedMs / capMs);
        assert.equal(isNearCap(result.pct), result.pct >= THRESHOLD_PCT);
      },
    ),
    { numRuns: 200 },
  );
});

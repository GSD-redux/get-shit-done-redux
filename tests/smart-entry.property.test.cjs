'use strict';

/**
 * Property-based tests for smart-entry's `last_activity` staleness detection.
 *
 * Module: src/smart-entry.cts (built to gsd-core/bin/lib/smart-entry.cjs)
 * Exercised surface: detectSignals(cwd, now) -> { stale_activity, ... }
 *
 * These drive the REAL frontmatter -> fmScalar -> parseActivityTimestamp ->
 * staleActivity chain rather than the parser in isolation, because that whole
 * chain is where #2570 actually failed: the parser is private, and asserting on
 * detectSignals' typed result is the surface ADR-456's typed-surface mandate
 * asks for (never rendered text or source literals).
 *
 * Properties tested:
 *   (a) suffix-invariance — for ANY description suffix the template shape can
 *       produce, a last_activity older than IDLE_STALE_MS reads stale. The
 *       description must never change the parsed instant. This is #2570's
 *       invariant: pre-fix, Date.parse on the whole string returned NaN and
 *       staleActivity failed OPEN to false for every one of these inputs.
 *   (b) no false positives — the same generated suffixes on a RECENT date must
 *       still read not-stale, so (a) cannot be satisfied by a parser that
 *       simply reports everything stale.
 *   (c) total function — detectSignals never throws and stale_activity is
 *       always a boolean, for arbitrary junk in last_activity.
 *   (d) threshold-exactness — driven with a FULL ISO instant rather than a
 *       bare date, stale_activity equals `age > IDLE_STALE_MS` across the
 *       whole range. (a)/(b) deliberately skip the [24, 95]h band because a
 *       date-only value truncates to UTC midnight and cannot express limit±1;
 *       (d) closes that band, including 71/72/73h, against an exact oracle.
 *   (e) calendar validity — a shape-valid date whose day cannot exist never
 *       yields a timestamp. Date.parse rolls those FORWARD (2026-02-30 ->
 *       2026-03-02), so shape-only validation would propagate a wrong instant
 *       instead of failing safe (ADR-227).
 *
 * IDLE_STALE_MS is 72h (src/smart-entry.cts). The clock is injected, so these
 * never depend on wall time.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const { detectSignals } = require('../gsd-core/bin/lib/smart-entry.cjs');

const FIXED_NOW = () => Date.parse('2026-08-01T00:00:00Z');
const HOUR_MS = 3600 * 1000;
/** Mirrors IDLE_STALE_MS (src/smart-entry.cts:121). The oracle for (d). */
const IDLE_STALE_MS = 72 * HOUR_MS;

/**
 * Shape-valid dates whose DAY cannot exist. All are in the past relative to
 * FIXED_NOW, so a rolled-forward parse would read stale=true — which is what
 * makes the property discriminating rather than vacuous.
 */
const IMPOSSIBLE_DAYS = [
  '2026-02-30',
  '2026-02-31',
  '2026-04-31',
  '2026-06-31',
  '2025-02-29', // 2025 is not a leap year
  '2025-11-31',
  '2024-04-31',
  '2023-06-31',
];

const created = [];

function makeProject(lastActivity) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-prop-'));
  created.push(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      `last_activity: ${lastActivity}`,
      '---',
      '',
      '# Project State',
      '',
      'Phase: 3',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  return tmpDir;
}

afterEach(() => {
  while (created.length) {
    // helpers.cleanup carries the Windows-EBUSY retry budget; raw fs.rmSync in
    // a test is banned by local/no-raw-rmsync-in-tests.
    cleanup(created.pop());
  }
});

/** An ISO `YYYY-MM-DD` date a generated number of hours before FIXED_NOW. */
const dateOffsetHours = (hours) =>
  new Date(FIXED_NOW() - hours * HOUR_MS).toISOString().slice(0, 10);

/**
 * The description suffix `templates/state.md` prescribes: a separator (em dash
 * or hyphen, as both appear in the wild) followed by free text. Constrained to
 * the template's real shape — an unconstrained suffix could append a second
 * timestamp and legitimately change the parsed instant, which is not the
 * contract this asserts.
 */
const descriptionSuffix = fc
  .tuple(
    fc.constantFrom(' — ', ' - ', '  —  '),
    fc.string({ minLength: 1, maxLength: 60 }).filter((s) => !s.includes('\n')),
  )
  .map(([sep, text]) => `${sep}${text}`);

describe('smart-entry stale_activity — properties (#2570)', () => {
  test('(a) a stale date reads stale regardless of the description suffix', () => {
    fc.assert(
      fc.property(
        // Strictly older than the 72h threshold, bounded so the date stays valid.
        fc.integer({ min: 96, max: 24 * 365 }),
        descriptionSuffix,
        (hoursAgo, suffix) => {
          const signals = detectSignals(
            makeProject(`${dateOffsetHours(hoursAgo)}${suffix}`),
            FIXED_NOW,
          );
          assert.equal(
            signals.stale_activity,
            true,
            `last_activity ${hoursAgo}h old with a description suffix must read stale, not fail open`,
          );
        },
      ),
    );
  });

  test('(b) a recent date reads not-stale regardless of the description suffix', () => {
    fc.assert(
      fc.property(
        // Same calendar day as FIXED_NOW, so the date-only value is < 72h old
        // even after truncation to midnight.
        fc.integer({ min: 0, max: 23 }),
        descriptionSuffix,
        (hoursAgo, suffix) => {
          const signals = detectSignals(
            makeProject(`${dateOffsetHours(hoursAgo)}${suffix}`),
            FIXED_NOW,
          );
          assert.equal(
            signals.stale_activity,
            false,
            'a same-day last_activity must not be reported stale',
          );
        },
      ),
    );
  });

  test('(c) arbitrary last_activity never throws; stale_activity stays a boolean', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }).filter((s) => !s.includes('\n')),
        (junk) => {
          const signals = detectSignals(makeProject(junk), FIXED_NOW);
          assert.equal(
            typeof signals.stale_activity,
            'boolean',
            'stale_activity must remain a boolean for unparseable input',
          );
        },
      ),
    );
  });

  test('(d) with an exact instant, stale_activity tracks the 72h threshold across the whole range', () => {
    fc.assert(
      fc.property(
        // The FULL range, including the [24, 95]h band (a) and (b) skip and the
        // limit itself. Properties (a)/(b) use bare dates, which truncate to UTC
        // midnight and so cannot address the threshold; a full ISO instant can.
        fc.integer({ min: 0, max: 24 * 365 }),
        descriptionSuffix,
        (hoursAgo, suffix) => {
          const instant = new Date(FIXED_NOW() - hoursAgo * HOUR_MS).toISOString();
          const signals = detectSignals(makeProject(`${instant}${suffix}`), FIXED_NOW);
          assert.equal(
            signals.stale_activity,
            hoursAgo * HOUR_MS > IDLE_STALE_MS,
            `an instant ${hoursAgo}h old must read stale=${hoursAgo * HOUR_MS > IDLE_STALE_MS} ` +
              'against the strict 72h comparison',
          );
        },
      ),
    );
  });

  test('(e) an impossible calendar date never yields a timestamp', () => {
    fc.assert(
      fc.property(
        // Day-in-month overflows only: a shape-valid date whose day cannot
        // exist. Date.parse rolls these FORWARD, so a shape-only guard would
        // substitute a real — and wrong — instant instead of failing safe.
        fc.constantFrom(...IMPOSSIBLE_DAYS),
        descriptionSuffix,
        (date, suffix) => {
          const signals = detectSignals(makeProject(`${date}${suffix}`), FIXED_NOW);
          assert.equal(
            signals.stale_activity,
            false,
            `${date} does not exist; it must coerce to the safe default, not roll forward`,
          );
        },
      ),
    );
  });
});

'use strict';

/**
 * Property tests for the compact GSD-state status normalizer (#2162).
 *
 * shortGsdStatus() collapses free-text STATE.md statuses to a canonical
 * keyword (or a capped first-word fallback). As a parsing/normalization
 * contract it gets property coverage per the repo testing rules, alongside
 * the example-based cases in gsd-statusline.test.cjs.
 */

const { test, describe } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');

const { shortGsdStatus } = require('../hooks/gsd-statusline.js');

const CANONICAL = ['discussing', 'planning', 'executing', 'verifying', 'completed', 'paused'];

describe('shortGsdStatus properties (#2162)', () => {
  test('totality: any string input yields null or a short non-empty string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = shortGsdStatus(s);
        if (out === null) return true;
        return typeof out === 'string' && out.length > 0 && out.length <= 16;
      }),
    );
  });

  test('canonical statuses are fixed points (paused shouts as PAUSED)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CANONICAL), (canonical) => {
        const out = shortGsdStatus(canonical);
        return canonical === 'paused' ? out === 'PAUSED' : out === canonical;
      }),
    );
  });

  test('output never contains whitespace or separator characters', () => {
    // The compact line joins segments with ' · ' — a status containing
    // whitespace or the separator would corrupt the segment structure.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = shortGsdStatus(s);
        return out === null || !/[\s·—–]/.test(out);
      }),
    );
  });

  test('unrecognized free text falls back to its first word, capped at 16', () => {
    // Alphabetic words that are not canonical and don't contain canonical
    // trigger substrings exercise the fallback path deterministically.
    const word = fc.stringMatching(/^[A-Za-z]{1,32}$/).filter((w) => {
      const lower = w.toLowerCase();
      return !CANONICAL.some((c) => lower.includes(c.slice(0, 4)));
    });
    fc.assert(
      fc.property(word, word, (first, second) => {
        const out = shortGsdStatus(`${first} ${second}`);
        // The normalizer may still map some phrasings to a canonical keyword
        // (e.g. synonym tables); otherwise the first word survives, capped.
        return out === null || CANONICAL.concat('PAUSED').includes(out) || out === first.slice(0, 16);
      }),
    );
  });
});

/**
 * Property tests for STATE.md freshness marker derivation (#2734).
 *
 * These properties are asserted against `deriveStateFreshness`,
 * `isValidStateHeadStamp`, `formatStateFreshness`, `formatGsdState`, and
 * `formatGsdStateCompact` per `.gsd/phase/feat-2734-statusline-state-freshness/50-test-matrix.md`
 * rows P1-P5. None of these symbols exist on `hooks/gsd-statusline.js` yet —
 * this block is deliberately failing-first TDD.
 */
const {
  STATE_HEAD_ADVISORY_COMMITS,
  isValidStateHeadStamp,
  deriveStateFreshness,
  formatStateFreshness,
  formatGsdState: formatGsdStateFull,
  formatGsdStateCompact: formatGsdStateCompactFn,
} = require('../hooks/gsd-statusline.js');

describe('state-head freshness properties (#2734)', () => {
  test('derivationIsTotalOverArbitraryStamps', () => {
    const root = require('node:os').tmpdir();
    fc.assert(
      fc.property(fc.string(), (stamp) => {
        const ir = deriveStateFreshness(root, stamp);
        if (!ir || typeof ir !== 'object') return false;
        const keys = Object.keys(ir).sort().join(',');
        if (keys !== ['commit_stale', 'commits_behind', 'state_head'].sort().join(',')) return false;
        const cb = ir.commits_behind;
        return cb === null || (Number.isInteger(cb) && cb >= 0);
      }),
    );
  });

  test('fenceAcceptsOnlyHexInRange', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const expected = /^[0-9a-f]{4,40}$/i.test(String(s).trim());
        return isValidStateHeadStamp(s) === expected;
      }),
    );
  });

  test('markerVisibilityIsMonotonicInCount', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000000 }), (n) => {
        const out = formatStateFreshness({ commits_behind: n });
        const shouldShow = n >= STATE_HEAD_ADVISORY_COMMITS;
        return shouldShow ? out !== '' : out === '';
      }),
    );
  });

  test('unknownNeverDegradesToFresh', () => {
    const root = require('node:os').tmpdir();
    fc.assert(
      fc.property(fc.string(), (stamp) => {
        const ir = deriveStateFreshness(root, stamp);
        return ir.commit_stale === null;
      }),
    );
  });

  test('renderersAreTotalOverArbitraryIr', () => {
    const optionalString = fc.oneof(fc.constant(undefined), fc.string());
    const optionalCount = fc.oneof(fc.constant(undefined), fc.nat({ max: 999 }));

    const hasBadSeparator = (str) => {
      const trimmed = str.trim();
      if (trimmed.startsWith('·') || trimmed.endsWith('·')) return true;
      return str.includes('··') || str.includes('· ·');
    };

    fc.assert(
      fc.property(
        fc.record({
          status: optionalString,
          phaseNum: optionalCount,
          phaseTotal: optionalCount,
          phaseName: optionalString,
          milestone: optionalString,
          milestoneName: optionalString,
          percent: fc.oneof(fc.constant(undefined), fc.nat({ max: 100 })),
          activePhase: optionalString,
          nextAction: optionalString,
          nextPhases: fc.oneof(fc.constant(undefined), fc.array(fc.string(), { maxLength: 3 })),
          completedPhases: optionalCount,
          totalPhases: optionalCount,
          noActiveWorkstream: fc.boolean(),
          freshness: fc.record({
            state_head: fc.oneof(fc.constant(null), fc.string()),
            commits_behind: fc.oneof(fc.constant(null), fc.nat({ max: 1000000 })),
            commit_stale: fc.oneof(fc.constant(null), fc.boolean()),
          }),
        }),
        (s) => {
          const full = formatGsdStateFull(s);
          const compact = formatGsdStateCompactFn(s);
          if (typeof full !== 'string' || typeof compact !== 'string') return false;
          return !hasBadSeparator(full) && !hasBadSeparator(compact);
        },
      ),
    );
  });
});

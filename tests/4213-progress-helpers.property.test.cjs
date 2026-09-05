'use strict';

/**
 * Property-based tests for the #4213 progress-surface helpers
 *
 * Module: gsd-core/bin/lib/state-transition.cjs
 * Exported: formatProgressMachineSegment(percent),
 *           stateReplaceProgressPercent(content, percent)
 *
 * Properties tested:
 *   (a) formatProgressMachineSegment: never throws on any finite input
 *       (the review's RangeError case — persisted frontmatter values are
 *       hand-editable and only finiteness-checked upstream)
 *   (b) formatProgressMachineSegment: always returns a well-formed
 *       `[bar] NN%` segment with an exactly-10-glyph bar, 0-100 percent
 *   (c) stateReplaceProgressPercent: idempotent — a second application with
 *       the same percent is a no-op
 *   (d) stateReplaceProgressPercent: round-trip — the written bar re-parses
 *       to the same (clamped) percent for any 0-100 input
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  formatProgressMachineSegment,
  stateReplaceProgressPercent,
} = require('../gsd-core/bin/lib/state-transition.cjs');

const SEGMENT_RE = /^\[(█{0,10}░{0,10})\] (\d{1,3})%$/;

function clampToPercentRange(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

describe('formatProgressMachineSegment properties (#4213 review finding)', () => {
  // (a) + (b) never throws, always well-formed, for ANY finite number.
  test('property: never throws and always yields a well-formed segment for any finite percent', () => {
    fc.assert(
      fc.property(fc.double({ noDefaultInfinity: true, noNaN: true }), (percent) => {
        const segment = formatProgressMachineSegment(percent);
        const match = SEGMENT_RE.exec(segment);
        assert.ok(match, `segment must match [bar] NN%, got ${segment}`);
        assert.equal(match[1].length, 10, 'bar must be exactly 10 glyphs');
        const printed = Number(match[2]);
        assert.ok(printed >= 0 && printed <= 100, `printed percent must be clamped, got ${printed}`);
      }),
    );
  });

  // Bar fill agrees with the printed percent at the 0-100 boundaries reviewers read.
  test('boundary literals: 0, 100, 105, -30', () => {
    assert.equal(formatProgressMachineSegment(0), '[░░░░░░░░░░] 0%');
    assert.equal(formatProgressMachineSegment(100), '[██████████] 100%');
    assert.equal(formatProgressMachineSegment(105), '[██████████] 100%');
    assert.equal(formatProgressMachineSegment(-30), '[░░░░░░░░░░] 0%');
  });
});

describe('stateReplaceProgressPercent properties (#4213 review finding)', () => {
  // Any percent the writer can be handed, applied to a representative body.
  const anyPercent = fc.integer({ min: -1000, max: 1000 });

  // (c) idempotency: applying twice with the same percent changes nothing more.
  test('property: idempotent on a second application with the same percent', () => {
    fc.assert(
      fc.property(anyPercent, (percent) => {
        const content = '# Project State\n\n**Progress:** [█████░░░░░] 50% (2/4 plans done)\n';
        const once = stateReplaceProgressPercent(content, percent);
        const twice = stateReplaceProgressPercent(once, percent);
        assert.equal(twice, once);
      }),
    );
  });

  // (d) round-trip: the segment the helper writes re-parses to the same
  // clamped percent it printed for any in-range input.
  test('property: written segment re-parses to the clamped percent (0-100)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (percent) => {
        const content = 'Progress: [██░░░░░░░░] 20%\n';
        const updated = stateReplaceProgressPercent(content, percent);
        const match = /\[(█{0,10}░{0,10})\] (\d{1,3})%/.exec(updated);
        assert.ok(match, `rewritten body must carry a machine segment, got ${updated}`);
        assert.equal(Number(match[2]), clampToPercentRange(percent));
      }),
    );
  });
});

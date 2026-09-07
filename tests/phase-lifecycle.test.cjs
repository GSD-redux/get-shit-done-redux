'use strict';

/**
 * Behavioral tests for phase-lifecycle.cjs
 *
 * Module: gsd-core/bin/lib/phase-lifecycle.cjs
 * Exports: deriveProgressFromRoadmap, clampPercent, progressBarFilledCells, renderProgressBar
 *
 * ADR-2143 (epic #2143) migrated deriveProgressFromRoadmap from position-based
 * regexes to the markdown-table schema registry (collectSection + parseMarkdownTable
 * + matchTableSchema against TABLE_SCHEMAS.RoadmapProgress). This suite pins:
 *   - the pre-existing 4-column flat Progress table behaviour (unchanged)
 *   - #2137: the 5-column milestone-grouped Progress table (Phase | Milestone |
 *     Plans Complete | Status | Completed) — the OLD position-anchored regex
 *     assumed "Status" was always the 3rd cell, so it silently returned all-null
 *     for this variant; the schema-registry rewrite reads cells by column NAME
 *     and fixes this.
 *   - the pre-existing 999.x backlog exclusion for totalPhases
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveProgressFromRoadmap,
  clampPercent,
  progressBarFilledCells,
  renderProgressBar,
} = require('../gsd-core/bin/lib/phase-lifecycle.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

describe('deriveProgressFromRoadmap', () => {
  test('parses the 4-column flat Progress table (behaviour preserved)', () => {
    const roadmap = [
      '# Roadmap',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.completedPhases, 1, `expected 1 completed phase, got ${result.completedPhases}`);
    assert.equal(result.totalPhases, 3, `expected 3 total phases, got ${result.totalPhases}`);
    assert.equal(result.totalPlans, 5, `expected totalPlans 5 (2+2+1), got ${result.totalPlans}`);
  });

  test('#2137: deriveProgressFromRoadmap parses the 5-column milestone-grouped Progress table', () => {
    // Before ADR-2143: the old position-anchored regex assumed the 3rd cell was
    // Status; here Status is the 4th cell (Milestone inserted at position 2), so
    // the old code silently returned { completedPhases: null, totalPhases: null }.
    const roadmap = [
      '# Roadmap',
      '',
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | ✅ |',
      '| 2. Beta | v1.0 | 1/2 | In Progress | |',
      '| 3. Gamma | v1.1 | 0/1 | Planned | |',
      '| 4. Delta | v1.1 | 3/3 | Complete | ✅ |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.completedPhases, 2, `expected 2 completed phases (non-null), got ${result.completedPhases}`);
    assert.equal(result.totalPhases, 4, `expected 4 total phases (non-null), got ${result.totalPhases}`);
    assert.equal(result.totalPlans, 8, `expected totalPlans 8 (2+2+1+3), got ${result.totalPlans}`);
  });

  test('excludes 999.x backlog rows from totalPhases (4-column table)', () => {
    const roadmap = [
      '## Milestone v1.0: Test',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
      '| 999.1 Backlog: Future Idea | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      3,
      `total_phases must be 3 (not 4) — 999.1 backlog row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(result.completedPhases, 1, `completed_phases must be 1. Got ${result.completedPhases}`);
  });

  test('excludes 999.x backlog rows from totalPhases (5-column milestone-grouped table)', () => {
    const roadmap = [
      '## Progress',
      '',
      '| Phase | Milestone | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- | --- |',
      '| 1. Alpha | v1.0 | 2/2 | Complete | ✅ |',
      '| 2. Beta | v1.0 | 1/2 | In Progress | |',
      '| 999.1 Backlog | v1.0 | 0/0 | Backlog | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(
      result.totalPhases,
      2,
      `total_phases must be 2 (not 3) — 999.1 backlog row must be excluded. Got ${result.totalPhases}`,
    );
    assert.equal(result.completedPhases, 1, `completed_phases must be 1. Got ${result.completedPhases}`);
  });

  test('non-table content returns all-null (no throw)', () => {
    const result = deriveProgressFromRoadmap('# Roadmap\n\nNo table here.\n');
    assert.equal(result.completedPhases, null);
    assert.equal(result.totalPhases, null);
    assert.equal(result.totalPlans, null);
  });

  // ─── Regression (#2242 review Fix 4): heading-dependency removed ───────────
  // The Progress table used to be located via collectSection(h => /^progress$/i)
  // first, THEN parsed — so a schema-matching table under a non-"Progress"
  // heading (or one that isn't the first table in the document) returned
  // all-null. deriveProgressFromRoadmap now delegates to findTableBySchema,
  // which scans the whole document for the schema, independent of heading name.

  test('Progress table under a NON-"Progress" heading, not the first table in the doc, still resolves', () => {
    const roadmap = [
      '# Roadmap',
      '',
      '## Legend',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
      '',
      '## Milestone v1.0: Alpha Release',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
      '| 2. Beta | 1/2 | In Progress | |',
      '| 3. Gamma | 0/1 | Planned | |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.completedPhases, 1, `expected 1 completed phase (non-null), got ${result.completedPhases}`);
    assert.equal(result.totalPhases, 3, `expected 3 total phases (non-null), got ${result.totalPhases}`);
    assert.equal(result.totalPlans, 5, `expected totalPlans 5 (2+2+1), got ${result.totalPlans}`);
  });

  test('Progress table with NO heading at all, not the first table in the doc, still resolves', () => {
    const roadmap = [
      '# Roadmap',
      '',
      'Some intro prose describing conventions used below.',
      '',
      '| Symbol | Meaning |',
      '| --- | --- |',
      '| ✅ | Done |',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '| --- | --- | --- | --- |',
      '| 1. Alpha | 2/2 | Complete | ✅ |',
    ].join('\n');

    const result = deriveProgressFromRoadmap(roadmap);
    assert.equal(result.completedPhases, 1, `expected 1 completed phase (non-null), got ${result.completedPhases}`);
    assert.equal(result.totalPhases, 1, `expected 1 total phase (non-null), got ${result.totalPhases}`);
    assert.equal(result.totalPlans, 2, `expected totalPlans 2, got ${result.totalPlans}`);
  });
});

describe('clampPercent', () => {
  test('computes a normal percentage', () => {
    assert.equal(clampPercent(1, 2), 50);
  });

  test('clamps to 100 when completed exceeds total', () => {
    assert.equal(clampPercent(5, 2), 100);
  });

  test('returns 0 when total is 0 or negative', () => {
    assert.equal(clampPercent(0, 0), 0);
    assert.equal(clampPercent(3, -1), 0);
  });
});

describe('renderProgressBar / progressBarFilledCells (#4294 — the render half has one owner)', () => {
  // The formula every call site used to carry inline. Kept here as the
  // reference curve the kernel is pinned against, NOT as an implementation.
  const legacyFilled = (percent, width) => Math.round((percent / 100) * width);
  const WIDTHS_IN_USE = [10, 20];

  const count = (bar, glyph) => bar.split('').filter((ch) => ch === glyph).length;

  test('a full bar is reserved for 100: the last sub-100 percents are held one cell short', () => {
    // width 10 — 94 already rounded to 9; 95-99 used to round to 10.
    assert.equal(renderProgressBar(94, 10), '█████████░');
    assert.equal(renderProgressBar(95, 10), '█████████░');
    assert.equal(renderProgressBar(99, 10), '█████████░');
    assert.equal(renderProgressBar(100, 10), '██████████');
    // width 20 — 97 already rounded to 19; 98-99 used to round to 20.
    assert.equal(renderProgressBar(97, 20), '███████████████████░');
    assert.equal(renderProgressBar(98, 20), '███████████████████░');
    assert.equal(renderProgressBar(99, 20), '███████████████████░');
    assert.equal(renderProgressBar(100, 20), '████████████████████');
    // The bottom of the range is untouched.
    assert.equal(renderProgressBar(0, 10), '░░░░░░░░░░');
    assert.equal(renderProgressBar(5, 10), '█░░░░░░░░░');
    assert.equal(renderProgressBar(50, 10), '█████░░░░░');
  });

  test('exhaustive 0-100 curve at both widths: identical to the legacy formula except exactly the saturating percents', () => {
    const expectedMoved = { 10: [95, 96, 97, 98, 99], 20: [98, 99] };
    for (const width of WIDTHS_IN_USE) {
      const moved = [];
      for (let percent = 0; percent <= 100; percent++) {
        const legacy = legacyFilled(percent, width);
        const actual = progressBarFilledCells(percent, width);
        if (actual !== legacy) {
          moved.push(percent);
          // The only permitted departure: legacy saturated below 100, kernel holds one short.
          assert.equal(legacy, width, `width ${width}, ${percent}%: moved but legacy was not saturated`);
          assert.equal(actual, width - 1, `width ${width}, ${percent}%: moved to ${actual}, expected ${width - 1}`);
        }
        // The rendered glyph run agrees with the count and is always width glyphs long.
        const bar = renderProgressBar(percent, width);
        assert.equal(bar.length, width);
        assert.equal(count(bar, '█'), actual);
        assert.equal(count(bar, '░'), width - actual);
      }
      assert.deepEqual(moved, expectedMoved[width], `width ${width}: the set of moved percents`);
    }
  });

  test('withheld / non-finite percent renders an empty bar (the `percent === null ? 0` guard, centralized)', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, '50']) {
      assert.equal(renderProgressBar(value, 10), '░░░░░░░░░░', `value ${String(value)}`);
      assert.equal(progressBarFilledCells(value, 10), 0, `value ${String(value)}`);
    }
  });

  test('out-of-range percent is clamped, never thrown: 120% is a full bar, -30% an empty one', () => {
    // The old inline form threw `RangeError: Invalid count value: -2` at 120%.
    assert.equal(renderProgressBar(120, 10), '██████████');
    assert.equal(renderProgressBar(-30, 10), '░░░░░░░░░░');
    assert.equal(renderProgressBar(100.4, 10), '██████████');
    assert.equal(renderProgressBar(99.9, 10), '█████████░');
  });

  test('property: for any finite percent and width in use, exactly width glyphs, and full only at >= 100', () => {
    fc.assert(
      fc.property(
        fc.double({ noDefaultInfinity: true, noNaN: true }),
        fc.constantFrom(...WIDTHS_IN_USE),
        (percent, width) => {
          const bar = renderProgressBar(percent, width);
          assert.equal(bar.length, width);
          assert.match(bar, /^█*░*$/);
          const full = count(bar, '█') === width;
          assert.equal(full, percent >= 100, `${percent}% at width ${width}: full=${full}`);
        },
      ),
    );
  });

  test('degenerate widths: non-positive yields nothing, width 1 fills only at 100', () => {
    assert.equal(renderProgressBar(50, 0), '');
    assert.equal(renderProgressBar(50, -3), '');
    assert.equal(progressBarFilledCells(50, 0), 0);
    assert.equal(renderProgressBar(99, 1), '░');
    assert.equal(renderProgressBar(100, 1), '█');
  });
});

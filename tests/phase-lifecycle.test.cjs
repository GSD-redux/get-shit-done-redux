'use strict';

/**
 * Behavioral tests for phase-lifecycle.cjs
 *
 * Module: gsd-core/bin/lib/phase-lifecycle.cjs
 * Exports: deriveProgressFromRoadmap, clampPercent
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

const { deriveProgressFromRoadmap, clampPercent } = require('../gsd-core/bin/lib/phase-lifecycle.cjs');
const { isBacklogPhaseId } = require('../gsd-core/bin/lib/phase-id.cjs');

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

  test('DEFECT.GENERATIVE-FIX: phase-count filtering excludes only the unambiguous backlog range', () => {
    for (const phase of ['0.1', '000.2', '999.1', '0999.2', '1', '998.1', '9990.1', '1000']) {
      const roadmap = [
        '## Progress',
        '',
        '| Phase | Plans Complete | Status | Completed |',
        '| --- | --- | --- | --- |',
        `| ${phase} Candidate | 0/0 | Planned | |`,
      ].join('\n');
      const expected = isBacklogPhaseId(phase) ? null : 1;
      assert.equal(
        deriveProgressFromRoadmap(roadmap).totalPhases,
        expected,
        `phase-lifecycle sentinel parity failed for ${phase}`,
      );
    }
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

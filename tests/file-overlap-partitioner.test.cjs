'use strict';

/**
 * file-overlap-partitioner.test.cjs — Behavioral tests for the shared
 * file-overlap wave partitioner (#3674), extracted from
 * `claude-orchestration.cts`'s `partitionStages` (#1143).
 *
 * Module: gsd-core/bin/lib/file-overlap-partitioner.cjs
 * Exported: partitionByFileOverlap(items: { id: string; files: string[] }[]) -> string[][]
 *
 * These tests pin the generic module's own contract, independent of any
 * `Plan`/`Wave` shape from `claude-orchestration.cts`. Several test names
 * carry a "(characterization)" suffix per the #3674 test matrix (rows 5, 6):
 * they characterize `partitionStages`' original algorithm — traced from its
 * source, since duplicate-id and chain-overlap inputs were never reachable
 * through `emitWorkflowScript`'s public API (it validates plan ids unique
 * before ever calling the partitioner) — now pinned against the extracted,
 * generic entry point.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { partitionByFileOverlap } = require('../gsd-core/bin/lib/file-overlap-partitioner.cjs');

describe('partitionByFileOverlap', () => {

  test('partitions overlapping plans into separate stages', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: ['shared.ts'] },
      { id: 'p2', files: ['shared.ts'] },
      { id: 'p3', files: ['shared.ts'] },
    ]);
    assert.strictEqual(stages.length, 3, 'every plan shares the same file -> each gets its own stage');
    assert.deepStrictEqual(stages, [['p1'], ['p2'], ['p3']]);
  });

  test('coalesces disjoint plans into stage 0', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: ['a.ts'] },
      { id: 'p2', files: ['b.ts'] },
      { id: 'p3', files: ['c.ts'] },
    ]);
    assert.strictEqual(stages.length, 1, 'fully disjoint plans coalesce into one stage');
    assert.deepStrictEqual(stages[0].slice().sort(), ['p1', 'p2', 'p3']);
  });

  test('an empty file set joins the first stage', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: [] },
    ]);
    assert.deepStrictEqual(stages, [['p1']]);
  });

  test('two plans with empty file sets do not collide', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: [] },
      { id: 'p2', files: [] },
    ]);
    assert.strictEqual(stages.length, 1, 'two empty file sets never overlap each other');
    assert.deepStrictEqual(stages[0], ['p1', 'p2']);
  });

  test('duplicate plan ids are not deduplicated by the partitioner (characterization)', () => {
    // Same id, overlapping files: each occurrence is placed independently by
    // the greedy first-fit walk (id is never used as a dedup/merge key) — the
    // second occurrence overlaps the first's file set and lands in stage 1.
    const overlapping = partitionByFileOverlap([
      { id: 'p1', files: ['a.ts'] },
      { id: 'p1', files: ['a.ts'] },
    ]);
    assert.deepStrictEqual(overlapping, [['p1'], ['p1']], 'both occurrences of the duplicate id are preserved, one per stage');

    // Same id, disjoint files: both occurrences independently coalesce into
    // stage 0 (files are what is checked for overlap, never the id).
    const disjoint = partitionByFileOverlap([
      { id: 'p1', files: ['a.ts'] },
      { id: 'p1', files: ['b.ts'] },
    ]);
    assert.deepStrictEqual(disjoint, [['p1', 'p1']], 'duplicate ids with disjoint files both land in stage 0, not merged');
  });

  test('chain-overlap plans produce the greedy, non-optimal assignment (characterization)', () => {
    // A∩B (share f2), B∩C (share f3), A∌C (no shared file). A minimal
    // assignment could place A and C together after B, but greedy first-fit
    // processes in input order: A -> stage0; B overlaps A -> stage1; C does
    // NOT overlap stage0 (A's files are f1,f2; C's are f3,f4) -> stage0.
    const stages = partitionByFileOverlap([
      { id: 'A', files: ['f1', 'f2'] },
      { id: 'B', files: ['f2', 'f3'] },
      { id: 'C', files: ['f3', 'f4'] },
    ]);
    assert.deepStrictEqual(stages, [['A', 'C'], ['B']], 'greedy first-fit, not optimal bin-packing');
  });

  test('path casing is compared by exact string, not normalized', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: ['Foo.ts'] },
      { id: 'p2', files: ['foo.ts'] },
    ]);
    assert.strictEqual(stages.length, 1, '"Foo.ts" and "foo.ts" are treated as distinct files -> no forced split');
    assert.deepStrictEqual(stages[0], ['p1', 'p2']);
  });

  test('backslash and forward-slash paths are not normalized to the same file', () => {
    const stages = partitionByFileOverlap([
      { id: 'p1', files: ['src\\foo.ts'] },
      { id: 'p2', files: ['src/foo.ts'] },
    ]);
    assert.strictEqual(stages.length, 1, 'no separator normalization -> the two strings never compare equal');
    assert.deepStrictEqual(stages[0], ['p1', 'p2']);
  });
});

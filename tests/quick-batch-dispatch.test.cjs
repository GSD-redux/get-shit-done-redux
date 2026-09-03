'use strict';

/**
 * quick-batch-dispatch.test.cjs — Behavioral tests for the quick-batch
 * dispatch decision core (#3676, Phase 4 of epic #3344 / ADR-1239
 * "Quick-batch binding").
 *
 * Module: gsd-core/bin/lib/quick-batch-dispatch.cjs
 *   (compiled from src/quick-batch-dispatch.cts)
 *
 * Design doc: `.gsd/phase/feat-3676-quick-batch-command-workflow/40-design.md`
 * Test matrix: `.gsd/phase/feat-3676-quick-batch-command-workflow/50-test-matrix.md`
 * This file covers matrix rows: 5,7,8,9,10,13,14,15 (args), 3,4,6,7,8,9,10,12
 * (effective concurrency), 24,32,33 (merge order), 27,39 (spawn backpressure),
 * 30,31 (verification routing), 28,34,35,36 (merge routing), 26 (cleanup entry).
 * Property rows 51-53 live in quick-batch-dispatch.property.test.cjs.
 *
 * This module is PURE — no filesystem or lock I/O — so every test here runs
 * without a temp project directory.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseQuickBatchArgs,
  computeEffectiveConcurrency,
  computeMergeOrder,
  computeSpawnPlan,
  routeVerificationOutcome,
  routeMergeOutcome,
  buildCleanupManifestEntry,
  filterAlreadyExecuted,
} = require('../gsd-core/bin/lib/quick-batch-dispatch.cjs');

// ─── parseQuickBatchArgs (rows 5,7-10,13-15) ────────────────────────────────

describe('quick-batch-dispatch: parseQuickBatchArgs', () => {
  test('row 10: --jobs omitted defaults to auto', () => {
    const result = parseQuickBatchArgs([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { jobs: 'auto', validate: false, research: false, resume: null });
  });

  test('--jobs auto parses explicitly', () => {
    const result = parseQuickBatchArgs(['--jobs', 'auto']);
    assert.equal(result.ok, true);
    assert.equal(result.value.jobs, 'auto');
  });

  test('--jobs N (positive integer) parses to a number', () => {
    const result = parseQuickBatchArgs(['--jobs', '4']);
    assert.equal(result.ok, true);
    assert.equal(result.value.jobs, 4);
  });

  test('boundary: --jobs 1 (limit) is accepted', () => {
    const result = parseQuickBatchArgs(['--jobs', '1']);
    assert.equal(result.ok, true);
    assert.equal(result.value.jobs, 1);
  });

  test('row 9 (hostile): --jobs 0 rejected before dispatch', () => {
    const result = parseQuickBatchArgs(['--jobs', '0']);
    assert.equal(result.ok, false);
  });

  test('row 9 (hostile): --jobs -1 rejected before dispatch', () => {
    const result = parseQuickBatchArgs(['--jobs', '-1']);
    assert.equal(result.ok, false);
  });

  test('row 9 (hostile): --jobs abc (non-numeric) rejected before dispatch', () => {
    const result = parseQuickBatchArgs(['--jobs', 'abc']);
    assert.equal(result.ok, false);
  });

  test('--jobs with a missing value is rejected', () => {
    const result = parseQuickBatchArgs(['--jobs']);
    assert.equal(result.ok, false);
  });

  test('--validate and --research set their respective flags', () => {
    const result = parseQuickBatchArgs(['--validate', '--research']);
    assert.equal(result.ok, true);
    assert.equal(result.value.validate, true);
    assert.equal(result.value.research, true);
  });

  test('row 16: --resume <batch-id> is parsed', () => {
    const result = parseQuickBatchArgs(['--resume', '260101-abc']);
    assert.equal(result.ok, true);
    assert.equal(result.value.resume, '260101-abc');
  });

  test('--resume with a missing value is rejected', () => {
    const result = parseQuickBatchArgs(['--resume']);
    assert.equal(result.ok, false);
  });

  test('row 7: --discuss is rejected before any dispatch', () => {
    const result = parseQuickBatchArgs(['--discuss']);
    assert.equal(result.ok, false);
  });

  test('row 8: --full is rejected before any dispatch', () => {
    const result = parseQuickBatchArgs(['--full']);
    assert.equal(result.ok, false);
  });

  test('row 15 (hostile): --discuss --validate is still rejected — presence alone is sufficient', () => {
    const result = parseQuickBatchArgs(['--discuss', '--validate']);
    assert.equal(result.ok, false);
  });

  test('row 15 (hostile): --full mixed with otherwise-valid flags is still rejected', () => {
    const result = parseQuickBatchArgs(['--jobs', '4', '--full', '--research']);
    assert.equal(result.ok, false);
  });
});

// ─── computeEffectiveConcurrency (rows 3,4,6,7,8,9,10,12) ───────────────────

describe('quick-batch-dispatch: computeEffectiveConcurrency', () => {
  test('row 3: --jobs auto uses capacity alone', () => {
    const n = computeEffectiveConcurrency({ jobs: 'auto', taskCount: 25, capacity: 4, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 4);
  });

  test('row 7: --jobs 10 with 3 tasks and capacity 4 -> min(3,10,4) = 3', () => {
    const n = computeEffectiveConcurrency({ jobs: 10, taskCount: 3, capacity: 4, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 3);
  });

  test('row 8: --jobs 2 with 8 tasks and capacity 4 -> min(8,2,4) = 2', () => {
    const n = computeEffectiveConcurrency({ jobs: 2, taskCount: 8, capacity: 4, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 2);
  });

  test('boundary: --jobs equal to capacity and task count (limit) never exceeds either', () => {
    const n = computeEffectiveConcurrency({ jobs: 4, taskCount: 4, capacity: 4, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 4);
  });

  test('boundary: --jobs one more than task count (limit+1) still bounded by task count', () => {
    const n = computeEffectiveConcurrency({ jobs: 5, taskCount: 4, capacity: 10, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 4);
  });

  test('boundary: --jobs one less than task count (limit-1) is honored', () => {
    const n = computeEffectiveConcurrency({ jobs: 3, taskCount: 4, capacity: 10, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 3);
  });

  test('row 6: isolation none forces a MUTATING wave to concurrency 1 regardless of --jobs/capacity', () => {
    const n = computeEffectiveConcurrency({ jobs: 4, taskCount: 4, capacity: 4, isolation: 'none', mutating: true });
    assert.equal(n, 1);
  });

  test('row 6: isolation none forces --jobs auto down to 1 for a mutating wave too', () => {
    const n = computeEffectiveConcurrency({ jobs: 'auto', taskCount: 4, capacity: 4, isolation: 'none', mutating: true });
    assert.equal(n, 1);
  });

  test('row 12: isolation none does NOT cap a non-mutating (research-only) wave', () => {
    const n = computeEffectiveConcurrency({ jobs: 4, taskCount: 4, capacity: 4, isolation: 'none', mutating: false });
    assert.equal(n, 4, 'research-only stage is not subject to the isolation=none cap');
  });

  test('a non-none isolation never triggers the cap regardless of mutating', () => {
    const n = computeEffectiveConcurrency({ jobs: 4, taskCount: 4, capacity: 4, isolation: 'harness-worktree', mutating: true });
    assert.equal(n, 4);
  });
});

// ─── computeMergeOrder (row 24; matrix rows 32-33) ──────────────────────────

describe('quick-batch-dispatch: computeMergeOrder — deterministic wave order, never completion order', () => {
  test('row 32: all items ready simultaneously merge in the original wave order', () => {
    const order = computeMergeOrder(['x', 'y', 'z'], new Set(['x', 'y', 'z']));
    assert.deepEqual(order, ['x', 'y', 'z']);
  });

  test('row 33: item 2 finishing before item 1 does not reorder the merge — item 2 waits', () => {
    // Only 'y' (wave position 2) is ready; 'x' (position 1) is not yet.
    const order = computeMergeOrder(['x', 'y', 'z'], new Set(['y']));
    assert.deepEqual(order, [], 'y must wait for x, which precedes it in wave order');
  });

  test('partial readiness returns only the contiguous ready PREFIX', () => {
    const order = computeMergeOrder(['x', 'y', 'z'], new Set(['x', 'y']));
    assert.deepEqual(order, ['x', 'y'], 'z is not ready yet, so it is excluded even though x and y are');
  });

  test('empty wave order returns empty', () => {
    assert.deepEqual(computeMergeOrder([], new Set(['x'])), []);
  });

  test('nothing ready returns empty', () => {
    assert.deepEqual(computeMergeOrder(['x', 'y'], new Set()), []);
  });
});

// ─── computeSpawnPlan (row 27; matrix row 39) ───────────────────────────────

describe('quick-batch-dispatch: computeSpawnPlan — backpressure never increases fan-out', () => {
  test('row 39: spawns up to remaining capacity, backpressures the rest to pending', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b', 'c'], capacity: 2, currentInFlight: 0 });
    assert.deepEqual(result.spawn, ['a', 'b']);
    assert.deepEqual(result.pending, ['c']);
  });

  test('boundary: eligible count exactly at capacity (limit) spawns everything', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b'], capacity: 2, currentInFlight: 0 });
    assert.deepEqual(result.spawn, ['a', 'b']);
    assert.deepEqual(result.pending, []);
  });

  test('boundary: eligible count one over capacity (limit+1) backpressures exactly one', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b', 'c'], capacity: 2, currentInFlight: 0 });
    assert.equal(result.spawn.length, 2);
    assert.equal(result.pending.length, 1);
  });

  test('boundary: eligible count one under capacity (limit-1) spawns everything, no backpressure', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a'], capacity: 2, currentInFlight: 0 });
    assert.deepEqual(result.spawn, ['a']);
    assert.deepEqual(result.pending, []);
  });

  test('row 27: a refused id returns to pending — never counted against capacity, never spawned', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b', 'c'], capacity: 3, currentInFlight: 0, refused: ['b'] });
    assert.deepEqual(result.spawn, ['a', 'c']);
    assert.deepEqual(result.pending, ['b']);
  });

  test('currentInFlight reduces available capacity for new spawns', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b'], capacity: 2, currentInFlight: 1 });
    assert.deepEqual(result.spawn, ['a']);
    assert.deepEqual(result.pending, ['b']);
  });

  test('currentInFlight already at or over capacity spawns nothing (never negative fan-out)', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b'], capacity: 2, currentInFlight: 5 });
    assert.deepEqual(result.spawn, []);
    assert.deepEqual(result.pending, ['a', 'b']);
  });

  test('accepts a Set for refused, same as an array', () => {
    const result = computeSpawnPlan({ eligibleIds: ['a', 'b'], capacity: 2, currentInFlight: 0, refused: new Set(['a']) });
    assert.deepEqual(result.spawn, ['b']);
    assert.deepEqual(result.pending, ['a']);
  });
});

// ─── routeVerificationOutcome (rows 30,31) ──────────────────────────────────

describe('quick-batch-dispatch: routeVerificationOutcome', () => {
  test('passed routes to complete', () => {
    assert.deepEqual(routeVerificationOutcome('passed'), { action: 'complete' });
  });

  test('row 30: human_needed routes to a terminal human_needed action — never complete', () => {
    const routing = routeVerificationOutcome('human_needed');
    assert.deepEqual(routing, { action: 'human_needed' });
    assert.notEqual(routing.action, 'complete');
  });

  test('row 31: gaps_found routes to fail, with a failure reason — no rollback signal, no retry signal', () => {
    const routing = routeVerificationOutcome('gaps_found');
    assert.equal(routing.action, 'fail');
    assert.match(routing.failureReason, /gaps_found/);
  });
});

// ─── routeMergeOutcome (rows 28,34-35,36) ───────────────────────────────────

describe('quick-batch-dispatch: routeMergeOutcome', () => {
  test('row 36: merged routes to complete', () => {
    assert.deepEqual(routeMergeOutcome({ kind: 'merged' }), { action: 'complete' });
  });

  test('row 34: merge_failed routes to fail and preserves the worktree', () => {
    const routing = routeMergeOutcome({ kind: 'merge_failed', detail: 'conflict in src/x.ts' });
    assert.equal(routing.action, 'fail');
    assert.equal(routing.preserveWorktree, true);
    assert.match(routing.failureReason, /merge_failed/);
  });

  test('row 28/35: scope_violation (undeclared deletion) routes to fail and preserves the worktree', () => {
    const routing = routeMergeOutcome({ kind: 'scope_violation', detail: 'undeclared deletion: src/y.ts' });
    assert.equal(routing.action, 'fail');
    assert.equal(routing.preserveWorktree, true);
    assert.match(routing.failureReason, /scope_violation/);
  });

  test('detail is optional — a bare kind still routes correctly', () => {
    const routing = routeMergeOutcome({ kind: 'merge_failed' });
    assert.equal(routing.action, 'fail');
    assert.equal(routing.failureReason, 'merge_failed');
  });
});

// ─── buildCleanupManifestEntry (row 26, Open Question 2) ────────────────────

describe('quick-batch-dispatch: buildCleanupManifestEntry — sourced FRESH from the plan, never BATCH.json', () => {
  test('row 26: derives files_modified/declared_deletions from the plan frontmatter', () => {
    const planContent = [
      '---',
      'files_modified:',
      '  - src/a.ts',
      '  - src/b.ts',
      'files_deleted:',
      '  - src/old.ts',
      '---',
      '',
      '<objective>Do the thing</objective>',
    ].join('\n');

    const entry = buildCleanupManifestEntry({
      agentId: 'agent-1',
      worktreePath: '/tmp/wt-1',
      branch: 'gsd/quick-batch/260101-abc',
      expectedBase: 'main',
      planContent,
    });

    assert.equal(entry.agent_id, 'agent-1');
    assert.equal(entry.worktree_path, '/tmp/wt-1');
    assert.equal(entry.branch, 'gsd/quick-batch/260101-abc');
    assert.equal(entry.expected_base, 'main');
    assert.deepEqual(entry.files_modified, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(entry.declared_deletions, ['src/old.ts']);
  });

  test('a plan declaring no files_modified/files_deleted produces empty arrays (never undefined, never guessed)', () => {
    const entry = buildCleanupManifestEntry({
      agentId: null,
      worktreePath: '/tmp/wt-2',
      branch: 'gsd/quick-batch/260101-def',
      expectedBase: 'main',
      planContent: '<objective>Do another thing</objective>',
    });
    assert.deepEqual(entry.files_modified, []);
    assert.deepEqual(entry.declared_deletions, []);
  });

  test('allowedBases is passed through only when supplied', () => {
    const withBases = buildCleanupManifestEntry({
      agentId: null,
      worktreePath: '/tmp/wt-3',
      branch: 'gsd/quick-batch/260101-ghi',
      expectedBase: 'main',
      allowedBases: ['main', 'next'],
      planContent: '',
    });
    assert.deepEqual(withBases.allowed_bases, ['main', 'next']);

    const withoutBases = buildCleanupManifestEntry({
      agentId: null,
      worktreePath: '/tmp/wt-4',
      branch: 'gsd/quick-batch/260101-jkl',
      expectedBase: 'main',
      planContent: '',
    });
    assert.equal('allowed_bases' in withoutBases, false);
  });
});

// ─── filterAlreadyExecuted — crash-window duplicate-dispatch guard (#3677) ──
//
// Pure-decision unit tests (this module performs no filesystem I/O — the
// caller determines `executedIds` via its own check). A REAL fixture
// combining this function with an actual on-disk SUMMARY.md and a real
// resumeBatch call lives in tests/quick-batch.test.cjs (crosses
// quick-batch.cjs + quick-batch-dispatch.cjs, so it belongs with the
// filesystem-backed suite, not this pure one).

describe('quick-batch-dispatch: filterAlreadyExecuted', () => {
  test('an id present in executedIds is excluded from spawnEligible and reported in alreadyExecuted', () => {
    const result = filterAlreadyExecuted(['a', 'b', 'c'], ['b']);
    assert.deepEqual(result.spawnEligible, ['a', 'c']);
    assert.deepEqual(result.alreadyExecuted, ['b']);
  });

  test('boundary: empty executedIds — every eligible id is spawnEligible, alreadyExecuted is empty', () => {
    const result = filterAlreadyExecuted(['a', 'b'], []);
    assert.deepEqual(result.spawnEligible, ['a', 'b']);
    assert.deepEqual(result.alreadyExecuted, []);
  });

  test('boundary: every eligible id already executed — spawnEligible is empty, nothing is silently dropped', () => {
    const result = filterAlreadyExecuted(['a', 'b'], ['a', 'b']);
    assert.deepEqual(result.spawnEligible, []);
    assert.deepEqual(result.alreadyExecuted, ['a', 'b']);
  });

  test('boundary: empty eligibleIds — both outputs empty regardless of executedIds', () => {
    const result = filterAlreadyExecuted([], ['x', 'y']);
    assert.deepEqual(result.spawnEligible, []);
    assert.deepEqual(result.alreadyExecuted, []);
  });

  test('order-preserving: spawnEligible/alreadyExecuted each keep eligibleIds\' original relative order', () => {
    const result = filterAlreadyExecuted(['c', 'a', 'b', 'd'], ['a', 'd']);
    assert.deepEqual(result.spawnEligible, ['c', 'b']);
    assert.deepEqual(result.alreadyExecuted, ['a', 'd']);
  });

  test('accepts a Set for executedIds, not only an array (same convention as computeSpawnPlan\'s refused param)', () => {
    const result = filterAlreadyExecuted(['a', 'b'], new Set(['a']));
    assert.deepEqual(result.spawnEligible, ['b']);
    assert.deepEqual(result.alreadyExecuted, ['a']);
  });

  test('an id in executedIds that is NOT in eligibleIds is ignored — never invented into either output', () => {
    const result = filterAlreadyExecuted(['a'], ['a', 'phantom-id']);
    assert.deepEqual(result.spawnEligible, []);
    assert.deepEqual(result.alreadyExecuted, ['a']);
  });
});

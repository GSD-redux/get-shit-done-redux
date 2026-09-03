'use strict';

/**
 * quick-batch-dispatch.property.test.cjs — Property-based tests for the
 * quick-batch dispatch decision core (#3676, Phase 4 of epic #3344 /
 * ADR-1239 "Quick-batch binding").
 *
 * Test matrix rows 51-53 (`.gsd/phase/feat-3676-quick-batch-command-workflow/
 * 50-test-matrix.md`):
 *   51 — post-planning `updateBatchItems` wave recompute (src/quick-batch.cts)
 *        terminates and every item lands in exactly one wave, for any valid
 *        (acyclic, in-batch-only) generated depends_on/files_modified
 *        assignment — same invariant class as Phase 3's row 32, now exercised
 *        through the Phase-4 recompute path.
 *   52 — merge order for any wave, under any interleaving of leaf-completion
 *        timing, always matches the deterministic input order computeWaves
 *        assigned (src/quick-batch-dispatch.cts's computeMergeOrder).
 *   53 — for any sequence of refused-then-accepted spawns, total fan-out
 *        never exceeds effective capacity at any point in time
 *        (src/quick-batch-dispatch.cts's computeSpawnPlan).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');

const { createBatch, updateBatchItems } = require('../gsd-core/bin/lib/quick-batch.cjs');
const { computeMergeOrder, computeSpawnPlan } = require('../gsd-core/bin/lib/quick-batch-dispatch.cjs');
const { cleanup } = require('./helpers.cjs');

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-batch-dispatch-prop-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

/** A small acyclic dependency graph: item i may depend on any j < i (DAG by construction). */
const dagItemsArb = fc.integer({ min: 2, max: 7 }).chain((n) =>
  fc.tuple(
    ...Array.from({ length: n }, (_, i) =>
      fc.record({
        dependsOnPrevious: fc.subarray(Array.from({ length: i }, (_, j) => j), { maxLength: i }),
        files: fc.array(fc.constantFrom('f0', 'f1', 'f2', 'f3'), { maxLength: 2 }),
      }),
    ),
  ),
);

describe('quick-batch-dispatch: property — post-planning wave recompute totality (row 51)', () => {
  test('property: for any valid (acyclic, in-batch-only) post-planning assignment, updateBatchItems recompute terminates and every item lands in exactly one wave', () => {
    fc.assert(fc.property(
      dagItemsArb,
      (rawItems) => {
        const dir = mkTmpProject();
        try {
          const items = rawItems.map((_, i) => ({ description: `item-${i}`, clientId: `c${i}` }));
          const created = createBatch(dir, items);
          assert.equal(created.ok, true);
          const byClient = created.value.manifest.items; // same order as `items`

          const updates = rawItems.map((it, i) => ({
            quickId: byClient[i].quick_id,
            dependsOn: it.dependsOnPrevious.map((j) => byClient[j].quick_id),
            plannedFiles: it.files,
          }));

          const result = updateBatchItems(dir, created.value.batchId, updates);
          assert.equal(result.ok, true, result.ok ? '' : result.reason);

          const manifestItems = result.value.manifest.items;
          // Termination + totality: every item has a defined, non-negative wave.
          for (const it of manifestItems) {
            assert.ok(Number.isInteger(it.wave) && it.wave >= 0, `item ${it.quick_id} has an invalid wave ${it.wave}`);
          }
          // Exactly one wave each: group by wave index and confirm the counts
          // sum to the total item count with no gaps between 0..maxWave.
          const maxWave = Math.max(...manifestItems.map((it) => it.wave));
          const counted = new Array(maxWave + 1).fill(0);
          for (const it of manifestItems) counted[it.wave] += 1;
          assert.ok(counted.every((c) => c > 0), 'no empty wave gaps');
          assert.equal(counted.reduce((a, b) => a + b, 0), manifestItems.length);

          // DAG readiness: every dependency's wave strictly precedes its dependent's.
          const waveOf = new Map(manifestItems.map((it) => [it.quick_id, it.wave]));
          for (const it of manifestItems) {
            for (const dep of it.depends_on) {
              assert.ok(waveOf.get(dep) < waveOf.get(it.quick_id), `${dep} must strictly precede ${it.quick_id}`);
            }
          }
        } finally {
          cleanup(dir);
        }
      },
    ), { numRuns: 25 }); // filesystem-backed property — bounded below the global default
  });
});

describe('quick-batch-dispatch: property — deterministic merge order under any completion interleaving (row 52)', () => {
  test('property: computeMergeOrder always returns the maximal READY prefix of waveOrder, never a completion-order result', () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim() === s && s.length > 0), { minLength: 1, maxLength: 10 }),
      fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }),
      (waveOrder, readyFlags) => {
        // Build an arbitrary "ready" subset — readyFlags[i] says whether
        // waveOrder[i] finished its leaf, in NO particular arrival order
        // (that's the point: the function must not depend on arrival order,
        // only on the ORIGINAL waveOrder position).
        const readyIds = new Set(waveOrder.filter((_, i) => readyFlags[i] === true));

        const result = computeMergeOrder(waveOrder, readyIds);

        // Independently derive the expected maximal ready PREFIX.
        const expected = [];
        for (const id of waveOrder) {
          if (!readyIds.has(id)) break;
          expected.push(id);
        }
        assert.deepEqual(result, expected);
        // The result is always a genuine prefix of waveOrder (same relative order).
        assert.deepEqual(result, waveOrder.slice(0, result.length));
      },
    ), { numRuns: 100 });
  });
});

describe('quick-batch-dispatch: property — spawn backpressure never exceeds capacity (row 53)', () => {
  test('property: for any sequence of refused-then-accepted spawn rounds, in-flight + newly spawned never exceeds capacity', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 8 }), // capacity
      fc.array(
        fc.record({
          eligibleCount: fc.integer({ min: 0, max: 10 }),
          refusedCount: fc.integer({ min: 0, max: 10 }),
          currentInFlight: fc.integer({ min: 0, max: 12 }),
        }),
        { minLength: 1, maxLength: 15 },
      ),
      (capacity, rounds) => {
        for (const round of rounds) {
          const eligibleIds = Array.from({ length: round.eligibleCount }, (_, i) => `e${i}`);
          const refusedIds = eligibleIds.slice(0, Math.min(round.refusedCount, eligibleIds.length));

          const result = computeSpawnPlan({
            eligibleIds,
            capacity,
            currentInFlight: round.currentInFlight,
            refused: refusedIds,
          });

          assert.ok(
            round.currentInFlight + result.spawn.length <= Math.max(capacity, round.currentInFlight),
            'spawning never increases fan-out beyond the capacity ceiling (once already over capacity, nothing new spawns)',
          );
          assert.ok(result.spawn.length <= Math.max(capacity - round.currentInFlight, 0), 'spawn count never exceeds remaining capacity');
          // Every refused id is in pending, never in spawn.
          for (const id of refusedIds) {
            assert.ok(!result.spawn.includes(id), `refused id ${id} must never be spawned`);
            assert.ok(result.pending.includes(id), `refused id ${id} must return to pending`);
          }
          // spawn and pending partition eligibleIds exactly (no id lost, none duplicated).
          assert.deepEqual([...result.spawn, ...result.pending].sort(), eligibleIds.slice().sort());
        }
      },
    ), { numRuns: 100 });
  });
});

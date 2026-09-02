'use strict';

/**
 * quick-batch.property.test.cjs — Property-based tests for quick-batch core
 * primitives (#3675, epic #3344, ADR-1239 "Quick-batch binding").
 *
 * Module: gsd-core/bin/lib/quick-batch.cjs (compiled from src/quick-batch.cts)
 *
 * Test matrix rows covered (`.gsd/phase/feat-3675-quick-batch-core-primitives/50-test-matrix.md`):
 *   15 — collision-freedom under lock contention (allocation)
 *   26 — resume idempotency
 *   30 — exactly-once STATE completion
 *   32 — wave totality (every item in exactly one wave)
 *   33 — wave order respects the DAG
 *
 * Every property calls the REAL, unmodified `createBatch` / `resumeBatch` /
 * `completeQuickItem` / `computeWaves` — never a mock — per the test matrix's
 * "Assertion-shape note".
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  createBatch,
  computeWaves,
  resumeBatch,
  completeQuickItem,
} = require('../gsd-core/bin/lib/quick-batch.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');
const { cleanup } = require('./helpers.cjs');

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-batch-prop-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  cleanup(dir);
}

function stateWithQuickTasksSection() {
  return [
    '# STATE',
    '',
    '## Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Status | Directory |',
    '| --- | --- | --- | --- | --- | --- |',
    '',
  ].join('\n');
}

/** A small acyclic dependency graph: item i may depend on any j < i (DAG by construction). */
const dagItemsArb = fc.integer({ min: 1, max: 8 }).chain((n) =>
  fc.tuple(
    ...Array.from({ length: n }, (_, i) =>
      fc.record({
        description: fc.constant(`item-${i}`),
        dependsOnPrevious: fc.subarray(Array.from({ length: i }, (_, j) => j), { maxLength: i }),
        files: fc.array(fc.constantFrom('f0', 'f1', 'f2', 'f3'), { maxLength: 2 }),
      }),
    ),
  ),
);

describe('quick-batch: property — collision-freedom under lock contention (row 15)', () => {
  test('property: any number of sequential createBatch calls sharing one frozen clock never collide', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 5 }), // number of createBatch calls
      fc.integer({ min: 1, max: 4 }), // items per call
      (numCalls, itemsPerCall) => {
        const dir = mkTmpProject();
        try {
          const clock = makeFakeClock(Date.UTC(2026, 5, 1, 12, 0, 0));
          const allIds = [];
          for (let c = 0; c < numCalls; c++) {
            const items = Array.from({ length: itemsPerCall }, (_, i) => ({ description: `call${c}-item${i}` }));
            const result = createBatch(dir, items, { clock });
            assert.equal(result.ok, true);
            allIds.push(result.value.batchId, ...result.value.manifest.items.map((it) => it.quick_id));
          }
          assert.equal(new Set(allIds).size, allIds.length, 'zero cross-call id collisions');
        } finally {
          cleanupDir(dir);
        }
      },
    ), { numRuns: 30 }); // filesystem-backed property — bounded below the global 200 default
  });
});

describe('quick-batch: property — resume idempotency (row 26)', () => {
  test('property: resuming an unchanged manifest twice produces identical eligible sets and zero transitions the second time', () => {
    fc.assert(fc.property(
      dagItemsArb,
      (rawItems) => {
        const dir = mkTmpProject();
        try {
          const items = rawItems.map((it, i) => ({
            description: it.description,
            clientId: `c${i}`,
            dependsOn: it.dependsOnPrevious.map((j) => `c${j}`),
            plannedFiles: it.files,
          }));
          const created = createBatch(dir, items);
          assert.equal(created.ok, true);

          const first = resumeBatch(dir, created.value.batchId);
          assert.equal(first.ok, true);
          const second = resumeBatch(dir, created.value.batchId);
          assert.equal(second.ok, true);

          assert.deepEqual(second.value.eligible.slice().sort(), first.value.eligible.slice().sort());
          assert.deepEqual(second.value.transitions, [], 'second call on an unchanged manifest is a no-op');
        } finally {
          cleanupDir(dir);
        }
      },
    ), { numRuns: 30 });
  });
});

describe('quick-batch: property — exactly-once STATE completion (row 30)', () => {
  test('property: completing the same item N times appends exactly one STATE row', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 5 }), // repeat count
      (repeatCount) => {
        const dir = mkTmpProject();
        fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), stateWithQuickTasksSection());
        try {
          const created = createBatch(dir, [{ description: 'solo' }, { description: 'other' }]);
          assert.equal(created.ok, true);
          const item = created.value.manifest.items[0];
          const fields = { description: item.description, date: '2026-01-01', commit: 'shaX' };

          let appendedCount = 0;
          for (let i = 0; i < repeatCount; i++) {
            const result = completeQuickItem(dir, created.value.batchId, item.quick_id, fields);
            assert.equal(result.ok, true);
            if (result.value.appended) appendedCount++;
          }
          assert.equal(appendedCount, 1, 'exactly one of the N calls actually appended');

          const state = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf-8');
          const rowOccurrences = state.split(item.quick_id).length - 1;
          assert.equal(rowOccurrences, 1, 'exactly one row, regardless of how many times completion was requested');
        } finally {
          cleanupDir(dir);
        }
      },
    ), { numRuns: 30 });
  });
});

describe('quick-batch: property — wave totality (row 32)', () => {
  test('property: for any valid (acyclic, in-batch-only) dependency graph, every item appears in exactly one wave', () => {
    fc.assert(fc.property(
      dagItemsArb,
      (rawItems) => {
        const items = rawItems.map((it, i) => ({
          quickId: `id-${i}`,
          dependsOn: it.dependsOnPrevious.map((j) => `id-${j}`),
          plannedFiles: it.files,
        }));
        const waves = computeWaves(items);
        assert.equal(waves.ok, true);
        const flat = waves.value.flat();
        assert.equal(flat.length, items.length, 'no item lost or duplicated across waves');
        assert.deepEqual(flat.slice().sort(), items.map((it) => it.quickId).sort());
      },
    ));
  });
});

describe('quick-batch: property — wave order respects the DAG (row 33)', () => {
  test('property: no item\'s wave index is <= any of its dependencies\' wave indices', () => {
    fc.assert(fc.property(
      dagItemsArb,
      (rawItems) => {
        const items = rawItems.map((it, i) => ({
          quickId: `id-${i}`,
          dependsOn: it.dependsOnPrevious.map((j) => `id-${j}`),
          plannedFiles: it.files,
        }));
        const waves = computeWaves(items);
        assert.equal(waves.ok, true);
        const waveIndexOf = new Map();
        waves.value.forEach((wave, idx) => {
          for (const id of wave) waveIndexOf.set(id, idx);
        });
        for (const it of items) {
          const ownWave = waveIndexOf.get(it.quickId);
          for (const dep of it.dependsOn) {
            const depWave = waveIndexOf.get(dep);
            assert.ok(depWave < ownWave, `dependency ${dep} (wave ${depWave}) must strictly precede ${it.quickId} (wave ${ownWave})`);
          }
        }
      },
    ));
  });
});

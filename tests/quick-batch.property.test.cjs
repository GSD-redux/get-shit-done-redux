'use strict';

/**
 * quick-batch.property.test.cjs — Property-based tests for quick-batch core
 * primitives (#3675, epic #3344, ADR-1239 "Quick-batch binding").
 *
 * Module: gsd-core/bin/lib/quick-batch.cjs (compiled from src/quick-batch.cts)
 *
 * Test matrix rows covered (`.gsd/phase/feat-3675-quick-batch-core-primitives/50-test-matrix.md`):
 *   parser — parseTaskList round-trips any valid bulleted task list (CLAUDE.md
 *            "Property-Based Testing: Parsers... must include at least one
 *            fast-check property test")
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
  parseTaskList,
  createBatch,
  computeWaves,
  resumeBatch,
  completeQuickItem,
  updateBatchItems,
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

// Trimmed, single-line, non-empty description — sidesteps the parser's own
// whitespace-collapsing at the bullet/content boundary (a leading run of
// whitespace right after the bullet marker is consumed by the required
// separator, not preserved as content) so round-tripping is exact.
const taskDescriptionArb = fc.string({ minLength: 1, maxLength: 40 })
  .filter((s) => !/[\r\n]/.test(s) && s === s.trim() && s.length > 0);
const bulletArb = fc.constantFrom('-', '*');

describe('quick-batch: property — parseTaskList round-trips any valid task list (parser)', () => {
  test('property: N (>=2) bulleted descriptions parse back in order, byte-identical', () => {
    fc.assert(fc.property(
      fc.array(taskDescriptionArb, { minLength: 2, maxLength: 20 }),
      fc.array(bulletArb, { minLength: 20, maxLength: 20 }),
      (descriptions, bullets) => {
        const text = descriptions.map((d, i) => `${bullets[i]} ${d}`).join('\n');
        const result = parseTaskList(text);
        assert.equal(result.ok, true);
        assert.deepEqual(result.value.map((it) => it.description), descriptions);
      },
    ), { numRuns: 100 });
  });

  test('property: fewer than 2 parsed lines is always rejected', () => {
    fc.assert(fc.property(
      fc.option(taskDescriptionArb, { nil: undefined }),
      (maybeOne) => {
        const text = maybeOne === undefined ? 'just prose, no bullets\nmore prose' : `- ${maybeOne}`;
        const result = parseTaskList(text);
        assert.equal(result.ok, false);
      },
    ), { numRuns: 30 });
  });
});

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

// #3676 review pass 3 (Spec finding, test matrix row 24): a post-planning
// updateBatchItems write racing a concurrent completeQuickItem write for a
// DIFFERENT already-dispatched item — both go through withPlanningLock, so
// no update should ever be lost regardless of call order. Mirrors row 15's
// own technique above: real lock serialization exercised via SEQUENTIAL
// calls (a working mutex makes any interleaving equivalent to SOME serial
// order — proving no ordering loses an update is the same claim a literal
// concurrent-thread test would make, without OS-level threading).
describe('quick-batch: property — updateBatchItems does not lose a concurrent completeQuickItem update, or vice versa (row 24)', () => {
  test('property: for any call order, both a post-planning update AND a different item\'s completion survive in the final manifest', () => {
    fc.assert(fc.property(
      fc.boolean(), // true: updateBatchItems first; false: completeQuickItem first
      fc.array(fc.constantFrom('f0', 'f1', 'f2'), { maxLength: 2 }),
      (updateFirst, plannedFiles) => {
        const dir = mkTmpProject();
        fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), stateWithQuickTasksSection());
        try {
          const created = createBatch(dir, [
            { description: 'item A (gets the post-planning update)', clientId: 'a' },
            { description: 'item B (gets completed concurrently)', clientId: 'b' },
          ]);
          assert.equal(created.ok, true);
          const [itemA, itemB] = created.value.manifest.items;

          const doUpdate = () => updateBatchItems(dir, created.value.batchId, [
            { quickId: itemA.quick_id, plannedFiles },
          ]);
          const doComplete = () => completeQuickItem(dir, created.value.batchId, itemB.quick_id, {
            description: itemB.description,
            date: '2026-01-01',
            commit: 'deadbeef',
          });

          const [first, second] = updateFirst ? [doUpdate, doComplete] : [doComplete, doUpdate];
          const firstResult = first();
          assert.equal(firstResult.ok, true, firstResult.ok ? '' : firstResult.reason);
          const secondResult = second();
          assert.equal(secondResult.ok, true, secondResult.ok ? '' : secondResult.reason);

          // No lost update, regardless of order: the FINAL on-disk manifest
          // (re-read fresh, not either call's own stale in-memory copy)
          // reflects BOTH mutations — valid JSON, both writers' changes present.
          const raw = fs.readFileSync(path.join(dir, '.planning', 'quick-batches', created.value.batchId, 'BATCH.json'), 'utf-8');
          const finalManifest = JSON.parse(raw); // throws (property fails) on invalid JSON
          const finalA = finalManifest.items.find((it) => it.quick_id === itemA.quick_id);
          const finalB = finalManifest.items.find((it) => it.quick_id === itemB.quick_id);
          assert.deepEqual(finalA.planned_files, plannedFiles, 'item A\'s post-planning update was not lost');
          assert.equal(finalB.status, 'complete', 'item B\'s completion was not lost');
          assert.equal(finalB.commit, 'deadbeef');
        } finally {
          cleanupDir(dir);
        }
      },
    ), { numRuns: 20 }); // filesystem-backed property — bounded below the global default
  });
});

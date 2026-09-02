'use strict';

/**
 * quick-batch-update-items.test.cjs — Behavioral tests for
 * `updateBatchItems`, the new additive export on `src/quick-batch.cts`
 * (#3676, Phase 4 of epic #3344 / ADR-1239 "Quick-batch binding").
 *
 * Resolves the design doc's Open Question 1 as ONE new, purely-additive
 * exported function on the SAME module `createBatch`/`resumeBatch`/
 * `completeQuickItem` already use — never a second, independent writer
 * against `BATCH.json`. This file is new and standalone (not appended to
 * `tests/quick-batch.test.cjs`) precisely so Phase 3's own test suite stays
 * untouched, per the phase brief's regression-check requirement.
 *
 * Module: gsd-core/bin/lib/quick-batch.cjs (compiled from src/quick-batch.cts)
 *
 * Design doc: `.gsd/phase/feat-3676-quick-batch-command-workflow/40-design.md`
 * (row 15, row 22-23). Test matrix rows 22-24.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createBatch,
  loadBatch,
  updateBatchItems,
} = require('../gsd-core/bin/lib/quick-batch.cjs');
const { cleanup } = require('./helpers.cjs');

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-batch-update-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

describe('quick-batch: updateBatchItems — basic mutation + persistence', () => {
  test('updates depends_on and planned_files for a named item and persists them', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [
        { description: 'item A', clientId: 'a' },
        { description: 'item B', clientId: 'b' },
      ]);
      assert.equal(created.ok, true);
      const [itemA, itemB] = created.value.manifest.items;

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemB.quick_id, dependsOn: [itemA.quick_id], plannedFiles: ['src/b.ts'] },
      ]);
      assert.equal(result.ok, true, result.ok ? '' : result.reason);

      const updatedB = result.value.manifest.items.find((it) => it.quick_id === itemB.quick_id);
      assert.deepEqual(updatedB.depends_on, [itemA.quick_id]);
      assert.deepEqual(updatedB.planned_files, ['src/b.ts']);

      // Durably persisted — a fresh loadBatch sees the same values.
      const reloaded = loadBatch(dir, created.value.batchId);
      assert.equal(reloaded.ok, true);
      const reloadedB = reloaded.value.items.find((it) => it.quick_id === itemB.quick_id);
      assert.deepEqual(reloadedB.depends_on, [itemA.quick_id]);
      assert.deepEqual(reloadedB.planned_files, ['src/b.ts']);
    } finally {
      cleanup(dir);
    }
  });

  test('normalizes plannedFiles with posixNormalize, same as createBatch', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [{ description: 'a' }, { description: 'b' }]);
      assert.equal(created.ok, true);
      const [itemA] = created.value.manifest.items;

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, plannedFiles: ['src\\windows\\path.ts'] },
      ]);
      assert.equal(result.ok, true);
      const updated = result.value.manifest.items.find((it) => it.quick_id === itemA.quick_id);
      assert.deepEqual(updated.planned_files, ['src/windows/path.ts']);
    } finally {
      cleanup(dir);
    }
  });

  test('omitting a field on an update leaves that item field untouched', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [
        { description: 'a', clientId: 'a', plannedFiles: ['src/a.ts'] },
        { description: 'b', clientId: 'b' },
      ]);
      assert.equal(created.ok, true);
      const [itemA] = created.value.manifest.items;

      // Only dependsOn supplied — plannedFiles must survive unchanged.
      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, dependsOn: [] },
      ]);
      assert.equal(result.ok, true);
      const updated = result.value.manifest.items.find((it) => it.quick_id === itemA.quick_id);
      assert.deepEqual(updated.planned_files, ['src/a.ts'], 'planned_files untouched when omitted from the update');
    } finally {
      cleanup(dir);
    }
  });

  test('updates for multiple items in one call apply atomically', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [
        { description: 'a', clientId: 'a' },
        { description: 'b', clientId: 'b' },
        { description: 'c', clientId: 'c' },
      ]);
      assert.equal(created.ok, true);
      const [itemA, itemB, itemC] = created.value.manifest.items;

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemB.quick_id, dependsOn: [itemA.quick_id] },
        { quickId: itemC.quick_id, dependsOn: [itemB.quick_id] },
      ]);
      assert.equal(result.ok, true);
      const byId = new Map(result.value.manifest.items.map((it) => [it.quick_id, it]));
      assert.deepEqual(byId.get(itemB.quick_id).depends_on, [itemA.quick_id]);
      assert.deepEqual(byId.get(itemC.quick_id).depends_on, [itemB.quick_id]);
    } finally {
      cleanup(dir);
    }
  });
});

describe('quick-batch: updateBatchItems — fails closed, never persists on a bad update', () => {
  test('rejects an unknown quickId without persisting anything', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [{ description: 'a' }, { description: 'b' }]);
      assert.equal(created.ok, true);

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: '999999-zzz', dependsOn: [] },
      ]);
      assert.equal(result.ok, false);
      assert.match(result.reason, /no item 999999-zzz/);

      const reloaded = loadBatch(dir, created.value.batchId);
      assert.equal(reloaded.ok, true);
      assert.deepEqual(reloaded.value.items, created.value.manifest.items, 'manifest is byte-unchanged after a rejected update');
    } finally {
      cleanup(dir);
    }
  });

  test('rejects an unknown dependency reference without persisting', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [{ description: 'a' }, { description: 'b' }]);
      assert.equal(created.ok, true);
      const [itemA] = created.value.manifest.items;

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, dependsOn: ['999999-zzz'] },
      ]);
      assert.equal(result.ok, false);
      assert.match(result.reason, /unknown dependency reference/);

      const reloaded = loadBatch(dir, created.value.batchId);
      assert.equal(reloaded.ok, true);
      assert.deepEqual(reloaded.value.items.find((it) => it.quick_id === itemA.quick_id).depends_on, []);
    } finally {
      cleanup(dir);
    }
  });

  test('rejects a self-dependency without persisting', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [{ description: 'a' }, { description: 'b' }]);
      assert.equal(created.ok, true);
      const [itemA] = created.value.manifest.items;

      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, dependsOn: [itemA.quick_id] },
      ]);
      assert.equal(result.ok, false);
      assert.match(result.reason, /dependency on itself/);
    } finally {
      cleanup(dir);
    }
  });

  test('rejects an update that introduces a dependency cycle — fails closed, no partial write (negative case)', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [
        { description: 'a', clientId: 'a' },
        { description: 'b', clientId: 'b' },
      ]);
      assert.equal(created.ok, true);
      const [itemA, itemB] = created.value.manifest.items;

      // First make B depend on A (valid).
      const first = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemB.quick_id, dependsOn: [itemA.quick_id] },
      ]);
      assert.equal(first.ok, true);

      // Now try to make A depend on B too — a two-item cycle.
      const cyclic = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, dependsOn: [itemB.quick_id] },
      ]);
      assert.equal(cyclic.ok, false);
      assert.match(cyclic.reason, /cycle/);

      // The manifest still reflects only the first (valid) update — the
      // rejected cyclic update never persisted.
      const reloaded = loadBatch(dir, created.value.batchId);
      assert.equal(reloaded.ok, true);
      const reloadedA = reloaded.value.items.find((it) => it.quick_id === itemA.quick_id);
      assert.deepEqual(reloadedA.depends_on, [], 'A was never actually updated to depend on B');
    } finally {
      cleanup(dir);
    }
  });
});

describe('quick-batch: updateBatchItems — post-planning wave recompute (design rows 15,22-23)', () => {
  test('row 22: a dependency declared after planning strictly separates waves', () => {
    const dir = mkTmpProject();
    try {
      // No dependency/file-overlap signal at createBatch time — both items
      // land in wave 0 (Open Question 1's documented negative space).
      const created = createBatch(dir, [
        { description: 'A', clientId: 'a' },
        { description: 'B', clientId: 'b' },
      ]);
      assert.equal(created.ok, true);
      const [itemA, itemB] = created.value.manifest.items;
      assert.equal(itemA.wave, 0);
      assert.equal(itemB.wave, 0, 'before planning, both items land in wave 0 (no signal yet)');

      // Planner for B declares depends_on: [A], files disjoint from A.
      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, plannedFiles: ['src/a.ts'] },
        { quickId: itemB.quick_id, dependsOn: [itemA.quick_id], plannedFiles: ['src/b.ts'] },
      ]);
      assert.equal(result.ok, true, result.ok ? '' : result.reason);
      const byId = new Map(result.value.manifest.items.map((it) => [it.quick_id, it]));
      assert.ok(byId.get(itemB.quick_id).wave > byId.get(itemA.quick_id).wave, 'B strictly follows A after the recompute');
    } finally {
      cleanup(dir);
    }
  });

  test('row 23: file-overlap declared after planning separates two independent items into different waves', () => {
    const dir = mkTmpProject();
    try {
      const created = createBatch(dir, [
        { description: 'A', clientId: 'a' },
        { description: 'B', clientId: 'b' },
      ]);
      assert.equal(created.ok, true);
      const [itemA, itemB] = created.value.manifest.items;
      assert.equal(itemA.wave, itemB.wave, 'both start in the same wave — no DAG edge, no file signal yet');

      // Two independent items (no depends_on edge) but their plans declare
      // OVERLAPPING files — partitionByFileOverlap must separate them.
      const result = updateBatchItems(dir, created.value.batchId, [
        { quickId: itemA.quick_id, plannedFiles: ['src/shared.ts'] },
        { quickId: itemB.quick_id, plannedFiles: ['src/shared.ts'] },
      ]);
      assert.equal(result.ok, true, result.ok ? '' : result.reason);
      const byId = new Map(result.value.manifest.items.map((it) => [it.quick_id, it]));
      assert.notEqual(
        byId.get(itemA.quick_id).wave,
        byId.get(itemB.quick_id).wave,
        'overlapping planned_files must land the two items in different waves, even though createBatch originally put them together',
      );
    } finally {
      cleanup(dir);
    }
  });
});

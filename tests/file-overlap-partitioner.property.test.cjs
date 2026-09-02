'use strict';

/**
 * Property-based tests for file-overlap-partitioner.cjs (#3674)
 *
 * Module: gsd-core/bin/lib/file-overlap-partitioner.cjs
 * Exported: partitionByFileOverlap(items: { id: string; files: string[] }[]) -> string[][]
 *
 * Properties tested (test matrix rows 9-11):
 *   (a) determinism — two runs on the same input produce an identical partition
 *   (b) totality — every input item appears in exactly one output stage,
 *       never lost or duplicated
 *   (c) the core invariant — no two items in the same stage share a file
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { partitionByFileOverlap } = require('../gsd-core/bin/lib/file-overlap-partitioner.cjs');

/** A single overlap item: a small id plus a small set of file tokens (some shared, some not). */
const itemArb = fc.record({
  id: fc.integer({ min: 0, max: 999 }).map((n) => 'p' + n),
  files: fc.array(fc.constantFrom('f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'), { maxLength: 4 }),
});

describe('partitionByFileOverlap: properties', () => {

  test('property: repeated runs on the same input are deterministic', () => {
    fc.assert(fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 60 }),
      (items) => {
        const a = partitionByFileOverlap(items);
        const b = partitionByFileOverlap(items);
        assert.deepStrictEqual(a, b);
      },
    ));
  });

  test('property: every input plan appears in exactly one output stage', () => {
    fc.assert(fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 60 }),
      (items) => {
        const stages = partitionByFileOverlap(items);
        const flat = stages.flatMap((s) => s);
        assert.strictEqual(flat.length, items.length, 'no item lost or duplicated across stages');
        // Positional identity: nth occurrence in flattened output must match
        // input order's ids, one-to-one (id alone is not unique under
        // duplicates, so compare the full multiset via sorted copies).
        assert.deepStrictEqual(flat.slice().sort(), items.map((i) => i.id).sort());
      },
    ));
  });

  test('property: no two plans in the same stage share a modified file', () => {
    fc.assert(fc.property(
      fc.array(itemArb, { minLength: 0, maxLength: 60 }),
      (items) => {
        const stages = partitionByFileOverlap(items);
        // Duplicate ids are possible (not deduplicated) — build a positional
        // lookup instead of an id-keyed one so every occurrence is checked.
        const remaining = items.map((i) => ({ id: i.id, files: new Set(i.files) }));
        for (const stageIds of stages) {
          const stageItems = stageIds.map((id) => {
            const idx = remaining.findIndex((r) => r.id === id);
            const found = remaining[idx];
            remaining.splice(idx, 1);
            return found;
          });
          for (let i = 0; i < stageItems.length; i++) {
            for (let j = i + 1; j < stageItems.length; j++) {
              const a = stageItems[i].files;
              const b = stageItems[j].files;
              let overlap = false;
              for (const f of a) if (b.has(f)) { overlap = true; break; }
              assert.ok(!overlap, `stage-mates ${stageItems[i].id} and ${stageItems[j].id} must not share a file`);
            }
          }
        }
      },
    ));
  });
});

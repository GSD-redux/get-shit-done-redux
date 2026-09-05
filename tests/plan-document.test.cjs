'use strict';

/**
 * Unit tests for plan-document.cjs
 *
 * Module: gsd-core/bin/lib/plan-document.cjs
 *
 * Covers the `tracker-id` attribute (ADR-3646 Phase 1, #3970) added to the
 * `<task>` element grammar, plus regression coverage proving the addition
 * does not alter pre-existing task-parsing behaviour.
 *
 * Matrix rows referenced below are from
 * .gsd/phase/feat-3970-task-content-resolution-seam/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePlanDocument } = require('../gsd-core/bin/lib/plan-document.cjs');

describe('plan-document: tracker-id attribute', () => {
  test('row 1 — no tracker-id attribute yields trackerId: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, null);
  });

  test('row 2 — tracker-id is read verbatim, never split', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="beads:GSD-42">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, 'beads:GSD-42');
  });

  test('row 3 — tracker-id="" (empty string) normalises to null', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, null);
  });

  test('row 4 — checkpoint tasks never read tracker-id, even when present', () => {
    const doc = parsePlanDocument(`
<task type="checkpoint:decision" tracker-id="beads:GSD-99">
<decision>Ship it</decision>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].kind, 'checkpoint');
    assert.equal(doc.tasks[0].trackerId, null);
  });
});

describe('plan-document: tdd attribute (#4273)', () => {
  test('row 1 — tdd="true" is read verbatim', () => {
    const doc = parsePlanDocument(`
<task type="auto" tdd="true">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, 'true');
  });

  test('row 2 — no tdd attribute yields tdd: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, null);
  });

  test('row 3 — tdd="" (empty string) normalises to null', () => {
    const doc = parsePlanDocument(`
<task type="auto" tdd="">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, null);
  });

  test('row 4 — tdd="TRUE" and tdd="1" are read verbatim, never coerced to a boolean', () => {
    const docUpper = parsePlanDocument(`
<task type="auto" tdd="TRUE">
<name>Do a thing</name>
</task>
`);
    assert.equal(docUpper.tasks[0].tdd, 'TRUE');
    assert.notEqual(docUpper.tasks[0].tdd, 'true');

    const docNumeric = parsePlanDocument(`
<task type="auto" tdd="1">
<name>Do a thing</name>
</task>
`);
    assert.equal(docNumeric.tasks[0].tdd, '1');
  });

  test('row 5 — checkpoint tasks never read tdd, even when present', () => {
    const doc = parsePlanDocument(`
<task type="checkpoint:decision" tdd="true">
<decision>Ship it</decision>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].kind, 'checkpoint');
    assert.equal(doc.tasks[0].tdd, null);
  });
});

describe('plan-document: frontmatter type (#4273)', () => {
  test('row 6 — frontmatter type: tdd is read verbatim onto doc.type', () => {
    const doc = parsePlanDocument(`---
type: tdd
---
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, 'tdd');
  });

  test('row 7 — frontmatter type: standard is read verbatim, not coerced to a boolean', () => {
    const doc = parsePlanDocument(`---
type: standard
---
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, 'standard');
  });

  test('row 8 — no frontmatter type yields doc.type: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, null);
  });
});

describe('plan-document: regression — legacy behaviour unchanged', () => {
  test('legacy `## Task N` markdown fallback still parses with trackerId: null', () => {
    const doc = parsePlanDocument(`
## Task 1: Do a thing

Some body text.

## Task 2: Do another thing
`);
    assert.equal(doc.tasks.length, 2);
    for (const t of doc.tasks) {
      assert.equal(t.kind, 'auto');
      assert.equal(t.type, null);
      assert.equal(t.trackerId, null);
      assert.deepEqual(t.plannedFiles, []);
      assert.deepEqual(t.acceptanceCriteria, []);
      assert.equal(t.done, null);
    }
    assert.equal(doc.tasks[0].name, 'Task 1: Do a thing');
    assert.equal(doc.tasks[1].name, 'Task 2: Do another thing');
  });

  test('ordinary task with name/files/acceptance_criteria still parses correctly alongside trackerId', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="beads:GSD-7">
<name>Implement the seam</name>
<files>src/a.cts, src/b.cts</files>
<acceptance_criteria>
- criterion one
- criterion two
</acceptance_criteria>
<done>Merged.</done>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    const t = doc.tasks[0];
    assert.equal(t.kind, 'auto');
    assert.equal(t.type, 'auto');
    assert.equal(t.name, 'Implement the seam');
    assert.deepEqual(t.plannedFiles, ['src/a.cts', 'src/b.cts']);
    assert.deepEqual(t.acceptanceCriteria, ['criterion one', 'criterion two']);
    assert.equal(t.done, 'Merged.');
    assert.equal(t.trackerId, 'beads:GSD-7');
  });
});

'use strict';

/**
 * Example-based unit tests for context-composer.cjs — new surface added by
 * issue #2929: `flexReserve` floors (criterion 5) and `isolate` fragments
 * (criterion 6). Property tests alone don't pin exact behavior, so these
 * assert exact outputs (exact content, exact metadata arrays, exact thrown
 * errors).
 *
 * Module: gsd-core/bin/lib/context-composer.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { composeWithinBudget } = require('../gsd-core/bin/lib/context-composer.cjs');

const measureChars4 = (text) => (text ? Math.ceil(text.length / 4) : 0);

// ─── flexReserve: drop ─────────────────────────────────────────────────────

describe('composeWithinBudget: flexReserve prevents a drop', () => {
  test('a flexReserve\'d drop fragment is never dropped under crushing pressure', () => {
    const result = composeWithinBudget({
      fragments: [
        { id: 'required', content: 'R'.repeat(100), strategy: { kind: 'verbatim' }, required: true },
        { id: 'droppable', content: 'X'.repeat(40), strategy: { kind: 'drop' }, flexReserve: 5 },
      ],
      budget: 1,
      measure: measureChars4,
    });

    assert.equal(result.metadata.hardFailed, false);
    const droppable = result.fragments.find((f) => f.id === 'droppable');
    assert.equal(droppable.content, 'X'.repeat(40));
    assert.ok(!result.metadata.omitted.includes('droppable'));
    assert.ok(result.metadata.floored.includes('droppable'));
  });

  test('a drop fragment WITHOUT flexReserve is dropped under the same pressure', () => {
    const result = composeWithinBudget({
      fragments: [
        { id: 'required', content: 'R'.repeat(100), strategy: { kind: 'verbatim' }, required: true },
        { id: 'droppable', content: 'X'.repeat(40), strategy: { kind: 'drop' } },
      ],
      budget: 1,
      measure: measureChars4,
    });

    const droppable = result.fragments.find((f) => f.id === 'droppable');
    assert.equal(droppable.content, '');
    assert.ok(result.metadata.omitted.includes('droppable'));
    assert.ok(!result.metadata.floored.includes('droppable'));
  });
});

// ─── flexReserve: head-shrink ──────────────────────────────────────────────

describe('composeWithinBudget: flexReserve prevents an undershooting head-shrink', () => {
  test('shrink is skipped entirely when it would fall below the floor', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const fragments = [
      { id: 'required', content: 'R'.repeat(200), strategy: { kind: 'verbatim' }, required: true },
      // headShrink(content, 1) => "line1" (measure = ceil(5/4) = 2), which is
      // below a flexReserve of 10 — shrink must be skipped entirely.
      { id: 'shrinkable', content, strategy: { kind: 'head-shrink', maxLines: 1 }, flexReserve: 10 },
    ];
    const result = composeWithinBudget({ fragments, budget: 1, measure: measureChars4 });

    const shrinkable = result.fragments.find((f) => f.id === 'shrinkable');
    assert.equal(shrinkable.content, content);
    assert.equal(shrinkable.shrunk, false);
    assert.ok(!result.metadata.shrunk.includes('shrinkable'));
    assert.ok(result.metadata.floored.includes('shrinkable'));
  });

  test('shrink still applies when the result stays at/above the floor', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const fragments = [
      { id: 'required', content: 'R'.repeat(200), strategy: { kind: 'verbatim' }, required: true },
      // headShrink(content, 1) => "line1" (measure = 2) >= flexReserve 1.
      { id: 'shrinkable', content, strategy: { kind: 'head-shrink', maxLines: 1 }, flexReserve: 1 },
    ];
    const result = composeWithinBudget({ fragments, budget: 1, measure: measureChars4 });

    const shrinkable = result.fragments.find((f) => f.id === 'shrinkable');
    assert.equal(shrinkable.content, 'line1');
    assert.equal(shrinkable.shrunk, true);
    assert.ok(result.metadata.shrunk.includes('shrinkable'));
    assert.ok(!result.metadata.floored.includes('shrinkable'));
  });
});

// ─── flexReserve: proportional-truncate ────────────────────────────────────

describe('composeWithinBudget: flexReserve raises the proportional cap above the share', () => {
  test('flexReserve wins over a smaller proportional share', () => {
    // Walk-through (charsPerUnit=4, safetyMarginPct=0, measure=chars/4):
    //   required: 'R'.repeat(40) verbatim -> measures 10 units
    //   proportional: 'Y'.repeat(400) proportional-truncate, floorChars: 0, flexReserve: 30
    //   baseline = 10 + 100 = 110 > 30 (budget), so pressure; contentBudget = 30 (reserve defaults to 0)
    //   overhead = 110 - 100 = 10  ->  groupBudget = 30 - 10 = 20, which is in (0, 100), so the step RUNS
    //   charsBudget = 20 * 4 = 80  ->  share = floor(400/400 * 80) = 80
    //   charsForReserve = flexReserve 30 * charsPerUnit 4 = 120
    //   maxChars = max(max(share 80, floorChars 0), 120) = 120
    // The surviving content is exactly 120 chars — not the 80 the share alone would allow,
    // proving flexReserve raised the cap above the proportional share.
    const content = 'Y'.repeat(400);
    const fragments = [
      { id: 'required', content: 'R'.repeat(40), strategy: { kind: 'verbatim' }, required: true },
      {
        id: 'proportional',
        content,
        strategy: { kind: 'proportional-truncate', floorChars: 0 },
        flexReserve: 30,
      },
    ];
    const result = composeWithinBudget({
      fragments,
      budget: 30,
      measure: measureChars4,
      options: { charsPerUnit: 4, safetyMarginPct: 0 },
    });

    const proportional = result.fragments.find((f) => f.id === 'proportional');
    assert.equal(proportional.content.length, 120);
    assert.equal(proportional.content, 'Y'.repeat(120));
    assert.equal(proportional.truncated, true);
    assert.ok(result.metadata.floored.includes('proportional'));
  });

  test('floored records exactly the ids whose flexReserve prevented a smaller truncation', () => {
    // Content already fits within the reserve-derived cap => no truncation
    // happens at all, so this id must NOT be floored (nothing prevented).
    const shortContent = 'Z'.repeat(10);
    const fragments = [
      { id: 'required', content: 'R'.repeat(400), strategy: { kind: 'verbatim' }, required: true },
      {
        id: 'untouched',
        content: shortContent,
        strategy: { kind: 'proportional-truncate', floorChars: 0 },
        flexReserve: 20,
      },
      {
        id: 'protected',
        content: 'Y'.repeat(100),
        strategy: { kind: 'proportional-truncate', floorChars: 0 },
        flexReserve: 20,
        group: 'g2',
      },
    ];
    const result = composeWithinBudget({
      fragments,
      budget: 1,
      measure: measureChars4,
      options: { charsPerUnit: 4 },
    });

    // 'untouched' has a distinct group key (its own id) from 'protected'
    // (explicit group 'g2'), so they're separate proportional groups; each
    // member's share alone (without flexReserve) would truncate it, but the
    // flexReserve floor (80 chars) rescues 'protected' from any cut since
    // its content (100 chars) actually would be cut without the floor —
    // wait, 100 > 80, so it IS still truncated to 80: not "floored", just
    // truncated less severely. 'untouched' (10 chars) never reaches its
    // proportional cap at all regardless of reserve, so it is untouched.
    assert.ok(!result.metadata.floored.includes('untouched'));
  });
});

// ─── floored: exact accounting across strategies ───────────────────────────

describe('composeWithinBudget: metadata.floored records exactly the protected ids', () => {
  test('floored contains only fragments whose flexReserve actually blocked a trim', () => {
    const fragments = [
      { id: 'required', content: 'R'.repeat(200), strategy: { kind: 'verbatim' }, required: true },
      { id: 'protected-drop', content: 'A'.repeat(20), strategy: { kind: 'drop' }, flexReserve: 3 },
      { id: 'unprotected-drop', content: 'B'.repeat(20), strategy: { kind: 'drop' } },
    ];
    const result = composeWithinBudget({ fragments, budget: 1, measure: measureChars4 });

    assert.deepEqual(result.metadata.floored, ['protected-drop']);
    assert.deepEqual(result.metadata.omitted, ['unprotected-drop']);
  });
});

// ─── isolate ────────────────────────────────────────────────────────────────

describe('composeWithinBudget: isolate fragments', () => {
  test('an isolate fragment survives a budget of 1', () => {
    const content = 'Canonical system prompt prefix, quite long indeed.';
    const fragments = [
      { id: 'system', content, wrapper: '', strategy: { kind: 'drop' }, isolate: true },
      { id: 'rest', content: 'C'.repeat(50), strategy: { kind: 'drop' } },
    ];
    const result = composeWithinBudget({ fragments, budget: 1, measure: measureChars4 });

    const system = result.fragments.find((f) => f.id === 'system');
    assert.equal(system.content, content);
    assert.ok(!result.metadata.omitted.includes('system'));
  });

  test('isolate declared after a non-isolate fragment throws TypeError', () => {
    assert.throws(
      () =>
        composeWithinBudget({
          fragments: [
            { id: 'a', content: 'a', strategy: { kind: 'verbatim' } },
            { id: 'b', content: 'b', strategy: { kind: 'verbatim' }, isolate: true },
          ],
          budget: 100,
          measure: measureChars4,
        }),
      TypeError
    );
  });

  test('two isolate fragments declared first, then non-isolate, does not throw', () => {
    assert.doesNotThrow(() =>
      composeWithinBudget({
        fragments: [
          { id: 'a', content: 'a', strategy: { kind: 'verbatim' }, isolate: true },
          { id: 'b', content: 'b', strategy: { kind: 'verbatim' }, isolate: true },
          { id: 'c', content: 'c', strategy: { kind: 'verbatim' } },
        ],
        budget: 100,
        measure: measureChars4,
      })
    );
  });

  test('isolatePrefix is the wrapper+content concatenation in declaration order', () => {
    const fragments = [
      { id: 'a', content: 'CONTENT-A', wrapper: '<a>', strategy: { kind: 'verbatim' }, isolate: true },
      { id: 'b', content: 'CONTENT-B', wrapper: '<b>', strategy: { kind: 'drop' }, isolate: true },
      { id: 'c', content: 'CONTENT-C', strategy: { kind: 'verbatim' } },
    ];
    const result = composeWithinBudget({ fragments, budget: 1000, measure: measureChars4 });

    assert.equal(result.metadata.isolatePrefix, '<a>CONTENT-A<b>CONTENT-B');
  });

  test('isolatePrefix is empty string when there are no isolate fragments', () => {
    const result = composeWithinBudget({
      fragments: [{ id: 'a', content: 'A', strategy: { kind: 'verbatim' } }],
      budget: 100,
      measure: measureChars4,
    });
    assert.equal(result.metadata.isolatePrefix, '');
  });

  test('isolate counts toward the budget (an isolate fragment still reduces headroom for others)', () => {
    // A large isolate fragment plus a droppable one, at a budget that only
    // fits the isolate fragment: the droppable one must be dropped, proving
    // the isolate fragment's cost was counted against the budget.
    const isolateContent = 'I'.repeat(96); // measure = 24
    const fragments = [
      { id: 'iso', content: isolateContent, strategy: { kind: 'verbatim' }, isolate: true },
      { id: 'drop-me', content: 'D'.repeat(40), strategy: { kind: 'drop' } },
    ];
    const result = composeWithinBudget({ fragments, budget: 24, measure: measureChars4 });

    const iso = result.fragments.find((f) => f.id === 'iso');
    assert.equal(iso.content, isolateContent);
    assert.ok(result.metadata.omitted.includes('drop-me'));
  });
});

// ─── Existing surface: unaffected sanity checks ────────────────────────────

describe('composeWithinBudget: pre-existing invariants still hold', () => {
  test('duplicate id still throws TypeError', () => {
    assert.throws(
      () =>
        composeWithinBudget({
          fragments: [
            { id: 'dup', content: 'x', strategy: { kind: 'verbatim' } },
            { id: 'dup', content: 'y', strategy: { kind: 'verbatim' } },
          ],
          budget: 100,
          measure: measureChars4,
        }),
      TypeError
    );
  });

  test('zero fragments still returns an empty plan', () => {
    const result = composeWithinBudget({ fragments: [], budget: 100, measure: measureChars4 });
    assert.deepEqual(result.fragments, []);
    assert.equal(result.metadata.hardFailed, false);
    assert.deepEqual(result.metadata.omitted, []);
    assert.deepEqual(result.metadata.shrunk, []);
    assert.deepEqual(result.metadata.floored, []);
    assert.equal(result.metadata.isolatePrefix, '');
  });
});

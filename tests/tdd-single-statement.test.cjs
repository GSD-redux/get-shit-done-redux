'use strict';

/**
 * #3990 — the RED/GREEN/REFACTOR cycle is stated ONCE.
 *
 * The cycle used to be restated verbatim in three files (references/tdd.md,
 * agents/gsd-executor.md <tdd_execution>, workflows/execute-plan.md
 * <tdd_plan_execution>), and tdd.md was embedded into EVERY executor dispatch
 * unconditionally — so non-TDD tasks paid for the whole cycle three times.
 * The contract now: one canonical statement in tdd.md, consumers carry
 * pointers, and the embed lists load tdd.md only when the dispatch is TDD.
 * Deployed text IS the runtime-loaded product; shape assertions are the check.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// #4228 diagnosis: the first draft used a regex with two lazy [^]*? spans to
// detect a restated RED/GREEN pair — on a 47KB agent file that is a
// superlinear backtracking walk which completed on linux but pinned a Windows
// CI core for the whole 32-minute job cap (the lane's three cancellations at
// 21m/32m/41m all traced here). IndexOf on disjoint anchors is linear and
// cannot backtrack: a restatement exists iff a RED commit-scope line and a
// LATER GREEN commit-scope line both appear outside the canonical reference.
function restatesCycle(text) {
  const red = text.indexOf('commit: `test({phase}-{plan})');
  if (red === -1) return false;
  const green = text.indexOf('commit: `feat({phase}-{plan})', red);
  return green !== -1;
}

describe('#3990 — one statement of the cycle', () => {
  test('the cycle is stated in full only in the canonical reference', () => {
    const tdd = read('gsd-core/references/tdd.md');
    assert.ok(/## Red-Green-Refactor Cycle/.test(tdd),
      'tdd.md carries the canonical Red-Green-Refactor Cycle section');
    assert.ok(/Commit: `test\(\{phase\}-\{plan\}\)/.test(tdd) && /Commit: `feat\(\{phase\}-\{plan\}\)/.test(tdd),
      'the canonical section carries the commit-scope contract');
  });

  test('the executor carries a pointer, not a third restatement', () => {
    const executor = read('agents/gsd-executor.md');
    assert.ok(!restatesCycle(executor),
      '<tdd_execution> must not restate the numbered RED/GREEN commit protocol — point at tdd.md');
    assert.ok(/references\/tdd\.md/.test(executor),
      'the executor points at the canonical reference');
  });

  test('execute-plan carries a pointer, not a second restatement', () => {
    const plan = read('gsd-core/workflows/execute-plan.md');
    assert.ok(!restatesCycle(plan),
      '<tdd_plan_execution> must not restate the numbered RED/GREEN commit protocol');
    assert.ok(/references\/tdd\.md/.test(plan.slice(plan.indexOf('tdd_plan_execution'))),
      'the plan-execution section points at the canonical reference');
  });

  test('both embed lists load tdd.md only when the dispatch is TDD', () => {
    const main = read('gsd-core/workflows/execute-phase.md');
    const wt = read('gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md');
    for (const [name, text] of [['execute-phase.md', main], ['executor-isolation-dispatch.md', wt]]) {
      // The LIST entry line — not any prose line that mentions tdd.md (the TDD
      // gate's own prose cites it too).
      const line = text.split('\n').find((l) => /tdd\.md/.test(l) && /TDD_APPLICABLE/.test(l));
      assert.ok(line, `${name} still lists tdd.md as a conditional embed entry`);
      assert.ok(/TDD_APPLICABLE \?/.test(line),
        `${name}'s tdd.md entry must be conditional on TDD_APPLICABLE (#3990), got: ${line.trim()}`);
    }
  });
});

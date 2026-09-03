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

const CYCLE_COMMIT_TRIPLET = /\*\*2?\.?\s*RED:\*\*[^]*?commit: `test\(\{phase\}-\{plan\}\)[^]*?\*\*3?\.?\s*GREEN:\*\*[^]*?commit: `feat\(\{phase\}-\{plan\}\)/;

describe('#3990 — one statement of the cycle', () => {
  test('the cycle is stated in full only in the canonical reference', () => {
    const tdd = read('gsd-core/references/tdd.md');
    assert.ok(/## Red-Green-Refactor Cycle/.test(tdd),
      'tdd.md carries the canonical Red-Green-Refactor Cycle section');
    assert.ok(/commit: `test\(\{phase\}-\{plan\}\)/.test(tdd) && /commit: `feat\(\{phase\}-\{plan\}\)/.test(tdd),
      'the canonical section carries the commit-scope contract');
  });

  test('the executor carries a pointer, not a third restatement', () => {
    const executor = read('agents/gsd-executor.md');
    assert.ok(!CYCLE_COMMIT_TRIPLET.test(executor),
      '<tdd_execution> must not restate the numbered RED/GREEN commit protocol — point at tdd.md');
    assert.ok(/references\/tdd\.md/.test(executor),
      'the executor points at the canonical reference');
  });

  test('execute-plan carries a pointer, not a second restatement', () => {
    const plan = read('gsd-core/workflows/execute-plan.md');
    assert.ok(!CYCLE_COMMIT_TRIPLET.test(plan),
      '<tdd_plan_execution> must not restate the numbered RED/GREEN commit protocol');
    assert.ok(/references\/tdd\.md/.test(plan.slice(plan.indexOf('tdd_plan_execution'))),
      'the plan-execution section points at the canonical reference');
  });

  test('both embed lists load tdd.md only when the dispatch is TDD', () => {
    const main = read('gsd-core/workflows/execute-phase.md');
    const wt = read('gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md');
    for (const [name, text] of [['execute-phase.md', main], ['executor-isolation-dispatch.md', wt]]) {
      const line = text.split('\n').find((l) => /references\/tdd\.md|^- tdd\.md/.test(l));
      assert.ok(line, `${name} still lists tdd.md`);
      assert.ok(/\?/.test(line) && /TDD/.test(line),
        `${name}'s tdd.md entry must be conditional on the dispatch being TDD (#3990), got: ${line.trim()}`);
    }
  });
});

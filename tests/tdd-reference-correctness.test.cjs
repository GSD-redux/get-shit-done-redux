'use strict';

/**
 * #4267 / #4269 — tdd.md pointer citations must name the section that
 * actually carries the guidance, and gsd-executor.md's plan-level gate
 * restatement collapses to a pointer at tdd.md's "Gate Enforcement Rules".
 *
 * #4228 introduced pointers in execute-plan.md and gsd-executor.md that all
 * cite a single section — "Red-Green-Refactor Cycle" — for three distinct
 * pieces of guidance (commit-scope contract, fail-fast rule, error handling).
 * Only the commit-scope contract actually lives there; the fail-fast rule is
 * in "Fail-Fast Rules" (a subsection of "Gate Enforcement Rules") and error
 * handling is in its own "Error Handling" section. (#4267)
 *
 * Separately, gsd-executor.md's "## Plan-Level TDD Gate Enforcement" section
 * fully restates gate-sequence rules that tdd.md's "## Gate Enforcement
 * Rules" section already owns (and covers more thoroughly, including the
 * actual bash validation script). (#4269)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('#4267 — pointer text cites the correct tdd.md section per fact', () => {
  test("execute-plan.md's cycle pointer cites three distinct, correctly-named sections", () => {
    const plan = read('gsd-core/workflows/execute-plan.md');
    const pointer = plan.slice(plan.indexOf('<tdd_plan_execution>'), plan.indexOf('</tdd_plan_execution>'));
    assert.ok(/"Red-Green-Refactor Cycle"/.test(pointer),
      'commit-scope contract must cite "Red-Green-Refactor Cycle"');
    assert.ok(/"Fail-Fast Rules"/.test(pointer),
      'fail-fast rule must cite "Fail-Fast Rules" by its literal section name, not just the words "fail-fast"');
    assert.ok(/"Error Handling"/.test(pointer),
      'error handling must cite "Error Handling" by its literal section name');
  });

  test("gsd-executor.md's cycle pointer cites three distinct, correctly-named sections", () => {
    const executor = read('agents/gsd-executor.md');
    const pointer = executor.slice(executor.indexOf('<tdd_execution>'), executor.indexOf('## Plan-Level') > -1 ? executor.indexOf('## Plan-Level') : executor.indexOf('</tdd_execution>'));
    assert.ok(/"Red-Green-Refactor Cycle"/.test(pointer),
      'commit-scope contract must cite "Red-Green-Refactor Cycle"');
    assert.ok(/"Fail-Fast Rules"/.test(pointer),
      'fail-fast rule must cite "Fail-Fast Rules" by its literal section name, not just the words "fail-fast"');
    assert.ok(/"Error Handling"/.test(pointer),
      'error handling must cite "Error Handling" by its literal section name');
  });

  test('tdd.md\'s "Fail-Fast Rules" section actually contains fail-fast guidance', () => {
    const tdd = read('gsd-core/references/tdd.md');
    const start = tdd.indexOf('### Fail-Fast Rules');
    assert.ok(start !== -1, 'tdd.md must carry a "### Fail-Fast Rules" section');
    const end = tdd.indexOf('### Executor Gate Validation', start);
    const section = tdd.slice(start, end === -1 ? undefined : end);
    assert.ok(/Unexpected GREEN in RED phase/i.test(section),
      'the Fail-Fast Rules section must actually describe the unexpected-pass-in-RED rule');
  });

  test('tdd.md\'s "Error Handling" section actually contains error-handling guidance', () => {
    const tdd = read('gsd-core/references/tdd.md');
    const start = tdd.indexOf('## Error Handling');
    assert.ok(start !== -1, 'tdd.md must carry an "## Error Handling" section');
    const end = tdd.indexOf('## Commit Pattern for TDD Plans', start);
    const section = tdd.slice(start, end === -1 ? undefined : end);
    assert.ok(/fail/i.test(section) && /RED|GREEN|REFACTOR/.test(section),
      'the Error Handling section must actually describe fail-in-RED/GREEN/REFACTOR guidance');
  });
});

describe('#4269 — plan-level gate rules are owned once, by tdd.md', () => {
  // The OLD gsd-executor.md restatement's distinctive two-line gate-sequence
  // pattern (its own phrasing, distinct from tdd.md's).
  const OLD_RESTATEMENT_MARKERS = [
    /A `test\(\.\.\.\)` commit exists \(RED gate\)/,
    /A `feat\(\.\.\.\)` commit exists after it \(GREEN gate\)/,
  ];

  test('gsd-executor.md no longer restates the plan-level gate rules inline', () => {
    const executor = read('agents/gsd-executor.md');
    for (const marker of OLD_RESTATEMENT_MARKERS) {
      assert.ok(!marker.test(executor),
        `gsd-executor.md must not restate the old gate-sequence wording ${marker} — point at tdd.md's "Gate Enforcement Rules" instead`);
    }
    assert.ok(/references\/tdd\.md/.test(executor) && /Gate Enforcement Rules/.test(executor),
      'gsd-executor.md must point at tdd.md\'s "Gate Enforcement Rules" section');
  });

  test('gsd-executor.md\'s plan-level gate section is now a short pointer, not a restatement', () => {
    const executor = read('agents/gsd-executor.md');
    const headingIdx = executor.search(/## Plan-Level TDD Gate Enforcement/);
    assert.ok(headingIdx !== -1, 'the "## Plan-Level TDD Gate Enforcement" heading must still exist as an anchor');
    const nextHeadingIdx = executor.indexOf('</tdd_execution>', headingIdx);
    const section = executor.slice(headingIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
    const lineCount = section.split('\n').filter((l) => l.trim().length > 0).length;
    assert.ok(lineCount <= 6,
      `the plan-level gate section must be a short pointer (<=6 non-blank lines), got ${lineCount} lines:\n${section}`);
  });

  test('the gate-sequence rules (fail-fast + git-log validation + TDD Gate Compliance) appear in full only in tdd.md', () => {
    const tdd = read('gsd-core/references/tdd.md');
    const executor = read('agents/gsd-executor.md');

    // tdd.md owns the full contract in its own words.
    assert.ok(/Unexpected GREEN in RED phase/.test(tdd),
      'tdd.md must carry the fail-fast rule');
    assert.ok(/git log --oneline -E --grep/.test(tdd),
      'tdd.md must carry the actual git-log gate validation script');
    assert.ok(/## TDD Gate Compliance/.test(tdd),
      'tdd.md must carry the TDD Gate Compliance SUMMARY.md contract');

    // gsd-executor.md must not carry the actual validation script or the
    // old fail-fast prose — only a pointer.
    assert.ok(!/git log --oneline -E --grep/.test(executor),
      'gsd-executor.md must not restate the git-log gate validation script — that lives only in tdd.md');
    assert.ok(!/If a test passes unexpectedly during RED, STOP/.test(executor),
      'gsd-executor.md must not restate the fail-fast rule prose — that lives only in tdd.md');
  });
});

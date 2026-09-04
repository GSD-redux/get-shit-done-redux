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
 *
 * #4268 design decision (ADR-3473: pointers, not restatements): a compact,
 * single-sentence citation that names the tdd.md section and commit-scope
 * tokens (e.g. execute-plan.md's and gsd-executor.md's "execute RED → GREEN
 * → REFACTOR exactly as specified in the canonical
 * `references/tdd.md` reference — the 'Red-Green-Refactor Cycle' section's
 * commit-scope contract...") is LEGAL — it is a pointer, not a restatement.
 * A multi-step re-derivation that independently re-explains what to DO in
 * each of the RED/GREEN/REFACTOR phases (the #3990 shape) is NOT legal, even
 * if reworded so no literal commit-scope substring matches. See
 * restatesCycleStructurally() below for the detector and its threshold
 * reasoning.
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

// #4268: restatesCycle() above only catches the exact literal commit-scope
// substring — a REWORDED restatement of the same RED/GREEN/REFACTOR
// procedure ships green. This detector is structural instead of literal, and
// stays within the #4228 linear-scan constraint (anchor lookups via
// String#search on a single unbounded-but-simple \b<WORD>\b pattern, chained
// sequentially — never two lazy spans inside one regex).
//
// Design (ADR-3473: pointers, not restatements):
//   - Find the FIRST word-boundary RED, then the FIRST GREEN after it, then
//     the FIRST REFACTOR after THAT (document order, three sequential linear
//     scans — O(n), no backtracking).
//   - A compact one-sentence pointer packs all three words within the same
//     clause/line (e.g. "RED → GREEN → REFACTOR" or "RED-GREEN-REFACTOR"),
//     so the RED..REFACTOR span is on the order of 10-20 characters. An
//     actual restatement re-explains each phase in its own prose/list item,
//     so the span runs to several hundred characters.
//   - Threshold: 200 characters. Measured empirically (see tests below)
//     against the real execute-plan.md and gsd-executor.md pointer text
//     (spans of 10-14 chars) and a realistic paraphrased-restatement fixture
//     (span of 424 chars) — 200 sits with wide margin on both sides.
//   - Second, independent structural signal: three DISTINCT markdown
//     list-marker lines (`- `, `* `, or `N. `/`N) `), one each carrying RED,
//     GREEN, and REFACTOR — mirroring tdd.md's own numbered-step shape. The
//     legitimate pointer's "2. **Cycle...): execute RED → GREEN →
//     REFACTOR" puts all three words on ONE list line, so requiring three
//     DISTINCT line indices avoids flagging it.
// Either signal alone is sufficient to flag a restatement.
const RESTATEMENT_SPAN_THRESHOLD = 200;
const LIST_MARKER_RE = /^\s*(?:[-*]|\d+[.)])\s/;

function findOwnListLineIndex(lines, word) {
  const wordRe = new RegExp(`\\b${word}\\b`);
  return lines.findIndex((l) => LIST_MARKER_RE.test(l) && wordRe.test(l));
}

function restatesCycleStructurally(text) {
  const redIdx = text.search(/\bRED\b/);
  if (redIdx === -1) return false;
  const afterRed = text.slice(redIdx);
  const greenRel = afterRed.search(/\bGREEN\b/);
  if (greenRel === -1) return false;
  const greenIdx = redIdx + greenRel;
  const afterGreen = text.slice(greenIdx);
  const refactorRel = afterGreen.search(/\bREFACTOR\b/);
  if (refactorRel === -1) return false;
  const refactorIdx = greenIdx + refactorRel;

  if (refactorIdx - redIdx > RESTATEMENT_SPAN_THRESHOLD) return true;

  const segment = text.slice(redIdx, refactorIdx + 'REFACTOR'.length);
  const lines = segment.split('\n');
  const redLine = findOwnListLineIndex(lines, 'RED');
  const greenLine = findOwnListLineIndex(lines, 'GREEN');
  const refactorLine = findOwnListLineIndex(lines, 'REFACTOR');
  if (redLine === -1 || greenLine === -1 || refactorLine === -1) return false;
  return redLine !== greenLine && greenLine !== refactorLine && redLine !== refactorLine;
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

describe('#4268 — reworded restatement detection (structural, not literal)', () => {
  test('flags a reworded multi-step re-derivation of RED/GREEN/REFACTOR', () => {
    const fixture = [
      '## TDD procedure for this task',
      '',
      '1. RED: write a failing test that captures the missing behavior, run the',
      '   suite, and confirm it fails for the expected reason before touching any',
      '   implementation code. Commit the failing test on its own.',
      '2. GREEN: write the minimal implementation needed to make that test pass,',
      '   run the full suite again, and confirm every test is green before moving',
      '   on. Commit the passing implementation separately from the test.',
      '3. REFACTOR: clean up the implementation and tests while keeping the suite',
      '   green throughout, committing only if something actually changed.',
    ].join('\n');
    assert.ok(restatesCycleStructurally(fixture),
      'a reworded, multi-step re-derivation of RED/GREEN/REFACTOR must be flagged even with no literal commit-scope match');
    // Confirm the literal-only detector is indeed blind to this fixture —
    // this is the #4268 gap restatesCycleStructurally exists to close.
    assert.ok(!restatesCycle(fixture),
      'sanity check: the fixture must NOT contain the literal commit-scope substring (that is the gap being closed)');
  });

  test('does not flag the real execute-plan.md and gsd-executor.md pointer text', () => {
    const plan = read('gsd-core/workflows/execute-plan.md');
    const executor = read('agents/gsd-executor.md');
    assert.ok(!restatesCycleStructurally(plan),
      'execute-plan.md\'s compact citation of RED/GREEN/REFACTOR must not be flagged as a restatement');
    assert.ok(!restatesCycleStructurally(executor),
      'gsd-executor.md\'s compact citation of RED/GREEN/REFACTOR must not be flagged as a restatement');
  });
});

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
 *
 * #4268 follow-up (Standards+Spec review, same issue): a length/list-marker
 * signal alone is evadable — a compact, no-list-marker, reworded restatement
 * kept under the span threshold sails through undetected. The actual
 * invariant this file protects is DEFERRAL, not length: a legitimate mention
 * of RED/GREEN/REFACTOR always points at tdd.md as the authority; a
 * restatement never needs to, because it isn't citing anything — it's
 * re-deriving the procedure itself. That is now the PRIMARY signal; span and
 * list-marker remain secondary, defense-in-depth OR-conditions.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

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
//     scans — O(n), no backtracking). Factored into measureCycleSpan() below
//     so its arithmetic can be tested directly (boundary coverage) without
//     going through the full multi-signal decision.
//   - PRIMARY signal (#4268 Standards+Spec review): deferral detection. A
//     legitimate RED/GREEN/REFACTOR mention always names tdd.md as the
//     authority nearby; a restatement never does, because it is re-deriving
//     the procedure instead of citing it. If the RED..REFACTOR span, extended
//     by a fixed trailing window, contains NO reference to `tdd.md`,
//     `references/tdd`, or `canonical`, it is flagged — REGARDLESS of length
//     or list-marker shape. This is what makes the signal non-evadable by a
//     compact, reworded restatement: shortening or dropping list markers does
//     nothing to manufacture a citation that was never there.
//   - Trailing window: the EARLIER of 500 characters past the REFACTOR
//     anchor, or the next markdown HEADING line (`\n#`) — never further.
//     #4302: a flat char count with no structural boundary let a
//     citation-free restatement borrow an UNRELATED later section's tdd.md
//     citation (on the real gsd-executor.md, the very next section after the
//     cycle pointer — "## Plan-Level TDD Gate Enforcement" — has its own,
//     independent tdd.md citation 82 chars past the pointer's REFACTOR
//     anchor, well inside a flat 500-char window). A first attempt bounded at
//     the next blank line instead of a heading, but that broke the real
//     execute-plan.md pointer: its FIRST RED/GREEN/REFACTOR occurrence is the
//     list's own intro sentence ("For `type: tdd` plans — RED-GREEN-REFACTOR:"),
//     separated by a genuine blank line from the numbered list item that
//     actually carries the citation — a blank line is not reliably "still the
//     same statement" the way it is in gsd-executor.md's prose form. A
//     heading is the unambiguous boundary both real files actually use to
//     start a new, unrelated statement (confirmed: no heading appears between
//     either real pointer's cycle mention and its own citation; a heading
//     does appear before the next, unrelated section in gsd-executor.md).
//     500 chars remains the OUTER cap when no heading appears at all, short
//     of the whole-file scan the #4228 postmortem (see comment above
//     restatesCycle()) warns against.
//   - SECONDARY signals (defense in depth, OR-ed in, kept from the original
//     design): span > 200 chars, or three DISTINCT markdown list-marker
//     lines (`- `, `* `, or `N. `/`N) `) each carrying one of RED/GREEN/
//     REFACTOR. These still catch something wildly long or exhaustively
//     itemized even if it happens to mention "tdd.md" somewhere in the
//     window as camouflage — a case the primary signal alone cannot see.
//     Threshold 200 and the list-marker shape are unchanged from the
//     original measurement: real pointers span 10-14 chars; a realistic
//     paraphrased restatement spans 424 chars.
const RESTATEMENT_SPAN_THRESHOLD = 200;
const DEFERRAL_WINDOW_TRAILING = 500;
const DEFERRAL_MARKER_RE = /tdd\.md|references\/tdd|canonical/;
const LIST_MARKER_RE = /^\s*(?:[-*]|\d+[.)])\s/;

function findOwnListLineIndex(lines, word) {
  const wordRe = new RegExp(`\\b${word}\\b`);
  return lines.findIndex((l) => LIST_MARKER_RE.test(l) && wordRe.test(l));
}

// Sequential linear scan for the first RED -> first GREEN-after-RED -> first
// REFACTOR-after-that triple. Returns null if the document doesn't carry the
// full RED/GREEN/REFACTOR sequence. Factored out of restatesCycleStructurally
// so the span arithmetic itself has a directly-testable seam (#4268 Standards
// review, boundary coverage).
function measureCycleSpan(text) {
  const redIdx = text.search(/\bRED\b/);
  if (redIdx === -1) return null;
  const afterRed = text.slice(redIdx);
  const greenRel = afterRed.search(/\bGREEN\b/);
  if (greenRel === -1) return null;
  const greenIdx = redIdx + greenRel;
  const afterGreen = text.slice(greenIdx);
  const refactorRel = afterGreen.search(/\bREFACTOR\b/);
  if (refactorRel === -1) return null;
  const refactorIdx = greenIdx + refactorRel;
  const refactorEndIdx = refactorIdx + 'REFACTOR'.length;
  return { redIdx, greenIdx, refactorIdx, refactorEndIdx, span: refactorIdx - redIdx };
}

function hasNearbyDeferralMarker(text, cycle) {
  const cappedEnd = Math.min(text.length, cycle.refactorEndIdx + DEFERRAL_WINDOW_TRAILING);
  // #4302: stop at the next markdown heading line (`\n#`) at or after the
  // REFACTOR anchor, whichever comes first against the flat char cap above —
  // a citation belonging to a LATER, unrelated section must not count as
  // this restatement's own deferral. A heading, not a blank line, is the
  // boundary: a legitimate citation can sit past a blank line WITHIN the
  // same enclosing section (e.g. a numbered list's intro sentence followed
  // by the list item that carries the citation), so bounding on blank lines
  // alone produces a false positive on that real shape.
  const headingMatch = text.slice(cycle.refactorEndIdx, cappedEnd).match(/\n#/);
  const windowEnd = headingMatch ? cycle.refactorEndIdx + headingMatch.index : cappedEnd;
  const window = text.slice(cycle.redIdx, windowEnd);
  return DEFERRAL_MARKER_RE.test(window);
}

function restatesCycleStructurally(text) {
  const cycle = measureCycleSpan(text);
  if (!cycle) return false;

  if (!hasNearbyDeferralMarker(text, cycle)) return true;
  if (cycle.span > RESTATEMENT_SPAN_THRESHOLD) return true;

  const segment = text.slice(cycle.redIdx, cycle.refactorEndIdx);
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

  // #4268 Standards+Spec review: the reviewer proved by execution that the
  // original span/list-marker-only design is defeated by a compact,
  // single-paragraph, no-list-marker restatement kept under the 200-char
  // span threshold (their crafted fixtures: ~142 and ~169 chars). This
  // fixture (189 chars, span 134 — well under the old threshold, no list
  // markers, no tdd.md/canonical mention) is that exact class of gap: it
  // fully re-derives what to DO in each phase without citing tdd.md
  // anywhere. Under the pre-fix span+list-marker-only logic this returned
  // false (a false negative); the deferral-detection primary signal now
  // catches it regardless of length or list-marker shape.
  test('flags a compact, no-list-marker restatement that never cites tdd.md (the reviewer-found gap)', () => {
    const fixture = 'RED: write a failing test proving the bug exists. GREEN: write the '
      + 'smallest change that makes the test pass and keep the suite green. '
      + 'REFACTOR: clean the code up now that everything passes.';
    assert.equal(fixture.length, 189, 'sanity: fixture is compact, well under the old span threshold');
    assert.ok(!/tdd\.md|references\/tdd|canonical/.test(fixture),
      'sanity: fixture must not mention tdd.md/canonical — that is the gap being closed');
    assert.ok(!/^\s*(?:[-*]|\d+[.)])\s/m.test(fixture),
      'sanity: fixture must carry no markdown list markers — that is the other axis of the gap');
    assert.ok(restatesCycleStructurally(fixture),
      'a compact, no-list-marker restatement must be flagged once it fails to cite tdd.md as the authority');
  });

  // #4268 Standards review — boundary coverage (CLAUDE.md: "Tests MUST
  // exercise inputs at limit-1, limit, and limit+1"). Tested against
  // measureCycleSpan() directly rather than restatesCycleStructurally(): any
  // fixture built without a tdd.md/canonical mention (required to isolate
  // the span arithmetic from list-marker noise) would ALSO trip the primary
  // deferral-detection OR-condition regardless of its span, so the top-level
  // function can't isolate the span check alone. The internal helper can.
  describe('RESTATEMENT_SPAN_THRESHOLD boundary (limit-1 / limit / limit+1)', () => {
    // Builds "RED GREEN " + '.'.repeat(n) + "REFACTOR" so that
    // measureCycleSpan(...).span === targetSpan exactly. The '.' filler is a
    // non-word character so \bREFACTOR\b still matches at the boundary, and
    // the fixture carries no markdown list markers or tdd.md/canonical text.
    function makeCycleSpanFixture(targetSpan) {
      const prefix = 'RED GREEN ';
      const fillerLen = targetSpan - prefix.length;
      assert.ok(fillerLen >= 0, 'targetSpan must be large enough to hold the fixed prefix');
      return prefix + '.'.repeat(fillerLen) + 'REFACTOR';
    }

    test('limit-1 (199): span condition does not fire', () => {
      const fixture = makeCycleSpanFixture(RESTATEMENT_SPAN_THRESHOLD - 1);
      const cycle = measureCycleSpan(fixture);
      assert.equal(cycle.span, RESTATEMENT_SPAN_THRESHOLD - 1);
      assert.equal(cycle.span > RESTATEMENT_SPAN_THRESHOLD, false);
    });

    test('limit (200): span condition does not fire (threshold is exclusive)', () => {
      const fixture = makeCycleSpanFixture(RESTATEMENT_SPAN_THRESHOLD);
      const cycle = measureCycleSpan(fixture);
      assert.equal(cycle.span, RESTATEMENT_SPAN_THRESHOLD);
      assert.equal(cycle.span > RESTATEMENT_SPAN_THRESHOLD, false);
    });

    test('limit+1 (201): span condition fires', () => {
      const fixture = makeCycleSpanFixture(RESTATEMENT_SPAN_THRESHOLD + 1);
      const cycle = measureCycleSpan(fixture);
      assert.equal(cycle.span, RESTATEMENT_SPAN_THRESHOLD + 1);
      assert.equal(cycle.span > RESTATEMENT_SPAN_THRESHOLD, true);
      // And end-to-end: with no tdd.md mention this also fires via the
      // primary deferral signal, so restatesCycleStructurally must be true
      // regardless — confirming the OR-composition doesn't mask a fired
      // secondary condition.
      assert.ok(restatesCycleStructurally(fixture));
    });
  });

  // #4268 Standards review: fast-check property test (CLAUDE.md: "Parsers,
  // budget limits, and bijective contracts must include at least one
  // fast-check (fc) property test" — RESTATEMENT_SPAN_THRESHOLD is a budget
  // limit). This directly property-tests the Finding-1 fix: ANY filler
  // (sanitized to strip newlines, list-marker punctuation, and any
  // RED/GREEN/REFACTOR/tdd/canonical substrings it might otherwise
  // accidentally contain) inserted into a compact, no-list-marker
  // RED/GREEN/REFACTOR restatement template that never cites tdd.md must be
  // flagged — independent of the filler's length.
  test('property: a no-tdd.md, no-list-marker RED/GREEN/REFACTOR restatement is always flagged regardless of filler length', () => {
    const fillerArb = fc.string({ maxLength: 300 }).map((s) => s
      .replace(/[\r\n]/g, ' ')
      .replace(/[-*]/g, '.')
      .replace(/\bRED\b/gi, 'xxx')
      .replace(/\bGREEN\b/gi, 'xxx')
      .replace(/\bREFACTOR\b/gi, 'xxx')
      .replace(/tdd/gi, 'xxx')
      .replace(/canonical/gi, 'xxx'));

    fc.assert(
      fc.property(fillerArb, (filler) => {
        const fixture = [
          `RED: write a failing test. ${filler}`,
          `GREEN: make it pass. ${filler}`,
          'REFACTOR: clean it up.',
        ].join(' ');
        return restatesCycleStructurally(fixture) === true;
      }),
      { numRuns: 20 },
    );
  });

  // #4302: hasNearbyDeferralMarker's 500-char trailing window is a flat
  // character count with no structural boundary — on the real
  // agents/gsd-executor.md, a compact citation-free restatement sits
  // immediately before an UNRELATED "## Plan-Level TDD Gate Enforcement"
  // section that carries its own, independent tdd.md citation 82 chars past
  // the REFACTOR anchor. The restatement borrows that neighbor's citation and
  // evades detection. This fixture reproduces the same shape: a restatement
  // paragraph with NO citation of its own, followed by a blank line and an
  // unrelated section that does cite tdd.md within the 500-char window.
  test('does not borrow a citation from an unrelated LATER section (paragraph-bounded window)', () => {
    const fixture = [
      'RED: write a failing test proving the bug exists and record it with a test-scoped commit.',
      'GREEN: implement the smallest change that makes the test pass and record that with a',
      'feat-scoped commit. REFACTOR: simplify the implementation now that it is proven correct,',
      'without changing observable behavior.',
      '',
      '## Unrelated Section',
      '',
      'This paragraph cites the canonical `gsd-core/references/tdd.md` reference for a completely',
      'different purpose and must not be borrowed by the restatement above.',
    ].join('\n');
    assert.ok(restatesCycleStructurally(fixture),
      "a citation belonging to a different, later paragraph/section must not count as this restatement's own deferral");
  });
});

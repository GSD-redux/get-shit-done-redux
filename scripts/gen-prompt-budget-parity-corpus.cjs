#!/usr/bin/env node
/**
 * gen-prompt-budget-parity-corpus.cjs
 *
 * Captures a characterization corpus of `prompt-budget.applyBudget`'s observable
 * output, for issue #2929 (epic #1671 Phase 2 — the `context-composer` seam).
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 2 generalizes `applyBudget`'s trim ladder into a shared composer seam.
 * Its success condition is that `prompt-budget`'s output does not change. The only
 * authority on "did not change" is the behavior that shipped BEFORE the refactor,
 * so this corpus is generated against the pre-refactor implementation and committed
 * as a frozen fixture. `tests/prompt-budget-parity.test.cjs` then replays every case
 * and asserts byte-identical `prompt` plus field-identical `metadata`.
 *
 * FIXTURE PROVENANCE (CONTRIBUTING.md "Fixture provenance (#2371)")
 * -----------------------------------------------------------------
 * That rule forbids fixtures derived from the gate's own writer, grammar, or the
 * author's mental model, because such a fixture can only confirm what the author
 * already believed. This corpus is expressly NOT hand-authored: every `expected`
 * value is computed by executing the shipped implementation, which predates the
 * composer and knows nothing about it. What IS author-chosen is the set of INPUTS —
 * so the inputs are derived from the design's parity-critical behavior table rather
 * than from intuition, and `tests/prompt-budget-parity.test.cjs` additionally proves
 * the corpus is non-vacuous by mutating the ladder and requiring the corpus to fail.
 * Disclosed here rather than assumed.
 *
 * USAGE
 *   node scripts/gen-prompt-budget-parity-corpus.cjs --write   # regenerate
 *   node scripts/gen-prompt-budget-parity-corpus.cjs --check   # drift-guard (exit 1 on drift)
 *
 * `--check` is the intentional-change gate: after Phase 2 lands, any diff here means
 * review-prompt output moved, which is a user-visible change requiring justification.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'prompt-budget-parity', 'corpus.json');
const IMPL_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'prompt-budget.cjs');

/** Corpus schema version. Bump only on a deliberate shape change. */
const CORPUS_VERSION = 1;

// ─── Deterministic content builders ──────────────────────────────────────────
// estimateTokens() is Math.ceil(len / 4), so a string of length 4*N measures
// exactly N tokens. Every size below is therefore exact, not approximate — which
// is what makes the cap-1 / cap / cap+1 rows land ON the boundary rather than near it.

/** A filler string measuring exactly `tokens` tokens under chars/4. */
function tokensOf(tokens, fill = 'x') {
  return fill.repeat(tokens * 4);
}

/** `lines` newline-separated lines, each `width` chars wide. */
function linesOf(lines, width = 19) {
  return Array.from({ length: lines }, (_, i) => String(i).padEnd(width, '-')).join('\n');
}

// ─── Case definitions ────────────────────────────────────────────────────────
// Each case is { name, why, sections, budget, options }.
// `why` names the design/test-matrix row the case exists to pin.

function buildCases() {
  const cases = [];
  const add = (c) => cases.push(c);

  // Base shape reused by the boundary family. With safetyMarginPct 0 the effective
  // budget equals the budget, so totals can be placed exactly on the cap.
  //   staticBase = est(instructions) + est('## Roadmap\n\n') + est(roadmap)
  //              + est('## Plans\n\n') + est('### a.md\n\n')
  const boundaryBase = (planTokens) => ({
    instructions: tokensOf(10, 'I'),
    roadmap: tokensOf(10, 'R'),
    plans: [{ file: 'a.md', content: tokensOf(planTokens, 'P') }],
  });

  // ── A. Budget boundary (RULESET.TESTS.boundary-coverage.fixtures a/b/c) ────
  add({
    name: 'A1-exact-cap',
    why: 'A1/row 3 — total measures exactly effectiveBudget; must NOT be treated as pressure',
    sections: boundaryBase(71),
    budget: 100,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'A2-one-under-cap',
    why: 'A2/row 5 — one token under; no pressure, no reserve deducted',
    sections: boundaryBase(70),
    budget: 100,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'A3-one-over-cap',
    why: 'A3/row 4 — one token over; pressure engages the ladder',
    sections: boundaryBase(72),
    budget: 100,
    options: { safetyMarginPct: 0 },
  });

  // A1 pins exact-cap as "no pressure", but with only a floored plan group present that
  // assertion is not load-bearing: the 1024-char floor absorbs any trim, so relaxing the
  // pressure test from `>` to `>=` produces byte-identical output and the corpus cannot
  // see the difference. This case gives the ladder something DROPPABLE at exactly the cap,
  // so `>` vs `>=` becomes observable as context surviving vs being omitted.
  //   staticBase 29 + plan 20 = 49, context wrapper 3, so est(context) 148 puts the
  //   baseline at exactly 200 = effectiveBudget.
  add({
    name: 'A3b-exact-cap-with-droppable-present',
    why: 'exact-cap discriminator — baseline lands exactly ON effectiveBudget with a droppable available. Pins that `baseline > effectiveBudget` is STRICT: at equality nothing is dropped. Mutating the comparison to >= flips context from kept to omitted, which A1 alone cannot detect.',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(20, 'P') }],
      context: tokensOf(148, 'C'),
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'A3c-one-under-cap-with-droppable-present',
    why: 'companion to A3b — one token under the cap with the same droppable available. Together they bracket the strict-inequality boundary from below.',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(20, 'P') }],
      context: tokensOf(147, 'C'),
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });

  // Row (d) of RULESET.TESTS.boundary-coverage.fixtures: baseline within
  // reserve-distance of the limit. NOTE_RESERVE_TOKENS is 80, and this is the exact
  // band (effectiveBudget - 80, effectiveBudget] that PR #3708 shipped two
  // regressions in (LEARNING.prompt-budget.boundary-gap). Swept token by token.
  // Budget 200 (not 100) is required here, not incidental: the band is
  // NOTE_RESERVE_TOKENS (80) wide, so the baseline needs >=81 tokens of headroom
  // beneath the cap to be swept. staticBase is 29 tokens, so planTokens = 171 - delta
  // places the baseline exactly `delta` under effectiveBudget and stays positive
  // across the whole sweep. delta 80 and 81 sit just OUTSIDE the band deliberately —
  // they are the negative controls that prove the band's edge is where it is claimed.
  for (const delta of [0, 1, 2, 39, 40, 79, 80, 81]) {
    add({
      name: `A4-reserve-band-minus-${delta}`,
      why: `boundary-coverage.fixtures row (d) — baseline at effectiveBudget-${delta}. Pins the NEGATIVE control: within NOTE_RESERVE_TOKENS distance of the cap, NOTHING may be trimmed. Early-pressure firing here is the exact PR #3708 regression.`,
      sections: boundaryBase(171 - delta),
      budget: 200,
      options: { safetyMarginPct: 0 },
    });
  }

  // Mirror of A4 on the OTHER side of the cap. A4 proves the reserve is NOT deducted
  // at or below the cap; this proves it IS deducted above it, and that the ladder
  // relieves pressure by dropping. Without both sides the family pins only half the
  // boundary, and an "always reserve" regression would still pass A4.
  //   staticBase 29 + planContent 20 = 49, and the context wrapper costs 3, so
  //   est(context) = 148 + delta places the baseline exactly `delta` OVER effectiveBudget.
  for (const delta of [1, 2, 40, 79, 80, 81]) {
    add({
      name: `A10-pressure-band-plus-${delta}`,
      why: `boundary-coverage.fixtures row (d), above-cap mirror — baseline at effectiveBudget+${delta}; pressure fires, NOTE_RESERVE_TOKENS is deducted, and context is dropped`,
      sections: {
        instructions: tokensOf(10, 'I'),
        roadmap: tokensOf(10, 'R'),
        plans: [{ file: 'a.md', content: tokensOf(20, 'P') }],
        context: tokensOf(148 + delta, 'C'),
      },
      budget: 200,
      options: { safetyMarginPct: 0 },
    });
  }

  add({
    name: 'A5-safety-margin-default',
    why: 'A4 — default 10% margin; effectiveBudget = floor(budget * 0.9)',
    sections: boundaryBase(60),
    budget: 100,
    options: {},
  });

  // The rounding mode of effectiveBudget was unpinned: every other case in this file
  // uses a (budget, safetyMarginPct) pair whose product is a whole number, so
  // Math.floor and Math.round agree and mutating one to the other changed nothing.
  // These three straddle .5 in both directions so the mode is observable.
  //   95 * 0.90 = 85.5  -> floor 85, round 86   (disagree)
  //   97 * 0.90 = 87.3  -> floor 87, round 87   (agree; guards against a ceil mutation)
  //   93 * 0.85 = 79.05 -> floor 79, round 79   (agree; second ceil guard, different margin)
  add({
    name: 'A11-fractional-effective-budget-half',
    why: 'pins the ROUNDING MODE of effectiveBudget. 95 * (1 - 10/100) = 85.5, where Math.floor (85) and Math.round (86) disagree. Without a fractional case the mode is unpinned and floor->round is a byte-invisible mutation, which an isolated review confirmed against the 47-case corpus.',
    sections: boundaryBase(56),
    budget: 95,
    options: { safetyMarginPct: 10 },
  });
  add({
    name: 'A12-fractional-effective-budget-below-half',
    why: 'companion to A11 below the .5 point: 97 * 0.90 = 87.3, where floor and round agree but Math.ceil (88) would not. Guards the mutation A11 does not cover.',
    sections: boundaryBase(58),
    budget: 97,
    options: { safetyMarginPct: 10 },
  });
  add({
    name: 'A13-fractional-effective-budget-odd-margin',
    why: 'third rounding guard at a non-multiple-of-10 margin: 93 * (1 - 15/100) = 79.05. Exercises the margin arithmetic itself, not just the budget, since safetyMarginPct is caller-supplied.',
    sections: boundaryBase(50),
    budget: 93,
    options: { safetyMarginPct: 15 },
  });
  add({
    name: 'A6-safety-margin-zero',
    why: 'A5 — 0% margin means the full budget is usable',
    sections: boundaryBase(60),
    budget: 100,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'A7-safety-margin-hundred',
    why: 'A5 — 100% margin drives effectiveBudget to 0, forcing the min-set hard fail',
    sections: boundaryBase(10),
    budget: 100,
    options: { safetyMarginPct: 100 },
  });
  add({
    name: 'A8-budget-zero',
    why: 'A6 — non-positive budget must hard-fail cleanly, never negative-length slice',
    sections: boundaryBase(10),
    budget: 0,
    options: {},
  });
  add({
    name: 'A9-budget-negative',
    why: 'A6 — negative budget must not crash',
    sections: boundaryBase(10),
    budget: -50,
    options: {},
  });

  // ── B. Shrink strategies ──────────────────────────────────────────────────
  add({
    name: 'B3-head-shrink-engaged',
    why: 'B3/row 7 — projectMd longer than projectMdHeadLines under pressure; shrunk flag true',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(40, 'P') }],
      projectMd: linesOf(120),
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B4-head-shrink-noop',
    why: 'B4/row 7+9 — fewer lines than the cap; text unchanged and shrunk flag MUST stay false',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(40, 'P') }],
      projectMd: linesOf(5),
    },
    budget: 60,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B5-head-shrink-zero-lines',
    why: 'B5/row 8 — projectMdHeadLines <= 0 yields the empty string',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(40, 'P') }],
      projectMd: linesOf(120),
    },
    budget: 60,
    options: { safetyMarginPct: 0, projectMdHeadLines: 0 },
  });
  add({
    name: 'B6-plan-truncate-share-above-floor',
    why: 'B6/row 13 — proportional share ABOVE the floor, so the share (not the floor) decides. Budget 700: min-set is 5+5+256+256=522 which fits, so this reaches the truncate step instead of hard-failing the way the original budget-400 version did. groupBudget 598 of 1000 => charsBudget 2392, share 1196 per plan > floor 1024.',
    sections: {
      instructions: tokensOf(5, 'I'),
      roadmap: tokensOf(5, 'R'),
      plans: [
        { file: 'a.md', content: tokensOf(500, 'A') },
        { file: 'b.md', content: tokensOf(500, 'B') },
      ],
    },
    budget: 700,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B7-plan-truncate-floor-binding',
    why: 'B7/row 10 — share falls BELOW the 1024-char floor so the floor wins, and the resulting total deliberately EXCEEDS the group budget. Budget 1100: min-set 5+5+4*256=1034 fits; groupBudget 992 => charsBudget 3968 => share 992 < 1024, so every plan is held at the floor. This is the case that proves a floor is a per-fragment guarantee, not a budget cap.',
    sections: {
      instructions: tokensOf(5, 'I'),
      roadmap: tokensOf(5, 'R'),
      plans: [
        { file: 'a.md', content: tokensOf(500, 'A') },
        { file: 'b.md', content: tokensOf(500, 'B') },
        { file: 'c.md', content: tokensOf(500, 'C') },
        { file: 'd.md', content: tokensOf(500, 'D') },
      ],
    },
    budget: 1100,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B8-zero-sized-plans',
    why: 'B8/row 11 — total original chars 0; no divide-by-zero, pct stays 0',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [
        { file: 'a.md', content: '' },
        { file: 'b.md', content: '' },
      ],
      context: tokensOf(200, 'C'),
    },
    budget: 60,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B9-nonpositive-plan-budget',
    why: 'B9/row 12 — computed plan budget <= 0 skips the truncate step ENTIRELY rather than clamping',
    sections: boundaryBase(72),
    budget: 100,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B11-drop-order-all-three',
    why: 'B11/row 14 — droppables leave in declared order: context, research, requirements',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(30, 'P') }],
      context: tokensOf(300, 'C'),
      research: tokensOf(300, 'S'),
      requirements: tokensOf(300, 'Q'),
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B11b-drop-context-only',
    why: 'B11 — pressure relieved after the first drop; research and requirements survive',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(30, 'P') }],
      context: tokensOf(300, 'C'),
      research: tokensOf(10, 'S'),
      requirements: tokensOf(10, 'Q'),
    },
    budget: 300,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B12-droppables-absent',
    why: 'B12/row 15 — null droppables are not dropped and never appear in omitted. Budget 400 (not 120) so this actually RENDERS: at 120 the min-set pre-check hard-fails and the case would compare two empty strings.',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(300, 'P') }],
      context: null,
      research: null,
      requirements: null,
    },
    budget: 400,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B13-droppables-empty-string',
    why: 'B13/row 23 — empty-string droppables. Paired with B12 to pin whether "" and null are distinguished. They are NOT: applyBudget uses truthy checks throughout, so "" behaves as absent. This case records that fact rather than the design doc\'s claim that they differ.',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(300, 'P') }],
      context: '',
      research: '',
      requirements: '',
    },
    budget: 400,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'B13b-empty-string-droppable-under-pressure',
    why: 'B13 companion — an empty-string droppable while the ladder is ACTIVELY running. Pins that "" is never recorded in omitted even under real pressure, which B12/B13 (no pressure) cannot show. research is real and IS dropped, so the ladder is demonstrably engaged.',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(20, 'P') }],
      context: '',
      research: tokensOf(200, 'S'),
      requirements: '',
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });

  // ── C. Note reserve + hard-fail paths ─────────────────────────────────────
  add({
    name: 'C1-no-trim-no-note',
    why: 'C1/row 1 — everything fits; no note, noteInjected false',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(10, 'P') }],
      projectMd: linesOf(3),
      context: tokensOf(5, 'C'),
      research: tokensOf(5, 'S'),
      requirements: tokensOf(5, 'Q'),
    },
    budget: 1000,
    options: {},
  });
  add({
    name: 'C4-min-set-hard-fail',
    why: 'C4/row 16 — min-set pre-check exceeds budget; empty output and estimatedTokens 0',
    sections: {
      instructions: tokensOf(500, 'I'),
      roadmap: tokensOf(500, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(500, 'P') }],
    },
    budget: 100,
    options: {},
  });
  add({
    name: 'C5-post-assembly-hard-fail',
    why: 'C5/row 17 — survives the min-set check but the assembled prompt still overflows; real measured size reported',
    sections: {
      instructions: tokensOf(80, 'I'),
      roadmap: tokensOf(80, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(2000, 'P') }],
    },
    budget: 200,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'C7-custom-note-template',
    why: 'note template placeholders {budget} {omittedList} {planTruncationPct} all substitute',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(30, 'P') }],
      context: tokensOf(300, 'C'),
    },
    budget: 200,
    options: {
      safetyMarginPct: 0,
      noteTemplate: 'TRIMMED b={budget} o={omittedList} p={planTruncationPct}',
    },
  });
  add({
    name: 'C8-omitted-list-none',
    why: 'renderNote emits the literal "none" when a trim occurred but nothing was dropped',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(30, 'P') }],
      projectMd: linesOf(120),
    },
    budget: 120,
    options: { safetyMarginPct: 0 },
  });

  // ── D. Shape + encoding ───────────────────────────────────────────────────
  add({
    name: 'D1-all-sections-present',
    why: 'full assembly order: instructions, note, roadmap, project, plans, context, research, requirements',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [
        { file: 'one.md', content: tokensOf(10, '1') },
        { file: 'two.md', content: tokensOf(10, '2') },
      ],
      projectMd: linesOf(4),
      context: tokensOf(10, 'C'),
      research: tokensOf(10, 'S'),
      requirements: tokensOf(10, 'Q'),
    },
    budget: 5000,
    options: {},
  });
  add({
    name: 'D2-no-optional-sections',
    why: 'minimum viable shape — only the two never-droppables plus one plan',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a.md', content: tokensOf(10, 'P') }],
    },
    budget: 5000,
    options: {},
  });
  add({
    name: 'D3-zero-plans',
    why: 'empty plans array — headers still assembled, reduce over [] is 0',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [],
    },
    budget: 5000,
    options: {},
  });
  add({
    name: 'D4-crlf-content',
    why: 'row 25 — CRLF measured and sliced identically to LF under the token unit',
    sections: {
      instructions: 'alpha\r\nbeta\r\ngamma',
      roadmap: 'one\r\ntwo\r\nthree',
      plans: [{ file: 'a.md', content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\r\n') }],
      projectMd: Array.from({ length: 80 }, (_, i) => `p${i}`).join('\r\n'),
    },
    budget: 120,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'D5-unicode-content',
    why: 'row 26 — multibyte and astral content; chars/4 counts UTF-16 units, and slice may split a surrogate pair (pinned as current behavior)',
    sections: {
      instructions: 'héllo wörld ünicode',
      roadmap: '日本語のロードマップ',
      plans: [{ file: 'ünï.md', content: '🎉'.repeat(400) }],
      context: 'Ω'.repeat(200),
    },
    budget: 150,
    options: { safetyMarginPct: 0 },
  });
  add({
    name: 'D6-plan-filename-affects-budget',
    why: 'S5 — per-plan wrapper cost "### <file>\\n\\n" counts toward staticBaseTokens',
    sections: {
      instructions: tokensOf(10, 'I'),
      roadmap: tokensOf(10, 'R'),
      plans: [{ file: 'a-very-long-plan-filename-that-costs-tokens.md', content: tokensOf(10, 'P') }],
    },
    budget: 5000,
    options: {},
  });

  return cases;
}

// ─── Capture ─────────────────────────────────────────────────────────────────

function capture() {
  if (!fs.existsSync(IMPL_PATH)) {
    throw new Error(
      `prompt-budget.cjs not found at ${IMPL_PATH}. Run "npm run build:lib" first ` +
        '(the .cjs is a gitignored tsc output of src/prompt-budget.cts).'
    );
  }
  const { applyBudget } = require(IMPL_PATH);

  const cases = buildCases();

  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`duplicate corpus case name: ${c.name}`);
    seen.add(c.name);
  }

  return {
    version: CORPUS_VERSION,
    description:
      'Characterization corpus of prompt-budget.applyBudget captured from the pre-refactor ' +
      'implementation. Oracle for issue #2929 (epic #1671 Phase 2). Regenerate with ' +
      'node scripts/gen-prompt-budget-parity-corpus.cjs --write',
    cases: cases.map((c) => {
      const result = applyBudget({
        sections: c.sections,
        budget: c.budget,
        options: c.options,
      });
      return {
        name: c.name,
        why: c.why,
        input: { sections: c.sections, budget: c.budget, options: c.options },
        expected: { prompt: result.prompt, metadata: result.metadata },
      };
    }),
  };
}

function serialize(corpus) {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');

  if (write === check) {
    process.stderr.write('usage: gen-prompt-budget-parity-corpus.cjs (--write | --check)\n');
    return 2;
  }

  const serialized = serialize(capture());

  if (write) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, serialized);
    const n = JSON.parse(serialized).cases.length;
    process.stdout.write(`wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${n} cases)\n`);
    return 0;
  }

  if (!fs.existsSync(OUT_PATH)) {
    process.stderr.write(
      `MISSING ${path.relative(REPO_ROOT, OUT_PATH)}\n` +
        'Run: node scripts/gen-prompt-budget-parity-corpus.cjs --write\n'
    );
    return 1;
  }

  const committed = fs.readFileSync(OUT_PATH, 'utf8');
  if (committed !== serialized) {
    process.stderr.write(
      `DRIFT in ${path.relative(REPO_ROOT, OUT_PATH)}\n\n` +
        "prompt-budget's observable output no longer matches the committed corpus.\n" +
        'This corpus is the parity oracle for #2929: a diff here means review-prompt\n' +
        'output MOVED. That is user-visible.\n\n' +
        'If the change was NOT intended, fix the code — do not regenerate.\n' +
        'If it WAS intended, regenerate and justify the diff in the PR:\n' +
        '  node scripts/gen-prompt-budget-parity-corpus.cjs --write\n'
    );
    return 1;
  }

  process.stdout.write(`ok ${path.relative(REPO_ROOT, OUT_PATH)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { buildCases, capture, serialize, OUT_PATH, CORPUS_VERSION };

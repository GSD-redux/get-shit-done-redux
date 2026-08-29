'use strict';

/**
 * state-document.test.cjs
 *
 * Characterization tests for the STATE.md pipe-table branch of
 * stateReplaceField / stateExtractField / stateReplaceFieldWithFallback
 * (issue #2880, ADR-2143 §3/§4). These lock byte-identical behaviour across
 * the migration of the table branch off a hand-rolled whole-document regex
 * onto a line-scan + byte-range splice (see gsd-core/bin/lib/state-document.cjs
 * locateFieldRow). Any future re-implementation of the table branch must keep
 * every assertion below true.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  stateReplaceField,
  stateExtractField,
  stateReplaceFieldWithFallback,
} = require('../gsd-core/bin/lib/state-document.cjs');

describe('stateReplaceField — table branch (characterization, #2880)', () => {
  test('replaces a two-cell row in place', () => {
    const input = '| Current Phase | 3 |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, '| Current Phase | 7 |');
  });

  test('returns null for a three-cell row', () => {
    const input = '| Current Phase | 3 | x |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, null);
  });

  test('matches the field name case-insensitively and preserves its original casing', () => {
    const input = '| current phase | 3 |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, '| current phase | 7 |');
  });

  test('replaces a row that has a header and delimiter above it', () => {
    const input = ['| F | V |', '| --- | --- |', '| Current Phase | 3 |'].join('\n');
    const expected = ['| F | V |', '| --- | --- |', '| Current Phase | 7 |'].join('\n');
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, expected);
  });

  test('replaces a header-less legacy row', () => {
    const input = '| Current Phase | 3 |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, '| Current Phase | 7 |');
  });

  test('replaces only the first of two rows naming the same field', () => {
    const input = ['| Current Phase | 3 |', '| Current Phase | 9 |'].join('\n');
    const expected = ['| Current Phase | 7 |', '| Current Phase | 9 |'].join('\n');
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, expected);
  });

  test('returns null when the value cell contains a pipe', () => {
    const input = '| Current Phase | a|b |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, null);
  });

  test('inserts before the closing pipe when the value cell is all whitespace', () => {
    const input = '| Current Phase |  |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, '| Current Phase |  7|');
  });

  test('never treats a delimiter row as a field', () => {
    const input = '| --- | --- |';
    const result = stateReplaceField(input, '---', 7);
    assert.equal(result, null);
  });

  test('ignores an indented row', () => {
    const input = '  | Current Phase | 3 |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, null);
  });

  test('inserts a dollar-sign pattern verbatim', () => {
    const input = '| Current Phase | 3 |';
    const result = stateReplaceField(input, 'Current Phase', '$&X');
    assert.equal(result, '| Current Phase | $&X |');
  });

  test("preserves the row's exact interior padding", () => {
    const input = '|   Current Phase   |   3   |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, '|   Current Phase   |   7   |');
  });

  test('returns null when the field is absent', () => {
    const input = '| Other | 3 |';
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, null);
  });

  test('returns null for empty content', () => {
    const result = stateReplaceField('', 'Current Phase', 7);
    assert.equal(result, null);
  });
});

describe('stateReplaceField — CRLF (#2880)', () => {
  test('preserves CRLF line endings byte-for-byte', () => {
    const input = ['| F | V |', '| --- | --- |', '| Current Phase | 3 |', ''].join('\r\n');
    const expected = ['| F | V |', '| --- | --- |', '| Current Phase | 7 |', ''].join('\r\n');
    const result = stateReplaceField(input, 'Current Phase', 7);
    assert.equal(result, expected);
  });

  test('replaces a bold field on a CRLF document', () => {
    const input = ['**Status:** old', ''].join('\r\n');
    const expected = ['**Status:** new', ''].join('\r\n');
    const result = stateReplaceField(input, 'Status', 'new');
    assert.equal(result, expected);
  });

  test('replaces a row terminated by a lone carriage return', () => {
    const input = ['| Phase | 3 |', '| Other | 9 |'].join('\r');
    const expected = ['| Phase | 5 |', '| Other | 9 |'].join('\r');
    const result = stateReplaceField(input, 'Phase', 5);
    assert.equal(result, expected);
  });
});

// #4010: when a STATE.md body field is empty, the label-to-value gap `\s*` in
// stateReplaceField's bold/plain patterns crossed the newline and `(.*)` ate the
// following line, which the rebuild then discarded — silent data-loss. The fix
// confines the gap to same-line whitespace (`[ \t]*`, mirroring the already-
// correct read side at stateExtractField) and pins the separator to a single
// space when the label line had none (no glued `**Status:**value`). These assert
// the EXACT output so the glued shape cannot pass (ADR-3180 §7.7 same-line owner).
describe('stateReplaceField — empty field preserves the following line (#4010)', () => {
  test('bold empty field: value lands on the label line, next line survives, no glue', () => {
    const input = '**Status:**\n**Current Plan:** 2 of 5';
    const expected = '**Status:** Executing Phase 5\n**Current Plan:** 2 of 5';
    assert.equal(stateReplaceField(input, 'Status', 'Executing Phase 5'), expected);
  });

  test('plain empty field: value lands on the label line, next line survives, no glue', () => {
    const input = 'Status:\nCurrent Plan: 2 of 5';
    const expected = 'Status: Executing Phase 5\nCurrent Plan: 2 of 5';
    assert.equal(stateReplaceField(input, 'Status', 'Executing Phase 5'), expected);
  });

  test('bold empty field on a CRLF document preserves the following line', () => {
    const input = '**Status:**\r\n**Current Plan:** 2 of 5';
    const expected = '**Status:** Executing Phase 5\r\n**Current Plan:** 2 of 5';
    assert.equal(stateReplaceField(input, 'Status', 'Executing Phase 5'), expected);
  });

  test('plain empty field on a CRLF document preserves the following line', () => {
    const input = 'Status:\r\nCurrent Plan: 2 of 5';
    const expected = 'Status: Executing Phase 5\r\nCurrent Plan: 2 of 5';
    assert.equal(stateReplaceField(input, 'Status', 'Executing Phase 5'), expected);
  });

  test('non-empty bold field stays byte-identical to prior behaviour', () => {
    const input = '**Status:** Planning\n**Current Plan:** 2 of 5';
    const expected = '**Status:** Executing Phase 5\n**Current Plan:** 2 of 5';
    assert.equal(stateReplaceField(input, 'Status', 'Executing Phase 5'), expected);
  });

  test('E2E: transitionCore update of an empty field preserves the next line (ADR-3180 Decision 4(c))', () => {
    const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
    const content = '## Current Position\n\n**Status:**\n**Current Plan:** 2 of 5';
    const result = transitionCore(content, { kind: 'update', field: 'Status', value: 'Executing Phase 5' });
    assert.equal(result.content, '## Current Position\n\n**Status:** Executing Phase 5\n**Current Plan:** 2 of 5');
    assert.deepEqual(result.updated, ['Status']);
  });
});

describe('stateExtractField (#2880)', () => {
  test('extracts from a two-cell row', () => {
    const input = '| Current Phase | 3 |';
    assert.equal(stateExtractField(input, 'Current Phase'), '3');
  });

  test('extracts from a CRLF document', () => {
    const input = ['| F | V |', '| --- | --- |', '| Current Phase | 3 |', ''].join('\r\n');
    assert.equal(stateExtractField(input, 'Current Phase'), '3');
  });

  test('returns null when absent', () => {
    const input = '| Other | 3 |';
    assert.equal(stateExtractField(input, 'Current Phase'), null);
  });

  test('round-trip: extract after replace returns the new value', () => {
    const input = '| Current Phase | 3 |';
    const replaced = stateReplaceField(input, 'Current Phase', '7');
    assert.equal(stateExtractField(replaced, 'Current Phase'), '7');
  });

  test('matches a row terminated by a lone carriage return', () => {
    const input = ['| Phase | 3 |', '| Other | 9 |'].join('\r');
    assert.equal(stateExtractField(input, 'Phase'), '3');
  });

  test('does not match when the field name has more padding than the cell', () => {
    const input = '| Phase | 3 |';
    assert.equal(stateExtractField(input, '  Phase  '), null);
  });
});

describe('stateReplaceFieldWithFallback (#2880)', () => {
  test('uses the primary when present', () => {
    const input = '| Current Phase | 3 |';
    const result = stateReplaceFieldWithFallback(input, 'Current Phase', 'Phase', 7);
    assert.equal(result, '| Current Phase | 7 |');
  });

  test('falls back to the secondary name when the primary is absent', () => {
    const input = '| Phase | 3 |';
    const result = stateReplaceFieldWithFallback(input, 'Current Phase', 'Phase', 7);
    assert.equal(result, '| Phase | 7 |');
  });

  test('returns the content UNCHANGED (not null) when both are absent', () => {
    const content = '| Other | 3 |';
    const result = stateReplaceFieldWithFallback(content, 'Current Phase', 'Phase', 7);
    assert.equal(result, content);
  });
});

describe('property: bounded mutation (#2880, ADR-2143 §4)', () => {
  test('replacing one row leaves every other line byte-identical', () => {
    const safeValue = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), {
        minLength: 1,
        maxLength: 8,
      })
      .map((chars) => chars.join('').trim() || 'x');

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            values: fc.array(safeValue, { minLength: n, maxLength: n }),
            targetIndex: fc.integer({ min: 0, max: n - 1 }),
            newValue: safeValue,
          }),
        ),
        ({ n, values, targetIndex, newValue }) => {
          const fieldNames = Array.from({ length: n }, (_, i) => `Field${i}`);
          const lines = fieldNames.map((name, i) => `| ${name} | ${values[i]} |`);
          const doc = lines.join('\n');

          const result = stateReplaceField(doc, fieldNames[targetIndex], newValue);
          assert.notEqual(result, null);

          const resultLines = result.split('\n');
          assert.equal(resultLines.length, lines.length);
          for (let i = 0; i < lines.length; i++) {
            if (i === targetIndex) continue;
            assert.equal(resultLines[i], lines[i]);
          }
          assert.equal(resultLines[targetIndex], `| ${fieldNames[targetIndex]} | ${newValue} |`);
        },
      ),
      { seed: 20880, numRuns: 200 },
    );
  });
});

describe('property: fieldNameMatchesRawCell case-fold semantics, via stateExtractField (FIX A)', () => {
  test('match verdict agrees with an explicit ECMAScript non-unicode Canonicalize reference predicate', () => {
    // Independent, obviously-correct reference for "are these two code units
    // the same character under a non-`u`-flag `/i` RegExp": NOT
    // `.toLowerCase()`, which incorrectly folds some non-ASCII characters
    // (e.g. KELVIN SIGN U+212A) onto their ASCII counterparts ("k"), and
    // also incorrectly folds multi-character uppercase mappings (e.g. "ß"
    // toUpperCase()'s "SS") onto a two-character string. Per ECMAScript's
    // non-unicode Canonicalize, a fold is REJECTED (the original character
    // is kept as-is) whenever `ch.toUpperCase()` is not exactly one
    // character, OR the original is non-ASCII (>= 128) while the uppercased
    // result is ASCII (< 128).
    function canonChar(ch) {
      const upper = ch.toUpperCase();
      if (upper.length !== 1) return ch;
      if (ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return ch;
      return upper;
    }
    function canonStringEqual(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (canonChar(a[i]) !== canonChar(b[i])) return false;
      }
      return true;
    }
    // Reference predicate for the whole field-name/cell match, stated
    // independently of (and structured differently from) the scanner under
    // test: `fieldName` matches `rawCell` iff `fieldName` occurs as a literal
    // (Canonicalize-compared) substring of `rawCell` at SOME offset `j`, with
    // everything BEFORE `j` and everything AFTER the occurrence consisting
    // exclusively of ' '/'\t'. This is a full, unbounded substring scan with
    // no "leading run" shortcut.
    function referenceFieldMatchesCell(fieldName, rawCell) {
      const n = fieldName.length;
      for (let j = 0; j + n <= rawCell.length; j++) {
        const before = rawCell.slice(0, j);
        const after = rawCell.slice(j + n);
        if (!/^[ \t]*$/.test(before)) continue;
        if (!/^[ \t]*$/.test(after)) continue;
        if (canonStringEqual(rawCell.slice(j, j + n), fieldName)) return true;
      }
      return false;
    }

    const padArb = fc.array(fc.constantFrom(' ', '\t'), { minLength: 0, maxLength: 3 }).map((chars) => chars.join(''));
    // Deliberately includes the KELVIN SIGN (U+212A) and other non-ASCII
    // characters whose `.toLowerCase()`/`.toUpperCase()` folds onto an ASCII
    // character — exactly the class of character FIX A addresses.
    const coreCharArb = fc.constantFrom('a', 'b', 'K', 'k', 'P', 'p', 'H', 'A', '\u212A', '\u1E9E', '\u00DF', '1', '_');
    const coreArb = fc.array(coreCharArb, { minLength: 1, maxLength: 5 }).map((chars) => chars.join(''));
    const fieldNameArb = fc
      .record({ pre: padArb, core: coreArb, post: padArb })
      .map(({ pre, core, post }) => pre + core + post);

    fc.assert(
      fc.property(
        fieldNameArb,
        fc.boolean(),
        fc.constantFrom('same', 'upper', 'lower'),
        padArb,
        padArb,
        coreArb,
        (fieldName, deriveFromFieldName, caseMode, cellPre, cellPost, randomCore) => {
          const fieldCore = fieldName.replace(/^[ \t]+|[ \t]+$/g, '');
          let derivedCore = fieldCore;
          if (caseMode === 'upper') derivedCore = fieldCore.toUpperCase();
          else if (caseMode === 'lower') derivedCore = fieldCore.toLowerCase();
          const cellCore = deriveFromFieldName ? derivedCore : randomCore;
          const cellContent = cellPre + cellCore + cellPost;
          // The template fixes exactly one literal space on each side of
          // cellContent, so rawCell (as locateFieldRow computes it) is
          // ` ${cellContent} ` byte-for-byte.
          const doc = `| ${cellContent} | value |`;
          const rawCell = ` ${cellContent} `;
          const expected = referenceFieldMatchesCell(fieldName, rawCell);
          const result = stateExtractField(doc, fieldName);
          assert.equal(result, expected ? 'value' : null);
        },
      ),
      { seed: 28801, numRuns: 300 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2828-flat-roadmap-total-phases.test.cjs (H3 Wave 7, #3339)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2828-flat-roadmap-total-phases', () => {
'use strict';

// Regression guard for #2828: on a flat unmilestoned roadmap (no versioned milestone
// heading), `state-snapshot`/`state record-session` reported progress.total_phases as
// the on-disk phase-dir count (1) instead of the authoritative roadmap count (6). The
// read-path disk-scan cache fell back to phaseDirs.length when milestoneBounded was
// false, even though roadmapPhaseCount (6) was correct for a flat roadmap (no sibling
// milestones to conflate). Fix: use roadmapPhaseCount as the floor when > 0.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('#2828 — total_phases uses the roadmap count on a flat unmilestoned roadmap', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2828-');
    const planningDir = path.join(tmpDir, '.planning');
    // Flat unmilestoned roadmap with 6 phases (no versioned milestone heading).
    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Foundation',
        '### Phase 2: Core API',
        '### Phase 3: UI Layer',
        '### Phase 4: Integration',
        '### Phase 5: Polish',
        '### Phase 6: Release',
        '',
      ].join('\n'),
    );
    // Only phase 1 has been discussed → 1 phase dir on disk.
    const phaseDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Phase 1 Context\n');
    // Minimal STATE.md with a milestone set (so milestoneBounded is computed) but no
    // versioned heading to bound it to → the flat-roadmap unbounded case.
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'status: executing',
        'milestone: v1.0',
        'milestone_name: milestone',
        '---',
        '',
        '# Project State',
        '',
        '**Current Phase:** 01',
        '**Status:** In progress',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('state sync writes progress.total_phases === 6 (roadmap count), not 1 (phase-dir count) (#2828)', () => {
    // `state sync` derives progress.total_phases from the disk-scan cache (the read path
    // #2828 fixes) and writes it to STATE.md frontmatter. Pre-fix this wrote 1.
    const result = runGsdTools(['state', 'sync'], tmpDir);
    assert.ok(result.success, `state sync failed: ${result.error}`);

    const stateMd = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
    // Parse the `progress:` YAML block line-by-line (ReDoS-safe: avoids a nested-quantifier
    // regex over the whole block). Find total_phases among the block's indented children.
    const lines = stateMd.split(/\r?\n/);
    let inProgress = false;
    let totalPhases = null;
    for (const line of lines) {
      if (/^progress:\s*$/.test(line)) { inProgress = true; continue; }
      if (inProgress) {
        // A new top-level (column-0) key ends the progress block.
        if (/^\S/.test(line)) { inProgress = false; continue; }
        const tp = line.match(/^\s+total_phases:\s*(\d+)/);
        if (tp) { totalPhases = Number(tp[1]); break; }
      }
    }
    assert.ok(
      totalPhases !== null,
      `progress.total_phases must be written by state sync. STATE.md:\n${stateMd}`,
    );
    assert.strictEqual(
      totalPhases,
      6,
      `progress.total_phases must be the roadmap count (6) for a flat unmilestoned roadmap, not the on-disk phase-dir count (1). Got: ${totalPhases}`,
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-3204-state-writer-phase-count.test.cjs (H3 Wave 7, #3339)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-3204-state-writer-phase-count', () => {
// allow-test-rule: source-text-is-the-product, see #3204
// Reads STATE.md/ROADMAP.md fixture files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * #3204 / #3185 — failing-first regression suite for `buildStateFrontmatter`'s
 * `total_phases` selection (`src/state.cts:1620`, guard at `:1795-1805`).
 *
 * `hasMilestoneSectioning` (`src/roadmap-parser.cts:195`) is
 *   /^#{2,3}\s+(?!Phase\s+\S)/mi
 * — true for ANY non-Phase level-2/3 heading, so a FLAT roadmap carrying an
 * ordinary structural heading (`## Progress`, `## Overview`, ...) is
 * misclassified as milestone-sectioned. `safeToUseRoadmapCount` then goes
 * false and the on-disk phase-directory count silently clobbers the
 * ROADMAP-declared count — a regression of #2828, reported in #3204 as
 * "roadmap declares 6 phases, 4 directories exist, state.record-session
 * writes total_phases: 4".
 *
 * DO NOT fix src/state.cts or src/roadmap-parser.cts from this file. Rows 2,
 * 3, and 14 below assert the CORRECT (post-fix) value and currently FAIL —
 * that is the point of a failing-first suite. Every other row asserts
 * behavior verified to already hold today (see phase-log for the manual CLI
 * probes that established each expected value before this file was written).
 *
 * Rows and naming follow `.gsd/phase/fix-3185-state-writer-phase-count/50-test-matrix.md`
 * verbatim (row numbers refer to that matrix, not the 8-row table in
 * `40-design.md`).
 *
 * Driven via `state record-session` (the shape #3204's own report used),
 * then read back with `state json --raw` — the product's own frontmatter
 * parser — so `progress.total_phases` is asserted as a NUMBER, never a
 * regex over rendered STATE.md text. `tests/helpers.cjs`'s `parseFrontmatter`
 * only reads flat top-level keys (it does not descend into the nested
 * `progress:` block), so `state json --raw` is the correct structured seam
 * for a nested field — it is what `tests/state.test.cjs`'s own '#1761
 * read-path' and 'milestone-scoped phase counting' suites already use for
 * this exact assertion shape.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed `.planning/phases/<padded>-phase-<n>` for each phase number in `nums`,
 * each with a single PLAN.md so the directory is a recognizable phase dir.
 */
function seedPhaseDirs(tmpDir, nums) {
  for (const n of nums) {
    const padded = String(n).padStart(2, '0');
    const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan\n');
  }
}

/** Seed one arbitrarily-named phase directory (sentinel / dup / pre-milestone cases). */
function seedNamedPhaseDir(tmpDir, dirName, planBase) {
  const dir = path.join(tmpDir, '.planning', 'phases', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planBase}-01-PLAN.md`), '# Plan\n');
}

/**
 * Build STATE.md frontmatter + minimal body. `milestone` is always set (the
 * #3204 fixture needs it truthy — `getMilestoneInfo` defaults an absent
 * `milestone:` field to 'v1.0' anyway, so this pins the same value
 * explicitly for every row rather than relying on that fallback).
 * Lines are joined with the caller-supplied `eol` (default '\n') — row 14
 * reuses this to build the CRLF variant without a second copy.
 */
function buildStateMd({ milestone = 'v1.0', milestoneName = 'Test', totalPhases, currentPhase = '01', eol = '\n' }) {
  const lines = [
    '---',
    'gsd_state_version: 1.0',
    `milestone: ${milestone}`,
    `milestone_name: ${milestoneName}`,
    `current_phase: "${currentPhase}"`,
    'status: executing',
    'progress:',
    `  total_phases: ${totalPhases}`,
    '  completed_phases: 0',
    '  total_plans: 0',
    '  completed_plans: 0',
    '  percent: 0',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Current Phase:** ${currentPhase}`,
    '**Status:** Executing',
    '',
  ];
  return lines.join(eol);
}

/** Invoke `state record-session` (the #3204 entry point) then read back `state json --raw`. */
function recordSessionAndReadTotalPhases(tmpDir) {
  const recordResult = runGsdTools(
    ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'],
    tmpDir,
  );
  assert.ok(recordResult.success, `state record-session failed: ${recordResult.error}`);

  const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
  assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
  return JSON.parse(jsonResult.output);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows 1-3, 14 — #3204 regression: flat roadmap + a structural heading
// ─────────────────────────────────────────────────────────────────────────────

describe('#3204 buildStateFrontmatter total_phases — flat roadmap misclassified as milestone-sectioned', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('flat roadmap with no structural headings keeps the roadmap count', () => {
    // Row 1 (happy path / control) — no non-Phase heading anywhere, so
    // hasMilestoneSectioning is false today and this already passes. Guards
    // against a fix that overcorrects and breaks the trivial flat case.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected roadmap count 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('#3204 flat roadmap with a Progress heading is not treated as milestone-sectioned', () => {
    // Row 2 — the crux repro, transcribed from #3204's own report: 6
    // declared phases, 4 directories, a flat '## Progress' heading. FAILS
    // TODAY: hasMilestoneSectioning misclassifies '## Progress' as
    // sectioning, safeToUseRoadmapCount goes false, and the write clobbers
    // total_phases down to the disk count (4) instead of 6.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Progress',
      '',
      'Some progress notes.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204: total_phases must stay 6 (roadmap-declared), not clobber to the disk count of 4. Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3204 multiple structural headings still count as flat', () => {
    // Row 3 — same shape as row 2 with TWO structural headings ('## Overview',
    // '## Phase Details'); '## Phase Details' is correctly excluded by the
    // heading's own '(?!Phase\s+\S)' lookahead, but '## Overview' still trips
    // the misclassification. FAILS TODAY for the same reason as row 2.
    const roadmap = [
      '# Roadmap',
      '',
      '## Overview',
      '',
      'Some overview text.',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Phase Details',
      '',
      'More detail prose.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204: multiple structural headings must still count as flat (6), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3204 repro under CRLF', () => {
    // Row 14 — row 2's exact repro, all fixture content authored with CRLF
    // line endings, proving the bug (and required fix) is not an artifact of
    // LF-only fixtures. FAILS TODAY for the same reason as row 2.
    const roadmapLines = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '## Progress',
      '',
      'Some progress notes.',
      '',
    ];
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmapLines.join('\r\n'));
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ totalPhases: 6, eol: '\r\n' }),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3204 under CRLF: total_phases must stay 6, got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows 4-11 — negative space and boundaries (must hold both before and after the fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3204 buildStateFrontmatter total_phases — negative space / boundaries (must not regress)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bounded milestone uses its own section count', () => {
    // Row 4 — versioned roadmap with two sibling milestone sections ('## v1.0'
    // owning phases 1-2, '## v2.0' owning phases 3-5). The asserted milestone
    // ('v2.0') IS bound to its own heading, so `sliceMilestoneWindow`/
    // `extractCurrentMilestoneScoped` narrow to that section and
    // roadmapPhaseCount is the SECTION's count (3), not the whole-document
    // count (5) and not the disk count (2 dirs seeded).
    const roadmap = [
      '# Roadmap',
      '',
      '## v1.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '',
      '## v2.0',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v2.0', milestoneName: 'Second', totalPhases: 3 }),
    );
    seedPhaseDirs(tmpDir, [3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `a bounded milestone must use its own section's phase count (3), not the whole document (5) or the disk count (2). Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('a single milestone section that is not the asserted one withholds the total (#3642)', () => {
    // Row 6, REWRITTEN by #3642 (maintainer-confirmed bug; the old contract
    // here was the bug). Exactly ONE '## v2.0' section owning phases, with
    // the asserted milestone ('v9.9') absent from the roadmap entirely. The
    // old row pinned that hasMilestoneSectioning's >=2 threshold reads this
    // as flat, so the roadmap-declared count (4) was used for v9.9 — which
    // IS the leak #3642 reports: the v2.0 section's phases became a
    // different milestone's total. The #3354 withhold doctrine governs both
    // faces now: neither the whole-document count (it is the foreign
    // section's phases) NOR the on-disk dir count is authoritative for a
    // milestone absent from the roadmap, so the STORED value (99, chosen to
    // differ from every substitute) must be preserved.
    const roadmap = [
      '# Roadmap',
      '',
      '## v2.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Absent', totalPhases: 99 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      99,
      `#3642: a single non-matching section must not leak its phases into the asserted milestone's total; stored 99 expected, got ${out.progress && out.progress.total_phases}`,
    );
    // The clobber must also be SURFACED, not silent: drive the seam directly
    // (runGsdTools discards stderr on success) and require the #3642 warning
    // naming the asserted milestone.
    const { runNode } = require('./helpers/process-seam.cjs');
    const { TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');
    const rec = runNode(
      [TOOLS_PATH, 'state', 'json', '--raw'],
      { cwd: tmpDir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
    assert.ok(rec.exitCode === 0, `state json --raw failed: ${rec.stderr}`);
    assert.ok(
      (rec.stderr || '').includes('v9.9') && (rec.stderr || '').includes('#3642'),
      `#3642: expected a stderr warning naming the asserted milestone and the issue, got stderr=${JSON.stringify(rec.stderr)}`,
    );
  });

  test('#1761/#3354 sibling milestone sections preserve the stored total', () => {
    // Row 5 — TWO sibling (unversioned) milestone sections, asserted
    // milestone ('v3.0') absent from either. This is genuinely
    // milestone-sectioned (2 phase-bearing sections would conflate if
    // whole-doc counted), so neither the whole-doc count NOR the on-disk dir
    // count is an authoritative total (#3354): the stored value must be
    // preserved instead. Pre-#3354 this row asserted the disk count (3).
    const roadmap = [
      '# Roadmap',
      '',
      '## Milestone 1: First Milestone',
      '### Phase 1: a',
      '### Phase 2: b',
      '### Phase 3: c',
      '### Phase 4: d',
      '',
      '## Milestone 2: Second Milestone',
      '### Phase 5: e',
      '### Phase 6: f',
      '### Phase 7: g',
      '### Phase 8: h',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v3.0', milestoneName: 'Third', totalPhases: 8 }),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      8,
      `#1761/#3354: unbounded sibling milestones must preserve the stored total (8), not clobber to the disk count (3). Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('zero phase directories keeps the declared count', () => {
    // Row 7 — boundary limit-1: 0 dirs vs 6 declared.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    // No phase dirs seeded.

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('equal counts agree', () => {
    // Row 8 — boundary limit: 6 dirs vs 6 declared.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4, 5, 6]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 6, `expected 6, got ${out.progress && out.progress.total_phases}`);
  });

  test('extra directories win via max()', () => {
    // Row 9 — boundary limit+1. 6 heading-declared phases + a 7th phase
    // declared only via the bullet-entry syntax ('- [ ] **Phase 7 — Extra**',
    // #2199 bullet house style), which the directory-membership filter
    // counts but the heading-only roadmapPhaseCount scan does not — so disk
    // (7, all pass the membership filter) legitimately exceeds the
    // heading-only roadmap count (6), and max() must pick 7.
    //
    // NOTE: a naive "N heading-declared phases + N+1 plain directories" does
    // NOT exercise this path — the directory-membership filter
    // (getMilestonePhaseFilter, roadmap-parser.cts) excludes any directory
    // whose phase number has no matching roadmap entry at all, so an
    // out-of-roadmap directory number is silently dropped from the disk
    // count rather than inflating it. Verified against the running CLI
    // before authoring this fixture.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
      '- [ ] **Phase 7 — Extra**',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 6 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4, 5, 6, 7]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      7,
      `expected max(7 dirs, 6 heading-declared) = 7, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('absent roadmap falls back to disk', () => {
    // Row 10 — no ROADMAP.md at all.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 4, `expected disk count 4, got ${out.progress && out.progress.total_phases}`);
  });

  test('roadmap with no phase headings falls back to disk', () => {
    // Row 11 — ROADMAP.md present but zero Phase headings anywhere.
    const roadmap = ['# Roadmap', '', '## Notes', '', 'No phases declared yet.', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(Number(out.progress.total_phases), 4, `expected disk count 4, got ${out.progress && out.progress.total_phases}`);
  });

  test('a phase heading carrying a version token is not a milestone heading', () => {
    // Row 12 (hostile, negative space) — '### Phase 3: Ship v2.0 gaps' carries
    // a version token in its own text, but hasMilestoneSectioning's
    // isPhaseHeading check excludes any heading matching '^Phase\s+\S' before
    // the vocabulary signal is ever tested, so this must NOT count as a
    // milestone heading. Otherwise-flat roadmap, so the roadmap-declared
    // count must be used, not the disk count.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '### Phase 3: Ship v2.0 gaps',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `a version token borne by a Phase heading must not trigger milestone sectioning; expected roadmap count 4, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('a version heading inside a fence is not sectioning', () => {
    // Row 13 (hostile, negative space) — '## v2.0' appears only inside a
    // fenced code block (a documentation example of the heading syntax) on an
    // otherwise flat roadmap. hasMilestoneSectioning is routed through
    // tokenizeHeadings (fence-aware), so a fenced heading is never tokenised
    // and must NOT count as sectioning. The roadmap-declared count must be
    // used, not the disk count.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
      'Example heading syntax:',
      '',
      '```',
      '## v2.0',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 4 }));
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `a version heading inside a fence must not trigger milestone sectioning; expected roadmap count 4, got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3185 adversarial review — hasMilestoneSectioning ownership-model shapes
// missed by the original suite (BLOCKER + MAJOR findings against the #3184
// "strictly-deeper nesting" rewrite).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3185 review — hasMilestoneSectioning shapes the original suite missed', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('BLOCKER: same-level sibling milestones preserve the stored total', () => {
    // Adversarial review BLOCKER (#1761 regression): the #3184 rewrite
    // required a candidate milestone heading's owned Phase heading to be
    // STRICTLY DEEPER (next.level > candidate.level). Real sibling
    // milestones are frequently at the SAME level as their own Phase
    // headings ('## v1.0' / '## Phase 1:' / '## v2.0' / '## Phase 3:'), so
    // that predicate answered false and the whole-document count conflated
    // both milestones. The asserted milestone ('v3.0') is unbound (matches
    // neither v1.0 nor v2.0), so this is genuinely sectioned and neither
    // the whole-doc count NOR the disk count may be written (#3354): the
    // stored value (4) must be preserved. Pre-#3354 this row asserted the
    // disk count (2).
    const roadmap = [
      '# Roadmap',
      '',
      '## v1.0',
      '## Phase 1: One',
      '## Phase 2: Two',
      '',
      '## v2.0',
      '## Phase 3: Three',
      '## Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v3.0', milestoneName: 'Third', totalPhases: 4 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      4,
      `same-level sibling milestones must preserve the stored total (4), not clobber to the disk count (2). Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3185 repro: structural headings interleaved among flat phases keep the roadmap count', () => {
    // #3185's own reproduction of the adjacency model this suite's
    // predecessor shipped: '## Overview' sits immediately before
    // '## Phase 1:' and '## Notes' sits immediately before '## Phase 4:',
    // giving an adjacency-based predicate 2 "owning" candidates even though
    // neither heading carries any milestone vocabulary (no version token, no
    // status marker, no "Milestone" word) and the roadmap is genuinely flat.
    const roadmap = [
      '# Roadmap',
      '',
      '## Overview',
      '## Phase 1: One',
      '## Phase 2: Two',
      '## Phase 3: Three',
      '## Notes',
      '## Phase 4: Four',
      '## Phase 5: Five',
      '## Phase 6: Six',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Test', totalPhases: 6 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      6,
      `#3185: structural headings adjacent to phase headings must not be treated as milestone sectioning; expected roadmap count 6, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('MAJOR: wrapper + single nested milestone, asserted elsewhere, withholds the total (#3642)', () => {
    // Adversarial review MAJOR (#3204 reintroduction), REWRITTEN by #3642
    // (maintainer-confirmed bug). The row's original purpose survives: a
    // generic wrapper ('## Phases') with ONE real milestone nested under it
    // (bundled template shape: '### 🚧 v1.1 [Name]' -> '#### Phase N:') is
    // NOT milestone-SECTIONED — hasMilestoneSectioning's >=2 still says
    // false, pinned by the #3642 seam rows. But the row's old ASSERTION
    // pinned the leak #3642 reports: with the asserted milestone ('v9.9')
    // deliberately unbound, the roadmap count (4) — which IS the v1.1
    // section's phases — was written as v9.9's total. Pre-#3354 that arm
    // existed to stop a clobber to the disk count (2); the #3354/#3642
    // withhold doctrine supersedes it: preserve the stored value (8, chosen
    // to differ from every substitute) and warn.
    const roadmap = [
      '# Roadmap',
      '',
      '## Phases',
      '',
      '### 🚧 v1.1 [Name] (In Progress)',
      '',
      '#### Phase 1: One',
      '#### Phase 2: Two',
      '#### Phase 3: Three',
      '#### Phase 4: Four',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v9.9', milestoneName: 'Unbound', totalPhases: 8 }),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      8,
      `#3642: a single real section's phases must not become an absent milestone's total; stored 8 expected. Got ${out.progress && out.progress.total_phases}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows 15-18 — #3185 consolidation independence checks
//
// These exercise the directory-enumeration owner (listMilestonePhaseDirs /
// getMilestonePhaseFilter), not hasMilestoneSectioning. Verified PASSING
// against the current build (manual CLI probe) before being added here —
// included per the dispatch brief's "include only if they pass today"
// condition. If a future change to the #3204 fix regresses one of these,
// that is a SEPARATE finding from the #3204 repro above, not folded into it.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3185 buildStateFrontmatter total_phases — directory-enumeration independence (currently passing)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sentinel directories are excluded by the canonical enumeration', () => {
    // Row 15 — a 999.x backlog directory alongside 3 real phase directories
    // must not inflate total_phases.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '999.1-backlog-idea', '999.1');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `sentinel 999.x directory must be excluded, expected 3, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('pre-milestone directories are excluded', () => {
    // Row 16 — a '0-*' pre-milestone directory must not be counted.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '0-premilestone', '0');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `pre-milestone '0-*' directory must be excluded, expected 3, got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('duplicate phase-number directories count once', () => {
    // Row 17 — two directories both keyed to phase number 2 must dedup to a
    // single count.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2, 3]);
    seedNamedPhaseDir(tmpDir, '02-phase-2-dup', '02');

    const out = recordSessionAndReadTotalPhases(tmpDir);
    assert.strictEqual(
      Number(out.progress.total_phases),
      3,
      `duplicate phase-2 directories must dedup to a single count (3), got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('re-running record-session does not move total_phases', () => {
    // Row 18 — idempotence: a second record-session call over an unchanged
    // tree, with the clock pinned so 'Last session' does not itself vary,
    // must produce a byte-identical STATE.md.
    const roadmap = ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    const sessionState = [
      '# GSD State',
      '',
      '## Session',
      '',
      '**Last session:** 2024-01-01T00:00:00.000Z',
      '**Stopped at:** None',
      '**Resume file:** None',
      '',
      '## Current Position',
      '',
      '**Current Phase:** 01',
      '**Status:** Executing',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), sessionState);
    seedPhaseDirs(tmpDir, [1, 2, 3]);

    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const pinnedEnv = { GSD_TEST_MODE: '1', GSD_NOW_MS: '1600000000000' };
    const args = ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'];

    const first = runGsdTools(args, tmpDir, pinnedEnv);
    assert.ok(first.success, `first record-session failed: ${first.error}`);
    const afterFirst = fs.readFileSync(statePath, 'utf8');

    const second = runGsdTools(args, tmpDir, pinnedEnv);
    assert.ok(second.success, `second record-session failed: ${second.error}`);
    const afterSecond = fs.readFileSync(statePath, 'utf8');

    assert.strictEqual(
      afterSecond,
      afterFirst,
      're-running record-session on an unchanged tree with a pinned clock must produce a byte-identical STATE.md',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3355 — same-milestone phase-dir collision: the seenPhaseNums dedup loop in
// buildStateFrontmatter resolved duplicate phase keys by fs mtime, which
// encodes checkout write order, not repository content — identical commits
// reported different progress.total_plans / completed_plans across clones.
// The tie-break must be content-derived and the collision surfaced, while the
// Bug #2445 one-survivor-per-key invariant is preserved.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3355 phase-dir dedup — collision tie-break must not consult mtime', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');

  // Both normalize to phase key '3' (phaseKeyFromDir) and are IN scope on a
  // flat roadmap, so they reach the dedup loop unfiltered. Distinct plan /
  // summary counts make the survivor observable in the derived progress
  // counts. Lexicographically 'mi' < 'mv', so DIR_LEX is the deterministic
  // survivor; DIR_MTIME is the pre-fix winner whenever it is mtime-newer.
  const DIR_LEX = '03-mi-cuenta-y-contactos';
  const DIR_MTIME = '03-mvp-modulos-portal-cliente';

  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3355-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function buildCollisionFixture() {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Phase 1: One', '## Phase 2: Two', '## Phase 3: Three', ''].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), buildStateMd({ totalPhases: 3 }));
    seedPhaseDirs(tmpDir, [1, 2]); // phases 01 + 02, one plan each

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const lexDir = path.join(phasesDir, DIR_LEX);
    fs.mkdirSync(lexDir, { recursive: true });
    fs.writeFileSync(path.join(lexDir, '03-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(lexDir, '03-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(lexDir, '03-01-SUMMARY.md'), '# Summary\n');
    const mtimeDir = path.join(phasesDir, DIR_MTIME);
    fs.mkdirSync(mtimeDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(mtimeDir, `03-0${i}-PLAN.md`), '# Plan\n');
    }
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(mtimeDir, `03-0${i}-SUMMARY.md`), '# Summary\n');
    }
    return { phasesDir, lexDir, mtimeDir };
  }

  function readProgress() {
    const result = runGsdTools(['state', 'json', '--raw'], tmpDir);
    assert.ok(result.success, `state json --raw failed: ${result.error}`);
    return JSON.parse(result.output).progress;
  }

  test('#3355 flipping the colliding dirs\' mtimes keeps counts byte-identical, warns naming both dirs, one survivor per key', () => {
    const { lexDir, mtimeDir } = buildCollisionFixture();

    // The issue reported a 0.133 ms mtime margin flipping the winner, but
    // filesystem timestamp granularity is platform-dependent (APFS rounds
    // utimes to whole ms), so the flip uses a margin guaranteed to register
    // everywhere — pre-fix, the mtime-newer duplicate then won the dedup
    // regardless of repository content. `_diskScanCache` is process-local
    // and runGsdTools spawns a fresh node per call, so each read below is a
    // cold scan exactly like a fresh checkout.
    const base = new Date('2026-01-01T00:00:00.000Z');
    const margin = new Date(base.getTime() + 1500);
    fs.utimesSync(lexDir, base, base);
    fs.utimesSync(mtimeDir, margin, margin); // DIR_MTIME mtime-newer — must NOT win

    const first = readProgress();

    // Deterministic lexicographic survivor: 01 (1 plan) + 02 (1 plan) +
    // DIR_LEX (2 plans) = 4 — never the mtime-newer DIR_MTIME's 7, never the
    // un-deduped sum of both (Bug #2445 invariant, 9).
    assert.strictEqual(
      Number(first.total_plans),
      4,
      `#3355: total_plans must follow the lexicographic survivor (${DIR_LEX}: 1+1+2=4), got ${first && first.total_plans} — mtime still deciding the collision?`,
    );
    assert.strictEqual(
      Number(first.completed_plans),
      1,
      `#3355: completed_plans must count only the survivor's summaries (1), got ${first && first.completed_plans}`,
    );

    // The collision must be surfaced: stderr warning naming BOTH dirs
    // (runGsdTools discards stderr on success, so drive the seam directly).
    const rec = runNode(
      [TOOLS_PATH, 'state', 'json', '--raw'],
      { cwd: tmpDir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
    assert.ok(rec.exitCode === 0, `state json --raw failed: ${rec.stderr}`);
    assert.ok(
      (rec.stderr || '').includes(DIR_LEX) && (rec.stderr || '').includes(DIR_MTIME),
      `#3355: expected a stderr warning naming both colliding dirs, got stderr=${JSON.stringify(rec.stderr)}`,
    );

    // Flip the mtimes — byte content unchanged, only checkout order would
    // differ. Every derived count must stay byte-identical.
    fs.utimesSync(mtimeDir, base, base);
    fs.utimesSync(lexDir, margin, margin);

    const second = readProgress();
    assert.strictEqual(second.total_plans, first.total_plans, `#3355: total_plans moved after the mtime flip (${first.total_plans} → ${second.total_plans})`);
    assert.strictEqual(second.completed_plans, first.completed_plans, `#3355: completed_plans moved after the mtime flip (${first.completed_plans} → ${second.completed_plans})`);
    assert.strictEqual(second.percent, first.percent, `#3355: percent moved after the mtime flip (${first.percent} → ${second.percent})`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3354 — milestoned-but-unbounded: a genuinely milestone-sectioned ROADMAP
// whose asserted milestone token matches no H1–H3 heading must not have its
// progress.total_phases clobbered to the on-disk phase-directory count.
// Surviving branch of #2828/#3204: #3204 closed only the flat-unmilestoned
// case; the sectioned-but-unbounded arm of `safeToUseRoadmapCount` still
// wrote phaseDirs.length (25 → 4 in the issue's report).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3354 buildStateFrontmatter total_phases — milestoned-but-unbounded roadmap', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');

  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** The #3354 crux fixture: 2 milestone-vocabulary sections, 25 phase headings across siblings. */
  function buildSectionedRoadmap() {
    const lines = ['# Roadmap', ''];
    lines.push('## Milestone v2.0 — Alpha', '');
    for (let i = 1; i <= 12; i++) lines.push(`### Phase ${i}: alpha-${i}`);
    lines.push('');
    lines.push('## Milestone v3.0 — Beta', '');
    for (let i = 13; i <= 25; i++) lines.push(`### Phase ${i}: beta-${i}`);
    lines.push('');
    return lines.join('\n');
  }

  test('#3354 stored total is preserved (not clobbered to the dir count), a stderr warning names the token, percent stays withheld', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), buildSectionedRoadmap());
    // milestone: v1.0 appears in NO heading of that roadmap — unbounded.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', milestoneName: 'Unbounded', totalPhases: 25 }),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    // Drive the mutating command with stderr captured (runGsdTools discards
    // stderr on success). The warning is asserted on THIS invocation.
    const rec = runNode(
      [TOOLS_PATH, 'state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'],
      { cwd: tmpDir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
    assert.ok(rec.exitCode === 0, `state record-session failed: ${rec.stderr}`);

    assert.ok(
      /v1\.0/.test(rec.stderr || ''),
      `#3354: expected a stderr warning naming the unbounded milestone token 'v1.0', got stderr=${JSON.stringify(rec.stderr)}`,
    );

    const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
    assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
    const out = JSON.parse(jsonResult.output);

    assert.strictEqual(
      Number(out.progress.total_phases),
      25,
      `#3354: total_phases must preserve the stored 25, not clobber to the on-disk dir count of 4. Got ${out.progress && out.progress.total_phases}`,
    );
    assert.ok(
      !(out.progress && ('percent' in out.progress)),
      `#3354: percent must stay withheld for an unbounded milestone (existing #1761 guard); got progress=${JSON.stringify(out.progress)}`,
    );
  });

  test('#3354 with nothing stored, the key is omitted rather than written from the dir count', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), buildSectionedRoadmap());
    // No progress block in frontmatter, no "Total Phases" body annotation —
    // nothing stored to preserve, so the key must be OMITTED (never 4).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0',
        'milestone_name: Unbounded',
        'current_phase: "01"',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '## Current Position',
        '',
        '**Current Phase:** 01',
        '**Status:** Executing',
        '',
      ].join('\n'),
    );
    seedPhaseDirs(tmpDir, [1, 2, 3, 4]);

    const recordResult = runGsdTools(
      ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'],
      tmpDir,
    );
    assert.ok(recordResult.success, `state record-session failed: ${recordResult.error}`);

    const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
    assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
    const out = JSON.parse(jsonResult.output);

    assert.ok(
      !(out.progress && ('total_phases' in out.progress)),
      `#3354: with no stored total, the key must be omitted — never written from the dir count. Got progress=${JSON.stringify(out.progress)}`,
    );
  });
});

// #3573 — roadmap-absent sibling of the #3354 shape: when ROADMAP.md is
// absent/unreadable while STATE.md asserts a milestone, the #549 heading counter
// never runs (roadmapScope === null) and every state.* write persisted the on-disk
// phase-directory count as progress.total_phases — counting only phases that have
// STARTED, quietly defeating #549's single-source-of-truth (5 → 1 in the issue's
// report). The stored frontmatter total must win, with a stderr warning.
describe('#3573 total_phases — roadmap absent with an asserted milestone', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { TOOLS_PATH, TEST_ENV_BASE } = require('./helpers.cjs');

  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Read the PERSISTED progress.total_phases straight out of STATE.md (the corruption is a file write, not a read derivation). */
  function persistedTotalPhases(dir) {
    const raw = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
    const m = raw.match(/^\s{2}total_phases:\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : null;
  }

  function recordSession(dir, stoppedAt = 'Phase 1, Plan 1') {
    return runNode(
      [TOOLS_PATH, 'state', 'record-session', '--stopped-at', stoppedAt, '--resume-file', 'none'],
      { cwd: dir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
  }

  test('#3573: roadmap-absent write keeps the stored total_phases instead of the phase-directory count', () => {
    // No ROADMAP.md at all — the issue's "scoping fails" endpoint. STATE asserts
    // milestone v1.0 with a stored total of 5; one phase directory exists.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', totalPhases: 5 }),
    );
    seedPhaseDirs(tmpDir, [1]);

    const rec = recordSession(tmpDir);
    assert.ok(rec.exitCode === 0, `state record-session failed: ${rec.stderr}`);
    assert.match(
      rec.stderr || '',
      /\(#3573\)/,
      `a stderr warning must name the roadmap-absent condition; got stderr=${JSON.stringify(rec.stderr)}`,
    );
    assert.strictEqual(
      persistedTotalPhases(tmpDir),
      5,
      `total_phases must stay at the stored 5, not the phase-directory count of 1`,
    );
  });

  test('#3573: begin-phase write keeps the stored total_phases (second issue-named verb)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', totalPhases: 5, currentPhase: '02' }),
    );
    seedPhaseDirs(tmpDir, [1]);

    // ADR-3473 §8.4 / #3358: a bare positional phase ("state begin-phase 2")
    // is now a rejected, undeclared token — see
    // tests/state.test.cjs positionalPlannedPhaseLeavesStateMdUntouched_3358,
    // the sibling regression for "planned-phase" that locks in exactly this
    // rejection. Use the documented "--phase N" flag form (see
    // CLI-TOOLS.md line 116 in the docs directory) instead; this test's own
    // assertions were never about the bare-positional shape itself, only
    // about total_phases surviving the resync.
    const rec = runNode(
      [TOOLS_PATH, 'state', 'begin-phase', '--phase', '2'],
      { cwd: tmpDir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
    assert.ok(rec.exitCode === 0, `state begin-phase failed: ${rec.stderr}`);
    assert.strictEqual(
      persistedTotalPhases(tmpDir),
      5,
      `total_phases must stay at the stored 5 across begin-phase's frontmatter resync`,
    );
  });

  test('#3573: no milestone asserted + roadmap absent keeps the directory count (fresh-project doctrine)', () => {
    // The #3354 doctrine: with nothing declared anywhere else, the disk count is
    // the only source and stays authoritative. A milestone-less STATE must keep
    // deriving total_phases from the directories — stored 5, dirs 2, expect 2,
    // so the row DISCRIMINATES: a withhold that fires without the milestone
    // gate would leave 5 and fail here (mutation-kill guard).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'none', totalPhases: 5 }).replace(/^milestone: none$/m, ''),
    );
    seedPhaseDirs(tmpDir, [1, 2]);

    const rec = recordSession(tmpDir);
    assert.ok(rec.exitCode === 0, `state record-session failed: ${rec.stderr}`);
    assert.strictEqual(
      persistedTotalPhases(tmpDir),
      2,
      `without an asserted milestone, the directory count (2) remains the source — not the stored 5`,
    );
  });

  test('#3573: state json read surface agrees with the persisted file (write/read parity)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', totalPhases: 5 }),
    );
    seedPhaseDirs(tmpDir, [1]);

    const rec = recordSession(tmpDir);
    assert.ok(rec.exitCode === 0, `state record-session failed: ${rec.stderr}`);

    const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
    assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
    const out = JSON.parse(jsonResult.output);
    assert.strictEqual(
      Number(out.progress && out.progress.total_phases),
      5,
      `#3573 read parity: state json must report the preserved stored 5, not the dir count of 1. Got ${out.progress && out.progress.total_phases}`,
    );
  });

  test('#3573: planned-phase write keeps the stored total_phases (third issue-named verb)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', totalPhases: 5, currentPhase: '02' }),
    );
    seedPhaseDirs(tmpDir, [1]);

    // ADR-3473 §8.4 / #3358: a bare positional phase ("state planned-phase 2")
    // is now a rejected, undeclared token — see
    // tests/state.test.cjs positionalPlannedPhaseLeavesStateMdUntouched_3358,
    // the regression test that locks in exactly this rejection for this same
    // subcommand. Use the documented "--phase N" flag form (see
    // COMMANDS.md line 2192 in the docs directory) instead; this test's own
    // assertions were never about the bare-positional shape itself, only
    // about total_phases surviving the resync.
    const rec = runNode(
      [TOOLS_PATH, 'state', 'planned-phase', '--phase', '2', '--name', 'Core'],
      { cwd: tmpDir, env: { ...process.env, ...TEST_ENV_BASE }, timeoutMs: 60000 },
    );
    assert.ok(rec.exitCode === 0, `state planned-phase failed: ${rec.stderr}`);
    assert.strictEqual(
      persistedTotalPhases(tmpDir),
      5,
      `total_phases must stay at the stored 5 across planned-phase's frontmatter resync`,
    );
  });

  test('#3573 (control): roadmap-present scoped write derives from headings, unchanged', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Milestone v1.0', '', ...[1, 2, 3, 4, 5].map((i) => `### Phase ${i}: p${i}`), ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      buildStateMd({ milestone: 'v1.0', totalPhases: 5 }),
    );
    seedPhaseDirs(tmpDir, [1]);

    const rec = recordSession(tmpDir);
    assert.ok(rec.exitCode === 0, `state record-session failed: ${rec.stderr}`);
    assert.strictEqual(
      persistedTotalPhases(tmpDir),
      5,
      `scoped roadmap keeps the heading-derived total of 5`,
    );
  });
});
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// #3642: hasMilestoneSectioning's >=2 threshold let a single non-matching
// milestone section's phases leak into an unrelated asserted milestone's
// total_phases. Fix: the >=1 sibling (hasAnyMilestoneSection) governs the
// unbounded branch's flat test, so the single-section shape takes the #3354
// withhold (stored value preserved + warning) instead of substituting the
// whole-document count. Controls pin what must NOT change.
// Matrix: .gsd/bug/fix-3642-milestone-sectioning-leak/50-test-matrix.md
// ─────────────────────────────────────────────────────────────────────────────

describe('#3642 — single-section leak controls and seam pins', () => {
  const { test, beforeEach, afterEach } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('fs');
  const path = require('path');
  const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

  // Compact local builders (this file's sections are deliberately
  // self-contained; the #3204 suite's identical builders live in its own
  // scope).
  function seedDirs(tmpDir, nums) {
    for (const n of nums) {
      const padded = String(n).padStart(2, '0');
      const dir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan\n');
    }
  }

  function stateMd({ milestone, totalPhases }) {
    return [
      '---',
      'gsd_state_version: 1.0',
      `milestone: ${milestone}`,
      'milestone_name: M',
      'current_phase: "01"',
      'status: executing',
      'progress:',
      `  total_phases: ${totalPhases}`,
      '  completed_phases: 0',
      '  total_plans: 0',
      '  completed_plans: 0',
      '  percent: 0',
      '---',
      '',
      '# GSD State',
      '',
      '## Current Position',
      '',
      '**Current Phase:** 01',
      '**Status:** Executing',
      '',
    ].join('\n');
  }

  function writeTotalAfterRecord(tmpDir) {
    const recordResult = runGsdTools(
      ['state', 'record-session', '--stopped-at', 'Phase 1, Plan 1', '--resume-file', 'none'],
      tmpDir,
    );
    assert.ok(recordResult.success, `state record-session failed: ${recordResult.error}`);
    const jsonResult = runGsdTools(['state', 'json', '--raw'], tmpDir);
    assert.ok(jsonResult.success, `state json --raw failed: ${jsonResult.error}`);
    return Number(JSON.parse(jsonResult.output).progress.total_phases);
  }

  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3642-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('control: a single section that MATCHES the assert keeps its own count', () => {
    // Bounded arm unchanged: asserted v2.0 IS bound to the one heading, so
    // the section's own count (4) is used — neither the stored (7) nor the
    // disk count (2).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap', '', '## v2.0', '## Phase 1: One', '## Phase 2: Two',
      '## Phase 3: Three', '## Phase 4: Four', '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd({ milestone: 'v2.0', totalPhases: 7 }));
    seedDirs(tmpDir, [1, 2]);
    assert.strictEqual(writeTotalAfterRecord(tmpDir), 4,
      'bounded single section keeps its own count (4)');
  });

  test('control: a FLAT roadmap with an unbounded assert keeps the roadmap count (#2828 doctrine)', () => {
    // Zero vocabulary headings → genuinely flat → the whole-document count
    // is correct (no milestone section exists to conflate with).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap', '', '## Phase 1: One', '## Phase 2: Two',
      '## Phase 3: Three', '## Phase 4: Four', '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateMd({ milestone: 'v9.9', totalPhases: 7 }));
    seedDirs(tmpDir, [1, 2]);
    assert.strictEqual(writeTotalAfterRecord(tmpDir), 4,
      'flat roadmap + unbounded assert keeps the roadmap count (4)');
  });

  test('seam pins: hasAnyMilestoneSection counts >=1; hasMilestoneSectioning stays >=2', () => {
    const roadmapParser = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'roadmap-parser.cjs'));
    assert.strictEqual(typeof roadmapParser.hasAnyMilestoneSection, 'function',
      'hasAnyMilestoneSection must be exported for buildStateFrontmatter (#3642)');
    const one = ['# Roadmap', '', '## v2.0', '## Phase 1: One'].join('\n');
    const two = ['# Roadmap', '', '## v1.0', '## Phase 1: One', '', '## v2.0', '## Phase 2: Two'].join('\n');
    const flat = ['# Roadmap', '', '## Phase 1: One'].join('\n');
    assert.strictEqual(roadmapParser.hasAnyMilestoneSection(one), true, 'one signal heading is a section');
    assert.strictEqual(roadmapParser.hasAnyMilestoneSection(two), true, 'two signal headings is a section');
    assert.strictEqual(roadmapParser.hasAnyMilestoneSection(flat), false, 'zero signal headings is flat');
    assert.strictEqual(roadmapParser.hasMilestoneSectioning(one), false, '>=2 predicate unchanged: one heading is NOT sectioning');
    assert.strictEqual(roadmapParser.hasMilestoneSectioning(two), true, '>=2 predicate unchanged: two headings is sectioning');
  });
});

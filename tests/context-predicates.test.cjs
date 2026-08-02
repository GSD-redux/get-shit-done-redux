'use strict';

/**
 * Unit tests for src/context-predicates.cts (compiled to
 * gsd-core/bin/lib/context-predicates.cjs) — the CONTEXT.md predicate
 * fact-store parser/validator/selector (ADR-1671, #2928 Phase 1).
 *
 * FAILING-FIRST: this file targets the REQUIRED production behavior from
 * .gsd/phase/chore-2928-context-predicate-store/40-design.md's behavior
 * table, not today's prototype-carried-forward behavior. Eight row-groups
 * are measured, provable defects in the current implementation and MUST be
 * RED until a later commit fixes them: A4, A5, A6, A7 (indented-bare / `*` /
 * `+` / numbered-list declaration forms are dropped), B2 (tilde fence not
 * skipped), B3 (4-backtick fence containing a 3-backtick line mis-toggles),
 * B5 (multi-line HTML comment not skipped).
 *
 * Fixture provenance (CONTRIBUTING.md #2371): the must-NOT-parse corpus
 * (rows A8-A11, negative space, I4) is drawn from real repo documents that
 * predate/ignore this grammar — the real CONTEXT.md and the real
 * CONTRIBUTING.md — never hand-authored from the grammar spec itself.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parsePredicates,
  selectPredicates,
  buildIndex,
} = require('../gsd-core/bin/lib/context-predicates.cjs');

const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.resolve(__dirname, '..');
const CRLF = '\r\n';

// ─── A. Declaration recognition ───────────────────────────────────────────

describe('parsePredicates: declaration recognition (A)', () => {
  test('parsesBareBacktickDeclaration', () => {
    const r = parsePredicates('`FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.deepEqual(
      { id: r.predicates[0].id, klass: r.predicates[0].klass, value: r.predicates[0].value },
      { id: 'FOO', klass: 'FOO', value: 'bar' },
    );
  });

  test('parsesDashListItemDeclaration', () => {
    const r = parsePredicates('- `FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesIndentedDashListItemDeclaration', () => {
    const r = parsePredicates('  - `FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesIndentedBareDeclaration', () => {
    // RED (measured defect): the prototype's bare-form check requires column
    // 0 (`line.startsWith('`')` on a line whose only trim is trimEnd()), so
    // leading whitespace with no list marker is silently dropped today.
    const r = parsePredicates('  `FOO=bar`');
    assert.equal(r.predicates.length, 1, 'indented bare declaration must be tolerated (Postel honored on shape)');
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesStarListItemDeclaration', () => {
    // RED (measured defect): today's list-item stripper only recognizes `-`.
    const r = parsePredicates('* `FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesPlusListItemDeclaration', () => {
    // RED (measured defect): same as `*`, `+` is not recognized today.
    const r = parsePredicates('+ `FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesNumberedListItemDeclaration', () => {
    // RED (measured defect): numbered list markers are not recognized today.
    const r = parsePredicates('1. `FOO=bar`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('ignoresInlineReferenceInsideProse', () => {
    const r = parsePredicates('see `FOO=bar` for details');
    assert.equal(r.predicates.length, 0, 'an inline mid-prose mention is a reference, not a declaration');
  });

  test('ignoresPredicateShapeInTableCell', () => {
    const r = parsePredicates('| x | `FOO=bar` |');
    assert.equal(r.predicates.length, 0);
  });

  test('ignoresPredicateShapeInHeading', () => {
    const md = ['# `FOO=bar`', '`REAL.one=value`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 1, 'the heading itself must never yield a predicate');
    assert.equal(r.predicates[0].id, 'REAL.one');
    assert.equal(r.predicates[0].section, '`FOO=bar`', 'the heading text (predicate-shaped or not) becomes the tracked section');
  });

  test('ignoresPredicateShapeInBlockquote', () => {
    const r = parsePredicates('> `FOO=bar`');
    assert.equal(r.predicates.length, 0);
  });

  test('tracksNearestPrecedingSectionHeading', () => {
    const md = ['# My Section', '`FOO=bar`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].section, 'My Section');
  });
});

// ─── B. Fenced / commented regions ────────────────────────────────────────

describe('parsePredicates: fenced/commented regions (B)', () => {
  test('ignoresDeclarationInsideBacktickFence', () => {
    const md = ['```', '`FOO=bar`', '```'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0);
  });

  test('ignoresDeclarationInsideTildeFence', () => {
    // RED (measured defect): the naive toggle only matches triple-backtick lines.
    const md = ['~~~', '`FOO=bar`', '~~~'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'a tilde fence must skip its contents exactly like a backtick fence');
  });

  test('ignoresDeclarationInsideLongerFenceContainingShorterFence', () => {
    // RED (measured defect): a naive backtick-count-agnostic toggle mis-flips
    // on the inner 3-backtick line and un-skips the remainder.
    const md = ['````', '```', '`FOO=bar`', '```', '````'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'fence-length awareness must prevent the inner fence from un-skipping the outer one');
  });

  test('ignoresDeclarationInsideLanguageTaggedFence', () => {
    const md = ['```bash', '`FOO=bar`', '```'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0);
  });

  test('ignoresDeclarationInsideMultiLineHtmlComment', () => {
    // RED (measured defect): the prototype has no HTML-comment awareness at
    // all — a predicate-shaped line between `<!--` and `-->` on its own line
    // parses as live today.
    const md = ['<!--', '`FOO=bar`', '-->'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'a commented-out predicate must not be read as live');
  });

  test('ignoresDeclarationInsideSingleLineHtmlComment', () => {
    const r = parsePredicates('<!-- `FOO=bar` -->');
    assert.equal(r.predicates.length, 0);
  });

  test('treatsUnclosedFenceAsSkippedToEndOfFile', () => {
    const md = ['```', '`FOO=bar`', '`BAZ=qux`'].join('\n');
    assert.doesNotThrow(() => parsePredicates(md));
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'everything after an unclosed fence must be treated as skipped, not crash or leak');
  });

  test('parsesDeclarationInFourSpaceIndentedBlockAsDocumentedLimit', () => {
    // Pins the documented limit (design known-limit 1): 4-space indentation
    // is NOT treated as a code block, because CONTEXT.md authors real
    // predicates as indented list items at that depth.
    const r = parsePredicates('    - `FOO=bar`');
    assert.equal(r.predicates.length, 1, 'documented limit: 4-space indent is not code, so this must still parse');
    assert.equal(r.predicates[0].id, 'FOO');
  });
});

// ─── B2. Comment/fence mutual precedence
// (DEFECT.CONTEXT-PREDICATES-COMMENT-FENCE-BLIND — BLOCKER review finding) ──
//
// The HTML-comment scan and the fence scan previously ran as two
// INDEPENDENT passes: `scanFencedBlocks` is comment-blind, so a fence
// delimiter appearing INSIDE an HTML comment (with no later matching close
// in the file) was treated as a real *unterminated* fence — silently
// dropping every remaining predicate to EOF. This is invisible to `--check`
// because `--check` diffs against a baseline generated by the same
// corrupted parse. This suite locks the chosen precedence (module doc
// comment, `computeSkippedLineFlags`): the two constructs are scanned in one
// interleaved pass and mutually suppress each other's open/close detection
// while active.

describe('parsePredicates: comment/fence mutual precedence (B2)', () => {
  test('fenceDelimiterInsideCommentWithNoLaterFenceDoesNotSwallowRemainingFile', () => {
    // The exact BLOCKER repro: a fence delimiter inside an HTML comment, with
    // no later real fence anywhere in the document, must not be treated as
    // an unterminated fence — the later real predicate must still parse.
    const md = ['<!-- example:', '```', '-->', '`RULESET.REAL.PREDICATE=x`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 1, 'the fence delimiter inside the comment must not swallow the rest of the file');
    assert.equal(r.predicates[0].id, 'RULESET.REAL.PREDICATE');
  });

  test('fenceDelimiterInsideCommentWithLaterRealFenceStillBehavesCorrectly', () => {
    const md = [
      '<!-- example:',
      '```',
      '-->',
      '`BEFORE=1`',
      '```',
      '`INSIDE=2`',
      '```',
      '`AFTER=3`',
    ].join('\n');
    const r = parsePredicates(md);
    const ids = r.predicates.map((p) => p.id);
    assert.deepEqual(ids.sort(), ['AFTER', 'BEFORE'], 'the real fence after the comment must still skip its own content');
  });

  test('arrowInsideRealFencedBlockDoesNotTerminateAnythingAndFenceStillSkipsItsContent', () => {
    const md = ['```', '`INSIDE=1`', 'noise line with --> token', '```', '`AFTER=2`'].join('\n');
    const r = parsePredicates(md);
    const ids = r.predicates.map((p) => p.id);
    assert.deepEqual(ids, ['AFTER'], '--> inside real fence content must not open/close a comment; fence must still skip INSIDE');
  });

  test('commentOpenerInsideRealFencedBlockDoesNotOpenAComment', () => {
    const md = ['```', '<!-- looks like a comment opener, but this is fence content', '`INSIDE=1`', '```', '`AFTER=2`'].join(
      '\n',
    );
    const r = parsePredicates(md);
    const ids = r.predicates.map((p) => p.id);
    assert.deepEqual(ids, ['AFTER'], '<!-- inside real fence content must not open a comment that leaks past the fence close');
  });

  test('unterminatedCommentAtEofSkipsRemainingLinesWithoutCrashing', () => {
    const md = ['`BEFORE=1`', '<!-- unterminated', '`INSIDE=2`', '`ALSOINSIDE=3`'].join('\n');
    assert.doesNotThrow(() => parsePredicates(md));
    const r = parsePredicates(md);
    const ids = r.predicates.map((p) => p.id);
    assert.deepEqual(ids, ['BEFORE'], 'an unterminated comment must skip to EOF, not crash and not leak later predicates');
  });

  test('commentAndFenceTokensOnTheSameLineResolveWithoutInterference', () => {
    // A fence-opener line whose CommonMark info string happens to contain a
    // full inline HTML comment: the line still starts with backticks, not
    // `<!--`, so it opens a real fence (comment text is just info-string
    // trailing content) — the fence still closes and skips its own content.
    const infoStringMd = ['`BEFORE=1`', '``` <!-- note -->', '`INSIDE=2`', '```', '`AFTER=3`'].join('\n');
    const infoStringResult = parsePredicates(infoStringMd);
    assert.deepEqual(
      infoStringResult.predicates.map((p) => p.id).sort(),
      ['AFTER', 'BEFORE'],
      'a fence opener whose info string contains comment-like text must still open/close as a real fence',
    );

    // A self-closing single-line HTML comment whose content happens to
    // contain a fence-delimiter-shaped token: the line still starts with
    // `<!--`, so the whole line is comment content and the embedded
    // backticks never open a fence.
    const commentMd = ['`BEFORE=1`', '<!-- see ``` for an example -->', '`AFTER=2`'].join('\n');
    const commentResult = parsePredicates(commentMd);
    assert.deepEqual(
      commentResult.predicates.map((p) => p.id).sort(),
      ['AFTER', 'BEFORE'],
      'a single-line comment whose content contains fence-shaped text must not open a fence',
    );
  });
});

// ─── C. ID / value grammar boundaries ──────────────────────────────────────

describe('parsePredicates: ID/value grammar boundaries (C)', () => {
  test('rejectsBacktickContentAtLengthTwo', () => {
    // `A=` — backtick content length 2 (limit-1 of the `inner.length > 2` guard).
    const r = parsePredicates('`A=`');
    assert.equal(r.predicates.length, 0);
  });

  test('acceptsMinimalBacktickContentAtLengthThree', () => {
    // `A=1` — length 3 (limit).
    const r = parsePredicates('`A=1`');
    assert.equal(r.predicates.length, 1);
    assert.deepEqual({ id: r.predicates[0].id, value: r.predicates[0].value }, { id: 'A', value: '1' });
  });

  test('acceptsBacktickContentAboveMinimumLength', () => {
    // `A=12` — length 4 (limit+1).
    const r = parsePredicates('`A=12`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].value, '12');
  });

  test('rejectsEqualsSignAtIndexZero', () => {
    // `=value` — eqIdx 0 (limit-1 of the `eqIdx < 1` guard).
    const r = parsePredicates('`=value`');
    assert.equal(r.predicates.length, 0);
  });

  test('acceptsEqualsSignAtIndexOne', () => {
    // `A=value` — eqIdx 1 (limit).
    const r = parsePredicates('`A=value`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'A');
  });

  test('acceptsEqualsSignAboveIndexOne', () => {
    // `AB=value` — eqIdx 2 (limit+1).
    const r = parsePredicates('`AB=value`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'AB');
  });

  test('rejectsInlineCodeWithoutEqualsSign', () => {
    const r = parsePredicates('`ID`');
    assert.equal(r.predicates.length, 0);
    assert.equal(
      r.malformed.length,
      0,
      'ordinary inline code with no "=" at all is not a declaration attempt and must not be diagnosed',
    );
  });

  test('reportsEmptyValueAsMalformedRatherThanDroppingSilently', () => {
    const r = parsePredicates('`ID=`');
    assert.equal(r.predicates.length, 0);
    assert.equal(r.malformed.length, 1, 'an empty value must surface as a diagnostic, not vanish silently');
    assert.equal(r.malformed[0].reason, 'empty-value');
  });

  test('splitsOnFirstEqualsSignOnly', () => {
    const r = parsePredicates('`ID=a=b=c`');
    assert.equal(r.predicates.length, 1);
    assert.deepEqual({ id: r.predicates[0].id, value: r.predicates[0].value }, { id: 'ID', value: 'a=b=c' });
  });

  test('rejectsLowercaseLeadingIdentifier', () => {
    const r = parsePredicates('`foo.bar=x`');
    assert.equal(r.predicates.length, 0);
  });

  test('acceptsLowercaseSubSegments', () => {
    const r = parsePredicates('`PRED.k320.rule=x`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].klass, 'PRED');
  });

  test('acceptsHyphenatedClassSegment', () => {
    const r = parsePredicates('`RELEASE-NOTES.x=y`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].klass, 'RELEASE-NOTES');
  });

  test('rejectsWhitespaceInIdentifier', () => {
    const r = parsePredicates('`FOO BAR=x`');
    assert.equal(r.predicates.length, 0);
  });

  test('acceptsSingleSegmentIdentifier', () => {
    const r = parsePredicates('`FOO=x`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].klass, r.predicates[0].id);
  });

  test('preservesTrailingWhitespaceInValueVerbatim', () => {
    const r = parsePredicates('`ID=1 `');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].value, '1 ', 'trailing whitespace in the value must not be trimmed');
  });

  test('acceptsBacktickWithinValue', () => {
    const r = parsePredicates('`ID=a`b`');
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].value, 'a`b');
  });

  test('rejectsPathAndQueryCharactersInIdentifier', () => {
    const r = parsePredicates('`A/B?c=d`');
    assert.equal(r.predicates.length, 0);
  });

  test('rejectsDoubledDotEmptySegment', () => {
    // DEFECT.CONTEXT-PREDICATES-ID-REDOS (MAJOR review finding): the
    // structural id validator (isValidId) splits on '.' and rejects any
    // empty segment. This is a deliberate behavior CHANGE vs. the old
    // `ID_RE` regex, which accepted `A..b` because `.` was inside the
    // subsequent-segment character class. The real repo CONTEXT.md was
    // checked (`grep -nE '`[A-Z][A-Za-z0-9_.-]*\\.\\.[A-Za-z0-9_.-]*='
    // CONTEXT.md`) and contains ZERO ids with a doubled dot, so this is a
    // pure grammar-tightening with no behavior loss against real data —
    // pinned here so a future change cannot silently re-loosen it.
    const r = parsePredicates('`A..b=value`');
    assert.equal(r.predicates.length, 0, 'a doubled dot (empty segment) must be rejected, not silently accepted');
  });

  test('idGrammarValidationIsLinearTimeAgainstManyConsecutiveDots', () => {
    // DEFECT.CONTEXT-PREDICATES-ID-REDOS (MAJOR review finding): the old
    // `ID_RE`'s `(?:\.[A-Za-z0-9_.-]+)*` group was exponential in the number
    // of consecutive dots (measured: ~565ms for 40 dots). The structural
    // per-segment validator is linear. A generous wall-clock bound is used
    // only as a smoke check; the load-bearing assertion is that the result
    // is a clean rejection (an id-shaped line with 60 consecutive dots has
    // an empty segment at every step and must not parse).
    const dots = '.'.repeat(60);
    const md = `\`A${dots}x=value\``;
    const start = Date.now();
    const r = parsePredicates(md);
    const elapsedMs = Date.now() - start;
    assert.equal(r.predicates.length, 0, 'an id with 60 consecutive dots has empty segments and must cleanly reject');
    assert.ok(elapsedMs < 1000, `expected well under 1s (linear time), got ${elapsedMs}ms — possible ReDoS regression`);
  });
});

// ─── D. CRLF / newline fidelity ────────────────────────────────────────────

describe('parsePredicates: CRLF/newline fidelity (D)', () => {
  test('parsesBareDeclarationUnderCrlf', () => {
    const r = parsePredicates('`FOO=bar`' + CRLF);
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].id, 'FOO');
  });

  test('parsesListItemDeclarationUnderCrlf', () => {
    const r = parsePredicates('- `FOO=bar`' + CRLF);
    assert.equal(r.predicates.length, 1);
  });

  test('parsesIndentedListDeclarationUnderCrlf', () => {
    const r = parsePredicates('  - `FOO=bar`' + CRLF);
    assert.equal(r.predicates.length, 1);
  });

  test('skipsFencedDeclarationUnderCrlf', () => {
    const md = ['```', '`FOO=bar`', '```', ''].join(CRLF);
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0);
  });

  test('skipsBlockquoteDeclarationUnderCrlf', () => {
    const r = parsePredicates('> `FOO=bar`' + CRLF);
    assert.equal(r.predicates.length, 0);
  });

  test('tracksSectionAndLineNumbersUnderCrlf', () => {
    const md = ['# Section Name', '`FOO=bar`', ''].join(CRLF);
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 1);
    assert.equal(r.predicates[0].section, 'Section Name');
    assert.equal(r.predicates[0].line, 2);
  });

  test('parsesMixedLfAndCrlfDocument', () => {
    const md = '`FOO=bar`' + CRLF + '- `BAZ=qux`' + '\n';
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 2);
    assert.deepEqual(r.predicates.map((p) => p.id).sort(), ['BAZ', 'FOO']);
  });

  test('yieldsNoPredicatesForLoneCrDocumentAsDocumentedLimit', () => {
    // Pins the documented limit (design known-limit 2): lone-CR-only line
    // endings are unsupported; no `\r`-only file exists in this repo.
    const md = '`FOO=bar`\r`BAZ=qux`\r';
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0);
  });
});

// ─── E. Duplicate detection + validation ───────────────────────────────────

describe('parsePredicates: duplicate detection + validation (E)', () => {
  test('reportsDuplicateIdentifierWithDifferentValues', () => {
    const md = ['`FOO=a`', '`FOO=b`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 1);
    assert.deepEqual(r.duplicates[0], { id: 'FOO', count: 2 });
  });

  test('reportsDuplicateIdentifierEvenWhenValuesAreIdentical', () => {
    const md = ['`FOO=a`', '`FOO=a`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 1, 'identical-value duplicates must not be silently deduped');
    assert.deepEqual(r.duplicates[0], { id: 'FOO', count: 2 });
  });

  test('reportsDuplicateCountForThreeOccurrences', () => {
    const md = ['`FOO=a`', '`FOO=b`', '`FOO=c`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].count, 3);
  });

  test('reportsNoDuplicateForSingleOccurrence', () => {
    const r = parsePredicates('`FOO=a`');
    assert.equal(r.duplicates.length, 0);
  });

  test('doesNotCountFenceSkippedOccurrenceAsDuplicate', () => {
    const md = ['`FOO=a`', '```', '`FOO=b`', '```'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 0, 'a fence-skipped occurrence is not a declaration');
    assert.equal(r.predicates.length, 1);
  });

  test('doesNotCountCommentedOccurrenceAsDuplicate', () => {
    const md = ['`FOO=a`', '<!-- `FOO=b` -->'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.predicates.length, 1);
  });

  test('reportsMalformedAndDuplicateDiagnosticsTogether', () => {
    const md = ['`FOO=a`', '`FOO=b`', '`BAR=`'].join('\n');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 1, 'the duplicate path must not be suppressed by the malformed path');
    assert.equal(r.malformed.length, 1, 'the malformed path must not be suppressed by the duplicate path');
  });

  test('realContextMdHasNoDuplicateIdentifiers', () => {
    const md = fs.readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 0, 'the real CONTEXT.md must carry no duplicate predicate ids');
  });
});

// ─── E2. Malformed diagnostics — one distinct reason per rejection class ───

describe('parsePredicates: malformed diagnostics name the exact rejection reason (E2)', () => {
  test('reportsEmptySegmentForDoubledDot', () => {
    const r = parsePredicates('`A..b=1`');
    assert.equal(r.predicates.length, 0);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].reason, 'empty-segment');
  });

  test('reportsInvalidIdCharsForSpaceInId', () => {
    const r = parsePredicates('`FOO BAR=1`');
    assert.equal(r.predicates.length, 0);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].reason, 'invalid-id-chars');
  });

  test('reportsLowercaseLeadingClassForLowercaseFirstSegment', () => {
    const r = parsePredicates('`foo.bar=1`');
    assert.equal(r.predicates.length, 0);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].reason, 'lowercase-leading-class');
  });

  test('reportsValueContainsNewlineForEmbeddedCr', () => {
    // A lone embedded CR inside an otherwise well-formed, LF-terminated
    // backtick line (distinct from the documented lone-CR-only-line limit
    // pinned by yieldsNoPredicatesForLoneCrDocumentAsDocumentedLimit above,
    // which never reaches a closing backtick at all).
    const md = '`ID=ab\rcd`\n';
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'a value with an embedded CR must be rejected, not silently accepted');
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].reason, 'value-contains-newline');
  });

  test('idCheckTakesPrecedenceOverEmptyValueWhenBothFail', () => {
    // `foo.bar=` fails BOTH the id (lowercase-leading) and the value (empty)
    // checks — id validity is checked first per detectMalformed's documented
    // precedence.
    const r = parsePredicates('`foo.bar=`');
    assert.equal(r.predicates.length, 0);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.malformed[0].reason, 'lowercase-leading-class');
  });
});

// ─── I. Independence + real-corpus regression ──────────────────────────────

describe('parsePredicates: independence + real-corpus regression (I)', () => {
  test('parserHasNoCrossTestSharedState', () => {
    // Run in an order that would surface a leaking module-level cache: parse
    // a document with a duplicate, then a clean document, then re-parse the
    // first — results must be identical each time, regardless of call order.
    const dupMd = ['`FOO=a`', '`FOO=b`'].join('\n');
    const cleanMd = '`BAR=x`';

    const firstPass = parsePredicates(dupMd);
    const cleanPass = parsePredicates(cleanMd);
    const secondPass = parsePredicates(dupMd);

    assert.equal(cleanPass.duplicates.length, 0, 'a clean parse must never see the previous call\'s duplicate');
    assert.deepEqual(secondPass.duplicates, firstPass.duplicates, 'repeating the same input must repeat the same result');
    assert.equal(secondPass.predicates.length, firstPass.predicates.length);
  });

  test('realContributingMdYieldsNoPredicates', () => {
    // Fixture provenance (#2371): CONTRIBUTING.md contains
    // `GITHUB_BASE_REF=next …` (inside a blockquote) and
    // `export GSD_BLOCKED_AUTHOR_REGEX='@example-corp\.com$'` (inside a
    // fenced bash block) — uppercase, `=`-bearing, backtick-adjacent text
    // authored by someone who never heard of this grammar.
    const md = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    const r = parsePredicates(md);
    assert.equal(r.predicates.length, 0, 'a document that never heard of the grammar must yield zero predicates');
  });

  test('realContextMdParsesFullPredicateSet', () => {
    const md = fs.readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8');
    const r = parsePredicates(md);
    assert.equal(r.duplicates.length, 0);
    assert.ok(r.predicates.length > 0, 'the real CONTEXT.md must yield a non-empty predicate set');
    const classes = new Set(r.predicates.map((p) => p.klass));
    assert.ok(classes.size >= 20, `expected >= 20 classes in the live predicate set, got ${classes.size}`);
  });
});

// ─── selectPredicates / buildIndex smoke coverage (not in the row matrix,
// but exercised here since they are pure, no-I/O functions covered by unit
// tests per the risk table — the CLI/query surfaces are covered separately). ───

describe('selectPredicates + buildIndex: pure-function smoke coverage', () => {
  test('selectPredicates filters by klass/prefix/contains independently', () => {
    const r = parsePredicates(['`FOO.a=hello world`', '`FOO.b=other`', '`BAR.a=hello`'].join('\n'));
    const byKlass = selectPredicates(r.predicates, { klass: 'FOO' });
    assert.equal(byKlass.length, 2);
    const byPrefix = selectPredicates(r.predicates, { prefix: 'FOO.a' });
    assert.equal(byPrefix.length, 1);
    const byContains = selectPredicates(r.predicates, { contains: 'hello' });
    assert.equal(byContains.length, 2);
  });

  test('buildIndex omits the line field from every entry (S5)', () => {
    const r = parsePredicates('`FOO=bar`');
    const index = buildIndex(r.predicates);
    assert.equal(index.predicates.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(index.predicates[0], 'line'));
  });
});

// ─── Parity: fenced-line determination vs markdown-sectionizer.scanFencedBlocks
// (DEFECT.GENERATIVE-FIX) ───────────────────────────────────────────────────
//
// context-predicates.cts derives its fenced-line skip flags from
// markdown-sectionizer.cts's exported `scanFencedBlocks` seam rather than
// carrying its own copy of the fence state machine. This suite asserts that
// parsePredicates' observable skip/keep decision for every ID-marker line
// agrees with what `scanFencedBlocks` independently reports for that same
// `lines` array, across the fence-shape table below — so a future change to
// the shared scanner cannot silently diverge from predicate parsing.

describe('parsePredicates: fence-skip parity with markdown-sectionizer.scanFencedBlocks', () => {
  const BARE_ID_RE = /^`([A-Za-z][A-Za-z0-9._-]*)=/;

  function assertFenceParity(name, lines) {
    test(name, () => {
      const md = lines.join('\n');
      const blocks = scanFencedBlocks(lines);
      const expectedSkip = new Array(lines.length).fill(false);
      for (const block of blocks) {
        const end = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
        for (let i = block.openLineIdx; i <= end; i++) expectedSkip[i] = true;
      }

      const r = parsePredicates(md);
      const parsedIds = new Set(r.predicates.map((p) => p.id));

      let sawMarker = false;
      for (let i = 0; i < lines.length; i++) {
        const m = BARE_ID_RE.exec(lines[i].trim());
        if (!m) continue;
        sawMarker = true;
        const id = m[1];
        if (expectedSkip[i]) {
          assert.ok(
            !parsedIds.has(id),
            `${name}: line ${i} (${id}) is inside a scanFencedBlocks fence and must not be parsed as live`,
          );
        } else {
          assert.ok(
            parsedIds.has(id),
            `${name}: line ${i} (${id}) is outside any scanFencedBlocks fence and must be parsed as live`,
          );
        }
      }
      assert.ok(sawMarker, `${name}: fixture must contain at least one ID marker line`);
    });
  }

  assertFenceParity('3-backtick fence', ['`BEFORE=1`', '```', '`INSIDE=2`', '```', '`AFTER=3`']);

  assertFenceParity('3-tilde fence', ['`BEFORE=1`', '~~~', '`INSIDE=2`', '~~~', '`AFTER=3`']);

  assertFenceParity('4-backtick fence containing a nested 3-backtick fence', [
    '`BEFORE=1`',
    '````',
    '```',
    '`INSIDE=2`',
    '```',
    '````',
    '`AFTER=3`',
  ]);

  assertFenceParity('language-tagged fence', [
    '`BEFORE=1`',
    '```bash',
    '`INSIDE=2`',
    '```',
    '`AFTER=3`',
  ]);

  assertFenceParity('info string containing a backtick is not a valid opener', [
    '`BEFORE=1`',
    '``` `evil` ',
    '`STILL=2`',
    '```',
    '`INSIDE=3`',
    '```',
    '`AFTER=4`',
  ]);

  assertFenceParity('indented (<=3 space) fence', [
    '`BEFORE=1`',
    '   ```',
    '`INSIDE=2`',
    '   ```',
    '`AFTER=3`',
  ]);

  assertFenceParity('unterminated fence skips to end of file', [
    '`BEFORE=1`',
    '```',
    '`INSIDE=2`',
    '`ALSOINSIDE=3`',
  ]);
});

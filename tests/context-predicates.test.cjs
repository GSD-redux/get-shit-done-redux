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

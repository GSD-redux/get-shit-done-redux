'use strict';

/**
 * Behavioral tests for markdown-sectionizer.cjs
 *
 * Module: gsd-core/bin/lib/markdown-sectionizer.cjs
 * Exports: stripFencedCode, stripInlineCode, extractFencedBlock, tokenizeHeadings,
 *          collectSections, collectSection, iterateBullets, updateBullet,
 *          extractTaggedBlocks, stripTaggedBlocks, replaceSection, withSection,
 *          deleteSection
 *
 * Covers the parser QA matrix from CONTRIBUTING.md §'Parser and project-file inputs':
 *   - LF vs CRLF line endings
 *   - Unicode headings
 *   - Heading INSIDE a fenced block (must be ignored)
 *   - Unterminated fence (unterminatedFence === true)
 *   - Nested heading levels with level-bounded stop
 *   - All three bullet markers (dash/checkbox/numbered) + indented continuation lines
 *   - Empty/whitespace/non-string input
 *
 * Includes fast-check property tests: stripFencedCode idempotence invariant,
 * and withSection's ADR-2143 §4 bounded-mutation guarantee (an edit confined to
 * one section cannot alter any other section, even with a greedy regex).
 * The parity guard for the T0-era tracked duplication (stripFencedCode vs
 * uat-predicate _stripFencedBlocks) was removed in T5: uat-predicate now imports
 * the seam directly, so the guard would compare the seam to itself.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  stripFencedCode,
  extractFencedBlock,
  scanFencedBlocks,
  tokenizeHeadings,
  collectSections,
  collectSection,
  iterateBullets,
  updateBullet,
  extractTaggedBlocks,
  stripTaggedBlocks,
  replaceSection,
  withSection,
  deleteSection,
  stripInlineCode,
  scanInlineCodeSpans,
} = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

// ─── stripInlineCode (#2365) ──────────────────────────────────────────────────

describe('stripInlineCode', () => {
  test('removes a single-backtick inline span, delimiters included', () => {
    assert.strictEqual(stripInlineCode('Verify the `api` helper'), 'Verify the   helper');
  });

  test('removes a double-backtick span (CommonMark same-length closer)', () => {
    assert.strictEqual(stripInlineCode('see ``a `nested` tick`` here'), 'see   here');
  });

  test('an unmatched backtick run is left as literal text', () => {
    assert.strictEqual(stripInlineCode('a ` stray backtick'), 'a ` stray backtick');
  });

  test('a longer closing run does not close a shorter opener (CommonMark §6.1)', () => {
    // `x`` — no run of exactly 1 backtick follows, so nothing is stripped.
    assert.strictEqual(stripInlineCode('a `x`` b'), 'a `x`` b');
  });

  test('multiple spans on one line are all removed', () => {
    assert.strictEqual(stripInlineCode('`a` and `b` remain not'), '  and   remain not');
  });

  test('spans do not cross line boundaries', () => {
    assert.strictEqual(stripInlineCode('open `here\nstill` open'), 'open `here\nstill` open');
  });

  test('non-string / empty input degrades to empty string without throwing', () => {
    assert.strictEqual(stripInlineCode(undefined), '');
    assert.strictEqual(stripInlineCode(null), '');
    assert.strictEqual(stripInlineCode(''), '');
  });

  test('text without backticks is returned unchanged', () => {
    const s = 'plain prose, no code spans at all';
    assert.strictEqual(stripInlineCode(s), s);
  });
});

describe('scanInlineCodeSpans', () => {
  test('returns spans covering the delimiters with inner content', () => {
    const spans = scanInlineCodeSpans('use `api` and ``x``');
    assert.deepStrictEqual(spans, [
      { start: 4, end: 9, content: 'api' },
      { start: 14, end: 19, content: 'x' },
    ]);
  });

  test('offsets are into the full multi-line string; spans never cross lines', () => {
    const spans = scanInlineCodeSpans('a `x`\nno `span\nhere');
    assert.deepStrictEqual(spans, [{ start: 2, end: 5, content: 'x' }]);
  });

  test('non-string / empty input yields no spans', () => {
    assert.deepStrictEqual(scanInlineCodeSpans(undefined), []);
    assert.deepStrictEqual(scanInlineCodeSpans(''), []);
  });
});

// ─── stripFencedCode ──────────────────────────────────────────────────────────

describe('stripFencedCode', () => {
  test('returns empty text and no unterminatedFence on empty input', () => {
    const r = stripFencedCode('');
    assert.equal(r.text, '');
    assert.equal(r.unterminatedFence, false);
  });

  test('non-string input returns empty result', () => {
    // Safety: callers may pass non-strings; must not throw
    for (const bad of [null, undefined, 42, [], {}]) {
      const r = stripFencedCode(bad);
      assert.equal(r.text, '');
      assert.equal(r.unterminatedFence, false);
    }
  });

  test('content with no fences is returned unchanged', () => {
    const src = '## Heading\n\nSome text.\n\n- bullet';
    const r = stripFencedCode(src);
    assert.equal(r.text, src);
    assert.equal(r.unterminatedFence, false);
  });

  test('removes a backtick fenced block (LF)', () => {
    const src = [
      'before',
      '```js',
      'const x = 1;',
      '```',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'before\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('removes a tilde fenced block', () => {
    const src = [
      'before',
      '~~~',
      'some code',
      '~~~',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'before\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('handles CRLF line endings correctly', () => {
    const src = 'before\r\n```\r\ncode\r\n```\r\nafter';
    const r = stripFencedCode(src);
    assert.ok(r.text.includes('before'));
    assert.ok(r.text.includes('after'));
    assert.ok(!r.text.includes('code'), 'code inside fence should be stripped');
    assert.equal(r.unterminatedFence, false);
  });

  test('unterminatedFence is true when fence is not closed', () => {
    const src = 'before\n```\nsome code without closing fence';
    const r = stripFencedCode(src);
    assert.equal(r.unterminatedFence, true);
    assert.ok(!r.text.includes('some code'), 'fence body should be stripped even if unterminated');
  });

  test('tilde inside backtick fence is treated as content, not a closer', () => {
    const src = [
      '```',
      '~~~',
      'still inside',
      '```',
      'outside',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'outside');
    assert.equal(r.unterminatedFence, false);
  });

  test('backtick inside tilde fence is treated as content, not a closer', () => {
    const src = [
      '~~~',
      '```',
      'still inside',
      '~~~',
      'outside',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'outside');
    assert.equal(r.unterminatedFence, false);
  });

  test('closing fence must be same-char and same-or-longer run', () => {
    // A `` ``` `` opener cannot be closed by ```` ```` ``; a 4-backtick closer is valid.
    const src = [
      'text',
      '```',
      'body',
      '`````',   // longer run of same char — valid closer per CommonMark
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'text\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('closing fence must have no trailing non-whitespace text', () => {
    // ``` js (info string) is only valid on OPENING lines; a line like "``` extra"
    // inside a fence is content, not a closer.
    const src = [
      '```',
      '``` still inside (has trailing text)',
      '```',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'after');
    assert.equal(r.unterminatedFence, false);
  });

  test('multiple successive fenced blocks are all stripped', () => {
    const src = [
      'a',
      '```',
      'code1',
      '```',
      'b',
      '```',
      'code2',
      '```',
      'c',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'a\nb\nc');
    assert.equal(r.unterminatedFence, false);
  });
});

// ─── extractFencedBlock ───────────────────────────────────────────────────────

describe('extractFencedBlock', () => {
  test('returns null for empty/non-string content', () => {
    assert.equal(extractFencedBlock('', 'coverage'), null);
    assert.equal(extractFencedBlock(null, 'coverage'), null);
    assert.equal(extractFencedBlock(undefined, 'coverage'), null);
  });

  test('returns null when infoString is non-string', () => {
    assert.equal(extractFencedBlock('```coverage\nbody\n```', null), null);
    assert.equal(extractFencedBlock('```coverage\nbody\n```', undefined), null);
  });

  test('extracts inner body of a ```coverage block', () => {
    const src = [
      'prose before',
      '```coverage',
      '[{"capability":"search","decision":"INTEGRATE","reason":""}]',
      '```',
      'prose after',
    ].join('\n');
    const result = extractFencedBlock(src, 'coverage');
    assert.equal(result, '[{"capability":"search","decision":"INTEGRATE","reason":""}]');
  });

  test('is case-insensitive on the info string', () => {
    const src = '```Coverage\ninner text\n```';
    assert.equal(extractFencedBlock(src, 'coverage'), 'inner text');
    assert.equal(extractFencedBlock(src, 'COVERAGE'), 'inner text');
  });

  test('ignores a ```json block when searching for coverage', () => {
    const src = '```json\n{"a":1}\n```';
    assert.equal(extractFencedBlock(src, 'coverage'), null);
  });

  test('returns null when no fence is present at all', () => {
    const src = 'just prose, no fences here.\n## Heading\n- bullet';
    assert.equal(extractFencedBlock(src, 'coverage'), null);
  });

  test('returns null when the named fence is present but unterminated (EOF inside fence)', () => {
    const src = '```coverage\nunterminated body, no closing fence';
    assert.equal(extractFencedBlock(src, 'coverage'), null);
  });

  test('handles ~~~ fences', () => {
    const src = '~~~coverage\ntilde-fenced body\n~~~';
    assert.equal(extractFencedBlock(src, 'coverage'), 'tilde-fenced body');
  });

  test('an info string with trailing text after the target word does NOT match (exact-equality, not prefix)', () => {
    const src = '```coverage extra-stuff\nbody\n```';
    assert.equal(extractFencedBlock(src, 'coverage'), null, 'the trimmed info string is "coverage extra-stuff", not "coverage"');
  });

  test('trailing whitespace on the opening info-string line is trimmed before comparison', () => {
    const src = '```coverage   \nbody\n```';
    assert.equal(extractFencedBlock(src, 'coverage'), 'body');
  });

  test('a fence nested inside another (longer-delimiter, differently-named) fence is not mis-extracted', () => {
    // CommonMark same-char fences only truly nest when the OUTER delimiter run
    // is longer (a bare 3-backtick closer would prematurely close a 3-backtick
    // outer fence too — there's no other way for a backtick fence to contain
    // another backtick fence). Outer uses 4 backticks, inner uses 3, so the
    // inner ```coverage ... ``` pair is entirely CONTENT of the outer fence
    // and never becomes its own open/close block — searching for 'coverage'
    // must find nothing, not the outer block's body.
    const src = [
      '````outer',
      '```coverage',
      'nested body',
      '```',
      '````',
    ].join('\n');
    assert.equal(extractFencedBlock(src, 'coverage'), null, 'nested ```coverage must not be mis-extracted as a top-level match');
    assert.equal(
      extractFencedBlock(src, 'outer'),
      '```coverage\nnested body\n```',
      'the OUTER block is the one real fence and contains the nested lines (including their literal ``` markers) as raw content',
    );
  });

  test('returns the FIRST matching block when multiple ```coverage blocks are present', () => {
    const src = [
      '```coverage',
      'first',
      '```',
      'prose',
      '```coverage',
      'second',
      '```',
    ].join('\n');
    assert.equal(extractFencedBlock(src, 'coverage'), 'first');
  });

  test('an empty fence body returns an empty string, not null', () => {
    const src = '```coverage\n\n```';
    assert.equal(extractFencedBlock(src, 'coverage'), '');
  });
});

// ─── scanFencedBlocks (public export) ─────────────────────────────────────────
// #2928: `export` was newly added to this function and its `FencedBlockRecord`
// interface, making it public API for the first time (context-predicates.cts
// consumes it directly). Hyrum's Law: a newly-public contract needs its own
// lock-in test, independent of the consumer that motivated exporting it.

describe('scanFencedBlocks (public export)', () => {
  test('is actually exported from the compiled module as a function', () => {
    assert.equal(typeof scanFencedBlocks, 'function');
  });

  test('returns {char, len, infoString, openLineIdx, closeLineIdx} with 0-based line indices', () => {
    const lines = [
      'before',
      '```js',
      'const x = 1;',
      '```',
      'after',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], {
      char: '`',
      len: 3,
      infoString: 'js',
      openLineIdx: 1,
      closeLineIdx: 3,
    });
  });

  test('closeLineIdx is -1 for an unterminated fence (EOF while open)', () => {
    const lines = [
      'before',
      '```',
      'body, never closed',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].openLineIdx, 1);
    assert.equal(blocks[0].closeLineIdx, -1);
  });

  test('requires >=3 backticks or >=3 tildes to open a fence', () => {
    assert.deepEqual(scanFencedBlocks(['``', 'not a fence']), []);
    assert.deepEqual(scanFencedBlocks(['~~', 'not a fence']), []);
    const backtickBlocks = scanFencedBlocks(['```', 'x', '```']);
    assert.equal(backtickBlocks.length, 1);
    assert.equal(backtickBlocks[0].char, '`');
    const tildeBlocks = scanFencedBlocks(['~~~', 'x', '~~~']);
    assert.equal(tildeBlocks.length, 1);
    assert.equal(tildeBlocks[0].char, '~');
  });

  test('tolerates up to 3 spaces of indent on the opening delimiter', () => {
    const blocks = scanFencedBlocks(['   ```', 'body', '```']);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].openLineIdx, 0);
    assert.equal(blocks[0].closeLineIdx, 2);
  });

  test('4+ spaces of indent is not recognised as a fence delimiter', () => {
    const blocks = scanFencedBlocks(['    ```', 'still not a fence']);
    assert.deepEqual(blocks, []);
  });

  test('a closer must be the same delimiter char with run length >= the opener, and no trailing text', () => {
    // Same char, longer run: valid closer.
    const longerCloser = scanFencedBlocks(['```', 'body', '`````']);
    assert.equal(longerCloser.length, 1);
    assert.equal(longerCloser[0].closeLineIdx, 2);

    // Same char, shorter run: not a valid closer -> content, fence stays open (EOF -> -1).
    const shorterCloser = scanFencedBlocks(['````', 'body', '```']);
    assert.equal(shorterCloser.length, 1);
    assert.equal(shorterCloser[0].closeLineIdx, -1);
  });

  test('mismatched delimiter char while a fence is open is CONTENT, not a boundary — a 3-backtick line inside a 4-backtick fence does not close it', () => {
    const lines = [
      '````outer',
      '```coverage',
      'nested body',
      '```',
      '````',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 1, 'only the outer 4-backtick fence is a real block');
    assert.equal(blocks[0].char, '`');
    assert.equal(blocks[0].len, 4);
    assert.equal(blocks[0].openLineIdx, 0);
    assert.equal(blocks[0].closeLineIdx, 4);
  });

  test('a same-char run that is too short, encountered while open, is content not a closer', () => {
    const lines = [
      '````',
      '```',
      'still inside',
      '````',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].openLineIdx, 0);
    assert.equal(blocks[0].closeLineIdx, 3);
  });

  test('a same-char, sufficient-length run carrying trailing non-whitespace text, encountered while open, is content not a closer', () => {
    const lines = [
      '```',
      '``` still inside (has trailing text)',
      '```',
      'after',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].openLineIdx, 0);
    assert.equal(blocks[0].closeLineIdx, 2);
  });

  test('CommonMark §4.5: a backtick fence info string must not contain a backtick — such a line is not a valid opener', () => {
    const blocks = scanFencedBlocks(['``` has ` a backtick', 'more text']);
    assert.deepEqual(blocks, [], 'a backtick in the info string means the line is not a valid opener at all');
  });

  test('infoString is the trimmed trailing text of the opener', () => {
    const blocks = scanFencedBlocks(['```   js and stuff   ', 'body', '```']);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].infoString, 'js and stuff');
  });

  test('multiple sequential blocks in one document are all returned, in order', () => {
    const lines = [
      'a',
      '```',
      'code1',
      '```',
      'b',
      '~~~py',
      'code2',
      '~~~',
      'c',
    ];
    const blocks = scanFencedBlocks(lines);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].char, '`');
    assert.equal(blocks[0].openLineIdx, 1);
    assert.equal(blocks[0].closeLineIdx, 3);
    assert.equal(blocks[1].char, '~');
    assert.equal(blocks[1].infoString, 'py');
    assert.equal(blocks[1].openLineIdx, 5);
    assert.equal(blocks[1].closeLineIdx, 7);
  });
});

// ─── tokenizeHeadings ─────────────────────────────────────────────────────────

describe('tokenizeHeadings', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(tokenizeHeadings(''), []);
    assert.deepEqual(tokenizeHeadings(null), []);
    assert.deepEqual(tokenizeHeadings(undefined), []);
  });

  test('extracts ATX headings in document order', () => {
    const src = '# H1\n## H2\n### H3\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0].level, 1);
    assert.equal(tokens[0].text, 'H1');
    assert.equal(tokens[1].level, 2);
    assert.equal(tokens[1].text, 'H2');
    assert.equal(tokens[2].level, 3);
    assert.equal(tokens[2].text, 'H3');
  });

  test('headings inside fenced blocks are ignored', () => {
    const src = [
      '# Real heading',
      '```',
      '## Fake heading inside fence',
      '```',
      '## Another real heading',
    ].join('\n');
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'Real heading');
    assert.equal(tokens[1].text, 'Another real heading');
  });

  test('supports Unicode heading text', () => {
    const src = '## Résumé — Überblick\n### 日本語見出し\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'Résumé — Überblick');
    assert.equal(tokens[1].text, '日本語見出し');
  });

  test('records correct 1-based line number', () => {
    const src = 'prose\n## Heading\nmore';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].line, 2);
  });

  test('records non-negative byte offset', () => {
    const src = 'prose\n## Heading\n';
    const tokens = tokenizeHeadings(src);
    assert.ok(tokens[0].offset >= 0);
    // The offset should point somewhere inside the heading line
    assert.ok(tokens[0].offset < src.length);
  });

  test('handles CRLF headings', () => {
    const src = '# H1\r\n## H2\r\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'H1');
    assert.equal(tokens[1].text, 'H2');
  });

  test('ignores setext-style headings (only ATX supported)', () => {
    // Setext (underline) headings are NOT in scope for this seam
    const src = 'Title\n=====\n\nSubtitle\n--------\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 0);
  });
});

// ─── collectSections ─────────────────────────────────────────────────────────

describe('collectSections', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(collectSections('', () => true), []);
    assert.deepEqual(collectSections(null, () => true), []);
  });

  test('collects all headings when predicate is always-true', () => {
    const src = '## A\nBody A\n## B\nBody B\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading.text, 'A');
    assert.ok(sections[0].body.includes('Body A'));
    assert.equal(sections[1].heading.text, 'B');
    assert.ok(sections[1].body.includes('Body B'));
  });

  test('collects only headings matching predicate; non-matching headings end section', () => {
    // When the predicate matches Section A but not Section B, Section B acts as
    // a body line inside Section A (it is not a stop boundary), so its *heading*
    // text appears in the body. However Section B's *content* also appears.
    // If we want to stop at any heading regardless of the predicate, callers
    // should use levelBounded collectSection instead.
    //
    // To test filtering: use a predicate that matches both headings, then verify
    // two sections are returned with the correct split.
    const src = '## Section A\nContent A\n## Section B\nContent B\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading.text, 'Section A');
    assert.ok(sections[0].body.includes('Content A'));
    assert.ok(!sections[0].body.includes('Content B'), 'Content B must not appear in Section A body');
    assert.equal(sections[1].heading.text, 'Section B');
    assert.ok(sections[1].body.includes('Content B'));
  });

  test('stopPredicate controls which headings open sections; non-matching headings appear as body text', () => {
    // When predicate matches only Section A, Section B is not a stop boundary
    // so it (and its content) is included in Section A's body.
    const src = '## Section A\nContent A\n## Section B\nContent B\n';
    const sections = collectSections(src, (h) => h.text.includes('A'));
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading.text, 'Section A');
    assert.ok(sections[0].body.includes('Content A'));
    // Section B heading line and Content B are inside Section A's body
    assert.ok(sections[0].body.includes('Section B'));
    assert.ok(sections[0].body.includes('Content B'));
  });

  test('last section body runs to EOF', () => {
    const src = '## Only\nBody line 1\nBody line 2';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 1);
    assert.ok(sections[0].body.includes('Body line 1'));
    assert.ok(sections[0].body.includes('Body line 2'));
  });

  test('adjacent headings produce empty bodies', () => {
    const src = '## A\n## B\n## C\nContent C\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].body.trim(), '');
    assert.equal(sections[1].body.trim(), '');
    assert.ok(sections[2].body.includes('Content C'));
  });
});

// ─── collectSection ───────────────────────────────────────────────────────────

describe('collectSection', () => {
  test('returns null when no heading matches', () => {
    const src = '## Foo\ntext\n';
    const result = collectSection(src, (h) => h.text === 'Bar');
    assert.equal(result, null);
  });

  test('returns null for empty/non-string input', () => {
    assert.equal(collectSection('', () => true), null);
    assert.equal(collectSection(null, () => true), null);
  });

  test('collects section body up to next same-level heading (levelBounded default)', () => {
    const src = [
      '## Section A',
      'Content A',
      '## Section B',
      'Content B',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Section A');
    assert.ok(result !== null);
    assert.ok(result.body.includes('Content A'));
    assert.ok(!result.body.includes('Content B'));
  });

  test('levelBounded: true — sub-headings are included in body, not stops', () => {
    const src = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Parent', { levelBounded: true });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Parent intro'));
    assert.ok(result.body.includes('Child'), 'child heading line should be in body');
    assert.ok(result.body.includes('Child body'));
    assert.ok(!result.body.includes('Sibling body'), 'sibling body should NOT be included');
  });

  test('levelBounded: false — stops at any following heading', () => {
    const src = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Parent', { levelBounded: false });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Parent intro'));
    assert.ok(!result.body.includes('Child body'), 'with levelBounded:false, child heading stops section');
  });

  test('stripFences: true — strips fenced blocks from body', () => {
    const src = [
      '## Section',
      '```',
      'code here',
      '```',
      'prose here',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Section', { stripFences: true });
    assert.ok(result !== null);
    assert.ok(!result.body.includes('code here'), 'fenced code should be stripped');
    assert.ok(result.body.includes('prose here'));
  });

  test('heading token in result matches the matched heading', () => {
    const src = '## My Section\nContent\n';
    const result = collectSection(src, (h) => h.text === 'My Section');
    assert.ok(result !== null);
    assert.equal(result.heading.text, 'My Section');
    assert.equal(result.heading.level, 2);
  });

  test('nested heading level: H3 section stops at next H3 or higher', () => {
    const src = [
      '### Alpha',
      'Alpha body',
      '#### Sub-Alpha',
      'Sub-Alpha body',
      '### Beta',
      'Beta body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Alpha', { levelBounded: true });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Alpha body'));
    assert.ok(result.body.includes('Sub-Alpha'));
    assert.ok(!result.body.includes('Beta body'));
  });

  test('section at EOF has body to end of string', () => {
    const src = '## Only\nLast line';
    const result = collectSection(src, (h) => h.text === 'Only');
    assert.ok(result !== null);
    assert.ok(result.body.includes('Last line'));
  });
});

// ─── iterateBullets ───────────────────────────────────────────────────────────

describe('iterateBullets', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(iterateBullets(''), []);
    assert.deepEqual(iterateBullets(null), []);
    assert.deepEqual(iterateBullets(undefined), []);
    assert.deepEqual(iterateBullets('   '), []);
  });

  test('parses dash bullets', () => {
    const src = '- First\n- Second\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].marker, 'dash');
    assert.equal(items[0].text, 'First');
    assert.equal(items[0].checked, null);
    assert.equal(items[1].text, 'Second');
  });

  test('parses asterisk and plus bullets as dash marker', () => {
    const src = '* Asterisk\n+ Plus\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].marker, 'dash');
    assert.equal(items[0].text, 'Asterisk');
    assert.equal(items[1].marker, 'dash');
    assert.equal(items[1].text, 'Plus');
  });

  test('parses unchecked checkbox bullets', () => {
    const src = '- [ ] Todo item\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-unchecked');
    assert.equal(items[0].checked, false);
    assert.equal(items[0].text, 'Todo item');
  });

  test('parses checked checkbox bullets (lowercase x)', () => {
    const src = '- [x] Done item\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-checked');
    assert.equal(items[0].checked, true);
    assert.equal(items[0].text, 'Done item');
  });

  test('parses checked checkbox bullets (uppercase X)', () => {
    const src = '- [X] Done uppercase\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-checked');
    assert.equal(items[0].checked, true);
  });

  test('parses numbered bullets', () => {
    const src = '1. First\n2. Second\n42. Forty-two\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 3);
    assert.equal(items[0].marker, 'numbered');
    assert.equal(items[0].text, 'First');
    assert.equal(items[0].checked, null);
    assert.equal(items[2].text, 'Forty-two');
  });

  test('accumulates indented continuation lines into bullet text', () => {
    const src = [
      '- Main bullet',
      '  continuation line',
      '  another continuation',
      '- Next bullet',
    ].join('\n');
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.ok(items[0].text.includes('Main bullet'));
    assert.ok(items[0].text.includes('continuation line'));
    assert.ok(items[0].text.includes('another continuation'));
    assert.equal(items[1].text, 'Next bullet');
  });

  test('blank line terminates current bullet', () => {
    const src = '- First\n\n- Second\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'First');
    assert.equal(items[1].text, 'Second');
  });

  test('mixed marker types in sequence', () => {
    const src = [
      '1. Numbered',
      '- [x] Checked',
      '- [ ] Unchecked',
      '- Plain dash',
    ].join('\n');
    const items = iterateBullets(src);
    assert.equal(items.length, 4);
    assert.equal(items[0].marker, 'numbered');
    assert.equal(items[1].marker, 'checkbox-checked');
    assert.equal(items[2].marker, 'checkbox-unchecked');
    assert.equal(items[3].marker, 'dash');
  });

  test('CRLF input is handled correctly', () => {
    const src = '- First\r\n- Second\r\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'First');
    assert.equal(items[1].text, 'Second');
  });

  test('indent field captures leading whitespace of bullet opener', () => {
    const src = '  - Indented bullet\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].indent, '  ');
  });

  test('non-bullet lines before any bullet are ignored', () => {
    const src = 'Some prose\n\n- Bullet\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'Bullet');
  });
});

// ─── updateBullet ─────────────────────────────────────────────────────────────

describe('updateBullet', () => {
  test('non-string / empty content is returned unchanged', () => {
    assert.equal(updateBullet(null, () => true, (l) => l), null);
    assert.equal(updateBullet(undefined, () => true, (l) => l), undefined);
    assert.equal(updateBullet('', () => true, (l) => l), '');
  });

  test('no-match is a no-op — content is returned unchanged', () => {
    const content = '- [ ] Phase 1: Foo\n- [ ] Phase 2: Bar\n';
    const result = updateBullet(content, (text) => text.includes('Phase 9'), (l) => `${l} EDITED`);
    assert.equal(result, content);
  });

  test('flips only the matched bullet; every other bullet/line is byte-identical', () => {
    const content = [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Foundation',
      '- [ ] Phase 2: API',
      '- [ ] Phase 3: Polish',
      '',
    ].join('\n');

    const result = updateBullet(
      content,
      (bulletText) => bulletText.includes('Phase 2'),
      (rawLine) => `${rawLine.replace('[ ]', '[x]')} (completed 2026-01-01)`,
    );

    assert.equal(
      result,
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Foundation',
        '- [x] Phase 2: API (completed 2026-01-01)',
        '- [ ] Phase 3: Polish',
        '',
      ].join('\n'),
    );
  });

  test('bulletText passed to match has the marker/checkbox stripped; rawLine is the untouched physical line', () => {
    const content = '- [ ] Phase 1: Foo\n';
    let seenText;
    let seenRaw;
    updateBullet(
      content,
      (bulletText, rawLine) => {
        seenText = bulletText;
        seenRaw = rawLine;
        return true;
      },
      (rawLine) => rawLine,
    );
    assert.equal(seenText, 'Phase 1: Foo');
    assert.equal(seenRaw, '- [ ] Phase 1: Foo');
  });

  test('recognises dash and numbered bullets too, not only checkboxes', () => {
    const dashContent = '- Alpha\n- Beta\n';
    const dashResult = updateBullet(dashContent, (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(dashResult, '- Alpha\n- Beta!\n');

    const numberedContent = '1. Alpha\n2. Beta\n';
    const numberedResult = updateBullet(numberedContent, (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(numberedResult, '1. Alpha\n2. Beta!\n');
  });

  test('ignores a matching bullet inside a fenced code block — the real bullet outside the fence is flipped', () => {
    const content = [
      '- [ ] Phase 1: Foo',
      '```md',
      '- [ ] Phase 1: Foo (inside fence, must not match)',
      '```',
      '- [ ] Phase 2: Bar',
      '',
    ].join('\n');

    const result = updateBullet(
      content,
      (bulletText) => bulletText.includes('Phase 1'),
      (rawLine) => rawLine.replace('[ ]', '[x]'),
    );

    assert.equal(
      result,
      [
        '- [x] Phase 1: Foo',
        '```md',
        '- [ ] Phase 1: Foo (inside fence, must not match)',
        '```',
        '- [ ] Phase 2: Bar',
        '',
      ].join('\n'),
    );
  });

  test('a matching bullet that exists ONLY inside a fenced code block is a genuine no-op', () => {
    const content = [
      '```md',
      '- [ ] Phase 9: OnlyInFence',
      '```',
      '- [ ] Phase 1: Foo',
      '',
    ].join('\n');

    const result = updateBullet(
      content,
      (bulletText) => bulletText.includes('Phase 9'),
      (rawLine) => rawLine.replace('[ ]', '[x]'),
    );

    assert.equal(result, content, 'the only matching bullet lives inside the fence — no-op');
  });

  test('CRLF line endings are preserved — only the matched line changes; others keep \\r\\n untouched', () => {
    const content = '- [ ] Phase 1: Foo\r\n- [ ] Phase 2: Bar\r\n';
    const result = updateBullet(
      content,
      (bulletText) => bulletText.includes('Phase 2'),
      (rawLine) => rawLine.replace('[ ]', '[x]'),
    );
    assert.equal(result, '- [ ] Phase 1: Foo\r\n- [x] Phase 2: Bar\r\n');
  });

  test('transform returning a non-string is a bounded no-op', () => {
    const content = '- [ ] Phase 1: Foo\n';
    const result = updateBullet(content, () => true, () => undefined);
    assert.equal(result, content);
  });

  test('only the FIRST matching bullet is replaced, even when a later bullet also matches', () => {
    const content = '- [ ] Phase 1: Foo\n- [ ] Phase 1: Foo (duplicate)\n';
    const result = updateBullet(
      content,
      (bulletText) => bulletText.startsWith('Phase 1'),
      (rawLine) => rawLine.replace('[ ]', '[x]'),
    );
    assert.equal(result, '- [x] Phase 1: Foo\n- [ ] Phase 1: Foo (duplicate)\n');
  });

  test('preserves the indentation of the matched bullet line', () => {
    const content = '  - [ ] Nested: Item\n';
    const result = updateBullet(content, (t) => t.includes('Nested'), (l) => l.replace('[ ]', '[x]'));
    assert.equal(result, '  - [x] Nested: Item\n');
  });

  // GFM/CommonMark tolerates more than one space between a list marker and
  // its content — a checkboxRe pinned to exactly one space fails to recognise
  // `-  [ ] …` (two spaces) as a CHECKBOX at all; it instead falls through to
  // the generic dash-bullet shape, leaking the literal `[ ] ` marker into
  // bulletText (` [ ] Phase 1: Foo` instead of the clean `Phase 1: Foo`) —
  // silently wrong for any caller whose `match`/`transform` assumes bulletText
  // has the checkbox marker stripped.
  test('recognises a multi-space marker (`-  [ ]`, two spaces) as a proper checkbox bullet — bulletText has the marker cleanly stripped', () => {
    const content = '-  [ ] Phase 1: Foo\n';
    let seenBulletText;
    const result = updateBullet(
      content,
      (bulletText) => {
        seenBulletText = bulletText;
        return bulletText.includes('Phase 1');
      },
      (rawLine) => `${rawLine.replace('[ ]', '[x]')} (completed 2026-01-01)`,
    );
    assert.equal(seenBulletText, 'Phase 1: Foo', 'bulletText must be cleanly stripped of the checkbox marker, not leak it in as dash-bullet text');
    assert.equal(result, '-  [x] Phase 1: Foo (completed 2026-01-01)\n');
  });

  test('recognises a multi-space dash/numbered marker too (not only checkboxes)', () => {
    const dashResult = updateBullet('-   Alpha\n-   Beta\n', (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(dashResult, '-   Alpha\n-   Beta!\n');

    const numberedResult = updateBullet('1.   Alpha\n2.   Beta\n', (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(numberedResult, '1.   Alpha\n2.   Beta!\n');
  });

  test('#2245 F5: recognises a TAB-separated marker gap (`-\\t[ ]`), not only spaces', () => {
    // checkboxRe/dashRe/numberedRe used a literal-space `[ ]{1,4}` gap,
    // narrower than the OLD hand-rolled `-\s*\[` regex it replaced (`\s`
    // matches a tab too) — a `-\t[ ]` bullet was silently never offered to
    // `match`.
    const checkboxResult = updateBullet(
      '-\t[ ] Phase 1: Foo\n',
      (bulletText) => bulletText.includes('Phase 1'),
      (rawLine) => rawLine.replace('[ ]', '[x]'),
    );
    assert.equal(checkboxResult, '-\t[x] Phase 1: Foo\n');

    const dashResult = updateBullet('-\tAlpha\n-\tBeta\n', (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(dashResult, '-\tAlpha\n-\tBeta!\n');

    const numberedResult = updateBullet('1.\tAlpha\n2.\tBeta\n', (t) => t === 'Beta', (l) => `${l}!`);
    assert.equal(numberedResult, '1.\tAlpha\n2.\tBeta!\n');
  });

  test('property: flip/unflip round-trip restores the original document byte-for-byte, and every non-target line stays untouched', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            labels: fc.array(
              fc.string({ minLength: 1, maxLength: 20 }).filter(
                (s) => !/[\r\n]/.test(s) && s.trim().length > 0 && !s.includes('EDITED'),
              ),
              { minLength: n, maxLength: n },
            ),
            targetIdx: fc.integer({ min: 0, max: n - 1 }),
          }),
        ),
        ({ n, labels, targetIdx }) => {
          const lines = [];
          for (let k = 0; k < n; k++) {
            lines.push(`- [ ] Item ${k}: ${labels[k]}`);
          }
          const content = `${lines.join('\n')}\n`;

          const flipped = updateBullet(
            content,
            (bulletText) => bulletText.includes(`Item ${targetIdx}:`),
            (rawLine) => `${rawLine.replace('[ ]', '[x]')} EDITED`,
          );

          const flippedLines = flipped.split('\n');
          for (let k = 0; k < n; k++) {
            if (k === targetIdx) continue;
            assert.equal(flippedLines[k], lines[k], `line ${k} must stay byte-identical`);
          }
          assert.equal(flippedLines[targetIdx], `- [x] Item ${targetIdx}: ${labels[targetIdx]} EDITED`);

          const restored = updateBullet(
            flipped,
            (bulletText) => bulletText.includes(`Item ${targetIdx}:`),
            (rawLine) => rawLine.replace('[x]', '[ ]').replace(' EDITED', ''),
          );
          assert.equal(restored, content, 'round-trip must restore the original document byte-for-byte');
        },
      ),
    );
  });
});

// ─── Integration: heading inside fenced block is ignored end-to-end ───────────

describe('integration: fenced heading ignored', () => {
  test('collectSection ignores headings inside fenced blocks', () => {
    const src = [
      '## Real',
      'Real body',
      '```',
      '## Fake inside fence',
      '```',
      'More real body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Real');
    assert.ok(result !== null, 'should find the real heading');
    assert.ok(result.body.includes('More real body'), 'real body after fence should be included');
    // The section should not have ended at the fake heading
  });

  test('tokenizeHeadings ignores headings in CRLF fenced blocks', () => {
    const src = '# Outer\r\n```\r\n# Inner\r\n```\r\n## After\r\n';
    const tokens = tokenizeHeadings(src);
    const texts = tokens.map((t) => t.text);
    assert.ok(texts.includes('Outer'));
    assert.ok(texts.includes('After'));
    assert.ok(!texts.includes('Inner'), 'heading inside fence should be invisible');
  });
});

// ─── Property test: stripFencedCode idempotence ───────────────────────────────

describe('stripFencedCode: property-based tests', () => {
  test('property: never throws on any string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 500 }),
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 200 }),
          fc.constant(''),
          fc.constant('```\ncode\n```\n'),
          fc.constant('~~~\nunterminated'),
        ),
        (input) => {
          assert.doesNotThrow(
            () => stripFencedCode(input),
            `stripFencedCode threw on: ${JSON.stringify(input.slice(0, 80))}`,
          );
        },
      ),
    );
  });

  test('property: always returns { text: string, unterminatedFence: boolean }', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const result = stripFencedCode(input);
          assert.ok(typeof result === 'object' && result !== null, 'result must be object');
          assert.ok(typeof result.text === 'string', 'text must be string');
          assert.ok(typeof result.unterminatedFence === 'boolean', 'unterminatedFence must be boolean');
        },
      ),
    );
  });

  test('property: idempotence — stripping twice gives the same text as stripping once', () => {
    // A well-formed (terminated) fence: strip once gives fence-free text with no
    // remaining fences. Stripping again gives the same text.
    // For unterminated fences the text after first strip has no fence content but
    // the result is still idempotent — stripping a fence-free string is a no-op.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const once = stripFencedCode(input);
          const twice = stripFencedCode(once.text);
          assert.equal(
            twice.text,
            once.text,
            `Idempotence violated: input=${JSON.stringify(input.slice(0, 60))}`,
          );
          // After the first strip the text has no fences (or only unterminated remnants),
          // so the second pass must not report unterminated unless the first pass already did.
          // (The second pass cannot have MORE unterminatedFence; it can have less.)
          assert.ok(
            !twice.unterminatedFence || once.unterminatedFence,
            'Second pass may not introduce a new unterminatedFence not present in first pass',
          );
        },
      ),
    );
  });

  test('property: output text is always a substring or equal-length string of input', () => {
    // Stripping removes content, so output length <= input length
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const result = stripFencedCode(input);
          assert.ok(
            result.text.length <= input.length,
            `Output (${result.text.length}) must not be longer than input (${input.length})`,
          );
        },
      ),
    );
  });
});

// ─── extractTaggedBlocks ──────────────────────────────────────────────────────

describe('extractTaggedBlocks', () => {
  test('returns empty array for empty/non-string content', () => {
    assert.deepEqual(extractTaggedBlocks('', 'decisions'), []);
    assert.deepEqual(extractTaggedBlocks(null, 'decisions'), []);
    assert.deepEqual(extractTaggedBlocks(undefined, 'decisions'), []);
  });

  test('returns empty array when tag is empty/non-string', () => {
    assert.deepEqual(extractTaggedBlocks('<decisions>body</decisions>', ''), []);
    assert.deepEqual(extractTaggedBlocks('<decisions>body</decisions>', null), []);
  });

  test('returns empty array when tag is not present', () => {
    const content = 'Some prose without any matching block.\n## Heading\n- bullet';
    assert.deepEqual(extractTaggedBlocks(content, 'decisions'), []);
  });

  test('extracts inner text of a single block', () => {
    const content = 'before\n<decisions>\nD-01: Foo\n</decisions>\nafter';
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('D-01: Foo'), 'inner text should be returned');
  });

  test('extracts multiple blocks in document order', () => {
    const content = [
      '<decisions>',
      'D-01: First',
      '</decisions>',
      'some text',
      '<decisions>',
      'D-02: Second',
      '</decisions>',
    ].join('\n');
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('D-01: First'));
    assert.ok(result[1].includes('D-02: Second'));
  });

  test('preserves document order of multiple blocks', () => {
    const content = '<tag>alpha</tag> middle <tag>beta</tag> end <tag>gamma</tag>';
    const result = extractTaggedBlocks(content, 'tag');
    assert.deepEqual(result, ['alpha', 'beta', 'gamma']);
  });

  test('handles CRLF content inside a block', () => {
    const content = '<decisions>\r\nD-01: CRLF test\r\n</decisions>';
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('D-01: CRLF test'));
  });

  test('tag name that needs regex-escaping: dot in tag name is matched literally', () => {
    // A tag name with a dot (e.g. 'my.tag') must be matched literally, not as
    // a regex wildcard. So '<my.tag>' should match only the exact literal tag.
    const content = '<my.tag>inner</my.tag>';
    const result = extractTaggedBlocks(content, 'my.tag');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'inner');
    // Crucially, 'myXtag' (dot as wildcard) should NOT match the literal block
    const result2 = extractTaggedBlocks('<myXtag>other</myXtag>', 'my.tag');
    assert.equal(result2.length, 0, 'dot in tagName must be treated as literal, not wildcard');
  });

  test('tag name with + character is escaped and matched literally', () => {
    const content = '<my+tag>inner</my+tag>';
    const result = extractTaggedBlocks(content, 'my+tag');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'inner');
  });

  test('content with tag text appearing outside any block is not extracted', () => {
    // The tag appears as inline text, not as an XML block
    const _content = 'This is about <decisions> but no closing tag in same element sense\n\nNot a block.';
    // Actually we need to use content that has the opening tag on the same line as text
    // but no matching close tag — result should be empty or the inner text is everything after.
    // Since the regex is non-greedy, an unclosed tag won't match.
    const content2 = 'Text with <decisions> but tag is unclosed.';
    const result = extractTaggedBlocks(content2, 'decisions');
    assert.equal(result.length, 0, 'unclosed tag should not produce a match');
  });
});

// ─── replaceSection ───────────────────────────────────────────────────────────

describe('replaceSection', () => {
  test('replaces section body and preserves heading and surrounding sections', () => {
    const content = '## Intro\nIntro body.\n## Name\nOld name body.\n## Footer\nFooter body.\n';
    const section = collectSection(content, (h) => h.text === 'Name');
    assert.ok(section !== null, 'section must be found');
    const newContent = replaceSection(content, section, 'New name body.\n');
    assert.ok(newContent.includes('## Intro'), 'Intro heading preserved');
    assert.ok(newContent.includes('Intro body.'), 'Intro body preserved');
    assert.ok(newContent.includes('## Name'), 'Name heading preserved');
    assert.ok(newContent.includes('New name body.'), 'new body present');
    assert.ok(!newContent.includes('Old name body.'), 'old body removed');
    assert.ok(newContent.includes('## Footer'), 'Footer heading preserved');
    assert.ok(newContent.includes('Footer body.'), 'Footer body preserved');
  });

  test('replaces section body in a multi-section document', () => {
    const content = [
      '## Alpha',
      'Alpha content.',
      '## Beta',
      'Beta old content.',
      '## Gamma',
      'Gamma content.',
    ].join('\n') + '\n';
    const section = collectSection(content, (h) => h.text === 'Beta');
    assert.ok(section !== null);
    const updated = replaceSection(content, section, 'Beta new content.\n');
    assert.ok(updated.includes('Alpha content.'), 'Alpha preserved');
    assert.ok(updated.includes('Beta new content.'), 'Beta updated');
    assert.ok(!updated.includes('Beta old content.'), 'Beta old removed');
    assert.ok(updated.includes('Gamma content.'), 'Gamma preserved');
  });

  test('round-trip: collectSection → replaceSection with section.body → content unchanged', () => {
    // INVARIANT: content.slice(bodyStart, bodyEnd) === body
    // so replaceSection(content, section, section.body) must equal content exactly.
    const content = '## Section A\nLine one.\nLine two.\n## Section B\nB body.\n';
    const section = collectSection(content, (h) => h.text === 'Section A');
    assert.ok(section !== null);
    // Verify the slice invariant directly
    assert.equal(
      content.slice(section.bodyStart, section.bodyEnd),
      section.body,
      'content.slice(bodyStart, bodyEnd) must equal section.body (invariant)',
    );
    // True round-trip: supply section.body (not a re-sliced value)
    const roundTripped = replaceSection(content, section, section.body);
    assert.equal(roundTripped, content, 'round-trip must produce identical content');
  });

  test('CRLF content is handled without corruption', () => {
    const content = '## Title\r\nOld body.\r\n## Next\r\nNext body.\r\n';
    const section = collectSection(content, (h) => h.text === 'Title');
    assert.ok(section !== null);
    const updated = replaceSection(content, section, 'New body.\r\n');
    assert.ok(updated.includes('## Title\r\n'), 'heading with CRLF preserved');
    assert.ok(updated.includes('New body.'), 'new body present');
    assert.ok(!updated.includes('Old body.'), 'old body removed');
    assert.ok(updated.includes('## Next\r\n'), 'next section heading preserved');
    assert.ok(updated.includes('Next body.'), 'next section body preserved');
  });

  test('non-string arguments return content unchanged', () => {
    const content = '## Sec\nbody\n';
    const section = collectSection(content, (h) => h.text === 'Sec');
    assert.ok(section !== null);
    assert.equal(replaceSection(null, section, 'x'), null);
    assert.equal(replaceSection(content, section, null), content);
  });
});

// ─── FIX 1: Section offset invariant tests ────────────────────────────────────

describe('Section offset invariant: content.slice(bodyStart, bodyEnd) === body', () => {
  test('invariant holds for a mid-document section (LF, trailing newline)', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    const s = collectSection(content, (h) => h.text === 'A');
    assert.ok(s !== null);
    assert.equal(
      content.slice(s.bodyStart, s.bodyEnd),
      s.body,
      'invariant: content.slice(bodyStart, bodyEnd) === body',
    );
    assert.equal(
      replaceSection(content, s, s.body),
      content,
      'true round-trip with section.body must be identity',
    );
  });

  test('invariant holds at EOF with no trailing newline', () => {
    const content = '## Only\nLast line';
    const s = collectSection(content, (h) => h.text === 'Only');
    assert.ok(s !== null);
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'EOF no-trailing-newline invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'round-trip EOF no-trailing-newline');
  });

  test('invariant holds with CRLF line endings', () => {
    const content = '## Title\r\nBody line.\r\n## Next\r\nNext body.\r\n';
    const s = collectSection(content, (h) => h.text === 'Title');
    assert.ok(s !== null);
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'CRLF invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'CRLF round-trip');
  });

  test('invariant holds for an empty body (adjacent headings)', () => {
    const content = '## A\n## B\nB body\n';
    const s = collectSection(content, (h) => h.text === 'A');
    assert.ok(s !== null);
    assert.equal(s.body, '', 'empty body expected');
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'empty body invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'empty body round-trip');
  });

  test('collectSections: invariant holds for every returned section', () => {
    const content = '## Alpha\nAlpha body.\n## Beta\nBeta body.\n## Gamma\nGamma body\n';
    const sections = collectSections(content, () => true);
    assert.equal(sections.length, 3);
    for (const s of sections) {
      assert.equal(
        content.slice(s.bodyStart, s.bodyEnd),
        s.body,
        `collectSections invariant for section "${s.heading.text}"`,
      );
      assert.equal(
        replaceSection(content, s, s.body),
        content,
        `collectSections round-trip for section "${s.heading.text}"`,
      );
    }
  });
});

// ─── FIX 2: tokenizeHeadings CommonMark indented and empty headings ──────────

describe('tokenizeHeadings: CommonMark ≤3-space indent and empty headings', () => {
  test('1-space indent is a valid heading', () => {
    const src = ' # One space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 1);
    assert.equal(tokens[0].text, 'One space heading');
  });

  test('2-space indent is a valid heading', () => {
    const src = '  ## Two space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, 'Two space heading');
  });

  test('3-space indent is a valid heading', () => {
    const src = '   ### Three space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 3);
    assert.equal(tokens[0].text, 'Three space heading');
  });

  test('4-space indent is NOT a heading (indented code block per CommonMark)', () => {
    const src = '    ## Four space — not a heading\n## Real heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1, 'only the non-indented heading should be found');
    assert.equal(tokens[0].text, 'Real heading');
  });

  test('## with no following text is an empty heading (text === "")', () => {
    const src = '##\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, '');
  });

  test('##   (only whitespace after hashes) is an empty heading (text === "")', () => {
    const src = '##   \n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, '');
  });
});

// ─── FIX 3: collectSection stopAtLevel option ─────────────────────────────────

describe('collectSection: stopAtLevel option', () => {
  test('stopAtLevel:3 stops a ##-opened section at the following ###', () => {
    const src = [
      '## Parent',
      'Parent body',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const s = collectSection(src, (h) => h.text === 'Parent', { stopAtLevel: 3 });
    assert.ok(s !== null);
    assert.ok(s.body.includes('Parent body'), 'parent body included');
    assert.ok(!s.body.includes('Child body'), 'section should stop at ### with stopAtLevel:3');
    assert.ok(!s.body.includes('Sibling body'), 'sibling body not included');
  });

  test('default levelBounded:true does NOT stop a ##-opened section at ###', () => {
    const src = [
      '## Parent',
      'Parent body',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const s = collectSection(src, (h) => h.text === 'Parent', { levelBounded: true });
    assert.ok(s !== null);
    assert.ok(s.body.includes('Child body'), 'child body is inside the ## section with levelBounded');
    assert.ok(!s.body.includes('Sibling body'), 'sibling body not included');
  });

  test('stopAtLevel:2 stops at the next ## (same as levelBounded default for ## opener)', () => {
    const src = '## A\nA body\n## B\nB body\n';
    const s = collectSection(src, (h) => h.text === 'A', { stopAtLevel: 2 });
    assert.ok(s !== null);
    assert.ok(s.body.includes('A body'));
    assert.ok(!s.body.includes('B body'));
  });

  test('stopAtLevel round-trip invariant holds', () => {
    const src = '## Parent\nParent body\n### Child\nChild body\n## Sibling\nSibling body\n';
    const s = collectSection(src, (h) => h.text === 'Parent', { stopAtLevel: 3 });
    assert.ok(s !== null);
    assert.equal(src.slice(s.bodyStart, s.bodyEnd), s.body, 'offset invariant with stopAtLevel');
    assert.equal(replaceSection(src, s, s.body), src, 'round-trip with stopAtLevel');
  });
});

// ─── FIX 4: backtick fence — info string with backtick is not a fence opener ─

describe('stripFencedCode and tokenizeHeadings: backtick info string with backtick', () => {
  test('stripFencedCode: backtick in info string does not open a backtick fence', () => {
    // The line "``` ` info" has a backtick in the info string → NOT a fence opener.
    const src = '``` ` not-a-fence\n## Heading\n';
    const r = stripFencedCode(src);
    // Both lines should be kept (no fence was opened)
    assert.ok(r.text.includes('## Heading'), 'heading line must be kept since no fence opened');
    assert.ok(r.text.includes('``` ` not-a-fence'), 'the non-fence line must be kept');
    assert.equal(r.unterminatedFence, false, 'no fence was opened, so unterminated must be false');
  });

  test('tokenizeHeadings: heading after a backtick-in-info line is still tokenized', () => {
    // ``` ` info-with-backtick is NOT a fence opener, so ## Heading below it is visible.
    const src = '``` ` not-a-fence\n## Heading\nprose\n```\n';
    const tokens = tokenizeHeadings(src);
    assert.ok(tokens.some((t) => t.text === 'Heading'), '## Heading must be tokenized when "opener" has backtick in info');
  });

  test('tilde fence info string WITH backtick IS still a valid fence opener (tildes unaffected)', () => {
    // Only backtick fences have the "no backtick in info" restriction.
    const src = '~~~ ` this-is-fine\n## Inside tilde fence\n~~~\n## Outside\n';
    const tokens = tokenizeHeadings(src);
    // ## Inside tilde fence should be ignored (inside a real fence)
    assert.ok(!tokens.some((t) => t.text === 'Inside tilde fence'), 'tilde fence with backtick in info is still a valid fence');
    assert.ok(tokens.some((t) => t.text === 'Outside'), 'heading after tilde fence close is tokenized');
  });
});

// ─── FIX 6: extractTaggedBlocks — nested tag behavior ─────────────────────────

describe('extractTaggedBlocks: nested same-name tag behavior (#2128 stop-at-next-open)', () => {
  test('nested <x><x>inner</x></x> extracts the well-formed inner block', () => {
    // #2128: the ReDoS-safe body scan terminates at the NEXT opening <x>, so the
    // unterminated outer <x> is skipped and the inner block is extracted.
    const content = '<x><x>inner</x></x>';
    const result = extractTaggedBlocks(content, 'x');
    assert.equal(result.length, 1, 'exactly one result from nested input');
    assert.equal(result[0], 'inner', 'the well-formed inner block is extracted; the unterminated outer is skipped');
  });

  test('back-to-back blocks (not nested) are both extracted', () => {
    const content = '<x>first</x><x>second</x>';
    const result = extractTaggedBlocks(content, 'x');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'first');
    assert.equal(result[1], 'second');
  });

  test('#2128: a document full of unclosed <x> openings stays linear and yields no match', () => {
    const content = '<x>a\n'.repeat(50) + 'no closing tag';
    assert.deepEqual(extractTaggedBlocks(content, 'x'), [], 'no </x> anywhere -> no blocks');
  });

  test('#557 / #2128: attr-intolerant by default preserves <details open>; opt-in matches <task type=…>', () => {
    // stripTaggedBlocks(details) must PRESERVE <details open> (the active-milestone
    // marker) and strip only bare <details>; extractTaggedBlocks(task, true) must
    // match attributed tasks, and must NOT when allowAttributes is left false.
    assert.equal(
      stripTaggedBlocks('X<details>shipped</details>Y<details open>active</details>Z', 'details'),
      'XY<details open>active</details>Z',
      '#557: <details open> preserved; bare <details> stripped',
    );
    assert.deepEqual(extractTaggedBlocks('<task type="auto">body</task>', 'task', true), ['body'], 'attributed task matched with allowAttributes=true');
    assert.deepEqual(extractTaggedBlocks('<task type="auto">body</task>', 'task'), [], 'attributed task NOT matched with allowAttributes=false');
  });
});

// ─── withSection ───────────────────────────────────────────────────────────────

describe('withSection', () => {
  test('edits only the targeted section, leaving surrounding sections untouched', () => {
    const content = '## Intro\nIntro body.\n## Name\nOld name body.\n## Footer\nFooter body.\n';
    const result = withSection(content, 'Name', (body) => body.replace('Old name body.', 'New name body.'));
    assert.ok(result.includes('## Intro\nIntro body.'), 'Intro section preserved verbatim');
    assert.ok(result.includes('## Name\nNew name body.'), 'Name section updated');
    assert.ok(!result.includes('Old name body.'), 'old body removed');
    assert.ok(result.includes('## Footer\nFooter body.'), 'Footer section preserved verbatim');
  });

  test('a section not present in content leaves content unchanged (bounded no-op)', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    const result = withSection(content, 'Nonexistent', (body) => body + ' MUTATED');
    assert.equal(result, content, 'no matching heading -> content returned unchanged');
  });

  test('predicate form: target may be a HeadingToken predicate function', () => {
    const content = '## Alpha\nAlpha body\n## Beta\nBeta body\n';
    const result = withSection(content, (h) => h.level === 2 && h.text === 'Beta', (body) => body.toUpperCase());
    assert.ok(result.includes('## Beta\nBETA BODY'), 'predicate-matched section edited');
    assert.ok(result.includes('## Alpha\nAlpha body'), 'non-matched section untouched');
  });

  test('edit returning the identical body is a no-op (no splice performed)', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    const result = withSection(content, 'A', (body) => body);
    assert.equal(result, content, 'identical body -> no-op');
  });

  test('edit returning a non-string is a no-op (defensive)', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    // Deliberately malformed edit callback (returns a number, not a string).
    const result = withSection(content, 'A', () => 42);
    assert.equal(result, content, 'non-string return -> no-op');
  });

  test('non-string content is returned unchanged', () => {
    assert.equal(withSection(null, 'A', (b) => b + 'x'), null);
    assert.equal(withSection(undefined, 'A', (b) => b + 'x'), undefined);
  });

  test('ADR-2143 §4: a greedy regex inside the edit callback cannot cross a section boundary', () => {
    // Build a 3-section document; run a maximally-greedy regex (`[\s\S]*`) inside
    // the edit callback for section 2. The callback only ever sees section 2's
    // body, so sections 1 and 3 must remain byte-identical.
    const content = [
      '## Section One',
      'alpha content line 1',
      'alpha content line 2',
      '## Section Two',
      'beta content to be replaced',
      '## Section Three',
      'gamma content line 1',
      'gamma content line 2',
    ].join('\n') + '\n';

    const before = collectSection(content, (h) => h.text === 'Section One');
    const afterSectionThree = collectSection(content, (h) => h.text === 'Section Three');
    assert.ok(before !== null && afterSectionThree !== null);

    const result = withSection(content, 'Section Two', (body) => body.replace(/[\s\S]*/, 'REPLACED ENTIRELY'));

    const resultOne = collectSection(result, (h) => h.text === 'Section One');
    const resultThree = collectSection(result, (h) => h.text === 'Section Three');
    assert.equal(resultOne.body, before.body, 'Section One byte-identical after greedy edit on Section Two');
    assert.equal(resultThree.body, afterSectionThree.body, 'Section Three byte-identical after greedy edit on Section Two');
    assert.ok(result.includes('## Section Two\nREPLACED ENTIRELY'), 'Section Two was replaced as intended');
  });
});

describe('withSection: property-based tests', () => {
  // Anchored phase-heading predicate mirroring roadmap-parser.cjs's
  // withPhaseSection fix: the phase token must sit at the START of the
  // heading text, so a section whose TITLE merely mentions another phase
  // number is never matched by that other phase's query.
  const anchoredPhasePredicate = (k) => {
    const re = new RegExp(`^Phase\\s+${k}(?=[\\s:(]|$)`, 'i');
    return (h) => re.test(h.text);
  };

  test('property (ADR-2143 §4): editing phase k never alters any sibling section j≠k', () => {
    // Model a ROADMAP-like document with N `## Phase k` sections (k=1..N), each
    // with a distinct, generated body. Pick a random k, run withSection to append
    // ' EDITED' to that section's body, and assert every OTHER section (j≠k) is
    // byte-identical in the output — the bounded-mutation guarantee this seam
    // exists to provide (structurally retires the #2130/#2067/#2080 boundary-
    // crossing class).
    //
    // Also exercises Blocker 1 (title-collision hijack): each section's heading
    // TITLE may be decorated with a reference to a DIFFERENT phase number
    // (e.g. `Phase 3: legacy Phase 1 notes`), and the predicate above (anchored
    // to the start of the heading text) must still resolve to the section whose
    // OWN number matches, never a differently-numbered section whose title
    // happens to mention the queried number.
    //
    // Heading level is kept UNIFORM (`##`) across sections deliberately: mixing
    // random heading levels would make "which section is k" ambiguous for this
    // property (a shallower section can syntactically nest a deeper one) — see
    // the separate explicit mixed-level test below instead.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            bodies: fc.array(
              fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/[\r\n]/.test(s) && s.trim().length > 0),
              { minLength: n, maxLength: n },
            ),
            targetIdx: fc.integer({ min: 0, max: n - 1 }),
            // For each section, optionally reference a DIFFERENT phase number in
            // its own heading title (title-collision decoy). `undefined`/self
            // means "no decoy for this section".
            titleDecoys: fc.array(
              fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
              { minLength: n, maxLength: n },
            ),
          }),
        ),
        ({ n, bodies, targetIdx, titleDecoys }) => {
          const lines = [];
          for (let k = 1; k <= n; k++) {
            const decoy = titleDecoys[k - 1];
            const heading = decoy !== undefined && decoy !== k
              ? `Phase ${k}: legacy Phase ${decoy} notes`
              : `Phase ${k}`;
            lines.push(`## ${heading}`);
            lines.push(`body-${k}: ${bodies[k - 1]}`);
          }
          const doc = lines.join('\n') + '\n';
          const targetPhase = targetIdx + 1;

          // Snapshot every section's body BEFORE the edit.
          const before = [];
          for (let k = 1; k <= n; k++) {
            const s = collectSection(doc, anchoredPhasePredicate(k));
            assert.ok(s !== null, `Phase ${k} section must be found before edit`);
            before.push(s.body);
          }

          const result = withSection(
            doc,
            anchoredPhasePredicate(targetPhase),
            (body) => body + ' EDITED',
          );

          for (let k = 1; k <= n; k++) {
            const s = collectSection(result, anchoredPhasePredicate(k));
            assert.ok(s !== null, `Phase ${k} section must still be found after edit`);
            if (k === targetPhase) {
              assert.equal(s.body, before[k - 1] + ' EDITED', `Phase ${targetPhase} (the target) must be edited`);
            } else {
              assert.equal(s.body, before[k - 1], `Phase ${k} (j≠k) must be byte-identical after editing Phase ${targetPhase}`);
            }
          }
        },
      ),
    );
  });

  test('mixed heading levels + title collision: withSection({levelBounded:false}) does not fold a deeper heading into the target section, and the anchored predicate is not hijacked by a title mentioning another phase', () => {
    // Phase 3 (appearing FIRST) has a title that mentions "Phase 1" — under the
    // OLD unanchored regex this would be matched first (document order) by a
    // query for phase 1 (Blocker 1). Phase 1 is followed by a DEEPER heading
    // (`#### Phase 2`, level 4 vs Phase 1's level 3) — under the default
    // `levelBounded: true` this would nest Phase 2 inside Phase 1's section
    // and let an edit on Phase 1 reach into it (Blocker 2).
    const content = [
      '### Phase 3: Migrate off Phase 1 pipeline',
      'gamma body line',
      '### Phase 1: Foundation',
      'alpha body line',
      '#### Phase 2: API (deeper level, nested syntactically under Phase 1)',
      '**Plans:** 1 plans',
    ].join('\n') + '\n';

    const before2 = collectSection(content, anchoredPhasePredicate(2));
    assert.ok(before2 !== null, 'Phase 2 section must be found before edit');

    const result = withSection(
      content,
      anchoredPhasePredicate(1),
      (body) => body + ' EDITED',
      { levelBounded: false },
    );

    assert.ok(
      result.includes('### Phase 3: Migrate off Phase 1 pipeline\ngamma body line'),
      'Phase 3 (title mentions "Phase 1") is byte-identical — not hijacked by the anchored Phase-1 query',
    );
    assert.ok(!result.includes('gamma body line EDITED'), 'the edit did not land in Phase 3');

    const after2 = collectSection(result, anchoredPhasePredicate(2));
    assert.equal(
      after2.body,
      before2.body,
      'Phase 2 (deeper level than Phase 1) stays byte-identical — levelBounded:false stopped Phase 1 at the next heading of ANY level',
    );

    assert.ok(result.includes('alpha body line EDITED'), "Phase 1's own body was correctly edited");
  });
});

// ─── deleteSection ────────────────────────────────────────────────────────────

describe('deleteSection', () => {
  test('no-match is a no-op — content is returned unchanged', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    const result = deleteSection(content, (h) => h.text === 'Nonexistent');
    assert.equal(result, content, 'no matching heading -> content unchanged');
  });

  test('non-string content is returned unchanged', () => {
    assert.equal(deleteSection(null, () => true), null);
    assert.equal(deleteSection(undefined, () => true), undefined);
  });

  test('deleting a middle ### Phase 2 leaves its siblings intact', () => {
    const content = [
      '### Phase 1: Foundation',
      '**Goal:** Setup',
      '',
      '### Phase 2: Auth',
      '**Goal:** Authentication',
      '',
      '### Phase 3: Features',
      '**Goal:** Core features',
      '',
    ].join('\n');

    const result = deleteSection(content, (h) => h.text.startsWith('Phase 2'));

    assert.ok(!result.includes('Phase 2'), 'Phase 2 heading removed');
    assert.ok(!result.includes('Authentication'), 'Phase 2 body content removed');
    assert.ok(result.includes('### Phase 1: Foundation'), 'Phase 1 heading preserved');
    assert.ok(result.includes('Setup'), 'Phase 1 body preserved');
    assert.ok(result.includes('### Phase 3: Features'), 'Phase 3 heading preserved');
    assert.ok(result.includes('Core features'), 'Phase 3 body preserved');
    assert.ok(!result.includes('\n\n\n'), 'no triple-newline (double-blank) seam left behind');
  });

  test('deleting the LAST ### Phase N does not touch a following ## Progress heading/table', () => {
    const content = [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '**Goal:** Setup',
      '',
      '### Phase 2: Auth',
      '**Goal:** Authentication',
      '',
      '## Progress',
      '',
      '| Phase | Plans | Status | Completed |',
      '|---|---|---|---|',
      '| 1 | 0/1 | Planned | - |',
      '| 2 | 0/1 | Planned | - |',
      '',
    ].join('\n');

    // "### Phase 2" is the LAST phase heading in the document — a naive scan
    // for "the next Phase heading" would run to EOF and take ## Progress with
    // it. deleteSection's level-bounded stop (any heading, level <= target's
    // level) must stop at ## Progress instead.
    const result = deleteSection(content, (h) => h.text.startsWith('Phase 2'));

    assert.ok(!result.includes('Phase 2'), 'Phase 2 section removed');
    assert.ok(!result.includes('Authentication'), 'Phase 2 body removed');
    assert.ok(result.includes('## Progress'), 'Progress heading survives');
    assert.ok(result.includes('| Phase | Plans | Status | Completed |'), 'Progress table header survives');
    assert.ok(result.includes('| 1 | 0/1 | Planned | - |'), 'Progress table row 1 survives');
    assert.ok(result.includes('| 2 | 0/1 | Planned | - |'), 'Progress table row 2 survives');
  });

  test('a nested #### subsection under the target is removed with it', () => {
    const content = [
      '### Phase 2: Auth',
      '**Goal:** Authentication',
      '',
      '#### Phase 2.1: Follow-up',
      '**Goal:** Nested cleanup',
      '',
      '### Phase 3: Features',
      '**Goal:** Core features',
      '',
    ].join('\n');

    const result = deleteSection(content, (h) => h.text.startsWith('Phase 2:'));

    assert.ok(!result.includes('Phase 2:'), 'Phase 2 heading removed');
    assert.ok(!result.includes('Phase 2.1'), 'nested #### subsection removed alongside its parent');
    assert.ok(!result.includes('Nested cleanup'), 'nested subsection body removed');
    assert.ok(result.includes('### Phase 3: Features'), 'sibling Phase 3 preserved');
    assert.ok(result.includes('Core features'), 'Phase 3 body preserved');
  });

  test('stopAtLevel option is honored, mirroring collectSection (a shallower opener also stops at a deeper heading)', () => {
    const content = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');

    // stopAtLevel: 3 makes the level-2 "Parent" opener ALSO stop at the next
    // level-3 heading (rather than nesting it, per the default levelBounded
    // rule) — so only "Parent intro" is removed; ### Child and everything
    // after it (including ## Sibling) survives untouched.
    const result = deleteSection(content, (h) => h.text === 'Parent', { stopAtLevel: 3 });

    assert.ok(!result.includes('Parent intro'), 'Parent heading + its own intro line removed');
    assert.ok(result.includes('### Child\nChild body'), 'stopAtLevel:3 stops BEFORE ### Child — it survives');
    assert.ok(result.includes('## Sibling\nSibling body'), 'Sibling section untouched');
  });

  test('levelBounded: false stops at the very next heading, regardless of level (deeper headings are not nested)', () => {
    const content = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');

    // With levelBounded:false, "Parent" stops at the IMMEDIATE next heading
    // (### Child, even though it's a deeper level than Parent) instead of
    // nesting it — the opposite of the default levelBounded:true rule, which
    // would fold ### Child into Parent's deleted range as nested content.
    const result = deleteSection(content, (h) => h.text === 'Parent', { levelBounded: false });

    assert.ok(!result.includes('Parent intro'), 'Parent heading + its own intro line removed');
    assert.ok(result.includes('### Child\nChild body'), 'levelBounded:false stops at ### Child — it survives, not nested');
    assert.ok(result.includes('## Sibling\nSibling body'), 'Sibling section untouched');
  });

  test('a pre-existing double-blank separator immediately before the deleted heading is collapsed to one blank line', () => {
    const content = [
      'Intro paragraph.',
      '',
      '',
      '### Phase 2: Auth',
      '**Goal:** Authentication',
      '',
      '### Phase 3: Features',
      '**Goal:** Core features',
    ].join('\n');

    const result = deleteSection(content, (h) => h.text.startsWith('Phase 2'));

    assert.ok(!result.includes('\n\n\n'), 'no triple-newline (double-blank) seam remains');
    assert.ok(
      result.includes('Intro paragraph.\n\n### Phase 3: Features'),
      `exactly one blank line survives at the seam, got ${JSON.stringify(result)}`,
    );
  });

  test('section at EOF (no following heading) deletes through end of string', () => {
    const content = '### Phase 1\nBody 1\n### Phase 2\nBody 2';
    const result = deleteSection(content, (h) => h.text === 'Phase 2');
    assert.equal(result, '### Phase 1\nBody 1\n');
  });
});

// Parity guard removed in T5 (ADR-1372): uat-predicate now imports stripFencedCode
// from the seam directly, so comparing the seam to itself is tautological.
// The seam's stripFencedCode correctness is already covered by the tests above.

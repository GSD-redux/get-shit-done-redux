// ADR-3473 §8.1 (#3881) — consequence and boundary coverage for the js-yaml migration.
// See .gsd/phase/feat-3881-one-yaml-parser/50-test-matrix.md sections A and F. Each row
// pins a consequence of swapping the hand-rolled line scanner for the vendored js-yaml
// (§40-design.md §0.2) that is otherwise invisible to the existing suite.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  UNTERMINATED_KEY_THRESHOLD,
  FRONTMATTER_UNPARSEABLE,
} = require('../gsd-core/bin/lib/frontmatter.cjs');
const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');
const {
  _resetUnusableInputWarningsForTests,
  _unusableInputEmissionCountForTests,
} = require('../gsd-core/bin/lib/unusable-input.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const fixedClock = Object.freeze({
  today: () => '2026-06-27',
  localToday: () => '2026-06-27',
  nowIso: () => '2026-06-27T12:00:00.000Z',
});

function withTempDir(fn) {
  const dir = createTempDir('feat-3881-consequences-');
  try {
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

// ─── A. Consequences ────────────────────────────────────────────────────────

describe('A1 emptyValuedKeySurvivesAWrite', () => {
  test('a key with no value round-trips through parse -> reconstruct -> re-parse with the key still present', () => {
    const doc = '---\nphase: 3\nprogress:\n---\n\nbody\n';

    const parsed = extractFrontmatter(doc);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'progress'),
      'an empty-valued key must survive the initial parse'
    );

    // reconstructFrontmatter omits null-valued keys (frontmatter.cjs: `if (value === null ...) continue`),
    // so the empty-value contract only survives a write if extractFrontmatter never hands one back —
    // this is what pins that guarantee rather than reconstructFrontmatter's own omission logic.
    const reconstructed = reconstructFrontmatter(parsed);
    const rewritten = `---\n${reconstructed}\n---\n\nbody\n`;
    const reparsed = extractFrontmatter(rewritten);

    assert.ok(
      Object.prototype.hasOwnProperty.call(reparsed, 'progress'),
      `progress must survive a write; reconstructed frontmatter was ${JSON.stringify(reconstructed)}`
    );
  });
});

describe('A2 unparseableDocumentKeepsItsFrontmatterBlock', () => {
  test('a STATE.md with a git merge-conflict marker in its frontmatter keeps the block through beginPhase', () => {
    const fmBlock = [
      '---',
      '<<<<<<< HEAD',
      'status: foo',
      '=======',
      'status: bar',
      '>>>>>>> feature',
      '---',
      '',
    ].join('\n');
    const body = [
      '# Project State',
      '',
      '**Status:** Planning',
      '',
      '## Current Position',
      '',
      'Phase: 2 — DONE',
      'Plan: —',
      'Status: Planning',
      '',
    ].join('\n');
    const content = fmBlock + body;

    // Verify reachability first: the conflicted region parses to zero keys with the
    // unparseable marker set, exercising the exact branch beginPhaseCore relies on.
    const fm = extractFrontmatter(content);
    assert.equal(Object.keys(fm).length, 0);
    assert.equal(fm[FRONTMATTER_UNPARSEABLE], true);

    const result = transitionCore(
      content,
      { kind: 'beginPhase', phaseNumber: 3, phaseName: 'Test Phase', planCount: 5 },
      { clock: fixedClock }
    );

    assert.ok(
      result.content.includes('<<<<<<< HEAD') &&
        result.content.includes('=======') &&
        result.content.includes('>>>>>>> feature'),
      `frontmatter conflict markers must survive the write; got ${JSON.stringify(result.content)}`
    );
  });
});

describe('A3 unparseableIsDistinguishableFromEmpty', () => {
  test('both an empty and an unparseable block yield zero keys, but only the unparseable one carries the marker', () => {
    const empty = extractFrontmatter('---\n---\n\nbody\n');
    const unparseable = extractFrontmatter('---\nfoo: [unclosed\n---\n\nbody\n');

    assert.equal(Object.keys(empty).length, 0);
    assert.equal(Object.keys(unparseable).length, 0);

    assert.notEqual(
      empty[FRONTMATTER_UNPARSEABLE],
      true,
      'a genuinely empty frontmatter block must not carry the unparseable marker'
    );
    assert.equal(
      unparseable[FRONTMATTER_UNPARSEABLE],
      true,
      'a malformed frontmatter block must carry the unparseable marker'
    );
  });
});

describe('A4 nonScalarValuesCanonicalize', () => {
  test('the four spellings of an object-list scalar canonicalize to one value', () => {
    const spellings = [
      '- test: "a b"',
      '- test: a b',
      "- test: 'a b'",
      '- {test: a b}',
    ];
    const CANONICAL = ['test: a b'];

    for (const spelling of spellings) {
      const doc = `---\nkey:\n${spelling}\n---\n\nbody\n`;
      const parsed = extractFrontmatter(doc);
      assert.deepEqual(
        parsed.key,
        CANONICAL,
        `spelling ${JSON.stringify(spelling)} must canonicalize to ${JSON.stringify(CANONICAL)}; got ${JSON.stringify(parsed.key)}`
      );
    }
  });
});

describe('A5 truncationProbeStillFiresOnAnOpenFence', () => {
  test('fires on the dominant real truncation shape: opening fence, well-formed keys, then nothing', () => {
    _resetUnusableInputWarningsForTests();
    const truncated = '---\nphase: 3\nplan: 2\n';
    extractFrontmatter(truncated);
    assert.equal(
      _unusableInputEmissionCountForTests(),
      1,
      'the #1882 probe must fire on a well-formed-but-unterminated frontmatter region'
    );
  });

  test('does NOT fire on the documented false-positive shape: a rule followed by ordinary prose', () => {
    _resetUnusableInputWarningsForTests();
    const rule = '---\nNote: this is a paragraph.\n\nJust ordinary prose after a thematic break.\n';
    extractFrontmatter(rule);
    assert.equal(
      _unusableInputEmissionCountForTests(),
      0,
      'a document that merely opens with a thematic break above prose must not be flagged as truncated'
    );
  });
});

describe('A6 commentsStayOnTheirOwnKey', () => {
  test('a column-0 comment above a Unicode key attaches to that key and survives a round-trip', () => {
    const doc = '---\nfoo: bar\n# note\n相: baz\n---\n\nbody\n';

    const parsed = extractFrontmatter(doc);
    assert.deepEqual(Object.keys(parsed), ['foo', '相']);
    assert.equal(parsed['相'], 'baz');

    const reconstructed = reconstructFrontmatter(parsed);
    const commentLine = reconstructed.split('\n').find((l) => l.startsWith('#'));
    const keyLine = reconstructed.split('\n').find((l) => l.startsWith('相:'));
    assert.ok(commentLine, `reconstructed frontmatter must carry the comment; got ${JSON.stringify(reconstructed)}`);
    const commentIdx = reconstructed.split('\n').indexOf(commentLine);
    const keyIdx = reconstructed.split('\n').indexOf(keyLine);
    assert.equal(keyIdx, commentIdx + 1, 'the comment must sit immediately above the 相 key, not the following one');

    // Round-trip: reparsing the reconstructed block and reconstructing again is byte-identical.
    const rewritten = `---\n${reconstructed}\n---\n\nbody\n`;
    const reparsed = extractFrontmatter(rewritten);
    assert.equal(reconstructFrontmatter(reparsed), reconstructed);
  });
});

describe('A7 anchorsAndAliasesAreRefused', () => {
  // #3881 review, finding 1: the original refusal was a raw-line regex matching only the
  // bare-key spelling (`key: &x`). A quoted key, a flow mapping and a flow sequence all
  // define/use the SAME anchor mechanics while never matching that line shape — table-driven
  // over every spelling that was confirmed bypassable, plus the original passing case, so a
  // future regression in any one spelling fails loudly rather than hiding behind the others.
  const SPELLINGS = [
    ['plain', '---\nfoo: &a bar\nbaz: *a\n---\n\nbody\n'],
    ['quoted key', '---\n"foo": &a bar\n"baz": *a\n---\n\nbody\n'],
    ['flow mapping', '---\na: {b: &a 1, c: *a}\n---\n\nbody\n'],
    ['flow sequence', '---\na: [&a "q", *a]\n---\n\nbody\n'],
    ['merge key (<<:) with an alias', '---\nbase: &b\n  x: "1"\nfoo:\n  <<: *b\n  y: "2"\n---\n\nbody\n'],
  ];

  for (const [label, doc] of SPELLINGS) {
    test(`${label}: refused rather than expanded`, () => {
      const parsed = extractFrontmatter(doc);
      assert.equal(Object.keys(parsed).length, 0, `${label} must parse to zero keys`);
      assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true, `${label} must carry the unparseable marker`);
    });
  }

  test('a bare merge key with NO alias is not itself refused (no anchor, no expansion risk)', () => {
    // Under FAILSAFE_SCHEMA (no !!merge type resolution) this never actually merges — it
    // parses as an ordinary, non-expanding literal "<<" string key. Documented behavior
    // change from the pre-review regex (which refused every `<<:`-shaped line regardless of
    // whether an alias was present) — see frontmatter.cts refuseAnchorsAndAliases docblock.
    const doc = '---\na:\n  <<: {b: 1}\n  c: 2\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.notEqual(parsed[FRONTMATTER_UNPARSEABLE], true);
    assert.deepEqual(parsed.a, { '<<': { b: '1' }, c: '2' });
  });
});

describe('A8 aliasExpansionCannotExhaustMemory', () => {
  test('a billion-laughs frontmatter is refused, bounded on the RESULT, never on elapsed time', () => {
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    const doc = `---\n${bomb}\n---\n\nbody\n`;

    const parsed = extractFrontmatter(doc);

    // Assertions are on the RESULT SHAPE (zero keys, bounded serialized size), never on
    // wall-clock elapsed time — this repo forbids elapsed-time assertions in tests.
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    const serializedSize = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    assert.ok(
      serializedSize < 1024,
      `a refused parse must stay tiny (would be ~22.8MB if expanded); got ${serializedSize} bytes`
    );
  });

  test('the same billion-laughs bomb, quoted-key-spelled, is ALSO refused (#3881 review, finding 1)', () => {
    // The exact bypass the review found: the pre-fix raw-text regex matched only bare
    // (unquoted) keys, so this 303-byte quoted-key spelling of the identical bomb went
    // straight through unrefused and expanded to ~35.8MB. Pinned here on the RESULT shape.
    const bomb = [
      '"a": &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      '"b": &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      '"c": &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      '"d": &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      '"e": &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      '"f": &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      '"g": [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    const doc = `---\n${bomb}\n---\n\nbody\n`;

    const parsed = extractFrontmatter(doc);

    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
    const serializedSize = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    assert.ok(
      serializedSize < 1024,
      `a refused parse must stay tiny (would be ~35.8MB if expanded); got ${serializedSize} bytes`
    );
  });
});

describe('finding 3: null-byte sentinel round-trip is injective', () => {
  const E000 = String.fromCharCode(0xE000);

  test('a real NUL is preserved exactly when no pre-existing U+E000 is present', () => {
    const doc = '---\nfoo: "has null"\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(parsed.foo, 'has null');
  });

  test('a document containing a literal U+E000 (the sentinel itself) is refused, not silently corrupted', () => {
    // Before the fix, restoreNullBytesDeep rewrote EVERY U+E000 in the parsed tree back to
    // U+0000 unconditionally — including one the document author legitimately wrote — so this
    // document's own U+E000 silently became a NUL. It must now be refused instead.
    const doc = `---\nfoo: "pre${E000}existing"\n---\n\nbody\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });

  test('a literal U+E000 alongside a real NUL is refused rather than merging the two into one byte', () => {
    // The exact corruption case from the review: escaping the real NUL to U+E000 makes it
    // indistinguishable from the pre-existing U+E000, and restoring converts BOTH back to NUL.
    const doc = `---\nfoo: "has null"\nbar: "pre${E000}existing"\n---\n\nbody\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });
});

// ─── F. Boundaries ──────────────────────────────────────────────────────────

describe('F1 UNTERMINATED_KEY_THRESHOLD boundary', () => {
  function unterminatedRegionWithKeys(n) {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(`k${i}: v${i}`);
    return `---\n${lines.join('\n')}\n`;
  }

  test('threshold-1 keys: no diagnostic', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD - 1));
    assert.equal(_unusableInputEmissionCountForTests(), 0);
  });

  test('threshold keys: fires', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD));
    assert.equal(_unusableInputEmissionCountForTests(), 1);
  });

  test('threshold+1 keys: fires', () => {
    _resetUnusableInputWarningsForTests();
    extractFrontmatter(unterminatedRegionWithKeys(UNTERMINATED_KEY_THRESHOLD + 1));
    assert.equal(_unusableInputEmissionCountForTests(), 1);
  });
});

describe('F2 alias/nesting refusal bound', () => {
  // refuseAnchorsAndAliases (frontmatter.cjs) is a raw-text pre-scan that refuses on ANY
  // line carrying an anchor/alias/merge-key marker — there is no numeric count threshold
  // in this implementation. The real boundary it exercises is therefore an occurrence
  // COUNT: 0 (below the refusal trigger) parses; 1 (the trigger) is refused; 2 (over) stays
  // refused, proving the refusal is not a first-occurrence artifact that a second alias
  // could slip past.
  test('0 anchor/alias lines: parses normally', () => {
    const doc = '---\nfoo: bar\nbaz: qux\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.deepEqual(parsed, { foo: 'bar', baz: 'qux' });
  });

  test('1 anchor/alias line: refused', () => {
    const doc = '---\nfoo: &a bar\nbaz: qux\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });

  test('2 anchor/alias lines: still refused', () => {
    const doc = '---\nfoo: &a bar\nbaz: *a\n---\n\nbody\n';
    const parsed = extractFrontmatter(doc);
    assert.equal(Object.keys(parsed).length, 0);
    assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
  });
});

describe('F3 frontmatter size boundary', () => {
  const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'adversarial', 'frontmatter', 'huge-bounded.md');

  test('~30KB fixture (huge-bounded.md) completes with a typed result', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const parsed = extractFrontmatter(content, FIXTURE_PATH);
    assert.equal(typeof parsed, 'object');
    assert.ok(Array.isArray(parsed.plans));
    assert.ok(parsed.plans.length > 0);
  });

  test('a larger (~640KB) frontmatter block also completes with a typed result', () => {
    withTempDir((dir) => {
      const lines = ['---', 'phase: "06"', 'plans:'];
      // ~640KB of array items — an order of magnitude above the committed ~30KB fixture,
      // isolated in a per-test temp file rather than a new committed fixture.
      for (let i = 0; i < 40000; i++) {
        lines.push(`  - item-${String(i).padStart(5, '0')}`);
      }
      lines.push('---', '', 'Body.', '');
      const content = lines.join('\n');
      assert.ok(Buffer.byteLength(content, 'utf8') > 500 * 1024, 'fixture must exceed the committed one by an order of magnitude');

      const filePath = path.join(dir, 'huge-bounded-larger.md');
      fs.writeFileSync(filePath, content, 'utf8');
      const readBack = fs.readFileSync(filePath, 'utf8');

      const parsed = extractFrontmatter(readBack, filePath);
      assert.equal(typeof parsed, 'object');
      assert.ok(Array.isArray(parsed.plans));
      assert.equal(parsed.plans.length, 40000);
      assert.equal(parsed.plans[0], 'item-00000');
      assert.equal(parsed.plans[39999], 'item-39999');
    });
  });
});

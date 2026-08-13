'use strict';

/**
 * Tests for `src/text-lines.cts` — the line-terminator seam (#3212 Phase 2, #3413).
 *
 * Design:       .gsd/phase/chore-3413-text-lines-seam/40-design.md
 * Test matrix:  .gsd/phase/chore-3413-text-lines-seam/50-test-matrix.md
 * ADR:          docs/adr/3212-lexical-seam-consolidation.md §3, §6, §7
 *
 * TDD RED: `src/text-lines.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/text-lines.cjs')` throws MODULE_NOT_FOUND until
 * the implementing phase adds it. That is the intended starting state (mirrors
 * tests/pattern.test.cjs's RED convention from Phase 1, #3412).
 *
 * Covers test-matrix rows 1-23: splitLines (1-7), normalizeEol (8-10),
 * detectEol (11-16), joinLines (17-20), round-trip (21-23).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
// Seeded fast-check convention: require the shared setup helper (NOT
// 'fast-check' directly) so numRuns/seed are configured globally before any
// fc.assert() call — mirrors tests/pattern.test.cjs. seed: 42, overridable
// via GSD_FC_SEED.
const fc = require('./helpers/fast-check-setup.cjs');

const { splitLines, normalizeEol, detectEol, joinLines } = require('../gsd-core/bin/lib/text-lines.cjs');

// ─── splitLines — rows 1-7 ─────────────────────────────────────────────────

describe('splitLines', () => {
  test('row 1: splits LF-only content', () => {
    assert.deepStrictEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
  });

  test('row 2: splits CRLF content with no trailing \\r per line', () => {
    const result = splitLines('a\r\nb\r\nc');
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
    for (const line of result) {
      assert.ok(!line.includes('\r'), `line ${JSON.stringify(line)} must not carry a trailing \\r`);
    }
  });

  test('row 3: handles mixed CRLF/LF in one document', () => {
    assert.deepStrictEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
  });

  test('row 4: empty string matches native String#split(/\\r?\\n/) contract', () => {
    assert.deepStrictEqual(splitLines(''), ['']);
    assert.deepStrictEqual(splitLines(''), ''.split(/\r?\n/));
  });

  test('row 5: trailing terminator yields a trailing empty element', () => {
    assert.deepStrictEqual(splitLines('a\n'), ['a', '']);
  });

  test('row 6: a lone \\r without a following \\n is not a delimiter', () => {
    assert.deepStrictEqual(splitLines('a\rb'), ['a\rb']);
  });

  test('row 7: rejects a non-string input', () => {
    assert.throws(() => splitLines(42), TypeError);
    assert.throws(() => splitLines(null), TypeError);
  });
});

// ─── normalizeEol — rows 8-10 ──────────────────────────────────────────────

describe('normalizeEol', () => {
  test('row 8: converts CRLF and leaves LF alone', () => {
    assert.strictEqual(normalizeEol('a\r\nb\nc'), 'a\nb\nc');
  });

  test('row 9: no-op on already-LF content', () => {
    assert.strictEqual(normalizeEol('a\nb'), 'a\nb');
  });

  test('row 10: strips an unpaired bare \\r, matching the scripts/ copies it replaces', () => {
    assert.strictEqual(normalizeEol('a\rb\rc'), 'abc');
  });
});

// ─── detectEol — rows 11-16 ────────────────────────────────────────────────

describe('detectEol', () => {
  test('row 11: all-CRLF content', () => {
    assert.strictEqual(detectEol('a\r\nb\r\nc'), '\r\n');
  });

  test('row 12: all-LF content', () => {
    assert.strictEqual(detectEol('a\nb\nc'), '\n');
  });

  test('row 13: mixed content, CRLF majority wins', () => {
    assert.strictEqual(detectEol('a\r\nb\nc\r\n'), '\r\n');
  });

  test('row 14: mixed content, LF majority wins', () => {
    assert.strictEqual(detectEol('a\nb\r\nc'), '\n');
  });

  test('row 15: no terminator present returns the documented default', () => {
    assert.strictEqual(detectEol('no terminator at all'), '\r\n');
  });

  test('row 16: empty string returns the documented default', () => {
    assert.strictEqual(detectEol(''), '\r\n');
  });
});

// ─── joinLines — rows 17-20 ────────────────────────────────────────────────

describe('joinLines', () => {
  test('row 17: defaults to LF', () => {
    assert.strictEqual(joinLines(['a', 'b', 'c']), 'a\nb\nc');
  });

  test('row 18: explicit CRLF', () => {
    assert.strictEqual(joinLines(['a', 'b', 'c'], '\r\n'), 'a\r\nb\r\nc');
  });

  test('row 19: empty array yields empty string', () => {
    assert.strictEqual(joinLines([]), '');
  });

  test('row 20: single-element array has no terminator', () => {
    assert.strictEqual(joinLines(['only']), 'only');
  });
});

// ─── round-trip — rows 21-23 ───────────────────────────────────────────────

describe('round-trip', () => {
  test('row 21: split->detect->join reproduces a CRLF document exactly (#3212 §3)', () => {
    const x = '---\r\nphase: 01\r\nmust_haves:\r\n  truths:\r\n    - "first truth"\r\n---\r\n\r\nBody.\r\n';
    assert.strictEqual(joinLines(splitLines(x), detectEol(x)), x);
  });

  test('row 22: split->detect->join reproduces an LF document exactly', () => {
    const x = '---\nphase: 01\nmust_haves:\n  truths:\n    - "first truth"\n---\n\nBody.\n';
    assert.strictEqual(joinLines(splitLines(x), detectEol(x)), x);
  });

  test('row 23: property — joinLines/splitLines are inverses over terminator-free line arrays (seeded)', () => {
    // Generator per 50-test-matrix.md's "Property test note (row 23)": arrays
    // of strings with no embedded \r/\n, 1 to 20 elements (0-element arrays
    // are the known non-invertible edge already covered explicitly at rows
    // 4/19 — joinLines([]) === '' but splitLines('') === [''], not [] — so
    // that edge is excluded here rather than re-asserted as a property
    // failure), eol drawn from ['\n', '\r\n'].
    fc.assert(
      fc.property(
        fc.array(
          fc.string().filter(s => !/[\r\n]/.test(s)),
          { minLength: 1, maxLength: 20 }
        ),
        fc.constantFrom('\n', '\r\n'),
        (lines, eol) => {
          assert.deepStrictEqual(splitLines(joinLines(lines, eol)), lines);
        }
      )
    );
  });
});

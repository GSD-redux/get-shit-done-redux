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

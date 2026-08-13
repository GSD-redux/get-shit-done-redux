'use strict';

/**
 * Tests for `src/pattern.cts` — the pattern-construction seam (#3212 Phase 1, #3412).
 *
 * Design:       .gsd/phase/chore-3412-pattern-seam/40-design.md
 * Test matrix:  .gsd/phase/chore-3412-pattern-seam/50-test-matrix.md
 * ADR:          docs/adr/3212-lexical-seam-consolidation.md §1, §2, §7
 *
 * TDD RED: `src/pattern.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/pattern.cjs')` throws MODULE_NOT_FOUND until
 * the implementing phase adds it. That is the intended starting state (mirrors
 * tests/planning-snapshot.test.cjs's RED convention).
 *
 * Covers test-matrix sections 1 (escapeRegex, rows 1-10), 2 (literalPattern,
 * rows 11-14), and 3 (migration equivalence, rows 15-17).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
// Seeded fast-check convention: require the shared setup helper (NOT
// 'fast-check' directly) so numRuns/seed are configured globally before any
// fc.assert() call — mirrors tests/frontmatter.property.test.cjs and every
// other *.property.test.cjs file. seed: 42, overridable via GSD_FC_SEED.
const fc = require('./helpers/fast-check-setup.cjs');

const { escapeRegex, literalPattern } = require('../gsd-core/bin/lib/pattern.cjs');

// ─── Section 1: escapeRegex — rows 1-10 ───────────────────────────────────

describe('escapeRegex', () => {
  test('row 1: "" returns ""', () => {
    assert.strictEqual(escapeRegex(''), '');
  });

  test('row 2: ordinary chars only ("_x") are unchanged', () => {
    assert.strictEqual(escapeRegex('_x'), '_x');
  });

  test('row 3: each metacharacter is escaped and the result matches its own literal form', () => {
    const metachars = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'];
    for (const ch of metachars) {
      const escaped = escapeRegex(ch);
      const re = new RegExp(escaped);
      assert.ok(re.test(ch), `escapeRegex(${JSON.stringify(ch)}) -> ${JSON.stringify(escaped)} must match its own literal char`);
    }
  });

  test('row 4: leading ASCII letter locks the MEASURED hex-escape ("abc" -> "\\x61bc", Node v26.5.1)', () => {
    assert.strictEqual(escapeRegex('abc'), '\\x61bc');
  });

  test('row 5: leading digit locks the MEASURED hex-escape ("5abc" -> "\\x35abc", Node v26.5.1)', () => {
    assert.strictEqual(escapeRegex('5abc'), '\\x35abc');
  });

  test('row 6: hyphen anywhere locks the MEASURED hex-escape ("a-b" -> "\\x61\\x2db", Node v26.5.1)', () => {
    assert.strictEqual(escapeRegex('a-b'), '\\x61\\x2db');
  });

  test('row 7: whitespace / newline / control chars are escaped and the result still constructs', () => {
    const values = [' ', '\n', '\t', '\r', 'a\nb', 'a\tb\rc'];
    for (const v of values) {
      const escaped = escapeRegex(v);
      assert.doesNotThrow(() => new RegExp(escaped));
      assert.ok(new RegExp(escaped).test(v));
    }
  });

  test('row 8: non-string input throws TypeError (matches the 12 deleted copies\' .replace throw)', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.throws(() => escapeRegex(bad), TypeError, `escapeRegex(${JSON.stringify(bad)}) must throw TypeError`);
    }
  });

  test('row 9: a 10,000-char value does not throw and completes without catastrophic time', () => {
    const big = 'a-b.c*d'.repeat(1429); // ~10,001 chars
    let escaped;
    assert.doesNotThrow(() => {
      escaped = escapeRegex(big);
    });
    assert.doesNotThrow(() => new RegExp(escaped));
  });

  test('row 10: RegExp.escape availability — the ADR §2 floor-vs-capability assertion', () => {
    assert.strictEqual(typeof RegExp.escape, 'function');
  });
});

// ─── Section 2: literalPattern — rows 11-14 ───────────────────────────────

describe('literalPattern', () => {
  test('row 11: value + no flags produces a RegExp matching the value literally', () => {
    const re = literalPattern('abc');
    assert.ok(re instanceof RegExp);
    assert.ok(re.test('abc'));
  });

  test('row 12: value + valid flags ("gi") applies the flags', () => {
    const re = literalPattern('abc', 'gi');
    assert.strictEqual(re.flags, 'gi');
    assert.ok(re.test('ABC'));
  });

  test('row 13: invalid flags ("qq") throws SyntaxError from RegExp', () => {
    assert.throws(() => literalPattern('abc', 'qq'), SyntaxError);
  });

  test('row 14: metacharacter-heavy value matches literally, not by its metacharacter interpretation', () => {
    const re = literalPattern('a.b*c');
    assert.ok(re.test('a.b*c'), 'must match the literal string');
    // If '.' and '*' were left live, this would ALSO match (any-char + zero-or-more)
    assert.ok(!re.test('aXbYYYc'), 'must NOT match the metacharacter interpretation');
  });
});

// ─── Section 3: migration equivalence — rows 15-17 (load-bearing) ─────────

describe('migration equivalence (row-9 sweep)', () => {
  test('row 15: property — hand oracle and escapeRegex are match-equivalent for all (s, probe) pairs (seeded)', () => {
    // `hand` is the historical oracle: the deleted pre-migration implementation,
    // byte-identical across all twelve copies before this seam existed (design
    // doc "Ground truth" #1; ADR §7 Class 1 census). It is inlined here ONLY as
    // a test oracle for this equivalence sweep — this is NOT a 13th production
    // copy of the escape helper (design doc Notes: "not a 13th production copy").
    // eslint-disable-next-line local/no-adhoc-regex-escape -- historical oracle for the row-15 equivalence sweep, not a production copy (#3412)
    const hand = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 50 }),
        (s, probe) => {
          const handResult = new RegExp(hand(s)).test(probe);
          const seamResult = new RegExp(escapeRegex(s)).test(probe);
          assert.strictEqual(
            seamResult,
            handResult,
            `match divergence for s=${JSON.stringify(s)} probe=${JSON.stringify(probe)}`
          );
        }
      )
    );
  });

  test('row 16: the real corpus — phase tokens, milestone versions, STATE field names, runtime ids are match-equivalent', () => {
    // eslint-disable-next-line local/no-adhoc-regex-escape -- historical oracle for the row-16 equivalence sweep, not a production copy (#3412)
    const hand = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const corpus = [
      '1A',
      'PROJ-05',
      '999.1',
      'v1.2',
      '**Current Phase:**',
      'claude-code',
      'gemini-cli',
    ];
    const probes = ['1A', 'PROJ-05', '999.1', 'v1.2', '**Current Phase:**', 'claude-code', 'gemini-cli', 'no-match-here'];
    for (const s of corpus) {
      for (const probe of probes) {
        const handResult = new RegExp(hand(s)).test(probe);
        const seamResult = new RegExp(escapeRegex(s)).test(probe);
        assert.strictEqual(
          seamResult,
          handResult,
          `corpus divergence for s=${JSON.stringify(s)} probe=${JSON.stringify(probe)}`
        );
      }
    }
  });

  test('row 17: latent-bug fix — a hyphen interpolated into a character class no longer forms a range', () => {
    // Pre-migration (hand-rolled, verified): new RegExp('[' + hand('a-z') + ']').test('m') === true
    // — the unescaped '-' formed an unintended a-through-z RANGE that happened
    // to match 'm'. This is design row 10's confirmed latent bug.
    // eslint-disable-next-line local/no-adhoc-regex-escape -- historical oracle for the row-17 latent-bug check, not a production copy (#3412)
    const hand = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.strictEqual(
      new RegExp('[' + hand('a-z') + ']').test('m'),
      true,
      'sanity check: pre-migration hand-rolled behavior was true (verified)'
    );

    // Post-migration (the seam): the fix. 'a', '-', 'z' are all escaped as
    // discrete literal characters, so '[...]' no longer forms a range and 'm'
    // (interior to the would-be range) must NOT match.
    assert.strictEqual(
      new RegExp('[' + escapeRegex('a-z') + ']').test('m'),
      false,
      'deliberate fix, not an accident: the seam must not let a value form a character-class range'
    );
  });
});

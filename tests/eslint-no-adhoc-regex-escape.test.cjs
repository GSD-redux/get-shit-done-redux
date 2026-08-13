'use strict';

/**
 * RuleTester unit tests for `local/no-adhoc-regex-escape`
 * (#3212 Phase 1, #3412).
 *
 * Design:       .gsd/phase/chore-3412-pattern-seam/40-design.md (Negative space)
 * Test matrix:  .gsd/phase/chore-3412-pattern-seam/50-test-matrix.md — section 5, rows 24-29
 * ADR:          docs/adr/3212-lexical-seam-consolidation.md §7
 *
 * TDD RED: `eslint-rules/no-adhoc-regex-escape.cjs` does not exist yet —
 * this file's require() throws MODULE_NOT_FOUND until the implementing phase
 * adds it. That is the intended starting state.
 *
 * RuleTester setup (languageOptions, sourceType, filename conventions) mirrors
 * tests/eslint-rules.test.cjs's `no-adhoc-markdown-parsing` suite, which is
 * this repo's other src/*.cts-scoped structural-shape rule.
 *
 * Contract this test file locks for the not-yet-written rule (per ADR §7 and
 * the design doc's Negative space section):
 *   - FIRES on an inline `.replace(<escape-all-metachars class>, '\$&')`
 *     shape outside src/pattern.cts, matching the SHAPE (character-class
 *     membership set) not exact byte order (row 25).
 *   - Does NOT fire inside src/pattern.cts itself — the seam is the owner
 *     (row 26).
 *   - Does NOT fire on `new RegExp(<identifier>)` when the identifier is a
 *     `*_SOURCE`-suffixed constant — the design's named provenance marker for
 *     "deliberate, reviewed pattern fragments" (row 27).
 *   - Does NOT fire on a regex literal that merely contains the escape class
 *     as DATA, with no `.replace(..., '\$&')` shape present (row 28).
 *   - FIRES on `new RegExp(<identifier>)` when the identifier is a plain
 *     runtime value with no `_SOURCE` provenance marker and no routing
 *     through escapeRegex/literalPattern — ADR §7's "new RegExp() built from
 *     a non-literal without routing through the seam" (row 29).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const noAdhocRegexEscape = require('../eslint-rules/no-adhoc-regex-escape.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

describe('no-adhoc-regex-escape rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noAdhocRegexEscape.create, 'function');
  });

  // ── row 24: invalid — a new inline escape-all-metachars .replace() ────────

  test('row 24 invalid: a new inline .replace(/[.*+?^${}()|[\\]\\\\]/g, \'\\\\$&\') outside the seam', () => {
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [],
      invalid: [
        {
          // NOT String.raw: the code-under-test contains a literal `${` (part
          // of the escape-all-metachars character class), which String.raw
          // would still interpret as a template-literal substitution marker.
          // A normal (non-raw) template literal is used instead, with `\$`
          // and doubled backslashes to produce the exact literal source text.
          code: `
            function esc(s) {
              return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
            }
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'adhocRegexEscape' }],
        },
      ],
    });
  });

  // ── row 25: invalid — reordered/differently-escaped char class, same shape ─

  test('row 25 invalid: same escape shape with a REORDERED character class still fires (matches shape, not exact bytes)', () => {
    // Same 14-member set { . * + ? ^ $ { } ( ) | [ ] \ } as row 24, but written
    // in a different order and with a different (still valid) escaping style.
    // If the rule only string-matched the exact literal bytes of the census
    // copies, this would slip through — it must not.
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [],
      invalid: [
        {
          code: String.raw`
            function escapeForRegex(value) {
              return value.replace(/[\^$.|?*+()[\]{}\\]/g, '\\$&');
            }
          `,
          filename: 'src/another-module.cts',
          errors: [{ messageId: 'adhocRegexEscape' }],
        },
      ],
    });
  });

  // ── row 26: valid — the seam file itself is exempt ─────────────────────────

  test('row 26 valid: src/pattern.cts itself is exempt (the seam owns this shape)', () => {
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [
        {
          // Not String.raw — see the row-24 comment above (`${` needs escaping
          // in a non-raw template literal).
          code: `
            function escapeRegex(value) {
              return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
            }
          `,
          filename: 'src/pattern.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── row 27: valid (negative space) — new RegExp from an exported *_SOURCE ──

  test('row 27 valid: new RegExp built from an exported *_SOURCE constant is NOT flagged (critical negative-space case)', () => {
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [
        {
          // A deliberate, reviewed pattern fragment (design doc Negative space:
          // PHASE_NUMBER_TOKEN_SOURCE, MILESTONE_HEADING_LINE_SOURCE, etc.) —
          // its metacharacters are load-bearing and must not be treated as an
          // unescaped runtime value.
          code: String.raw`
            const PHASE_NUMBER_TOKEN_SOURCE = '\\d+[A-Z]?';
            const re = new RegExp(PHASE_NUMBER_TOKEN_SOURCE);
          `,
          filename: 'src/phase-id.cts',
        },
        {
          code: String.raw`
            const MILESTONE_HEADING_LINE_SOURCE = '^##\\s+Milestone\\s';
            const re = new RegExp(MILESTONE_HEADING_LINE_SOURCE, 'm');
          `,
          filename: 'src/roadmap-parser.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── row 28: valid (negative space) — regex literal containing the class as data ─

  test('row 28 valid: a regex literal that merely CONTAINS [.*+?] as data is NOT flagged', () => {
    // A legitimate validator matching one of the metacharacters as literal
    // DATA — no .replace(..., '\$&') shape present, so this must not fire.
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [
        {
          code: String.raw`const isMetachar = /^[.*+?]$/.test(char);`,
          filename: 'src/some-validator.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── row 29: invalid — new RegExp from a genuinely unescaped runtime value ──

  test('row 29 invalid: new RegExp from a genuinely unescaped runtime value fires', () => {
    // A plain, non-`_SOURCE`-suffixed parameter interpolated straight into
    // new RegExp() with no seam routing (no escapeRegex/literalPattern call
    // anywhere on it) — ADR §7: "flags new RegExp() built from a non-literal
    // without routing through the seam." This is the minimal-pair inverse of
    // row 27: same `new RegExp(<identifier>)` shape, but the identifier
    // carries no `_SOURCE` provenance marker.
    ruleTester.run('no-adhoc-regex-escape', noAdhocRegexEscape, {
      valid: [],
      invalid: [
        {
          code: String.raw`
            function buildLiteralMatcher(userSuppliedValue) {
              return new RegExp(userSuppliedValue);
            }
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'unsafeNewRegExp' }],
        },
      ],
    });
  });
});

'use strict';

/**
 * no-unbounded-quantifier.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-unbounded-quantifier ESLint rule
 * (ADR-3212 §5/§7, epic #3212 Phase 4, #3415). Rows 1-13 per
 * .gsd/phase/chore-3415-prohibition-with-teeth/50-test-matrix.md.
 *
 * NOTE: Fixture code strings must encode actual regex-literal backslashes
 * (e.g. `\s`, `\S`, `\n`, `\d`) as doubled `\\s`/`\\S`/`\\n`/`\\d` inside the
 * JavaScript string literals used for RuleTester `code` fields, so that the
 * ESLint parser receives the intended source text (mirrors
 * tests/no-crlf-fragile-split.rule.test.cjs's convention). For row 10's
 * `new RegExp('[\s\S]*')` — the pattern is itself a STRING LITERAL in the
 * target source, so its `\s`/`\S` need a further doubling in that source
 * text (`\\s`/`\\S`), which then needs doubling AGAIN to survive our own
 * JS string literal — four backslashes total before each `s`/`S`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-unbounded-quantifier.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-unbounded-quantifier rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.unboundedQuantifier, 'unboundedQuantifier message must exist');
  });
});

// ─── INVALID (happy-path, rule fires) ─────────────────────────────────────────

describe('no-unbounded-quantifier: invalid (unboundedQuantifier fires)', () => {
  test('row 1: [\\s\\S]* on readFileSync-derived content', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[\\s\\S]*/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });

  test('row 3: flags the #2128 [^)\\n]* shape', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[^)\\n]*/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });

  test('row 5: flags dotAll . with unbounded *', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/.*text/s);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });

  test('row 10: flags new RegExp() built from a literal string', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          // Source text: new RegExp('[\\s\\S]*').test(fs.readFileSync(p, 'utf8'))
          code: "const ok = new RegExp('[\\\\s\\\\S]*').test(fs.readFileSync(p, 'utf8'));",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });

  test('row 12: flags a lazy [\\s\\S]+? as unbounded too', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[\\s\\S]+?/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });

  test('row 13: flags an open-ended {0,} as unbounded', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [],
      invalid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[\\s\\S]{0,}/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'unboundedQuantifier' }],
        },
      ],
    });
  });
});

// ─── VALID (negative) ──────────────────────────────────────────────────────────

describe('no-unbounded-quantifier: valid cases', () => {
  test('row 2: does not flag an already-bounded [\\s\\S]{0,200}', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[\\s\\S]{0,200}/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 4: does not flag the #2128-fixed {0,200} form', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[^)\\n]{0,200}/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 6: does not flag plain . without dotAll', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/.*text/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 7: does not flag a wide (3+ unit) negated class', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[^abc]*/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 8: does not flag a narrow class like \\d*', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/\\d*/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 9: does not flag a non-readFileSync-derived receiver', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: 'const m = someShortConstant.match(/[\\s\\S]*/);',
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 11: does not attempt to inspect a non-literal new RegExp() pattern', () => {
    ruleTester.run('no-unbounded-quantifier', rule, {
      valid: [
        {
          code: "const pat = someVar; readFileSync(p, 'utf8').match(new RegExp(pat));",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

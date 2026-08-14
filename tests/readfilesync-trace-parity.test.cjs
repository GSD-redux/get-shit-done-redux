'use strict';

/**
 * readfilesync-trace-parity.test.cjs
 *
 * Row 14 of .gsd/phase/chore-3415-prohibition-with-teeth/50-test-matrix.md:
 * `no-crlf-fragile-split.cjs` and `no-unbounded-quantifier.cjs` both import
 * their readFileSync-derivation data-flow tracing from the shared
 * `eslint-rules/lib/readfilesync-trace.cjs` module (extracted from
 * no-crlf-fragile-split, ADR-1703 Phase 4 / ADR-3212 §5-6, #3415). There is
 * no separate "pre-extraction inline copy" left to diff against — this test
 * instead asserts the two RULES currently AGREE on the shared data-flow
 * classification: for a fixture whose receiver is NOT readFileSync-derived,
 * BOTH rules must report zero errors, even though each rule's own
 * pattern-shape condition (bare `\n` for crlf; broad-atom + unbounded
 * quantifier for unbounded-quantifier) would independently match the regex
 * content. For a fixture whose receiver IS readFileSync-derived (direct,
 * chained, or via a same-scope variable), each rule's own pattern-shape
 * condition is ALSO satisfied by every fixture below, so each fires.
 *
 * `isPatternUsedOnFileContent`/`isReadFileSyncDerived` are not exercised
 * standalone: both take a live `sourceCode` (parent pointers via
 * `sourceCode.getScope`/`node.parent`) that only exists inside a real
 * ESLint visitor, so a RuleTester run against both consuming rules is the
 * faithful way to exercise the shared module identically to production.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const crlfRule = require('../eslint-rules/no-crlf-fragile-split.cjs');
const quantifierRule = require('../eslint-rules/no-unbounded-quantifier.cjs');
const trace = require('../eslint-rules/lib/readfilesync-trace.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── shared module shape ────────────────────────────────────────────────────

describe('readfilesync-trace shared module shape', () => {
  test('exports isReadFileSyncDerived(node, sourceCode) and isPatternUsedOnFileContent(regexNode, sourceCode)', () => {
    assert.strictEqual(typeof trace.isReadFileSyncDerived, 'function');
    assert.strictEqual(trace.isReadFileSyncDerived.length, 2);
    assert.strictEqual(typeof trace.isPatternUsedOnFileContent, 'function');
    assert.strictEqual(trace.isPatternUsedOnFileContent.length, 2);
  });
});

// ─── shared fixtures ─────────────────────────────────────────────────────────
//
// Every fixture's regex carries BOTH a bare \n (crlf rule's own pattern-shape
// trigger) AND an unbounded [\s\S]* (unbounded-quantifier rule's own
// pattern-shape trigger), so any divergence between the two rules can only
// come from disagreement on the shared readFileSync-derived classification,
// never from a pattern-shape mismatch.

const READFILESYNC_DERIVED_FIXTURES = [
  {
    name: 'direct call: fs.readFileSync(p, "utf8").match(...)',
    code: "const m = fs.readFileSync(p, 'utf8').match(/[\\s\\S]*\\n/);",
  },
  {
    name: 'chained call: fs.readFileSync(p, "utf8").toString().match(...)',
    code: "const m = fs.readFileSync(p, 'utf8').toString().match(/[\\s\\S]*\\n/);",
  },
  {
    name: 'scope variable: const content = fs.readFileSync(...); content.match(...)',
    code: [
      "const content = fs.readFileSync(filePath, 'utf8');",
      'const m = content.match(/[\\s\\S]*\\n/);',
    ].join('\n'),
  },
];

const NOT_READFILESYNC_DERIVED_FIXTURES = [
  {
    name: 'plain identifier: someShortConstant.match(...)',
    code: 'const m = someShortConstant.match(/[\\s\\S]*\\n/);',
  },
  {
    name: 'scope variable NOT from readFileSync: const content = "hello"; content.match(...)',
    code: ["const content = 'hello';", 'const m = content.match(/[\\s\\S]*\\n/);'].join('\n'),
  },
];

// ─── parity: readFileSync-derived receivers — both rules fire ───────────────

describe('readfilesync-trace parity: readFileSync-derived receivers — both rules fire', () => {
  for (const fixture of READFILESYNC_DERIVED_FIXTURES) {
    test(`crlf and unbounded-quantifier both fire on: ${fixture.name}`, () => {
      ruleTester.run('no-crlf-fragile-split', crlfRule, {
        valid: [],
        invalid: [
          {
            code: fixture.code,
            filename: 'tests/foo.test.cjs',
            errors: [{ messageId: 'crlfFragileRegex' }],
          },
        ],
      });
      ruleTester.run('no-unbounded-quantifier', quantifierRule, {
        valid: [],
        invalid: [
          {
            code: fixture.code,
            filename: 'tests/foo.test.cjs',
            errors: [{ messageId: 'unboundedQuantifier' }],
          },
        ],
      });
    });
  }
});

// ─── parity: non-readFileSync-derived receivers — both rules stay silent ────

describe('readfilesync-trace parity: non-readFileSync-derived receivers — both rules agree on zero', () => {
  for (const fixture of NOT_READFILESYNC_DERIVED_FIXTURES) {
    test(`crlf and unbounded-quantifier both report zero on: ${fixture.name}`, () => {
      ruleTester.run('no-crlf-fragile-split', crlfRule, {
        valid: [
          {
            code: fixture.code,
            filename: 'tests/foo.test.cjs',
          },
        ],
        invalid: [],
      });
      ruleTester.run('no-unbounded-quantifier', quantifierRule, {
        valid: [
          {
            code: fixture.code,
            filename: 'tests/foo.test.cjs',
          },
        ],
        invalid: [],
      });
    });
  }
});

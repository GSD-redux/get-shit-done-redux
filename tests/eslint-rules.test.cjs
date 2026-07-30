'use strict';

/**
 * eslint-rules.test.cjs
 *
 * RuleTester unit tests for the local ESLint rules:
 *   - local/no-source-grep
 *   - local/no-magic-sleep-in-tests
 *   - local/no-elapsed-assertion
 *   - local/no-raw-rmsync-in-tests
 *   - local/no-adhoc-markdown-parsing
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');
const fc = require('fast-check');

const noSourceGrep = require('../eslint-rules/no-source-grep.cjs');
const noMagicSleepInTests = require('../eslint-rules/no-magic-sleep-in-tests.cjs');
const noElapsedAssertion = require('../eslint-rules/no-elapsed-assertion.cjs');
const noRawRmsyncInTests = require('../eslint-rules/no-raw-rmsync-in-tests.cjs');
const noTautologicalAssert = require('../eslint-rules/no-tautological-assert.cjs');
const noAdhocMarkdownParsing = require('../eslint-rules/no-adhoc-markdown-parsing.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── no-source-grep ──────────────────────────────────────────────────────────

describe('no-source-grep rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noSourceGrep.create, 'function');
  });

  test('valid: readFileSync on .md file is allowed', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');
            content.includes('hello');
          `,
          filename: 'tests/foo.test.cjs',
        },
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'config.json'), 'utf-8');
            content.includes('key');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: readFileSync on .cjs source file followed by .includes()', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'), 'utf-8');
            src.includes('someFunction');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('invalid: readFileSync on .cjs source file followed by .match()', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'foo.cjs'), 'utf-8');
            src.match(/pattern/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('valid: file with allow-test-rule annotation is exempt', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          // The allow annotation exempts the whole file
          code: `
            // allow-test-rule: pending migration
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'), 'utf-8');
            src.includes('someFunction');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: require() of a .cjs file is allowed (not readFileSync)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const mod = require('../gsd-core/bin/lib/io.cjs');
            mod.someMethod();
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── no-magic-sleep-in-tests ─────────────────────────────────────────────────

describe('no-magic-sleep-in-tests rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noMagicSleepInTests.create, 'function');
  });

  test('valid: setTimeout used outside tests (no-op since rule only applies to *.test.cjs)', () => {
    // Rule only applies to *.test.cjs files; a non-test filename is always valid
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [
        {
          code: `
            const delay = new Promise(resolve => setTimeout(resolve, 100));
          `,
          filename: 'scripts/some-script.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: Atomics.wait() in test file', () => {
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const shared = new SharedArrayBuffer(4);
            const arr = new Int32Array(shared);
            Atomics.wait(arr, 0, 0, 100);
          `,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'atomicsWaitSleep' }],
        },
      ],
    });
  });

  test('invalid: setTimeout used for synchronization in Promise in test file', () => {
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [],
      invalid: [
        {
          code: `
            async function waitABit() {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          `,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'setTimeoutSync' }],
        },
      ],
    });
  });

  test('valid: setTimeout with callback (not synchronization pattern) in test file', () => {
    // A setTimeout with no second arg or with a callback that does real work
    // is allowed. The rule only flags the await-new-Promise(setTimeout) pattern.
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [
        {
          code: `
            function doSomethingLater(cb) {
              setTimeout(cb, 100);
            }
          `,
          filename: 'tests/some.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── no-elapsed-assertion ─────────────────────────────────────────────────────

describe('no-elapsed-assertion rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noElapsedAssertion.create, 'function');
  });

  test('valid: assert on non-timing property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            const result = { count: 5 };
            assert.equal(result.count, 5);
          `,
          filename: 'tests/foo.test.cjs',
        },
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.success);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: assert on .elapsed property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            const result = { elapsed: 150 };
            assert.ok(result.elapsed < 200);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('invalid: assert on .duration property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.equal(stats.duration, 100);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('invalid: assert on .took property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.took < 500);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('invalid: assert on .ms property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.ms > 0);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('invalid: assert.equal with timing comparison', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.equal(result.elapsed > 0, true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });
});

// ─── no-raw-rmsync-in-tests ──────────────────────────────────────────────────

describe('no-raw-rmsync-in-tests rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noRawRmsyncInTests.create, 'function');
  });

  // ── INVALID cases (must error) ────────────────────────────────────────────

  test('invalid: fs.rmSync() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            fs.rmSync(tmpDir, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
  });

  test('invalid: computed member fs["rmSync"]() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            fs['rmSync'](d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
  });

  test('invalid: destructured rmSync from require("fs") in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const { rmSync } = require('fs');
            rmSync(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
  });

  test('invalid: aliased const del = fs.rmSync; del() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const del = fs.rmSync;
            del(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
  });

  test('invalid: allow-test-rule annotation no longer suppresses this rule (Defect 1 fixed)', () => {
    // A file with // allow-test-rule: <source-grep reason> must still error
    // on raw rmSync calls. The file-level annotation is for no-source-grep only.
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            // allow-test-rule: source-text-is-the-product
            const fs = require('fs');
            fs.rmSync(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
  });

  // ── VALID cases (must NOT error) ──────────────────────────────────────────

  test('valid: helpers.cleanup() in a test file (no error)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const { cleanup } = require('../helpers.cjs');
            cleanup(tmpDir);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: bare rmSync() that is NOT fs-derived (local function) is not flagged', () => {
    // A locally defined function named rmSync must not be flagged — the rule
    // only tracks names that were bound from require("fs").
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const rmSync = () => {};
            rmSync(d);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // NOTE: The inline `// eslint-disable-next-line local/no-raw-rmsync-in-tests -- reason`
  // escape hatch is handled entirely by ESLint's own disable-comment mechanism and
  // cannot be unit-tested here via RuleTester (RuleTester runs the rule under a
  // different internal namespace so the comment's rule-id doesn't match). The escape
  // hatch works correctly when ESLint processes real files via `npx eslint`.

  test('valid: fs.rmSync() in a non-test file (rule is inert outside *.test.cjs)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const fs = require('fs');
            fs.rmSync(tmpDir, { recursive: true, force: true });
          `,
          filename: 'scripts/foo.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: member access / assignment without calling (not a CallExpression)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const orig = fs.rmSync;
            fs.rmSync = orig;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── no-tautological-assert ──────────────────────────────────────────────────

describe('no-tautological-assert rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noTautologicalAssert.create, 'function');
  });

  // ── VALID cases (must NOT error) ──────────────────────────────────────────

  test('valid: assert.ok with a non-literal identifier argument', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.strictEqual with mixed literal/identifier arguments', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.strictEqual(actual, true);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.strictEqual with identifier and numeric literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.strictEqual(x, 5);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.ok with a CallExpression argument', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(fn());
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.deepStrictEqual with two identifier arguments', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.deepStrictEqual(got, expected);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.strictEqual with two different identifier arguments', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.strictEqual(a, b);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── INVALID cases (must error) ────────────────────────────────────────────

  test('invalid: assert.ok(true) — always-truthy boolean literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert(true) — bare assert with always-truthy boolean literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert');
            assert(true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert.ok(1) — always-truthy non-zero numeric literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(1);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert.ok("always") — always-truthy non-empty string literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok('always');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert.ok([]) — always-truthy array literal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok([]);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert.ok(cond || true) — logical OR whose right side is true', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(cond || true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert.strictEqual(true, true) — identical boolean literals', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.strictEqual(true, true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalEquality' }],
        },
      ],
    });
  });

  test('invalid: assert.equal(1, 1) — identical numeric literals', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.equal(1, 1);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalEquality' }],
        },
      ],
    });
  });

  // ── Fix #3: true || cond (left-side true) ────────────────────────────────

  test('invalid: assert.ok(true || x) — left side is literal true (always short-circuits)', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(true || x);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  test('invalid: assert(true || y) — bare assert, left side is literal true', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert');
            assert(true || y);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalTruthiness' }],
        },
      ],
    });
  });

  // ── Fix #4: empty [] / {} deep-equality ──────────────────────────────────

  test('invalid: assert.deepStrictEqual([], []) — two empty arrays are always deep-equal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.deepStrictEqual([], []);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalEquality' }],
        },
      ],
    });
  });

  test('invalid: assert.deepStrictEqual({}, {}) — two empty objects are always deep-equal', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.deepStrictEqual({}, {});
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'tautologicalEquality' }],
        },
      ],
    });
  });

  // ── Conservative: non-empty arrays/objects must NOT be flagged ────────────

  test('valid: assert.deepStrictEqual([1], [2]) — non-empty arrays with different content are not flagged', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.deepStrictEqual([1], [2]);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.deepStrictEqual(got, expected) — identifier arguments are not flagged', () => {
    ruleTester.run('no-tautological-assert', noTautologicalAssert, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.deepStrictEqual(got, expected);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── no-adhoc-markdown-parsing ───────────────────────────────────────────────

describe('no-adhoc-markdown-parsing rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noAdhocMarkdownParsing.create, 'function');
  });

  // ── POSITIVE cases: flag fence-block-strip and section-collect ────────────

  test('invalid: fence-block-strip regex with triple-backtick and multiline body', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // /```[\s\S]*?```/ — triple-backtick + [\s\S] body → flagged as fenceRegex
          code: String.raw`const stripFences = /` + '```' + String.raw`[\s\S]*?` + '```' + '/;',
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'fenceRegex' }],
        },
      ],
    });
  });

  test('invalid: fence-block-strip regex with triple-tilde and multiline body', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // /~~~[\s\S]*?~~~/ — triple-tilde + [\s\S] body → flagged as fenceRegex
          code: String.raw`const stripTildes = /~~~[\s\S]*?~~~/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'fenceRegex' }],
        },
      ],
    });
  });

  test('invalid: section-collect regex with heading capture, multiline body, heading lookahead', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // /(##\s*X\n)([\s\S]*?)(?=\n##|$)/ — the classic section-collect fingerprint
          code: String.raw`const pat = /(##\s*X\n)([\s\S]*?)(?=\n##|$)/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'sectionCollect' }],
        },
      ],
    });
  });

  // ── NEGATIVE cases: single-line fence tests and heading matches NOT flagged ─

  test('valid: bare single-line fence-opener /^```/ is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: 'const fenceRegex = /^' + '```' + '/;',
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /^\\s*(?:```|~~~)/ fence-line test is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const isFenceLine = /^\s*(?:` + '```' + String.raw`|~~~)/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /^#\\s+/ single-line title-find is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const titleRe = /^#\s+/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /^###\\s+(.+?)\\s*$/ single-line heading-category match is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const headingRe = /^###\s+(.+?)\s*$/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /^(#{1,6})\\s+(.*)/ single-line heading match is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const headingM = line.match(/^(#{1,6})\s+(.*)/);`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: seam usage (no regex, just an import reference) is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `
            const { collectSection } = require('./markdown-sectionizer');
            const result = collectSection(content, 'Introduction');
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: annotated fence-block-strip with allow-adhoc-markdown is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          // Trailing annotation on the same line suppresses the finding
          code:
            'const stripFences = /```' +
            String.raw`[\s\S]*?` +
            '`' +
            '``/; // allow-adhoc-markdown: pre-seam write path; pending migration #1372',
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: rule is inert outside src/*.cts files', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          // Same fence-block-strip regex in a test file → rule does not apply
          code: String.raw`const stripFences = /~~~[\s\S]*?~~~/;`,
          filename: 'tests/some.test.cjs',
        },
        {
          // Same regex in a scripts file → rule does not apply
          code: String.raw`const p = /(##\s*X\n)([\s\S]*?)(?=\n##|$)/;`,
          filename: 'scripts/helper.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── TABLE-REGEX (ADR-2143 §7) ──────────────────────────────────────────────

  test('invalid: table-row/cell regex with escaped pipe and negated-pipe cell class', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // /\|[^|]*\|/ — the classic hand-rolled table-row/cell scan fingerprint
          code: String.raw`const rowRe = /\|[^|]*\|/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: table-cell regex with escaped-pipe class variant [^\\|]', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellRe = /\|\s*([^\|]+)\s*\|/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: parseMarkdownTable() seam call is NOT flagged (no regex literal)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `
            const { parseMarkdownTable } = require('./markdown-table');
            const result = parseMarkdownTable(sectionText);
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: escaped pipe alone (no negated-pipe cell class) is NOT flagged', () => {
    // A bare delimiter probe like /^\|/ or /\|\|/ has an escaped pipe but no
    // [^|] cell-capture class — not a table-row/cell scan, so it must stay
    // conservative and not fire.
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const isPipeDelim = /^\|/;`,
          filename: 'src/some-module.cts',
        },
        {
          code: String.raw`const orDelim = /a\|b/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: annotated table-regex with allow-adhoc-markdown is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = /\|[^|]*\|/; // allow-adhoc-markdown: not a table scan, protocol-marker probe`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: table-regex in a non-src/*.cts file is not flagged (rule is inert there)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = /\|[^|]*\|/;`,
          filename: 'scripts/helper.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── TABLE-REGEX via new RegExp(<Literal-string | TemplateLiteral>) (#2143 Phase 4) ─

  test('invalid: new RegExp(<string literal>) matching the table fingerprint', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // new RegExp('\|[^|]*\|') — doubled backslashes cook to a literal \|
          code: String.raw`const rowRe = new RegExp('\\|[^|]*\\|');`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: new RegExp(<template literal>) whose STATIC quasis match the table fingerprint (dynamic segment ignored)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // new RegExp(`^(\|\s*${phase}\.?\s[^|]*(?:\|[^\n]*))$`) — the exact
          // roadmap.cts/phase.cts tableRowPattern shape, dynamic ${phase} in the middle.
          code: 'const tableRowPattern = new RegExp(`^(\\\\|\\\\s*${phase}\\\\.?\\\\s[^|]*(?:\\\\|[^\\\\n]*))$`, \'im\');',
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: new RegExp(`## Phase ${x}`) — dynamic heading pattern, static quasis are not table/section (non-table)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: 'const headingRe = new RegExp(`## Phase ${x}`, \'i\');',
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: new RegExp(someIdentifier) — pattern built elsewhere and referenced by variable is out of scope for this check', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `
            const pattern = buildRowPattern();
            const rowRe = new RegExp(pattern, 'im');
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── new RegExp(identifier) resolved via resolveVariableInit scope walk (#2245 recall-hole fix) ─

  test('invalid: new RegExp(identifier) resolves a const-declared identifier whose pattern matches the table fingerprint', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // const tablePattern = '\|[^|]*\|' (doubled backslashes cook to a literal \|),
          // then new RegExp(tablePattern) — the pattern is built one hop away via a
          // const-declared identifier instead of inline, which used to escape the
          // fingerprint check entirely (the recall hole this fix closes).
          code: String.raw`
            const tablePattern = '\\|[^|]*\\|';
            const rowRe = new RegExp(tablePattern);
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: new RegExp(identifier) resolves a const-declared identifier whose pattern is NOT table-shaped', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `
            const headingPattern = '## Phase';
            const headingRe = new RegExp(headingPattern);
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: new RegExp(identifier) does NOT resolve a function-parameter identifier (documented boundary)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`
            function buildRowRegex(tablePattern) {
              return new RegExp(tablePattern);
            }
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: annotated new RegExp(...) table-regex with allow-adhoc-markdown is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = new RegExp('\\|[^|]*\\|'); // allow-adhoc-markdown: protocol-marker probe, not a table scan`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: new RegExp(...) table-regex in a non-src/*.cts file is not flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = new RegExp('\\|[^|]*\\|');`,
          filename: 'scripts/helper.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── ADHOC-REPLACE-MUTATION: .replace() on a roadmap/state receiver (#2143 Phase 4) ─

  test('invalid: roadmapContent.replace(<inline table-fingerprint literal>, ...) trips both the CallExpression and Literal detectors', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`roadmapContent.replace(/\|[^|]*\|/, 'x');`,
          filename: 'src/some-module.cts',
          // CallExpression is the outer/enter-first node; its Literal argument
          // (visited next, on descent) is a second, independent finding.
          errors: [{ messageId: 'adhocReplaceMutation' }, { messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: stateContent.replace(<variable holding a table-fingerprint regex>, ...) resolves the variable via scope', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`
            const rowRe = /\|[^|]*\|/;
            stateContent.replace(rowRe, 'x');
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }, { messageId: 'adhocReplaceMutation' }],
        },
      ],
    });
  });

  test('valid: withSection(...) call is NOT a .replace() and is never flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `
            const { withSection } = require('./markdown-sectionizer');
            const result = withSection(content, 'x', (body) => body);
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: foo.replace(/x/, "y") — neither the receiver name nor the pattern match, not flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `foo.replace(/x/, 'y');`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: state.replace(/x/, "y") — matching receiver name but non-matching pattern, not flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: `state.replace(/x/, 'y');`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: allow-adhoc-markdown suppresses an inline ad-hoc .replace() mutation', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`roadmapContent.replace(/\|[^|]*\|/, 'x'); // allow-adhoc-markdown: pre-seam write path`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: .replace() ad-hoc mutation in a non-src/*.cts file is not flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`roadmapContent.replace(/\|[^|]*\|/, 'x');`,
          filename: 'scripts/helper.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── TABLE-REGEX widening: [^|\n] and escaped-pipe-plus-others classes (#2880) ──

  test('invalid: content.replace(<inline [^|\\n] cell-class regex>) — the exact shape that evaded the rule before #2880', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // /\|[^|\n]*\|/ — pipe-excluding cell class ALSO excludes newline; this
          // is the src/state-document.cts shape that the sole-member-class check
          // missed prior to the #2880 widening.
          code: String.raw`content.replace(/\|[^|\n]*\|/, 'x');`,
          filename: 'src/state-document.cts',
          // CallExpression is the outer/enter-first node (adhocReplaceMutation);
          // its Literal argument (visited next, on descent) is the second,
          // independent tableRegex finding — same ordering as the established
          // roadmapContent.replace(...) case above.
          errors: [{ messageId: 'adhocReplaceMutation' }, { messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: factory function returning new RegExp(<template literal with [^|\\n] cell class>)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: 'function buildRowPattern() {\n  return new RegExp(`\\\\|[^|\\\\n]*\\\\|`, \'im\');\n}',
          filename: 'src/state-document.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: cell class with the pipe escaped alongside another excluded member [^\\|\\n]', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellRe = /\|[^\|\n]*\|/;`,
          filename: 'src/state-document.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: negated class with NO pipe at all is not a cell scan (e.g. /^[^\\n]*$/)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`content.replace(/^[^\n]*$/, 'x');`,
          filename: 'src/state-document.cts',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: body.replace(...) — non-matching receiver name (bounded withSection callback) suppresses ONLY adhocReplaceMutation; the regex literal itself is still an independent tableRegex finding', () => {
    // The ADHOC-REPLACE-MUTATION check is scoped to receivers matching
    // /roadmap|state|reqContent|content/i — "body" (the withSection callback
    // parameter name) does not match, so no adhocReplaceMutation fires here.
    // But the standalone Literal visitor inspects EVERY regex literal in the
    // file regardless of call-site context, so the pipe-excluding-class regex
    // is still caught as a bare tableRegex finding either way.
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`body.replace(/\|[^|\n]*\|/, 'x');`,
          filename: 'src/state-document.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: allow-adhoc-markdown suppresses the widened [^|\\n] shape', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`content.replace(/\|[^|\n]*\|/, 'x'); // allow-adhoc-markdown: reason`,
          filename: 'src/state-document.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── TABLE-REGEX narrowing: negated class excluding pipe + something ELSE
  //    is a different (non-table) idiom, not flagged (#2880 FIX 4) ───────────

  test('valid: [^\\s|] (pipe excluded alongside \\s, not a pure line-terminator class) is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const re = /[^\s|]+\|cmd/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: [^"|] (pipe excluded alongside a quote) is NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const re = /\|[^"|]*\|/;`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: [^|\\r\\n] (pipe plus only line-terminator escapes) IS flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const rowRe = /\|[^|\r\n]*\|/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('performance: a 256000-char adversarial regex-literal source does not hang the rule (ReDoS regression)', () => {
    // The previous regex-based fingerprint, /\[\^[^\]]*\\?\|[^\]]*\]/, was
    // quadratic on failure — an unclosed negated class of this size took
    // ~23s. The single-pass scanner must stay linear. The adversarial text is
    // embedded directly inside a single string-literal argument to
    // `new RegExp(...)` (not built via `+` at the source-code level under
    // test) so `getNewRegExpSource` actually resolves it and the scanner
    // walks the full 256000-char unclosed negated class.
    const bigPipeRun = '|'.repeat(256000);
    const code = `const re = new RegExp('\\\\|[^${bigPipeRun}');`;
    // The 256000-char input is the regression guard for the O(n^2) scan fixed
    // in #2880: the pre-fix regex took ~23s on this input. There is deliberately
    // no elapsed-time assertion (banned by local/no-elapsed-assertion and flaky
    // by nature) — if the quadratic path is ever reintroduced this test stops
    // completing, which surfaces as a suite timeout rather than a silent pass.
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── property test: negated-pipe-class scanner (hasQualifyingNegatedPipeClass) ──
  test('property: single-pass negated-class scanner verdict matches an independent reference implementation', () => {
    // hasQualifyingNegatedPipeClass is a closure private to the rule's
    // `create(context)` — it cannot be called directly, so it is exercised
    // through the public surface: `new RegExp(<string literal>)` feeds
    // `arg.value` through UNCHANGED as the "effective regex source" (see
    // getNewRegExpSource), so any generated string, however malformed as a
    // real regex, reaches the scanner byte-for-byte via JSON.stringify(...).
    // A guaranteed literal `\|` is prepended so isTableRegexSource's OTHER
    // gate (`src.includes('\\|')`) is always satisfied — the property is then
    // solely a probe of the negated-class scanner's own verdict, matching the
    // instruction to test the scanner in isolation.
    //
    // Reference implementation (independent tokenizer, NOT a copy of the
    // scanner under test): tokenize `src` once into {esc, text} units,
    // tracking escapes; then walk the tokens with a MONOTONIC cursor: on
    // finding a `[` char-token immediately followed by a `^` char-token,
    // consume forward to the first unescaped `]` (or to the end if there is
    // none) as a single committed unit, decide qualification for that unit,
    // and resume scanning strictly AFTER whatever was consumed — a class
    // candidate found INSIDE an already-consumed (opened) class body is
    // never separately reconsidered. Qualifies iff the collected body
    // contains a pipe (bare `|` or escaped `\|`) AND every other member is
    // one of the escapes `\n`, `\r`, `\t`.
    function referenceHasQualifyingNegatedPipeClass(src) {
      const tokens = [];
      let i = 0;
      while (i < src.length) {
        if (src[i] === '\\') {
          const next = i + 1 < src.length ? src[i + 1] : '';
          tokens.push({ esc: true, text: next });
          i += 2;
        }
        else {
          tokens.push({ esc: false, text: src[i] });
          i += 1;
        }
      }
      let t = 0;
      while (t < tokens.length) {
        const opensClass = !tokens[t].esc && tokens[t].text === '['
          && t + 1 < tokens.length && !tokens[t + 1].esc && tokens[t + 1].text === '^';
        if (!opensClass) {
          t += 1;
          continue;
        }
        let u = t + 2;
        const members = [];
        let closed = false;
        while (u < tokens.length) {
          const tok = tokens[u];
          if (!tok.esc && tok.text === ']') {
            closed = true;
            u += 1;
            break;
          }
          members.push(tok);
          u += 1;
        }
        if (closed) {
          let hasPipe = false;
          let isPure = true;
          for (const m of members) {
            if (!m.esc && m.text === '|') {
              hasPipe = true;
              continue;
            }
            if (m.esc && m.text === '|') {
              hasPipe = true;
              continue;
            }
            if (m.esc && (m.text === 'n' || m.text === 'r' || m.text === 't')) continue;
            isPure = false;
          }
          if (hasPipe && isPure) return true;
        }
        // Monotonic advance: whether this candidate qualified, failed, or
        // ran off the end unclosed, never re-enter the bytes just consumed.
        t = closed ? u : tokens.length;
      }
      return false;
    }

    // Composed of random characters PLUS randomly inserted `[^...]` classes
    // with and without pipes (some closed, some not; some qualifying, some
    // not) so both the "flagged" and "not flagged" verdicts are well
    // exercised — a purely uniform character soup almost never assembles a
    // well-formed `[^...|...]` class by chance.
    const pipeMemberArb = fc.constantFrom('|', '\\|');
    const pureFillerArb = fc.constantFrom('\\n', '\\r', '\\t');
    const impureFillerArb = fc.constantFrom('a', 'Z', '1', '\\s', '\\d', '\\w', '\\\\', '-', ' ', '\\]', '\\[');
    const classMemberArb = fc.oneof(pipeMemberArb, pureFillerArb, impureFillerArb);
    const classBodyArb = fc.array(classMemberArb, { minLength: 1, maxLength: 3 }).map((members) => members.join(''));
    const classChunkArb = fc
      .record({ body: classBodyArb, closed: fc.boolean() })
      .map(({ body, closed }) => '[^' + body + (closed ? ']' : ''));
    const noiseCharArb = fc.constantFrom('[', ']', '^', 'x', 'y', '0', '9', ' ', '.', '-', '(', ')');
    const escapeChunkArb = fc
      .tuple(fc.constant('\\'), fc.constantFrom('n', 'r', 't', '|', 's', 'd', '\\', '[', ']', '^', 'a'))
      .map(([bs, c]) => bs + c);
    const chunkArb = fc.oneof(
      { weight: 5, arbitrary: classChunkArb },
      { weight: 2, arbitrary: escapeChunkArb },
      { weight: 2, arbitrary: noiseCharArb },
    );
    const srcArb = fc.array(chunkArb, { minLength: 0, maxLength: 5 }).map((chunks) => chunks.join(''));

    fc.assert(
      fc.property(srcArb, (fuzzed) => {
        const src = '\\|' + fuzzed;
        const expected = referenceHasQualifyingNegatedPipeClass(src);
        const code = `const re = new RegExp(${JSON.stringify(src)});`;
        if (expected) {
          ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
            valid: [],
            invalid: [
              {
                code,
                filename: 'src/some-module.cts',
                errors: [{ messageId: 'tableRegex' }],
              },
            ],
          });
        }
        else {
          ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
            valid: [{ code, filename: 'src/some-module.cts' }],
            invalid: [],
          });
        }
      }),
      { numRuns: 200, seed: 2880 },
    );
  });
});

'use strict';

/**
 * no-path-literal-in-assert.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-path-literal-in-assert ESLint rule.
 * Mirrors the style of tests/eslint-rules.test.cjs.
 *
 * Rule: report when a path-returning call (path.join, getGlobalConfigDir, …)
 * is compared to a hardcoded POSIX-slash literal in an assert.*() or
 * expect(…).<matcher>() assertion — a DEFECT that fails on Windows.
 *
 * VALID (no report) when:
 *   - the path operand is wrapped by a POSIX normalizer (.replace, .replaceAll, toPosixPath, etc.)
 *   - the assertion is inside a Windows-excluded block (process.platform !== 'win32' guard,
 *     early-return guard, hoisted isWindows guard)
 *   - both operands are path calls (no slash literal involved)
 *   - the string literal has no slash (file-name only)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const noPathLiteralInAssert = require('../eslint-rules/no-path-literal-in-assert.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-path-literal-in-assert rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof noPathLiteralInAssert.meta, 'object');
    assert.strictEqual(typeof noPathLiteralInAssert.create, 'function');
    assert.strictEqual(noPathLiteralInAssert.meta.type, 'problem');
    assert.ok(noPathLiteralInAssert.meta.messages.pathLiteral);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('no-path-literal-in-assert invalid cases', () => {
  test('invalid: assert.strictEqual(path.join(a,b), "/x/y")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(path.join(a, b), '/x/y');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: assert.equal(getGlobalConfigDir("claude"), "/custom/claude")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(getGlobalConfigDir('claude'), '/custom/claude');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: assert.deepStrictEqual(path.resolve(x), "/a/b")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.deepStrictEqual(path.resolve(x), '/a/b');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: reversed operands — assert.equal("/x/y", path.join(a,b))', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal('/x/y', path.join(a, b));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: expect(path.resolve(x)).toBe("/a/b")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `expect(path.resolve(x)).toBe('/a/b');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: multi-line assert.strictEqual', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `
            assert.strictEqual(
              path.join(base, 'dir'),
              '/home/user/dir'
            );
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: assert.equal(os.homedir(), "/home/user")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(os.homedir(), '/home/user');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: assert.equal(os.tmpdir(), "/tmp")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(os.tmpdir(), '/tmp');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: expect(getGlobalConfigDir("claude")).toEqual("/custom/claude")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `expect(getGlobalConfigDir('claude')).toEqual('/custom/claude');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid: assert.deepEqual(path.normalize(x), "/a/b/c")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.deepEqual(path.normalize(x), '/a/b/c');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  // ── #2764: membership / substring checks over a path-returning receiver ──
  // The equality-only visitor missed these; they pass lint and fail on Windows.

  test('invalid (#2764): assert.ok(path.relative(R,f).includes("a/b"))', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(path.relative(ROOT, f).includes('a/b'));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid (#2764): .map(f => path.relative(...)) hop then .includes (the #2728 shape)', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(arr.map(f => path.relative(ROOT, f)).includes('a/b'));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid (#2764): path.join(...).indexOf("a/b") !== -1', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(path.join(a, b).indexOf('a/b') !== -1);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid (#2764): path.resolve(...).startsWith("a/b")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(path.resolve(x).startsWith('a/b'));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid (#2764): path.resolve(...).endsWith("a/b")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(path.resolve(x).endsWith('a/b'));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('invalid (#2764): path.resolve(...).match(/a\\/b/) — regex with a slash', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(path.resolve(x).match(/a\\/b/));`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation expected) ─────────────────────────────────────

describe('no-path-literal-in-assert valid cases', () => {
  test('valid: normalized with String(path.join).replace(/\\\\/g, "/")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(String(path.join(a, b)).replace(/\\\\/g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: normalized with String(path.join).replace(/[\\\\/]/g, "/")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(String(path.join(a, b)).replace(/[\\\\/]/g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: normalized with path.join().replaceAll(path.sep, "/")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(path.join(a, b).replaceAll(path.sep, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal("foo", "foo") — no path call, no slash difference', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal('foo', 'foo');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(path.basename(p), "file.txt") — string has no slash', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(path.basename(p), 'file.txt');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: both operands are path calls — no slash literal', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(path.join(a, b), path.join(c, d));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: guarded by if (process.platform !== "win32") { ... }', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `
            if (process.platform !== 'win32') {
              assert.equal(path.join(a, b), '/x/y');
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: early-return guard — if (process.platform === "win32") return; assert.equal(path.join(a,b), "/x/y")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `
            if (process.platform === 'win32') return;
            assert.equal(path.join(a, b), '/x/y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: hoisted isWindows guard — const isWindows = process.platform === "win32"; if (!isWindows) assert.equal(...)', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `
            const isWindows = process.platform === 'win32';
            if (!isWindows) assert.equal(path.join(a, b), '/x/y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.ok(path.join(a,b)) — not an equality assert', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.ok(path.join(a, b));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: URL string starting with https:// is not flagged', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(getUrl(), 'https://example.com/path');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: normalized with toPosixPath(path.join(a,b))', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(toPosixPath(path.join(a, b)), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── #2764: membership checks that must NOT trigger ──

  test('valid (#2764): normalized receiver .includes("a/b") — POSIX normalizer suppresses', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.ok(path.relative(ROOT, f).replace(/\\\\/g, '/').includes('a/b'));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (#2764): non-path string receiver .includes("a/b")', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.ok('plain string'.includes('a/b'));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (#2764): path receiver .includes(arg-with-no-slash)', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.ok(path.relative(ROOT, f).includes('foo'));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (#2764): path receiver .match(regex-with-no-slash)', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.ok(path.resolve(x).match(/^home/));`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (#2764): membership inside a Windows-excluded platform guard', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `if (process.platform !== 'win32') { assert.ok(path.relative(ROOT, f).includes('a/b')); }`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── C1: isPosixNormalizerCall must require backslash-targeting regex ─────────
// The fix: .replace(/foo/g,'/') and .replace(/\//g,'/') must NOT suppress the rule.
// Before the fix, ANY <x>.replace(/<anything>/g, '/') was accepted as a normalizer
// and would suppress the violation even when the regex did not target backslashes.

describe('C1 — isPosixNormalizerCall backslash-targeting requirement', () => {
  test('C1 INVALID: path.join().replace(/foo/g, "/") is NOT a POSIX normalizer — flagged', () => {
    // Before C1 fix: was NOT flagged (any regex with g flag was accepted as normalizer).
    // After C1 fix: IS flagged (/foo/g does not target backslashes → not a normalizer;
    // rule now peels the non-normalizer method chain and finds path.join inside).
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(path.join(a,b).replace(/foo/g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('C1 INVALID: path.join().replace(/\\//g, "/") targets forward-slash only — flagged', () => {
    // Before C1 fix: was NOT flagged.
    // After C1 fix: IS flagged (/\//g matches forward-slash only, not backslash → not a normalizer).
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(path.join(a,b).replace(/\\//g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'pathLiteral' }],
        },
      ],
    });
  });

  test('C1 VALID: path.join().replace(/\\\\/g, "/") IS a proper POSIX normalizer — NOT flagged', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(path.join(a,b).replace(/\\\\/g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('C1 VALID: path.join().replace(/[\\\\/]/g, "/") IS a proper POSIX normalizer — NOT flagged', () => {
    ruleTester.run('no-path-literal-in-assert', noPathLiteralInAssert, {
      valid: [
        {
          code: `assert.equal(path.join(a,b).replace(/[\\\\/]/g, '/'), '/x/y');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

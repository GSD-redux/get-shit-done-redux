'use strict';

/**
 * require-full-tmpdir-triad.rule.test.cjs
 *
 * RuleTester unit tests for the local/require-full-tmpdir-triad ESLint rule.
 *
 * Rule: flag a TMPDIR environment override — direct process.env.TMPDIR
 * assignment, or a TMPDIR property inside a child-process env: object
 * literal — that is not accompanied by TEMP and TMP in the same scope
 * (DEFECT.WINDOWS-TEST-PORTABILITY, the #4220 masked child-env bug: Node's
 * os.tmpdir() never reads TMPDIR on Windows).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/require-full-tmpdir-triad.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('require-full-tmpdir-triad rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.missingTempTmp, 'missingTempTmp message must exist');
  });
});

// ─── Shape 1: direct process.env.TMPDIR assignment ────────────────────────────

describe('require-full-tmpdir-triad: direct assignment shape', () => {
  test('invalid: process.env.TMPDIR = X with no TEMP/TMP anywhere', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `process.env.TMPDIR = outer;`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingTempTmp' }],
        },
      ],
    });
  });

  test('invalid: process.env["TMPDIR"] = X with only TEMP set (TMP missing)', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `
            process.env['TMPDIR'] = outer;
            process.env.TEMP = outer;
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingTempTmp' }],
        },
      ],
    });
  });

  test('valid: process.env.TMPDIR assigned AND TEMP AND TMP also assigned', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `
            process.env.TMPDIR = outer;
            process.env.TEMP = outer;
            process.env.TMP = outer;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: no TMPDIR assignment at all', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `const t = process.env.TMPDIR;`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: multiple TMPDIR assignments — all reported when TEMP/TMP absent', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `
            process.env.TMPDIR = a;
            process.env.TMPDIR = b;
          `,
          filename: 'tests/foo.test.cjs',
          errors: [
            { messageId: 'missingTempTmp' },
            { messageId: 'missingTempTmp' },
          ],
        },
      ],
    });
  });
});

// ─── Shape 2: object-literal env override passed to a spawn-like call ────────

describe('require-full-tmpdir-triad: child-process env object-literal shape', () => {
  test('invalid: the real #4220 shape — runNode(..., { env: { ...process.env, TMPDIR: outer } })', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `const r = runNode(['-e', probe], { timeoutMs: 30000, env: { ...process.env, TMPDIR: outer } });`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingTempTmp' }],
        },
      ],
    });
  });

  test('invalid: child_process.spawnSync with TMPDIR-only env', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const { spawnSync } = require('child_process');
            spawnSync('node', ['-e', 'x'], { env: { ...process.env, TMPDIR: outer } });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingTempTmp' }],
        },
      ],
    });
  });

  test('invalid: execFileSync with TMPDIR-only env', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const cp = require('child_process');
            cp.execFileSync('node', [], { env: { TMPDIR: outer } });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingTempTmp' }],
        },
      ],
    });
  });

  test('valid: the real fixed shape — TMPDIR, TEMP, and TMP all in the same env literal', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `const r = runNode(['-e', probe], { timeoutMs: 30000, env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer } });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: env object with no TMPDIR key at all', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `runNode(['-e', probe], { env: { ...process.env, FOO: 'bar' } });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: a spawn-like call with no env option at all', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `require('child_process').spawnSync('node', ['-v']);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: an unrelated call with an object literal containing TMPDIR is not a spawn — stays silent', () => {
    ruleTester.run('require-full-tmpdir-triad', rule, {
      valid: [
        {
          code: `buildConfig({ env: { TMPDIR: outer } });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

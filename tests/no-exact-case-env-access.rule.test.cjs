'use strict';

/**
 * no-exact-case-env-access.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-exact-case-env-access ESLint rule.
 * Ids (V1-V14, I1-I8) map to the case list in the #3624 dispatch brief.
 *
 * RuleTester feeds fixtures to the rule directly and does not scan this test
 * file's own source, so the self-flagging problem that forced eslint.config.mjs
 * to carve the eslint-rules directory out of the scripts .cjs block does not
 * arise here (ADR-1703 rule 5).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-exact-case-env-access.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

const OUTSIDE_SEAM_FILE = 'src/some-other-module.cts';
const SEAM_FILE = 'src/shell-command-projection.cts';

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-exact-case-env-access rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.exactCaseEnvRead, 'exactCaseEnvRead message must exist');
  });
});

// ─── VALID cases (V1-V14) ───────────────────────────────────────────────────

describe('no-exact-case-env-access: valid cases', () => {
  test('V1: process.env.PATH', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = process.env.PATH;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V2: process.env['PATH']", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = process.env['PATH'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V3: process['env'].PATH", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = process['env'].PATH;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V4: process['env']['PATH']", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = process['env']['PATH'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V5: const { PATH } = process.env;', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const { PATH } = process.env;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V6: config.path — unrelated object, dot, lowercase path (real false-positive class)', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = config.path;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V7: artifact['path'] — unrelated object, bracket, lowercase path (real false-positive class)", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = artifact['path'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V8: const { path } = someConfig; — destructuring an unrelated field from a non-env-shaped source', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const { path } = someConfig;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V9: env[someVar] — computed non-literal key, not statically decidable', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const v = env[someVar];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V10: opts.env.NODE_ENV — env-shaped receiver but name outside the vocab', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const v = opts.env.NODE_ENV;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V11: process.env.PATHEXT in src/shell-command-projection.cts — seam exemption', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const ext = process.env.PATHEXT;`,
          filename: SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V12: opts.env['PATH'] in src/shell-command-projection.cts — seam exemption applies even to a real violation shape", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = opts.env['PATH'];`,
          filename: SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V13: merged['PATH'] where merged is a bare identifier not named env — documented accepted false-negative", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `merged['PATH'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V14: const { [key]: v } = opts.env; — computed non-literal destructuring key', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const { [key]: v } = opts.env;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V15: envGet(env, "PATH") — the case-insensitive accessor call itself is valid', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [
        {
          code: `const p = envGet(env, 'PATH');`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });
});

// ─── INVALID cases (I1-I8) ──────────────────────────────────────────────────

describe('no-exact-case-env-access: invalid cases', () => {
  test("I1: opts.env['PATH'] — 1 error", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const p = opts.env['PATH'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });

  test('I2: opts.env.pathext — lowercase dot form — 1 error', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = opts.env.pathext;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });

  test("I3: env['Pathext'] — bare env-named identifier, mixed case — 1 error", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = env['Pathext'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });

  test("I4: const env = { ...process.env, ...opts.env }; env['PATH']; — spread-derived, read via env-shaped identifier — 1 error total", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const env = { ...process.env, ...opts.env }; env['PATH'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: 1,
        },
      ],
    });
  });

  test('I5: const { PATHEXT } = opts.env; — 1 error', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const { PATHEXT } = opts.env;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });

  test('I6: const { PATHEXT: exts } = env; — renamed destructuring from a bare env identifier — 1 error', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const { PATHEXT: exts } = env;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });

  test('I7: dot-form AND bracket-form violation in one fixture — 2 errors', () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const a = opts.env.PATH; const b = opts.env['PATHEXT'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: 2,
        },
      ],
    });
  });

  test("I8: const { 'PATH': v } = opts.env; — non-computed string-literal destructuring key — 1 error", () => {
    ruleTester.run('no-exact-case-env-access', rule, {
      valid: [],
      invalid: [
        {
          code: `const { 'PATH': v } = opts.env;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'exactCaseEnvRead' }],
        },
      ],
    });
  });
});


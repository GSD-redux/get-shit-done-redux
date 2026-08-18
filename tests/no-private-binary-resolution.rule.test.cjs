'use strict';

/**
 * no-private-binary-resolution.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-private-binary-resolution ESLint rule.
 * Ids (V1-V8, I1-I9) map to .gsd/phase/chore-3619-no-bare-binary-spawn/50-test-matrix.md.
 *
 * RuleTester feeds fixtures to the rule directly and does not scan this test
 * file's own source, so the self-flagging problem that forced eslint.config.mjs
 * to carve the eslint-rules directory out of the scripts .cjs block does not
 * arise here (ADR-1703 rule 5 / 40-design.md).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-private-binary-resolution.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

const OUTSIDE_SEAM_FILE = 'src/some-other-module.cts';
const SEAM_FILE = 'src/shell-command-projection.cts';

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-private-binary-resolution rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.pathextRead, 'pathextRead message must exist');
    assert.ok(rule.meta.messages.extensionList, 'extensionList message must exist');
  });
});

// ─── VALID cases (V1-V8) ────────────────────────────────────────────────────

describe('no-private-binary-resolution: valid cases', () => {
  test('V1: process.env.PATHEXT in src/shell-command-projection.cts — the seam is exempt', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const ext = process.env.PATHEXT;`,
          filename: SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V2: ['.exe'] — one extension is classification, not a candidate list", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const exts = ['.exe'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V3: p.endsWith('.cmd') — one extension", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const isCmd = p.endsWith('.cmd');`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V4: scriptPath.replace(/\\.js$/, '.cmd') — shim-path derivation (runtime-hooks-surface.cts shape)", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const shimPath = scriptPath.replace(/\\.js$/, '.cmd');`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V5: pathEnv.split(path.delimiter) — PATH scans are deliberately not flagged', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const segments = pathEnv.split(path.delimiter);`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test('V6: process.env.PATH — only PATHEXT is the signal', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const p = process.env.PATH;`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V7: ['.exe', '.txt'] — one exe extension plus an unrelated one, below the two-or-more threshold", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const exts = ['.exe', '.txt'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });

  test("V8: '.execute'/'.compacting' are substrings only — the src/host-integration.cts:724 false-positive fix", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [
        {
          code: `const OPENCODE_EXTENSION_EVENTS = ['.execute', '.compacting'];`,
          filename: OUTSIDE_SEAM_FILE,
        },
      ],
      invalid: [],
    });
  });
});

// ─── INVALID cases (I1-I9) ──────────────────────────────────────────────────

describe('no-private-binary-resolution: invalid cases', () => {
  test('I1: process.env.PATHEXT outside the seam — 1 error', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = process.env.PATHEXT;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'pathextRead' }],
        },
      ],
    });
  });

  test("I2: process.env['PATHEXT'] — bracket form", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = process.env['PATHEXT'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'pathextRead' }],
        },
      ],
    });
  });

  test("I3: env['Pathext'] — Windows env names are case-insensitive", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = env['Pathext'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'pathextRead' }],
        },
      ],
    });
  });

  test('I4: opts.env.pathext — lower case, non-process receiver', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = opts.env.pathext;`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'pathextRead' }],
        },
      ],
    });
  });

  test("I5: ['a.exe','a.cmd','a.bat','a'] — the deleted fallow-runner shape verbatim", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const candidates = ['a.exe', 'a.cmd', 'a.bat', 'a'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'extensionList' }],
        },
      ],
    });
  });

  test("I6: '.EXE;.CMD;.BAT;.COM' — the deleted gsd-tools shape verbatim", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const exts = '.EXE;.CMD;.BAT;.COM';`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'extensionList' }],
        },
      ],
    });
  });

  test("I7: ['.cmd', '.bat'] — exactly two, the threshold boundary from below", () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const exts = ['.cmd', '.bat'];`,
          filename: OUTSIDE_SEAM_FILE,
          errors: [{ messageId: 'extensionList' }],
        },
      ],
    });
  });

  test('I8: a file that trips BOTH signals — two errors, not one', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `
            const ext = process.env.PATHEXT;
            const candidates = ['a.exe', 'a.cmd'];
          `,
          filename: OUTSIDE_SEAM_FILE,
          errors: 2,
        },
      ],
    });
  });

  test('I9: process.env.PATHEXT in a file whose path merely CONTAINS the seam name as a substring — still errors (path-anchored, not substring-matched)', () => {
    ruleTester.run('no-private-binary-resolution', rule, {
      valid: [],
      invalid: [
        {
          code: `const ext = process.env.PATHEXT;`,
          filename: 'tests/shell-command-projection-dispatch.test.cjs',
          errors: [{ messageId: 'pathextRead' }],
        },
      ],
    });
  });
});

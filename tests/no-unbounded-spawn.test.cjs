'use strict';

/**
 * no-unbounded-spawn.test.cjs
 *
 * RuleTester unit tests for the `local/no-unbounded-spawn` ESLint rule
 * (eslint-rules/no-unbounded-spawn.cjs). Covers matrix sections A, B, C, D of
 * .gsd/phase/chore-3143-no-unbounded-spawn-guard/50-test-matrix.md.
 *
 * All spawn/exec call shapes below are TEST DATA (fixture code strings
 * handed to RuleTester) — none of them are real invocations, and they never
 * execute as real CallExpressions in THIS file's own AST (they live inside
 * string literals), so this file is not itself flaggable by the rule under
 * test.
 *
 * Discrepancy note (A12): 40-design.md / the test matrix state that a
 * locally-declared `function execSync(){}` followed by a bare `execSync(x)`
 * call is clean, because it isn't a `child_process` binding. The rule's
 * actual implementation does not check origin for a bare Identifier call —
 * `getFnName()` returns the raw callee name, and that name is looked up
 * directly against `TARGET_FNS` regardless of whether it was ever resolved
 * through the alias map. Verified empirically against the shipped rule
 * (RuleTester run, see PR discussion): a local `execSync` is FLAGGED, not
 * clean. This file asserts the actual (flagged) behavior rather than the
 * matrix's stated expectation — see A12 below.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester, Linter } = require('eslint');
const path = require('path');
const fs = require('fs');

const rule = require('../eslint-rules/no-unbounded-spawn.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

const FILE = 'tests/foo.test.cjs';

// ─── A. detection ──────────────────────────────────────────────────────────

describe('no-unbounded-spawn: A — detection', () => {
  test('A1/A2/A3/A4: bounded literal timeout is clean; missing/empty options and single-arg are unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `spawnSync(c, a, { timeout: 5000 });`, filename: FILE },
      ],
      invalid: [
        {
          code: `spawnSync(c, a, {});`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
        {
          code: `spawnSync(c, a);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
        {
          code: `spawnSync(c);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A5: execSync without timeout is unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `execSync('git status', { cwd });`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A6: execFileSync without timeout is unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `execFileSync('git', ['status'], { cwd, encoding: 'utf8' });`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A7: member call on a namespace object is matched', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `cp.spawnSync(c, a, {});`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A8: member call on a require() CallExpression is matched (object-blind)', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `require('node:child_process').execFileSync('git',['--version'],{stdio:'ignore'});`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A9: destructured-and-renamed binding is matched', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `const { execSync: exec } = require('node:child_process');\n` +
            `exec('git branch main',{cwd,stdio:'pipe'});`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A10: renamed binding with a timeout is clean', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `const { execSync: exec } = require('node:child_process');\n` +
            `exec('x',{timeout:1000});`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A11: plain destructure, bounded, is clean', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `const { spawnSync } = require('child_process');\n` +
            `spawnSync('git', ['status'], { timeout: 5000 });`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A12: unrelated local named execSync IS matched (name-only matching) — diverges from matrix', () => {
    // See file header: the matrix states "clean"; the shipped rule
    // name-matches bare identifiers regardless of child_process origin, so
    // this actually reports 1 error. Asserting the real behavior here.
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `function execSync(x) { return x; }\nexecSync('foo');`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('seam-routed calls are never flagged (runGit/runNode/runHook/gitOrThrow)', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `runGit(args, { timeoutMs: 5000 });`, filename: FILE },
        { code: `runNode([script], { timeoutMs: 5000 });`, filename: FILE },
        { code: `runHook(HOOK, [], { input: payload, timeoutMs: 5000 });`, filename: FILE },
        { code: `gitOrThrow(['status'], { cwd });`, filename: FILE },
      ],
      invalid: [],
    });
  });

  test('A13: property-name match is deliberately object-blind (documented false positive)', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `db.execSync(q);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });
});

// ─── ceiling escape (allow-spawn-timeout-ceiling) — #3145 matrix section A ──
//
// Rows A1-A13 of .gsd/phase/chore-3145-bound-installer-runtime/50-test-matrix.md.
// (Distinct from the "A — detection" section above, which is #3143's matrix.)

describe('no-unbounded-spawn: ceiling escape (allow-spawn-timeout-ceiling)', () => {
  test('A1: exactly the ceiling is still clean without a marker', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [{ code: `spawnSync(c, a, { timeout: 600000 });`, filename: FILE }],
      invalid: [],
    });
  });

  test('A2: just over the ceiling still reports without a marker', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync(c, a, { timeout: 600001 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A3: a reasoned marker permits an over-ceiling bound', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `// allow-spawn-timeout-ceiling: regen:derived runs a full build\n` +
            `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A4: an empty reason is not an audit trail', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `// allow-spawn-timeout-ceiling:\n` +
            `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A5: whitespace-only reason is rejected', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `// allow-spawn-timeout-ceiling:   \n` +
            `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A6: the marker binds to its own call, not the file', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `// allow-spawn-timeout-ceiling: reason for the first call\n` +
            `spawnSync(c, a, { timeout: 900000 });\n` +
            `spawnSync(c, b, { timeout: 700000 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A7: an inert marker is not itself an error', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `// allow-spawn-timeout-ceiling: reason\n` +
            `spawnSync(c, a, { timeout: 5000 });`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A8: the escape raises the ceiling, it never waives the bound', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `// allow-spawn-timeout-ceiling: reason\n` +
            `spawnSync(c, a, {});`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('A9: marker is recognized above the call', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `// allow-spawn-timeout-ceiling: reason above the call\n` +
            `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A10: marker is recognized inline at the timeout', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code:
            `spawnSync(c, a, {\n` +
            `  // allow-spawn-timeout-ceiling: reason inline at the timeout\n` +
            `  timeout: 900000,\n` +
            `});`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('A11: only a real comment counts as a marker', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code:
            `const note = 'allow-spawn-timeout-ceiling: reason in a string';\n` +
            `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A12: an unrelated marker does not apply', () => {
    // The marker text is built via concatenation, not a string literal, so
    // this file does not itself contain the contiguous exemption-directive
    // text (the no-source-grep marker, name split across the concat below) —
    // the refs linter that guards that directive can't tell fixture data
    // proving non-suppression from a real exemption, and a literal here
    // would be misread as an unreferenced one. Same idiom as GUARDED_RULE
    // in no-unbounded-spawn-allowlist.test.cjs.
    const UNRELATED_MARKER = '// ' + 'allow-test-rule' + ': unrelated escape\n';
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: UNRELATED_MARKER + `spawnSync(c, a, { timeout: 900000 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('A13: the real 900000 site passes with its marker', () => {
    const { ESLint } = require('eslint');
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        plugins: { local: { rules: { 'no-unbounded-spawn': rule } } },
        rules: { 'local/no-unbounded-spawn': ['error', { allowlist: [] }] },
      },
    });
    return eslint
      .lintFiles(['tests/fragment-single-edit-propagation.install.test.cjs'])
      .then((results) => {
        const messages = results[0] ? results[0].messages : [];
        const tooLarge = messages.filter((m) => m.messageId === 'timeoutTooLarge');
        assert.deepEqual(tooLarge, []);
      });
  });
});

// ─── B. the timeout value (Goodhart defenses) ──────────────────────────────

describe('no-unbounded-spawn: B — timeout value boundaries', () => {
  test('B1/B2/B3/B4/B5: zero/negative/null/undefined/NaN timeout are all unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        { code: `spawnSync(c, a, { timeout: 0 });`, filename: FILE, errors: [{ messageId: 'unboundedSpawn' }] },
        { code: `spawnSync(c, a, { timeout: -1 });`, filename: FILE, errors: [{ messageId: 'unboundedSpawn' }] },
        { code: `spawnSync(c, a, { timeout: null });`, filename: FILE, errors: [{ messageId: 'unboundedSpawn' }] },
        { code: `spawnSync(c, a, { timeout: undefined });`, filename: FILE, errors: [{ messageId: 'unboundedSpawn' }] },
        { code: `spawnSync(c, a, { timeout: NaN });`, filename: FILE, errors: [{ messageId: 'unboundedSpawn' }] },
      ],
    });
  });

  test('B6/B7/B8: 1ms, ceiling-1, and exactly the ceiling are all clean', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `spawnSync(c, a, { timeout: 1 });`, filename: FILE },
        { code: `spawnSync(c, a, { timeout: 599999 });`, filename: FILE },
        { code: `spawnSync(c, a, { timeout: 600000 });`, filename: FILE },
      ],
      invalid: [],
    });
  });

  test('B9/B10: over the ceiling and an absurd timeout are both unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync(c, a, { timeout: 600001 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
        {
          code: `spawnSync(c, a, { timeout: 999999999 });`,
          filename: FILE,
          errors: [{ messageId: 'timeoutTooLarge' }],
        },
      ],
    });
  });

  test('B11/B12/B13: non-literal timeout values are trusted as bounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `spawnSync(c, a, { timeout: someVar });`, filename: FILE },
        { code: `spawnSync(c, a, { timeout: opts.t });`, filename: FILE },
        { code: `spawnSync(c, a, { timeout: 5 * 1000 });`, filename: FILE },
      ],
      invalid: [],
    });
  });

  test('B14: computed key is not a resolvable timeout', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync(c, a, { ['time'+'out']: 5000 });`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('B15: string-literal key is a timeout', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `spawnSync(c, a, { 'timeout': 5000 });`, filename: FILE },
      ],
      invalid: [],
    });
  });

  test('B16: duplicate timeout keys resolve to the last', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync(c, a, { timeout: 5000, timeout: 0 });`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });
});

// ─── C. options passed by reference (the seam's own shape) ────────────────

describe('no-unbounded-spawn: C — options by reference', () => {
  test('C1: options held in a const are resolved (the real process-seam.cjs shape)', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code: `const o = { timeout: t }; spawnSync(c, a, o);`,
          filename: FILE,
        },
      ],
      invalid: [],
    });
  });

  test('C2: post-hoc property assignment is not resolved', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `const o = {}; o.timeout = 5; spawnSync(c,a,o);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('C3: resolved options without a timeout are unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `const o = { cwd }; spawnSync(c, a, o);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('C4: unresolvable options binding (function parameter) is unbounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `function f(o) { spawnSync(c, a, o); }`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('C5: reassigned binding is not trusted', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `let o = {timeout:1}; o = {}; spawnSync(c,a,o);`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('C6: spread-only options cannot prove a bound', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync(c, a, { ...opts });`,
          filename: FILE,
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });

  test('C7: spread plus a literal timeout is bounded', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        { code: `spawnSync(c, a, { ...opts, timeout: 5000 });`, filename: FILE },
      ],
      invalid: [],
    });
  });

  test('C8: the process seam does not flag itself', () => {
    // Uses the real ESLint Linter (not RuleTester) against the actual file
    // contents, since this is checking the real implementation, not a
    // synthetic fixture.
    const linter = new Linter({ configType: 'flat' });
    const seamPath = path.join(__dirname, 'helpers', 'process-seam.cjs');
    const code = fs.readFileSync(seamPath, 'utf8');
    const messages = linter.verify(
      code,
      {
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        plugins: { local: { rules: { 'no-unbounded-spawn': rule } } },
        rules: { 'local/no-unbounded-spawn': 'error' },
      },
      { filename: 'tests/helpers/process-seam.cjs' }
    );
    assert.deepEqual(messages, []);
  });
});

// ─── D. allowlist + ratchet (D1-D3 here; D4-D8 in no-unbounded-spawn-allowlist.test.cjs) ─

describe('no-unbounded-spawn: D — allowlist behavior', () => {
  const ALLOWLISTED_ABS = path.join(process.cwd(), 'tests/allowlisted-fixture.test.cjs');
  const ALLOWLISTED_REL = 'tests/allowlisted-fixture.test.cjs';

  test('D1: allowlisted file suppresses its violations', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [
        {
          code: `spawnSync('git', ['status'], {});`,
          filename: ALLOWLISTED_ABS,
          options: [{ allowlist: [ALLOWLISTED_REL] }],
        },
      ],
      invalid: [],
    });
  });

  test('D2: allowlisted file with zero violations reports exactly one stale-entry error', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync('git', ['status'], { timeout: 5000 });`,
          filename: ALLOWLISTED_ABS,
          options: [{ allowlist: [ALLOWLISTED_REL] }],
          errors: [{ messageId: 'staleAllowlistEntry' }],
        },
      ],
    });
  });

  test('D3: non-allowlisted file reports normally', () => {
    ruleTester.run('local/no-unbounded-spawn', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync('git', ['status'], {});`,
          filename: FILE,
          options: [{ allowlist: [ALLOWLISTED_REL] }],
          errors: [{ messageId: 'unboundedSpawn' }],
        },
      ],
    });
  });
});

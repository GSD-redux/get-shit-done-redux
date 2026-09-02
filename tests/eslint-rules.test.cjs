'use strict';

// docs-guard-exempt: 'docs/readme.md' appears only inside literal RuleTester
// fixture `code` strings (sample source text fed to no-source-grep for AST
// linting) — this file never itself reads a real docs/ file off disk.

/**
 * eslint-rules.test.cjs
 *
 * RuleTester unit tests for the local ESLint rules:
 *   - local/no-source-grep
 *   - local/no-magic-sleep-in-tests
 *   - local/no-elapsed-assertion
 *   - local/no-raw-rmsync-in-tests
 *   - local/no-adhoc-markdown-parsing
 *   - local/require-subprocess-timeout
 *   - local/require-registered-exit
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester, ESLint, Linter } = require('eslint');
const path = require('node:path');
const fc = require('fast-check');
const pluginN = require('eslint-plugin-n');

const noSourceGrep = require('../eslint-rules/no-source-grep.cjs');
const noMagicSleepInTests = require('../eslint-rules/no-magic-sleep-in-tests.cjs');
const noElapsedAssertion = require('../eslint-rules/no-elapsed-assertion.cjs');
const noRawRmsyncInTests = require('../eslint-rules/no-raw-rmsync-in-tests.cjs');
const noTautologicalAssert = require('../eslint-rules/no-tautological-assert.cjs');
const noAdhocMarkdownParsing = require('../eslint-rules/no-adhoc-markdown-parsing.cjs');
const noDuplicateFoldMarker = require('../eslint-rules/no-duplicate-fold-marker.cjs');
const requireSubprocessTimeout = require('../eslint-rules/require-subprocess-timeout.cjs');
const requireRegisteredExit = require('../eslint-rules/require-registered-exit.cjs');

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

  test('valid: allow-test-rule annotation adjacent to the read exempts that site (#3508: site-scoped, not file-wide)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          // The marker sits directly above the read+search it suppresses.
          code: `
            const fs = require('fs');
            const path = require('path');
            // allow-test-rule: pending migration
            const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'io.cjs'), 'utf-8'); src.includes('someFunction');
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

// ─── no-source-grep widening (#3502 / Phase 3 of #3464) ─────────────────────
//
// One RuleTester case per row of .gsd/phase/chore-3464-widen-source-grep/
// 50-test-matrix.md. Row numbers in test names refer to that matrix.

describe('no-source-grep rule — widening (#3502)', () => {
  test('row 1: baseline literal .cjs read + .includes() (happy regression)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            src.includes('x');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 2: .cts source read + .match() (gap B)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const ROOT = '/repo';
            const src = fs.readFileSync(path.join(ROOT, 'src', 'verification.cts'), 'utf-8');
            src.match(/x/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 3: .mts source read + .match() (gap B)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const ROOT = '/repo';
            const src = fs.readFileSync(path.join(ROOT, 'src', 'x.mts'), 'utf-8');
            src.match(/x/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 4: .mjs source read + .match() (gap B)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const ROOT = '/repo';
            const src = fs.readFileSync(path.join(ROOT, 'src', 'x.mjs'), 'utf-8');
            src.match(/x/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 5: .matchAll() on a tracked read (gap A)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            src.matchAll(/x/g);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 6: regex.test(tracked) (gap A, argument-side detection)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const re = /x/;
            re.test(src);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 7: /lit/.test(tracked) (gap A, argument-side detection)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            /x/.test(src);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 8: .split() / .replace() probes (gap A)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            src.split('\\n');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            src.replace(/x/, '');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 9: two-hop derived variable (gap C)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            function strip(x) { return x; }
            const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const b = strip(a);
            b.match(/x/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 10: three-hop derived variable — at the depth bound (gap C, boundary)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const b = a;
            const c = b;
            c.includes('x');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 11: hop chain beyond the configured depth is a documented limit (gap C, boundary)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const b = a;
            const c = b;
            const d = c;
            d.includes('x');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 12: shadowed same-name param — false-positive guard (gap D)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const fn = (src) => src.replace(/x/, 'y');
            fn('unrelated');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 13: same name, sibling block scopes — false-positive guard (gap D)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            {
              const c = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            }
            {
              const c = 'x';
              c.includes('y');
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 14: .md literal read + .includes() (negative space, unchanged)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'a.md'), 'utf-8');
            content.includes('x');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 15: .json literal read + .match() (negative space, unchanged)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.json'), 'utf-8');
            content.match(/x/);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 16: dynamic path variable → .includes() — deliberately not flagged (rejected widening)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            function readIt(p) {
              const content = fs.readFileSync(p, 'utf-8');
              content.includes('x');
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 17: tracked read, no text search (negative space, unchanged)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'));
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 18: require() of a .cjs (negative space, unchanged)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const mod = require('../lib/a.cjs');
            mod.someMethod();
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 19: a marker adjacent to the read+search suppresses it (#3508: site-scoped, not file-wide)', () => {
    // The raw marker text is assembled via string concatenation so this
    // FILE's own bytes never contain a contiguous "allow" + "-test-rule:"
    // token (scripts/lint-allow-test-rule-refs.cjs does a raw whole-file
    // substring scan). At RuleTester-run time the concatenation resolves to
    // a real single-line comment, which the rule under test honors normally.
    // The marker sits directly above the read+search (site-scoped, #3508),
    // not merely somewhere earlier in the file (the pre-#3508 file-wide form
    // this row originally exercised).
    const marker = '// ' + 'allow' + '-test-rule: split marker for row 19, see #3502';
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      marker,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('row 20: marker text inside a string literal (not a comment) does not suppress', () => {
    // Same split-marker technique as row 19, applied to a STRING literal
    // (not a comment) — this row exists to prove the rule's suppression
    // check only honors an actual comment, per the #3465 discriminator.
    const stringMarkerLine = "const note = '" + 'allow' + "-test-rule: this is just data, not a directive';";
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      stringMarkerLine,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');",
      'src.includes(note);',
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  // ─── fold + hooks widening (#3545 / Phase 7 of #3464) ─────────────────────
  //
  // One RuleTester case per row of
  // .gsd/phase/chore-3545-fold-hooks-widening-migration/50-test-matrix.md,
  // rows 1-8. Covers `fold` (a bare-Identifier readFileSync
  // path argument resolved ONE hop back to its VariableDeclarator init) and
  // `hooks` (now a recognized source directory alongside bin/lib/gsd-core/src).

  test('#3545 row 1: baseline inline literal src path — unchanged by fold/hooks widening', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'x.cjs'), 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('#3545 row 2: one-hop identifier bound to a src-dir path is now flagged (fold)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const p = path.join(__dirname, '..', 'src', 'x.cjs');
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('#3545 row 3: one-hop identifier bound to a hooks-dir path is now flagged (fold + hooks)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const p = path.join(__dirname, '..', 'hooks', 'x.cjs');
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('#3545 row 4: identifier bound to a non-path value is not flagged (fold negative space)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const p = process.env.FOO;
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3545 row 5: identifier bound to a non-source-extension path is not flagged (fold negative space)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const p = path.join(__dirname, '..', 'src', 'x.md');
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3545 row 6: two-hop indirection is not flagged — fold only resolves one hop (boundary)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const a = path.join(__dirname, '..', 'src', 'x.cjs');
            const p = a;
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3545 row 7: assignment-bound path is not flagged — fold only resolves a VariableDeclarator init (boundary)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            let p;
            p = path.join(__dirname, '..', 'src', 'x.cjs');
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3545 row 8: "hooks" as a substring of a longer quoted segment is not flagged (hasSourceDir requires an exact quoted segment)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const p = path.join(__dirname, '..', 'my-hooks-dir', 'x.cjs');
            const s = fs.readFileSync(p, 'utf-8');
            s.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // One RuleTester case per row of the widen-regex.exec()-detection matrix,
  // epic #3464 phase 8: `regex.exec(tracked)` must be flagged the same way
  // `regex.test(tracked)` already is, sharing the identical
  // looksLikeRegexReceiver / trackedInfo(args[0]) detection path.

  test('#3464p8 row 1: re.exec(trackedSrc) — flagged (new .exec() detection)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const re = /foo/;
            const trackedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'x.cjs'), 'utf8');
            re.exec(trackedSrc);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('#3464p8 row 2: re.test(trackedSrc) — still flagged (unchanged baseline)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const re = /foo/;
            const trackedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'x.cjs'), 'utf8');
            re.test(trackedSrc);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('#3464p8 row 3: re.exec(untrackedString) — not flagged (argument is not source-derived)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const re = /foo/;
            const untrackedString = 'hello';
            re.exec(untrackedString);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3464p8 row 4: someObj.exec(trackedSrc) — not flagged (receiver is not a bare Identifier/regex literal)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const trackedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'x.cjs'), 'utf8');
            getRegex().exec(trackedSrc);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('#3464p8 row 5: re.exec() with zero arguments — not flagged, does not throw', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const re = /foo/;
            re.exec();
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── no-source-grep site-scoped suppression (#3508 / Phase 4 of #3464) ──────
//
// One RuleTester case per row of
// .gsd/phase/chore-3464-site-scoped-suppression/50-test-matrix.md, rows 1-12.
// Row 4 is the one that actually proves the defect is closed: file-wide
// amnesty is gone, so a marker adjacent to one violation must NOT reach an
// unrelated violation later in the same file. Rows 3 and 6 are the
// compatibility guards (prose between marker and read; marker + zero
// violations) that must keep working or this would break the 277
// marker-bearing files that rely on file-level markers being a documented
// no-op when there's nothing to suppress.
//
// Marker text is always assembled via string concatenation (`AT` below) so
// THIS file's raw bytes never contain a contiguous "allow" + "-test-rule:"
// token — same fixture-host discipline as the row 19/20 cases above
// (scripts/lint-allow-test-rule-refs.cjs does a raw whole-file substring
// scan and must not newly count this file).
//
// NOTE: row 9's fixture length is tied to MAX_MARKER_LOOKAHEAD_LINES (8) in
// eslint-rules/no-source-grep.cjs — if that constant changes, this fixture's
// filler-line count must change with it.
// Row 12 ("marker with no #NNN") is explicitly a script-level check, not a
// RuleTester case (test-matrix.md marks it "(script, not RuleTester)") —
// it's covered by `node scripts/lint-allow-test-rule-refs.cjs` instead.

describe('no-source-grep rule — site-scoped suppression (#3508)', () => {
  const AT = 'allow' + '-test-rule:';

  test('row 1: marker directly above the read+search is suppressed (site-scoped)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('row 2: marker trailing on the same line as the search is suppressed', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x'); // ${AT} reason (#1)`,
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('row 3: marker with prose lines between it and the read is still suppressed (repo real-style guard)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      '// continuation prose line one explaining the reason',
      '// continuation prose line two continuing the explanation',
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('row 4: marker adjacent to V1 does NOT reach an unrelated V2 later in the file (the defect this phase closes)', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `// unrelated filler line ${i + 1}, pushing V2 well past the lookahead bound`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason for V1 (#1)`,
      "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s1.includes('x');",
      ...filler,
      "const s2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf-8'); s2.includes('y');",
    ];
    const code = lines.join('\n');
    const v2Line = lines.length; // s2's line is the last line of the fixture
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          // Exactly ONE error, reported at V2 -- V1 stays suppressed, and the
          // marker's reach does NOT extend to the unrelated V2 40 lines later.
          errors: [{ messageId: 'noSourceGrep', line: v2Line }],
        },
      ],
    });
  });

  test('row 5: marker far above a violation with no marker text of its own is not suppressed', () => {
    const filler = Array.from({ length: 100 }, (_, i) => `// unrelated filler line ${i + 1}`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      ...filler,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ];
    const code = lines.join('\n');
    const violationLine = lines.length;
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep', line: violationLine }],
        },
      ],
    });
  });

  test('row 6: file with a marker and zero violations stays green (the 277 inert-marker files compatibility guard)', () => {
    const code = [
      `// ${AT} reason (#1)`,
      "const fs = require('fs');",
      "const path = require('path');",
      "const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');",
      "content.includes('hello');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('row 7: no marker, one violation is flagged (baseline unchanged)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 8: two violations, two adjacent markers -- per-site marking works', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason for V1 (#1)`,
      "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s1.includes('x');",
      `// ${AT} reason for V2 (#1)`,
      "const s2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf-8'); s2.includes('y');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('row 9: marker beyond the lookahead bound does not suppress (the bound is where it claims)', () => {
    // MAX_MARKER_LOOKAHEAD_LINES is 8 in eslint-rules/no-source-grep.cjs.
    // 9 filler comment lines between the marker and the read pushes the gap
    // to 10 lines (> 8), just past the bound.
    const filler = Array.from({ length: 9 }, (_, i) => `// filler comment line ${i + 1}`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      ...filler,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ];
    const code = lines.join('\n');
    const violationLine = lines.length;
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep', line: violationLine }],
        },
      ],
    });
  });

  test('row 10: marker text inside a fixture string (not a real comment) is not a directive', () => {
    // The marker-looking text lives inside a STRING LITERAL in the linted
    // fixture, never as a `//` comment -- ESLint's comment AST (what the
    // rule inspects) never sees string-literal contents, so this must not
    // suppress the real, unmarked violation below it (the #3465 lesson).
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `const note = 'not a directive: ${AT} fake reason';`,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes(note);",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('row 11: marker citing #NNN on the same line still suppresses (citation contract unaffected)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason for this read (#3508)`,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  // ─── read-site suppression (adversarial-review fix, ITEM 1) ────────────
  //
  // A violation is fundamentally about a read+search PAIR. Before this fix,
  // a marker adjacent to the readFileSync() call (the intuitive annotation
  // spot) failed to suppress once the search happened on a later line,
  // because the readFileSync assignment line itself is "real code" and
  // broke comment-purity on the marker->search lookahead path. The rule now
  // also checks a marker's site-scoping against the ORIGINATING read call's
  // own line, independent of the marker->search path.

  test('valid: marker directly above the read, search on the very next (non-comment) line', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      "src.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('valid: marker directly above the read, search several comment-pure lines later (read-line real code no longer breaks the marker->search path)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      '// comment-pure line one',
      '// comment-pure line two',
      '// comment-pure line three',
      "src.includes('x');",
    ].join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('invalid: marker above the read suppresses that pair, but an unrelated tracked variable searched further down is still flagged', () => {
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason for V1 (#1)`,
      "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      "s1.includes('x');",
      "const s2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf8');",
      "s2.includes('y');",
    ];
    const code = lines.join('\n');
    const v2Line = lines.length; // s2.includes(...) is the last line
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep', line: v2Line }],
        },
      ],
    });
  });

  test('invalid: marker far from both the read and the search is still flagged', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `// unrelated filler line ${i + 1}`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      ...filler,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      "s.includes('x');",
    ];
    const code = lines.join('\n');
    const violationLine = lines.length; // s.includes(...) is the last line
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep', line: violationLine }],
        },
      ],
    });
  });

  test('boundary: marker exactly MAX_MARKER_LOOKAHEAD_LINES (8) above the read is suppressed via the read-site path', () => {
    // 7 comment-pure filler lines between the marker and the read puts the
    // read exactly 8 lines below the marker -- the inclusive boundary.
    const filler = Array.from({ length: 7 }, (_, i) => `// filler comment line ${i + 1}`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      ...filler,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      "s.includes('x');",
    ];
    const code = lines.join('\n');
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [{ code, filename: 'tests/foo.test.cjs' }],
      invalid: [],
    });
  });

  test('boundary: marker one line beyond MAX_MARKER_LOOKAHEAD_LINES (9) above the read is not suppressed', () => {
    // 8 comment-pure filler lines between the marker and the read puts the
    // read 9 lines below the marker -- one past the inclusive boundary.
    const filler = Array.from({ length: 8 }, (_, i) => `// filler comment line ${i + 1}`);
    const lines = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${AT} reason (#1)`,
      ...filler,
      "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
      "s.includes('x');",
    ];
    const code = lines.join('\n');
    const violationLine = lines.length; // s.includes(...) is the last line
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep', line: violationLine }],
        },
      ],
    });
  });
});

// ─── no-source-grep hop-propagation value-shape (adversarial-review fix) ────
//
// minTrackedHop() used to walk EVERY Identifier under a derivation's RHS
// and treat any bare reference to a tracked variable as propagating,
// regardless of whether the derived VALUE could still carry text (e.g.
// `.length`). These rows cover the value-shape gate that replaced that
// blind walk: propagate only through derivations that plausibly still
// carry the source file's text; do not propagate through scalar-producing
// shapes (member access, numeric/boolean methods, comparisons, Number()
// et al).

describe('no-source-grep rule — hop-propagation value-shape (adversarial-review fix)', () => {
  test('valid: .length derivation does not propagate (reported false-positive repro)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const len = raw.length;
            if (/^\\d+$/.test(len)) {}
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: numeric-returning method derivation does not cascade to a second error', () => {
    // raw.indexOf('x') is itself already flagged directly (indexOf is one
    // of the TEXT_METHODS this rule flags on a tracked receiver, unrelated
    // to hop propagation). The important assertion here is that there is
    // exactly ONE error, not two: the numeric result of .indexOf() must
    // NOT stay tracked, so String(n).includes('1') is not a second finding.
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const n = raw.indexOf('x');
            String(n).includes('1');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('invalid: boolean-returning method derivation does not cascade to a second error', () => {
    // Same shape as above with a boolean-returning method: raw.includes('x')
    // is itself already flagged directly. The boolean result must NOT stay
    // tracked, so String(ok).includes('true') is not a second finding.
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const ok = raw.includes('x');
            String(ok).includes('true');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('valid: comparison of a tracked derivation does not propagate', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const same = raw.length === 0;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: string-returning method derivation still propagates and is caught', () => {
    // raw.replace(...) is flagged directly (replace is a TEXT_METHOD, same
    // as the indexOf/includes rows above) AND the string-returning result
    // (b) correctly stays tracked, so b.includes('y') is a second, distinct
    // finding. Two errors total, both real.
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const b = raw.replace(/x/, '');
            b.includes('y');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }, { messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('invalid: template-literal derivation still propagates and is caught', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            const b = \`\${raw}\`;
            b.match(/y/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
  });

  test('invalid: direct .includes() on the tracked source read is unchanged (no regression)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8');
            raw.includes('x');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
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

  // ─── #3987: camelCase/suffixed evasion (elapsedMs escaped the exact-name
  // regex; CI caught the resulting flake instead of lint catching the
  // anti-pattern) ───────────────────────────────────────────────────────

  test('invalid: assert on .elapsedMs property (the exact identifier that evaded the pre-widening exact-name regex)', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            const result = { elapsedMs: 150 };
            assert.ok(result.elapsedMs < 200);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('invalid: assert on tookMs/durationMs/msElapsed/elapsedTime/startMs/endMs — camelCase family the widened rule must catch', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `assert.ok(x.tookMs < 500);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
        {
          code: `assert.ok(x.durationMs > 0);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
        {
          code: `assert.ok(x.msElapsed > 0);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
        {
          code: `assert.ok(x.elapsedTime < 1000);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
        {
          code: `assert.ok(x.endMs - x.startMs < 100);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
  });

  test('valid: non-timing camelCase identifiers containing "ms" as a plain substring do not flag (params/items/forms/terms/dirnames — and a configured-bound timeoutMs)', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [
        { code: `assert.equal(params.length, 2);`, filename: 'tests/foo.test.cjs' },
        { code: `assert.equal(items.length, 0);`, filename: 'tests/foo.test.cjs' },
        { code: `assert.ok(forms.valid);`, filename: 'tests/foo.test.cjs' },
        { code: `assert.equal(terms.length, 3);`, filename: 'tests/foo.test.cjs' },
        { code: `assert.equal(dirnames.length, 1);`, filename: 'tests/foo.test.cjs' },
        {
          // A configured bound (deterministic pass-through), not a measured
          // wall-clock elapsed value — must not be caught by the widening.
          code: `assert.equal(seen[0].timeoutMs, HOOK_FANOUT_TIMEOUT_MS);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
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

  // ── #3951 B6(b): filename-gate reach — src/**/*.cts, subdirectories included ──
  // The gate used to be `/(?:^|\/)src\/[^/]+\.cts$/` (flat-only), which
  // silently exempted 28 files in src/ subdirectories
  // (health-diagnostic-rules/, installer-migrations/, observability/,
  // host-integration-adapters/, vendor/) even though the eslint.config.mjs
  // registration (src/**/*.cts) already covers them. These three rows pin
  // that the gate and the registration agree — a subdirectory path is
  // linted, a flat src/ path keeps working, and a path outside src/ stays
  // exempt.

  test('invalid: a table-regex fingerprint under a src/ SUBDIRECTORY is linted (gate reach)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'src/health-diagnostic-rules/some-check.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: the same fingerprint under a FLAT src/*.cts path still is linted (regression, not exempt)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: the same fingerprint OUTSIDE src/+tests/+scripts/ is NOT linted (gate and registration must agree)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'gsd-core/bin/lib/foo.cjs',
        },
      ],
      invalid: [],
    });
  });

  // ── #3951 Rung B: filename-gate reach — tests/**/*.cjs and scripts/**/*.cjs ──
  // The gate self-restricted to src/**/*.cts only. eslint.config.mjs also
  // registers the rule on tests/**/*.cjs and scripts/**/*.cjs (Rung B); these
  // rows pin that the gate and the registration agree for BOTH new globs —
  // a path each registration covers must not be silently skipped by the
  // gate, and a path outside all three globs stays exempt (mirrors the
  // src/ subdirectory rows above, which pinned the same contract for #3951
  // B6(b)).

  test('invalid: a table-regex fingerprint under tests/**/*.cjs is linted (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: a table-regex fingerprint under a tests/ SUBDIRECTORY is linted (gate reach)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'tests/fixtures/some.test.cjs',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('invalid: a table-regex fingerprint under scripts/**/*.cjs is linted (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const cellPattern = /\|[^|]*\|/;`,
          filename: 'scripts/some-tool.cjs',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
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

  // #3951 Rung B: the gate's reach is src/**/*.cts, tests/**/*.cjs and
  // scripts/**/*.cjs — the same fingerprints under those three roots are now
  // linted, and the negative space (a path outside all three) stays exempt.
  test('invalid: fence-block-strip and section-collect fingerprints under tests/ and scripts/ are now flagged (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          // Same fence-block-strip regex under tests/**/*.cjs → now linted
          code: String.raw`const stripFences = /~~~[\s\S]*?~~~/;`,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'fenceRegex' }],
        },
        {
          // Same section-collect regex under scripts/**/*.cjs → now linted
          code: String.raw`const p = /(##\s*X\n)([\s\S]*?)(?=\n##|$)/;`,
          filename: 'scripts/helper.cjs',
          errors: [{ messageId: 'sectionCollect' }],
        },
      ],
    });
  });

  test('valid: the same fence-block-strip fingerprint OUTSIDE src/+tests/+scripts/ stays NOT flagged (negative space preserved)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const stripFences = /~~~[\s\S]*?~~~/;`,
          filename: 'gsd-core/bin/lib/foo.cjs',
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

  // #3951 Rung B: table-regex under scripts/**/*.cjs is now linted (gate/
  // registration parity); the same fingerprint outside src/+tests/+scripts/
  // stays exempt (negative space preserved).
  test('invalid: table-regex under scripts/**/*.cjs is now flagged (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const rowRe = /\|[^|]*\|/;`,
          filename: 'scripts/helper.cjs',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: the same table-regex fingerprint OUTSIDE src/+tests/+scripts/ stays NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = /\|[^|]*\|/;`,
          filename: 'gsd-core/bin/lib/foo.cjs',
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

  // #3951 Rung B: a new RegExp(...) table-regex under tests/**/*.cjs is now
  // linted; the same fingerprint outside src/+tests/+scripts/ stays exempt.
  test('invalid: new RegExp(...) table-regex under tests/**/*.cjs is now flagged (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`const rowRe = new RegExp('\\|[^|]*\\|');`,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: the same new RegExp(...) table-regex fingerprint OUTSIDE src/+tests/+scripts/ stays NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`const rowRe = new RegExp('\\|[^|]*\\|');`,
          filename: 'gsd-core/bin/lib/foo.cjs',
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

  // #3951 Rung B: an ad-hoc .replace() mutation under scripts/**/*.cjs is now
  // linted (both the CallExpression and its Literal argument fire); the same
  // fingerprint outside src/+tests/+scripts/ stays exempt.
  test('invalid: .replace() ad-hoc mutation under scripts/**/*.cjs is now flagged (gate/registration parity)', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [],
      invalid: [
        {
          code: String.raw`roadmapContent.replace(/\|[^|]*\|/, 'x');`,
          filename: 'scripts/helper.cjs',
          errors: [{ messageId: 'adhocReplaceMutation' }, { messageId: 'tableRegex' }],
        },
      ],
    });
  });

  test('valid: the same .replace() ad-hoc mutation fingerprint OUTSIDE src/+tests/+scripts/ stays NOT flagged', () => {
    ruleTester.run('no-adhoc-markdown-parsing', noAdhocMarkdownParsing, {
      valid: [
        {
          code: String.raw`roadmapContent.replace(/\|[^|]*\|/, 'x');`,
          filename: 'gsd-core/bin/lib/foo.cjs',
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

// ─── no-duplicate-fold-marker ────────────────────────────────────────

describe('no-duplicate-fold-marker rule', () => {
  const REPO_ROOT = path.join(__dirname, '..');

  /** Build a source string whose line numbers are the array indices + 1. */
  const src = (...lines) => lines.join('\n');

  const FOLD_A_B1 = '__foldDescribe("folded:a (consolidation epic #1969 B1 #1970)", () => {});';
  const FOLD_A_B5 = '__foldDescribe("folded:a (consolidation epic #1969 B5 #1975)", () => {});';
  const FOLD_B_B1 = '__foldDescribe("folded:b (consolidation epic #1969 B1 #1970)", () => {});';

  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noDuplicateFoldMarker.create, 'function');
  });

  // ── Row 1: the #3271 regression, asserted against the real tree ────────────
  //
  // The unit cases below prove the rule can fire. THIS proves the tree it
  // guards is actually clean — it is the assertion that was red before the 25
  // duplicated regions were deleted (18 in install.test.cjs, 5 in
  // install-minimal-hooks.test.cjs, 2 in install-write-confinement.test.cjs).
  //
  // Driven through the real ESLint API over the production glob rather than a
  // hand-rolled scan of file text: a readFileSync + .match() scan of a .cjs
  // path is exactly the shape `local/no-source-grep` bans in tests/**.
  test('regression #3271: the real tests/ tree has no duplicate fold markers', async () => {
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['tests/**/*.cjs'],
        plugins: { local: { rules: { 'no-duplicate-fold-marker': noDuplicateFoldMarker } } },
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        rules: { 'local/no-duplicate-fold-marker': 'error' },
      },
    });

    const results = await eslint.lintFiles(['tests/**/*.cjs']);

    // Filter to THIS rule: an ad-hoc config also surfaces "rule not found" for
    // inline eslint-disable directives naming rules it does not register.
    const violations = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'local/no-duplicate-fold-marker')
        .map((m) => `${path.relative(REPO_ROOT, r.filePath)}:${m.line} ${m.message}`),
    );

    // Non-vacuous: if the glob silently matched nothing, the empty result below
    // would be meaningless.
    assert.ok(results.length > 100, `expected the tests/ glob to match many files, got ${results.length}`);
    assert.deepStrictEqual(violations, [], `duplicate folded suites found:\n${violations.join('\n')}`);
  });

  test('the rule is registered at error for tests/**/*.cjs in the real config', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const config = await eslint.calculateConfigForFile(
      path.join(REPO_ROOT, 'tests', 'install.test.cjs'),
    );
    assert.deepStrictEqual(config.rules['local/no-duplicate-fold-marker'], [2]);
  });

  // ── Occurrence-count boundary: 1 (clean) / 2 (one report) / 3 (two) ────────

  test('valid: a single folded marker in a file', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [{ code: src(FOLD_A_B1), filename: 'tests/host.test.cjs' }],
      invalid: [],
    });
  });

  test('invalid: the same folded marker twice in one file', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [],
      invalid: [
        {
          code: src(FOLD_A_B1, FOLD_A_B1),
          filename: 'tests/host.test.cjs',
          errors: [
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 2 },
          ],
        },
      ],
    });
  });

  test('invalid: three occurrences report the 2nd and 3rd', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [],
      invalid: [
        {
          code: src(FOLD_A_B1, FOLD_A_B1, FOLD_A_B1),
          filename: 'tests/host.test.cjs',
          errors: [
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 2 },
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 3 },
          ],
        },
      ],
    });
  });

  test('valid: two distinct folded markers', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [{ code: src(FOLD_A_B1, FOLD_B_B1), filename: 'tests/host.test.cjs' }],
      invalid: [],
    });
  });

  // ── Negative space (10-diagnosis.md) ──────────────────────────────────────

  // #3271's own reproduction regex (`folded:[a-z0-9-]*`) stops at `.` and
  // collides these two genuinely distinct suites, which coexist in
  // tests/model-resolver.test.cjs. A guard written to that key would red the
  // build on `next` forever.
  test('valid: dot-suffixed marker is distinct from its prefix (model-resolver #3271 false positive)', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            '__foldDescribe("folded:feat-443-effort-fast-mode.integration (consolidation epic #1969 B8 #1977)", () => {});',
            '__foldDescribe("folded:feat-443-effort-fast-mode (consolidation epic #1969 B8 #1977)", () => {});',
          ),
          filename: 'tests/model-resolver.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // tests/review-default-reviewers-workflow.test.cjs reuses the fold alias for
  // an ordinary describe block. Those carry no uniqueness obligation.
  test('valid: __foldDescribe titles without a folded: prefix are ignored', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            "__foldDescribe('#1936: OpenCode reviewer empty-output hardening', () => {});",
            "__foldDescribe('#1936: OpenCode reviewer empty-output hardening', () => {});",
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: a file with no fold markers', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [{ code: src('describe("ordinary", () => {});'), filename: 'tests/host.test.cjs' }],
      invalid: [],
    });
  });

  test('valid: plain describe with a folded: title is not the fold convention', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            'describe("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
            'describe("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // Documented non-goal, pinned so the behavior is deliberate rather than
  // accidental: the rule keys on the callee identifier being literally
  // __foldDescribe. Every one of the 365 fold sites calls it directly.
  test('valid: a call through a further alias of the fold alias is not tracked', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            'const d = __foldDescribe;',
            'd("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
            'd("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: a member-expression call named __foldDescribe is not the fold alias', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            'helpers.__foldDescribe("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
            'helpers.__foldDescribe("folded:a (consolidation epic #1969 B1 #1970)", () => {});',
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // The same marker in two different HOST files is not intra-file duplication.
  // RuleTester lints each entry as its own file, so this also proves the
  // per-file state is rebuilt rather than shared across files.
  test('valid: the same marker in two different files is not an intra-file duplicate', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        { code: src(FOLD_A_B1), filename: 'tests/host-one.test.cjs' },
        { code: src(FOLD_A_B1), filename: 'tests/host-two.test.cjs' },
      ],
      invalid: [],
    });
  });

  // ── Ordering / identity ───────────────────────────────────────────────────

  test('invalid: interleaved duplicates each report against their own first occurrence', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [],
      invalid: [
        {
          code: src(FOLD_A_B1, FOLD_B_B1, FOLD_A_B1, FOLD_B_B1),
          filename: 'tests/host.test.cjs',
          errors: [
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 3 },
            { messageId: 'duplicateFoldMarker', data: { marker: 'b', firstLine: '2' }, line: 4 },
          ],
        },
      ],
    });
  });

  // The batch label is provenance, not identity — a re-fold under a different
  // batch must not evade the guard. This is the exact shape of #3271: #1975
  // re-applied #1970's blocks.
  test('invalid: a duplicate marker is reported even when the batch label differs', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [],
      invalid: [
        {
          code: src(FOLD_A_B1, FOLD_A_B5),
          filename: 'tests/host.test.cjs',
          errors: [
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 2 },
          ],
        },
      ],
    });
  });

  // ── Title shapes that cannot be resolved statically ───────────────────────

  test('invalid: substitution-free template-literal fold titles are resolved', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [],
      invalid: [
        {
          code: src(
            '__foldDescribe(`folded:a (consolidation epic #1969 B1 #1970)`, () => {});',
            '__foldDescribe(`folded:a (consolidation epic #1969 B1 #1970)`, () => {});',
          ),
          filename: 'tests/host.test.cjs',
          errors: [
            { messageId: 'duplicateFoldMarker', data: { marker: 'a', firstLine: '1' }, line: 2 },
          ],
        },
      ],
    });
  });

  test('valid: non-literal fold titles are skipped without throwing', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            'const name = "folded:a";',
            'const x = "a";',
            '__foldDescribe(name, () => {});',
            '__foldDescribe(name, () => {});',
            '__foldDescribe(`folded:${x} (epic)`, () => {});',
            '__foldDescribe(`folded:${x} (epic)`, () => {});',
            '__foldDescribe(42, () => {});',
            '__foldDescribe(42, () => {});',
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: __foldDescribe with no arguments does not throw', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        { code: src('__foldDescribe();', '__foldDescribe();'), filename: 'tests/host.test.cjs' },
      ],
      invalid: [],
    });
  });

  test('valid: an empty marker after the folded: prefix is not tracked', () => {
    ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
      valid: [
        {
          code: src(
            '__foldDescribe("folded: (consolidation epic #1969 B1 #1970)", () => {});',
            '__foldDescribe("folded: (consolidation epic #1969 B1 #1970)", () => {});',
          ),
          filename: 'tests/host.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // Property: marker identity is the whole whitespace-delimited token.
  //
  // This is the generative form of the #3271 correctness question. An
  // implementation that keyed on the issue's `[a-z0-9-]*` slice would truncate
  // at `.` and pass arm 1 while failing arm 2 on any pair like
  // (`a.integration`, `a`) — which is exactly the tests/model-resolver.test.cjs
  // false positive. The alphabet deliberately includes `.` and `_` so those
  // pairs are generated, not hoped for.
  //
  // `fc` is already imported at the top of this file and used by the
  // no-adhoc-markdown-parsing suite; this follows the same
  // fc.property-driving-ruleTester shape.
  test('property: a marker is identified by its whole token, so distinct markers never collide', () => {
    const markerArb = fc
      .array(fc.constantFrom('a', 'z', 'q', '0', '9', '-', '.', '_'), { minLength: 1, maxLength: 12 })
      .map((chars) => chars.join(''));

    const fold = (marker) =>
      `__foldDescribe("folded:${marker} (consolidation epic #1969 B1 #1970)", () => {});`;

    // Arm 1: the SAME marker twice is always reported exactly once, against
    // the first occurrence.
    fc.assert(
      fc.property(markerArb, (marker) => {
        ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
          valid: [],
          invalid: [
            {
              code: src(fold(marker), fold(marker)),
              filename: 'tests/host.test.cjs',
              errors: [
                { messageId: 'duplicateFoldMarker', data: { marker, firstLine: '1' }, line: 2 },
              ],
            },
          ],
        });
      }),
      { numRuns: 150, seed: 3271 },
    );

    // Arm 2: two DISTINCT markers never collide, however they differ.
    fc.assert(
      fc.property(markerArb, markerArb, (a, b) => {
        fc.pre(a !== b);
        ruleTester.run('no-duplicate-fold-marker', noDuplicateFoldMarker, {
          valid: [{ code: src(fold(a), fold(b)), filename: 'tests/host.test.cjs' }],
          invalid: [],
        });
      }),
      { numRuns: 150, seed: 3271 },
    );
  });
});

// ─── require-subprocess-timeout ────────────────────────────────────

describe('require-subprocess-timeout rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof requireSubprocessTimeout.create, 'function');
  });

  // ── INVALID cases (must error) ────────────────────────────────────────────

  test('invalid: execFileSync("git", args, { cwd }) — object-literal options with no timeout key', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [],
      invalid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            const args = ['status'];
            const cwd = '/repo';
            execFileSync('git', args, { cwd });
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'requireSubprocessTimeout' }],
        },
      ],
    });
  });

  test('invalid: execSync("npm ci", { encoding: "utf8" }) — object-literal options with no timeout key', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [],
      invalid: [
        {
          code: `
            const { execSync } = require('node:child_process');
            execSync('npm ci', { encoding: 'utf8' });
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'requireSubprocessTimeout' }],
        },
      ],
    });
  });

  test('invalid: spawnSync with a dotted childProcess.spawnSync callee and no timeout', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [],
      invalid: [
        {
          code: `
            const childProcess = require('node:child_process');
            childProcess.spawnSync('git', ['log'], { cwd: '/repo', encoding: 'utf-8' });
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'requireSubprocessTimeout' }],
        },
      ],
    });
  });

  test('invalid: execFileSync with NO options argument at all — categorically no timeout', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [],
      invalid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            execFileSync('git', ['status']);
          `,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'requireSubprocessTimeout' }],
        },
      ],
    });
  });

  // ── VALID cases (must NOT error) ──────────────────────────────────────────

  test('valid: execFileSync("git", args, { cwd, timeout: 30000 }) — timeout key present', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            const args = ['status'];
            const cwd = '/repo';
            execFileSync('git', args, { cwd, timeout: 30000 });
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: options as a pre-built identifier — execFileSync("git", args, opts) is not traced', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            const args = ['status'];
            const opts = { cwd: '/repo', timeout: 30000 };
            execFileSync('git', args, opts);
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: same unbounded call under a tests/** filename — rule is inert outside src/*.cts', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            execFileSync('git', ['status'], { cwd: '/repo' });
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: allow-unbounded-subprocess suppression comment on the call line', () => {
    ruleTester.run('require-subprocess-timeout', requireSubprocessTimeout, {
      valid: [
        {
          code: `
            const { execFileSync } = require('node:child_process');
            execFileSync('git', ['status'], { cwd: '/repo' }); // allow-unbounded-subprocess: bounded by caller's own watchdog
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });
});

// ─── require-registered-exit (#3910, epic #3889 Phase 6) ──────────────────
//
// See .gsd/phase/enhance-3910-ban-raw-terminator/50-test-matrix.md for the
// enumerated input-class matrix these tests implement.

describe('require-registered-exit rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof requireRegisteredExit.create, 'function');
  });

  // ── Positive control: one per registered glob (matrix rows 1-4) ──────────

  test('invalid: process.exit() at top level — src/**/*.cts glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `process.exit(0);`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  test('invalid: process.exit() at top level — scripts/**/*.cjs glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `process.exit(1);`,
          filename: 'scripts/some-script.cjs',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  test('invalid: process.exit() at top level — hooks/**/*.js glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `process.exit(2);`,
          filename: 'hooks/some-hook.js',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  test('invalid: process.exit() at top level — gsd-core/bin/**/*.cjs glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `process.exit(1);`,
          filename: 'gsd-core/bin/gsd-tools.cjs',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  // ── Negative control: process.exitCode must NEVER be flagged (matrix rows 5-8) ──
  //
  // Required negative control: conflating process.exitCode (the CORRECT
  // drain-then-exit pattern) with process.exit() is what inflated this
  // epic's original raw-exit census 2x.

  test('valid: process.exitCode = 1 is not flagged — src/**/*.cts glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        { code: `process.exitCode = 1;`, filename: 'src/some-module.cts' },
      ],
      invalid: [],
    });
  });

  test('valid: process.exitCode = 1 is not flagged — scripts/**/*.cjs glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        { code: `process.exitCode = 1;`, filename: 'scripts/some-script.cjs' },
      ],
      invalid: [],
    });
  });

  test('valid: process.exitCode = 1 is not flagged — hooks/**/*.js glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        { code: `process.exitCode = 1;`, filename: 'hooks/some-hook.js' },
      ],
      invalid: [],
    });
  });

  test('valid: process.exitCode = 1 is not flagged — gsd-core/bin/**/*.cjs glob', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        { code: `process.exitCode = 1;`, filename: 'gsd-core/bin/gsd-tools.cjs' },
      ],
      invalid: [],
    });
  });

  // ── Allowlist boundary: the ONE sanctioned terminator (matrix rows 9-11) ──

  test('valid: process.exit() lexically inside a function named terminateNow is allowlisted', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        {
          code: `
            function terminateNow(outcome, payload) {
              try {
                process.exit(0);
              } catch (err) {
                process.exit(1);
              }
            }
          `,
          filename: 'src/cli-exit.cts',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: near-miss — same shape, function named something else IS flagged', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `
            function notTerminateNow(outcome, payload) {
              process.exit(0);
            }
          `,
          filename: 'src/cli-exit.cts',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  test('invalid: a top-level process.exit() is flagged even when an unrelated terminateNow exists elsewhere in the same file (allowlist is structural nesting, not file-wide)', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `
            function terminateNow() {
              // unrelated to the top-level exit below
            }
            process.exit(0);
          `,
          filename: 'src/cli-exit.cts',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  // ── Independence (matrix rows 12-13) ──────────────────────────────────────

  test('valid: a bare (non-process) exit(...) call is not flagged', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        {
          code: `
            function exit(code) { return code; }
            exit(0);
          `,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  // #3914 (epic #3889 Phase 7 follow-up) moved this boundary on purpose: see
  // docs/adr/3889-process-exit-contract.md ~:350-362. Previously
  // process['exit'](0) was caught by NEITHER this rule (name-based matching
  // only) nor n/no-process-exit's Identifier-only property match, so it was
  // a genuine, silent evasion. The rule now resolves a string-literal
  // computed property the same as a dotted one, closing that gap. This is
  // NOT a weakening — the old "not flagged" behavior documented below is
  // superseded and should never be restored to make this test pass again.
  test('invalid: computed member access process["exit"](0) IS flagged (boundary moved by #3914, ADR-3889)', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `process['exit'](0);`,
          filename: 'src/some-module.cts',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  // ── Finding 5: KNOWN LIMITS, pinned — the rule does NOT catch these evasions
  // today. These tests do not endorse the patterns; they pin the CURRENT
  // behavior so that a future change which starts catching one of them is a
  // visible, deliberate diff (an intentionally-failing pinning test) rather
  // than a silent behavior change discovered later. See the rule's header
  // doc comment for the same limits documented for a human reader.

  test('KNOWN LIMIT (pinned, not endorsed): aliasing process.exit to a local binding evades detection', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        {
          code: `const e = process.exit; e(1);`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('KNOWN LIMIT (pinned, not endorsed): process.exit.call(...) evades detection', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        {
          code: `process.exit.call(null, 1);`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  test('KNOWN LIMIT (pinned, not endorsed): process.exit.apply(...) evades detection', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [
        {
          code: `process.exit.apply(null, [1]);`,
          filename: 'src/some-module.cts',
        },
      ],
      invalid: [],
    });
  });

  // ── Allowlist is basename-AND-name gated, not name-only (finding: any file
  // named terminateNow would otherwise inherit the allowlist for free) ───────

  test('invalid: a function named terminateNow in a file that is NOT cli-exit.cts is still flagged', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `
            function terminateNow(outcome, payload) {
              process.exit(0);
            }
          `,
          filename: 'src/some-other-module.cts',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  test('invalid: a function named terminateNow in gsd-core/bin/gsd-tools.cjs (not cli-exit.cts) is still flagged', () => {
    ruleTester.run('require-registered-exit', requireRegisteredExit, {
      valid: [],
      invalid: [
        {
          code: `
            function terminateNow(outcome, payload) {
              process.exit(0);
            }
          `,
          filename: 'gsd-core/bin/gsd-tools.cjs',
          errors: [{ messageId: 'rawProcessExit' }],
        },
      ],
    });
  });

  // ── Finding 4: registration proof, not just filename-agnostic rule logic ──
  //
  // The RuleTester cases above vary `filename` directly, which RuleTester
  // never resolves against eslint.config.mjs — they prove the rule's AST
  // logic, not that it is actually WIRED to the four globs. This proves
  // wiring: it resolves the real config for one representative path per
  // glob and asserts the rule is enabled there. This test fails if a glob
  // registration is ever removed from eslint.config.mjs (verified live:
  // temporarily deleting the gsd-core/bin/**/*.cjs registration flipped
  // this test red before it was restored).
  test('the rule is registered at error for one representative path per glob in the real config', async () => {
    const REPO_ROOT = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const representativePaths = [
      path.join(REPO_ROOT, 'src', 'cli-exit.cts'),
      path.join(REPO_ROOT, 'scripts', 'affected-tests-lib.cjs'),
      path.join(REPO_ROOT, 'hooks', 'gsd-check-update.js'),
      path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    ];
    for (const p of representativePaths) {
      // Sequential config resolution (not a hot loop) — no-await-in-loop is
      // not registered on this glob, so no disable directive is needed here.
      const config = await eslint.calculateConfigForFile(p);
      assert.deepStrictEqual(
        config.rules['local/require-registered-exit'],
        [2],
        `expected local/require-registered-exit to be registered at error for ${path.relative(REPO_ROOT, p)}`,
      );
    }
  });

  // ── #3914 (epic #3889 criterion 5, CORRECTED): the two rules are
  // COMPLEMENTARY, not predecessor/successor ──────────────────────────────
  //
  // An isolated review, plus live measurement (see the parity matrix below),
  // proved the original #3914 retirement of n/no-process-exit on
  // gsd-core/bin/**/*.cjs and scripts/**/*.cjs was WRONG: local/require-
  // registered-exit is NOT a strict superset there. n/no-process-exit's
  // esquery selector `[property.name="exit"]` matches ANY MemberExpression
  // property node whose own AST `.name` reads `exit`, computed or not,
  // regardless of whether the value is statically resolvable — so it catches
  // a function parameter, a destructured binding, a for-of loop variable, a
  // reassign-to-the-same-string, a `var` redeclaration, a catch param, or an
  // undeclared global, all named `exit`, none of which
  // local/require-registered-exit's narrower (declaration-must-resolve-to-a-
  // single-string-literal) analysis reaches. Conversely, the successor
  // catches a string-literal computed property (`process['exit']()`) and an
  // optional-chained computed property, neither of which the predecessor's
  // Identifier-only property match reaches. Both rules therefore remain
  // 'error' everywhere they were already registered; this section documents
  // and pins that complementary relationship instead of a supersession that
  // does not exist.
  //
  // n/no-process-exit resolves to a bare string OR an array whose first
  // element is severity (possibly numeric 0/1/2) depending on how ESLint
  // merges the flat config; normalize before asserting.
  function normalizeSeverity(entry) {
    const raw = Array.isArray(entry) ? entry[0] : entry;
    if (raw === 'off' || raw === 0) return 'off';
    if (raw === 'warn' || raw === 1) return 'warn';
    if (raw === 'error' || raw === 2) return 'error';
    return raw;
  }

  // n/no-process-exit is registered ('error') on exactly the nine globs of
  // the shared CommonJS block (eslint.config.mjs ~:476-486): gsd-core/bin/**/*.cjs,
  // scripts/**/*.cjs, eslint-rules/**/*.cjs, bin/lib/**/*.cjs, pi/**/*.cjs,
  // examples/**/*.cjs, vscode/*.js, .kilo/plugins/*.js, .opencode/plugins/*.js.
  // hooks/**/*.js is NOT one of them — the hooks block (eslint.config.mjs
  // ~:594-619) registers the `n` plugin (for n/no-path-concat) but never sets
  // the n/no-process-exit rule key, so it resolves to undefined there, not
  // 'off' and not 'error'. Asserting 'error' for a hooks path is a false
  // claim about the rule's actual reach; see the companion test below, which
  // pins that undefined resolution explicitly.
  // bin/lib/**/*.cjs is skipped here: it is a build-time-generated directory
  // with no file checked into this repo, so there is no real representative
  // path to resolve config for. Eight of the nine globs are exercised.
  test('n/no-process-exit is error on eight of its nine CommonJS globs (bin/lib/** has no checked-in file; no supersession)', async () => {
    const REPO_ROOT = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const allPaths = [
      path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'),
      path.join(REPO_ROOT, 'scripts', 'affected-tests-lib.cjs'),
      path.join(REPO_ROOT, 'eslint-rules', 'no-source-grep.cjs'),
      path.join(REPO_ROOT, 'pi', 'gsd.cjs'),
      path.join(REPO_ROOT, 'examples', 'dynamic-context-management', 'demo.cjs'),
      path.join(REPO_ROOT, 'vscode', 'extension.js'),
      path.join(REPO_ROOT, '.kilo', 'plugins', 'gsd-core.js'),
      path.join(REPO_ROOT, '.opencode', 'plugins', 'gsd-core.js'),
    ];
    for (const p of allPaths) {
      const config = await eslint.calculateConfigForFile(p);
      assert.strictEqual(
        normalizeSeverity(config.rules['n/no-process-exit']),
        'error',
        `expected n/no-process-exit to be error for ${path.relative(REPO_ROOT, p)}`,
      );
    }
  });

  // hooks/**/*.js is NOT among n/no-process-exit's registered globs (see
  // above): the rule resolves to undefined there, while local/require-
  // registered-exit — the successor rule for this surface — is 'error'.
  // This pins the real, slightly surprising state (an unregistered rule,
  // not an 'off' rule) rather than papering over it with a false 'error'
  // claim.
  test('on hooks/** n/no-process-exit is unregistered (undefined) while local/require-registered-exit is error', async () => {
    const REPO_ROOT = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const p = path.join(REPO_ROOT, 'hooks', 'gsd-check-update.js');
    const config = await eslint.calculateConfigForFile(p);
    assert.strictEqual(
      config.rules['n/no-process-exit'],
      undefined,
      `expected n/no-process-exit to be unregistered for ${path.relative(REPO_ROOT, p)}`,
    );
    assert.strictEqual(
      normalizeSeverity(config.rules['local/require-registered-exit']),
      'error',
      `expected local/require-registered-exit to be error for ${path.relative(REPO_ROOT, p)}`,
    );
  });

  test('local/require-registered-exit is error on all four of its globs', async () => {
    const REPO_ROOT = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const registeredPaths = [
      path.join(REPO_ROOT, 'src', 'cli-exit.cts'),
      path.join(REPO_ROOT, 'scripts', 'affected-tests-lib.cjs'),
      path.join(REPO_ROOT, 'hooks', 'gsd-check-update.js'),
      path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    ];
    for (const p of registeredPaths) {
      const config = await eslint.calculateConfigForFile(p);
      assert.strictEqual(
        normalizeSeverity(config.rules['local/require-registered-exit']),
        'error',
        `expected local/require-registered-exit to be error for ${path.relative(REPO_ROOT, p)}`,
      );
    }
  });

  // ── #3914 (corrected): bidirectional construct-parity matrix ────────────
  //
  // The severity-registration tests above prove both rules are 'error' on
  // the shared globs — they don't prove the two rules' AST reach relative to
  // each other. This matrix lints each measured shape through BOTH rules
  // directly (via `Linter`) and asserts the true, bidirectional relationship:
  // each rule catches constructs the other misses; neither over-fires on a
  // genuinely dynamic property.
  describe('construct parity with n/no-process-exit (complementary, not predecessor/successor)', () => {
    const FILES_GLOB = ['**/*.js', '**/*.cjs', '**/*.cts'];

    function lintLocal(ruleModule, code, filename) {
      const linter = new Linter();
      const config = {
        files: FILES_GLOB,
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        plugins: { local: { rules: { 'require-registered-exit': ruleModule } } },
        rules: { 'local/require-registered-exit': 'error' },
      };
      return linter.verify(code, config, { filename });
    }

    function lintPredecessor(code, filename) {
      const linter = new Linter();
      const config = {
        files: FILES_GLOB,
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        plugins: { n: pluginN },
        rules: { 'n/no-process-exit': 'error' },
      };
      return linter.verify(code, config, { filename });
    }

    test('process.exit(1) — BOTH rules flag (plain member access)', () => {
      const code = 'process.exit(1);';
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 1);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 1);
    });

    test("process['exit'](1) — successor-ONLY (string-literal computed property; predecessor's Identifier-only property match cannot see it)", () => {
      const code = "process['exit'](1);";
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 0);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 1);
    });

    test('process?.[k]?.(1) with k statically "exit" — successor-ONLY (optional-chained computed property)', () => {
      const code = "const k = 'exit'; process?.[k]?.(1);";
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 0);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 1);
    });

    test('function f(exit) { process[exit](1); } — predecessor-ONLY (parameter named exit; not a resolvable literal binding)', () => {
      const code = 'function f(exit) { process[exit](1); }';
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 1);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 0);
    });

    test("let exit='exit'; exit='exit'; process[exit]() — predecessor-ONLY (reassigned-to-same-value binding disqualifies the successor's single-write check)", () => {
      const code = "let exit = 'exit'; exit = 'exit'; process[exit]();";
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 1);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 0);
    });

    test('const { exit } = obj; process[exit](1) — predecessor-ONLY (destructured binding; no string-literal initializer to resolve)', () => {
      const code = "const { exit } = require('x'); process[exit](1);";
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 1);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 0);
    });

    test('process[someRuntimeValue](1) with a genuinely dynamic value — NEITHER rule flags (no over-firing)', () => {
      const code =
        'function pick(v) { return v; } '
        + 'const someRuntimeValue = pick("exit"); '
        + 'process[someRuntimeValue](1);';
      assert.strictEqual(lintPredecessor(code, 'x.cjs').length, 0);
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'x.cjs').length, 0);
    });

    test('a sanctioned process.exit() inside terminateNow in cli-exit.cts is still not flagged by the successor (allowlist unaffected)', () => {
      const code = 'function terminateNow(outcome, payload) {\n  process.exit(2);\n}';
      assert.strictEqual(lintLocal(requireRegisteredExit, code, 'src/cli-exit.cts').length, 0);
    });

    test('a sanctioned process.exit() inside terminateNow is still flagged by the predecessor (why both directives are needed at that call site)', () => {
      const code = 'function terminateNow(outcome, payload) {\n  process.exit(2);\n}';
      assert.strictEqual(lintPredecessor(code, 'src/cli-exit.cts').length, 1);
    });
  });
});

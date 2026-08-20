/**
 * Failing-first (RED) tests for #2554 — path-scoped code-review depth overrides.
 *
 * Binds to the not-yet-built module `gsd-core/bin/lib/code-review-depth.cjs`
 * (see .gsd/phase/feat-2554-support-path-scoped-code-review-depth-ov/40-design.md
 * for the behavior table and .gsd/phase/.../50-test-matrix.md for the case
 * matrix these tests are numbered against). The module does not exist yet —
 * this file is expected to fail until it is built.
 *
 * Rows 1-41 and 44-45 (matrix numbering) are pure-function unit tests against
 * the resolver directly — no fs, no clock, no subprocess. Rows 42-43 are CLI
 * integration tests through the real `gsd-tools` binary (via runGsdTools),
 * because CONTRIBUTING names the CLI round-trip as the only non-source-grep
 * way to prove a config key is registered and survives a load. Row 44 has no
 * quoted "Test name" in the matrix (asserted structurally by construction: every
 * test below builds its own rules/files fixtures, no module-level mutable
 * state) so it is not given its own test().
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const {
  REASON,
  DEPTH_TIERS,
  LARGE_SCOPE_THRESHOLD,
  ruleMatchesFile,
  resolveCodeReviewDepth,
  normalizeRelPath,
} = require('../gsd-core/bin/lib/code-review-depth.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── enum lock ────────────────────────────────────────────────────────────

describe('REASON enum', () => {
  test('REASON is frozen and carries exactly the nine documented keys', () => {
    assert.strictEqual(Object.isFrozen(REASON), true);
    assert.deepEqual(
      Object.keys(REASON).sort(),
      [
        'GLOB_UNSUPPORTED',
        'INVALID_DEPTH',
        'NOT_AN_ARRAY',
        'PATHS_MALFORMED',
        'PATH_ABSOLUTE',
        'PATH_CONTROL_CHAR',
        'PATH_EMPTY',
        'PATH_TRAVERSAL',
        'RULE_NOT_OBJECT',
      ].sort(),
    );
  });
});

// ─── resolution order (rows 1-10) ──────────────────────────────────────────

describe('resolveCodeReviewDepth — resolution order', () => {
  test('resolves to standard when nothing is configured', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [],
      files: ['src/lib/a.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.source, 'default');
  });

  test('falls through to the global config depth', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: 'deep',
      overrides: [],
      files: ['src/lib/a.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'config');
  });

  test('escalates when a changed file sits under a rule path', () => {
    // Production shape: plain cwd-relative POSIX strings, as git diff --name-only emits.
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'rule');
    assert.deepEqual(result.matchedRule, { index: 0, path: 'src/auth', depth: 'deep' });
  });

  test('ignores rules that match no changed file', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src/billing/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.source, 'default');
    assert.strictEqual(result.matchedRule, null);
  });

  test('a single matched file escalates the whole review', () => {
    // Production shape: plain cwd-relative POSIX strings.
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src/lib/a.ts', 'src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'rule');
  });

  test('takes the strongest tier among matching rules', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [
        { paths: ['src/lib'], depth: 'quick' },
        { paths: ['src/auth'], depth: 'deep' },
      ],
      files: ['src/lib/a.ts', 'src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'rule');
    assert.strictEqual(result.matchedRule.path, 'src/auth');
  });

  test('reports the first rule declared at the winning tier', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [
        { paths: ['src/auth'], depth: 'deep' },
        { paths: ['src/billing'], depth: 'deep' },
      ],
      files: ['src/auth/x.ts', 'src/billing/y.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.deepEqual(result.matchedRule, { index: 0, path: 'src/auth', depth: 'deep' });
  });

  test('a matching rule replaces the global depth even when weaker', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: 'deep',
      overrides: [{ paths: ['src/auth'], depth: 'quick' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'quick');
    assert.strictEqual(result.source, 'rule');
  });

  test('the invocation flag outranks every configured rule', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: 'deep',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'quick' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'flag');
  });

  test('validates rules even when the flag would win', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: 'deep',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'not-a-tier' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].reason, REASON.INVALID_DEPTH);
  });
});

// ─── segment-aware matching / negative space (rows 11-14, 26 counterpart) ──

describe('resolveCodeReviewDepth — segment-aware matching', () => {
  test('does not match a sibling directory sharing a name prefix', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src/authfoo/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.matchedRule, null);
  });

  test('anchors the prefix at the path root, not anywhere in the path', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['docs/src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.matchedRule, null);
  });

  test('treats a trailing slash as insignificant', () => {
    const withSlash = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth/'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    const withoutSlash = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.deepEqual(withSlash, withoutSlash);
  });

  test('a file-shaped rule matches only that exact file', () => {
    const hit = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth.ts'], depth: 'deep' }],
      files: ['src/auth.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(hit.ok, true);
    assert.strictEqual(hit.depth, 'deep');
    assert.strictEqual(hit.source, 'rule');

    const miss = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth.ts'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(miss.ok, true);
    assert.strictEqual(miss.depth, 'standard');
    assert.strictEqual(miss.matchedRule, null);
  });
});

// ─── path normalization (rows 15-19) ───────────────────────────────────────

describe('resolveCodeReviewDepth — path normalization', () => {
  test('normalizes a leading dot-slash on a changed file', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['./src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
  });

  test('normalizes backslash separators on a changed file', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['src\\auth\\x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
  });

  test('normalizes backslash separators in a rule path', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src\\auth'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
  });

  test('relativizes an absolute changed-file path under the repo root', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['/repo/src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'rule');
  });

  test('an out-of-repo absolute path matches no repo-relative rule', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['/home/user/.claude/notes.md'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.matchedRule, null);

    // Discriminating case: a filesystem-root absolute path that merely
    // *looks* like it could be repo-relative once a leading `/` is
    // stripped. If normalizeRelPath ever unconditionally strips the
    // leading `/`, this would false-escalate by matching rule `src/auth`.
    const outsideRepo = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['/src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(outsideRepo.ok, true);
    assert.strictEqual(outsideRepo.depth, 'standard');
    assert.strictEqual(outsideRepo.matchedRule, null);

    // Sibling case: the same file, but genuinely under repoRoot, must
    // still relativize and match — proving the fix does not over-correct.
    const insideRepo = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: ['/repo/src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(insideRepo.ok, true);
    assert.strictEqual(insideRepo.source, 'rule');
    assert.strictEqual(insideRepo.matchedRule && insideRepo.matchedRule.path, 'src/auth');

    // Unit-level pin on normalizeRelPath itself.
    assert.strictEqual(normalizeRelPath('/src/auth/x.ts', '/repo'), '/src/auth/x.ts');
  });
});

// ─── totality on empty inputs (rows 20-21) ─────────────────────────────────

describe('resolveCodeReviewDepth — totality on empty inputs', () => {
  test('is total on an empty changed-file set', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.source, 'default');
    assert.strictEqual(result.fileCount, 0);
    assert.strictEqual(result.matchedRule, null);
  });

  test('an empty rule array is valid and changes nothing', () => {
    const withEmptyArray = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: 'quick',
      overrides: [],
      files: ['src/lib/a.ts'],
      repoRoot: '/repo',
    });
    const withNoOverridesField = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: 'quick',
      files: ['src/lib/a.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(withEmptyArray.ok, true);
    assert.strictEqual(withEmptyArray.depth, 'quick');
    assert.strictEqual(withEmptyArray.source, 'config');
    assert.deepEqual(withEmptyArray, withNoOverridesField);
  });
});

// ─── malformed rule paths (rows 22-27) ─────────────────────────────────────

describe('resolveCodeReviewDepth — malformed rule paths', () => {
  test('rejects glob syntax with a configuration error', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth/**'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].reason, REASON.GLOB_UNSUPPORTED);
    assert.strictEqual(result.errors[0].ruleIndex, 0);
  });

  test('rejects single-star and question-mark globs', () => {
    const star = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/*.ts'], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(star.ok, false);
    assert.strictEqual(star.errors[0].reason, REASON.GLOB_UNSUPPORTED);

    const question = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['a?b'], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(question.ok, false);
    assert.strictEqual(question.errors[0].reason, REASON.GLOB_UNSUPPORTED);
  });

  test('rejects a rule path containing a parent-directory segment', () => {
    for (const badPath of ['../etc', 'src/../../etc']) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [{ paths: [badPath], depth: 'deep' }],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${badPath} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.PATH_TRAVERSAL);
    }
  });

  test('rejects an absolute rule path', () => {
    for (const badPath of ['/etc/passwd', 'C:\\Windows']) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [{ paths: [badPath], depth: 'deep' }],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${badPath} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.PATH_ABSOLUTE);
    }
  });

  test('rejects a rule path that normalizes to nothing', () => {
    for (const badPath of ['', '   ', '/', '.', './']) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [{ paths: [badPath], depth: 'deep' }],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(badPath)} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.PATH_EMPTY);
    }
  });

  test('trims whitespace and CR before validating a rule path', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['  src/auth\r\n'], depth: 'deep' }],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.matchedRule.path, 'src/auth');
  });

  test('rejects a rule path containing an interior control character', () => {
    // 'src/au th' below is 'src/au\tth' (tab); 'src/auth' below is
    // 'src/au\x7fth' (DEL) — both non-printing, so they render as
    // near-invisible in this test's source.
    const cases = [
      ['src/au\nth', 'embedded newline'],
      ['src/au\rth', 'embedded carriage return'],
      ['src/au\tth', 'embedded tab'],
      ['src/au\x7fth', 'embedded DEL'],
    ];
    for (const [badPath, label] of cases) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [{ paths: [badPath], depth: 'deep' }],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${label} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.PATH_CONTROL_CHAR, `expected ${label} to fail`);
    }
  });

  test('a glob-and-control-char path still reports GLOB_UNSUPPORTED (precedence)', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/*\nauth'], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].reason, REASON.GLOB_UNSUPPORTED);
  });
});

// ─── malformed rule shapes (rows 28-34) ────────────────────────────────────

describe('resolveCodeReviewDepth — malformed rule shapes', () => {
  test('rejects a rule depth outside quick, standard and deep', () => {
    for (const badDepth of ['light', 'DEEP', '']) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [{ paths: ['src/auth'], depth: badDepth }],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected depth ${JSON.stringify(badDepth)} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.INVALID_DEPTH);
    }
  });

  test('rejects a rule with no depth', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'] }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].reason, REASON.INVALID_DEPTH);
  });

  test('rejects a rule whose paths is absent, empty, or not a string array', () => {
    const variants = [{ depth: 'deep' }, { paths: [], depth: 'deep' }, { paths: 'src', depth: 'deep' }];
    for (const rule of variants) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [rule],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(rule)} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.PATHS_MALFORMED);
    }
  });

  test('rejects a paths array containing a non-string', () => {
    const withNumber = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['ok', 42], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(withNumber.ok, false);
    assert.strictEqual(withNumber.errors[0].reason, REASON.PATHS_MALFORMED);

    const withNull = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['ok', null], depth: 'deep' }],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(withNull.ok, false);
    assert.strictEqual(withNull.errors[0].reason, REASON.PATHS_MALFORMED);
  });

  test('rejects an overrides value that is valid JSON but not an array', () => {
    for (const badOverrides of [{}, 'deep', 0, true, null]) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: badOverrides,
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(badOverrides)} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.NOT_AN_ARRAY);
    }
  });

  test('rejects a rule entry that is not an object', () => {
    for (const badRule of ['src/auth', [], null, 0]) {
      const result = resolveCodeReviewDepth({
        flagDepth: '',
        configDepth: '',
        overrides: [badRule],
        files: [],
        repoRoot: '/repo',
      });
      assert.strictEqual(result.ok, false, `expected ${JSON.stringify(badRule)} to fail`);
      assert.strictEqual(result.errors[0].reason, REASON.RULE_NOT_OBJECT);
    }
  });

  test('reports every malformed rule, not only the first', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [
        { paths: ['src/auth/**'], depth: 'deep' },
        { paths: ['src/billing'], depth: 'nonsense' },
      ],
      files: [],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 2);
    assert.strictEqual(result.errors[0].reason, REASON.GLOB_UNSUPPORTED);
    assert.strictEqual(result.errors[0].ruleIndex, 0);
    assert.strictEqual(result.errors[1].reason, REASON.INVALID_DEPTH);
    assert.strictEqual(result.errors[1].ruleIndex, 1);
  });
});

// ─── hostile input (row 35-36) ─────────────────────────────────────────────

describe('resolveCodeReviewDepth — hostile input', () => {
  test('a rule carrying a __proto__ key does not pollute Object.prototype', () => {
    const hostileRule = JSON.parse('{"__proto__": {"polluted": true}, "paths": ["src/auth"], "depth": "deep"}');
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [hostileRule],
      files: ['src/auth/x.ts'],
      repoRoot: '/repo',
    });
    assert.strictEqual(({}).polluted, undefined);
    // The call must still behave sanely — not necessarily error, but must not
    // let the pollution attempt masquerade as a valid escalation.
    assert.ok(result.ok === true || result.ok === false);
  });

  test('accepts unusual but well-formed rule paths', () => {
    const longSegment = 'a'.repeat(4096);
    const rulePath = `café/日本語 dir/${longSegment}`;
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: [rulePath], depth: 'deep' }],
      files: [`${rulePath}/x.ts`],
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'deep');
    assert.strictEqual(result.source, 'rule');
  });
});

// ─── large-scope downgrade boundary (rows 37-39) ───────────────────────────

describe('resolveCodeReviewDepth — large-scope downgrade boundary', () => {
  function filesUnder(rulePath, count) {
    return Array.from({ length: count }, (_, i) => `${rulePath}/f${i}.ts`);
  }

  test('applies the large-scope downgrade at the file-count boundary', () => {
    const below = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: filesUnder('src/auth', LARGE_SCOPE_THRESHOLD - 1),
      repoRoot: '/repo',
    });
    assert.strictEqual(below.ok, true);
    assert.strictEqual(below.depth, 'deep');
    assert.strictEqual(below.resolvedDepth, 'deep');
    assert.strictEqual(below.downgraded, false);

    const at = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: filesUnder('src/auth', LARGE_SCOPE_THRESHOLD),
      repoRoot: '/repo',
    });
    assert.strictEqual(at.ok, true);
    assert.strictEqual(at.depth, 'deep');
    assert.strictEqual(at.resolvedDepth, 'deep');
    assert.strictEqual(at.downgraded, false);

    const above = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides: [{ paths: ['src/auth'], depth: 'deep' }],
      files: filesUnder('src/auth', LARGE_SCOPE_THRESHOLD + 1),
      repoRoot: '/repo',
    });
    assert.strictEqual(above.ok, true);
    assert.strictEqual(above.depth, 'standard');
    assert.strictEqual(above.resolvedDepth, 'deep');
    assert.strictEqual(above.downgraded, true);
    assert.strictEqual(above.source, 'rule');
    assert.deepEqual(above.matchedRule, { index: 0, path: 'src/auth', depth: 'deep' });
  });

  test('downgrades a flag-sourced deep without naming a rule', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: 'deep',
      configDepth: '',
      overrides: [],
      files: filesUnder('src/misc', LARGE_SCOPE_THRESHOLD + 1),
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.resolvedDepth, 'deep');
    assert.strictEqual(result.downgraded, true);
    assert.strictEqual(result.source, 'flag');
    assert.strictEqual(result.matchedRule, null);
  });

  test('leaves a non-deep depth alone above the file-count threshold', () => {
    const result = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: 'standard',
      overrides: [],
      files: filesUnder('src/misc', LARGE_SCOPE_THRESHOLD + 1),
      repoRoot: '/repo',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.depth, 'standard');
    assert.strictEqual(result.resolvedDepth, 'standard');
    assert.strictEqual(result.downgraded, false);
  });
});

// ─── independence (row 45) ─────────────────────────────────────────────────

describe('resolveCodeReviewDepth — independence', () => {
  test('does not mutate its inputs', () => {
    const overrides = [{ paths: ['src/auth'], depth: 'deep' }];
    const files = ['src/auth/x.ts', 'src/lib/a.ts'];
    const overridesSnapshot = JSON.stringify(overrides);
    const filesSnapshot = JSON.stringify(files);

    const first = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides,
      files,
      repoRoot: '/repo',
    });
    const second = resolveCodeReviewDepth({
      flagDepth: '',
      configDepth: '',
      overrides,
      files,
      repoRoot: '/repo',
    });

    assert.strictEqual(JSON.stringify(overrides), overridesSnapshot);
    assert.strictEqual(JSON.stringify(files), filesSnapshot);
    assert.deepEqual(first, second);
  });
});

// ─── property-based tests (rows 40-41, plus one additional) ───────────────

describe('resolveCodeReviewDepth — properties', () => {
  const segment = fc.stringOf(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split('')),
    { minLength: 1, maxLength: 8 },
  );
  const rulePathArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
  const depthArb = fc.constantFrom(...DEPTH_TIERS);
  const ruleArb = fc.record({ paths: fc.array(rulePathArb, { minLength: 1, maxLength: 2 }), depth: depthArb });
  const fileArb = fc.array(rulePathArb, { minLength: 0, maxLength: 5 }).map((parts) => parts.join('/'));

  test('property: a successful resolution is internally consistent', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { minLength: 0, maxLength: 4 }),
        // Bounded well below LARGE_SCOPE_THRESHOLD so the large-scope downgrade
        // (rows 37-39, tested separately above) never fires here — this
        // property is about matchedRule/depth consistency, not the downgrade.
        fc.array(fileArb, { minLength: 0, maxLength: 10 }),
        depthArb,
        (overrides, files, configDepth) => {
          const result = resolveCodeReviewDepth({
            flagDepth: '',
            configDepth,
            overrides,
            files,
            repoRoot: '/repo',
          });
          // ruleArb/rulePathArb only ever generate well-formed rules (alnum
          // segments, no glob/traversal/absolute chars), so this must hold.
          assert.strictEqual(result.ok, true);
          assert.ok(DEPTH_TIERS.includes(result.depth));
          if (result.source === 'rule') {
            assert.ok(result.matchedRule !== null);
            assert.strictEqual(result.matchedRule.depth, result.depth);
          }
          return true;
        },
      ),
      { numRuns: 200, seed: 25540 },
    );
  });

  test('property: prefix matching is segment-aware', () => {
    fc.assert(
      fc.property(rulePathArb, segment, (rule, suffix) => {
        assert.strictEqual(ruleMatchesFile(rule, `${rule}/${suffix}`), true);
        assert.strictEqual(ruleMatchesFile(rule, `${rule}${suffix}`), false);
        return true;
      }),
      { numRuns: 200, seed: 25540 },
    );
  });

  test('property: an overrides value that is not a JSON array is always rejected with NOT_AN_ARRAY', () => {
    const nonArrayArb = fc.oneof(
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.object(),
    );
    fc.assert(
      fc.property(nonArrayArb, (overrides) => {
        const result = resolveCodeReviewDepth({
          flagDepth: '',
          configDepth: '',
          overrides,
          files: [],
          repoRoot: '/repo',
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.errors[0].reason, REASON.NOT_AN_ARRAY);
        return true;
      }),
      { numRuns: 200, seed: 25540 },
    );
  });
});

// ─── config-key registration (rows 42-43) ──────────────────────────────────

describe('workflow.code_review_depth_overrides — config registration', () => {
  test('the new key survives a config-set / config-get round trip', (t) => {
    const cwd = createTempProject();
    t.after(() => cleanup(cwd));

    const value = JSON.stringify([{ paths: ['src/auth'], depth: 'deep' }]);
    const setResult = runGsdTools(
      ['config-set', 'workflow.code_review_depth_overrides', value, '--raw'],
      cwd,
      { HOME: cwd },
    );
    assert.strictEqual(setResult.success, true, `config-set failed: ${setResult.error}`);

    const getResult = runGsdTools(
      ['config-get', 'workflow.code_review_depth_overrides'],
      cwd,
      { HOME: cwd },
    );
    assert.strictEqual(getResult.success, true, `config-get failed: ${getResult.error}`);
    assert.deepEqual(JSON.parse(getResult.output), [{ paths: ['src/auth'], depth: 'deep' }]);
  });

  test('a configured override array survives a configuration load', (t) => {
    const cwd = createTempProject();
    t.after(() => cleanup(cwd));

    const ensureResult = runGsdTools('config-ensure-section', cwd, { HOME: cwd });
    assert.strictEqual(ensureResult.success, true, `config-ensure-section failed: ${ensureResult.error}`);

    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.workflow = config.workflow || {};
    config.workflow.code_review_depth_overrides = [{ paths: ['src/billing'], depth: 'quick' }];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const getResult = runGsdTools(
      ['config-get', 'workflow.code_review_depth_overrides'],
      cwd,
      { HOME: cwd },
    );
    assert.strictEqual(getResult.success, true, `config-get failed: ${getResult.error}`);
    assert.deepEqual(JSON.parse(getResult.output), [{ paths: ['src/billing'], depth: 'quick' }]);
  });
});

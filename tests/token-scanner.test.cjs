'use strict';

/**
 * Tests for `src/token-scanner.cts` — the tokenizer-first seam (#3212 Phase 3, #3414).
 *
 * Design:       .gsd/phase/chore-3414-tokenizer-first-seam/40-design.md
 * Test matrix:  .gsd/phase/chore-3414-tokenizer-first-seam/50-test-matrix.md
 * ADR:          docs/adr/3212-lexical-seam-consolidation.md §4, §6, §7
 *
 * TDD RED: `src/token-scanner.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/token-scanner.cjs')` throws MODULE_NOT_FOUND until
 * the implementing phase adds it (mirrors tests/pattern.test.cjs / tests/text-lines.test.cjs's
 * RED convention from Phases 1-2).
 *
 * Covers test-matrix rows 1-10: tokenizeShellLike (1-5), indentWidth (6-10).
 * extractBranchArgument (rows 11-17) lives in git-cmd.js, tested in
 * tests/worktree-safety.test.cjs's folded bug-3129 block, not here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Seeded fast-check convention: require the shared setup helper (NOT
// 'fast-check' directly) so numRuns/seed are configured globally before any
// fc.assert() call — mirrors tests/pattern.test.cjs / tests/text-lines.test.cjs.
// seed: 42, overridable via GSD_FC_SEED. Required by TESTING-STANDARDS.md:169
// ("modules that implement parsing... must include at least one fast-check
// property test asserting a domain invariant") — a review finding this phase
// missed on first pass; both invariants below are added in response to it.
const fc = require('./helpers/fast-check-setup.cjs');

const { tokenizeShellLike, indentWidth } = require('../gsd-core/bin/lib/token-scanner.cjs');
const { tokenize: gitCmdTokenize } = require(path.join(__dirname, '..', 'hooks', 'lib', 'git-cmd.js'));

// ─── tokenizeShellLike — rows 1-5 ──────────────────────────────────────────

describe('tokenizeShellLike', () => {
  test('row 1: bare git commit, double-quoted message', () => {
    assert.deepStrictEqual(
      tokenizeShellLike('git commit -m "msg"'),
      ['git', 'commit', '-m', 'msg'],
    );
  });

  test('row 2: single-quoted message', () => {
    assert.deepStrictEqual(
      tokenizeShellLike("git commit -m 'my message'"),
      ['git', 'commit', '-m', 'my message'],
    );
  });

  test('row 3: env-prefix assignment token preserved', () => {
    assert.deepStrictEqual(
      tokenizeShellLike('GIT_AUTHOR_NAME=x git commit'),
      ['GIT_AUTHOR_NAME=x', 'git', 'commit'],
    );
  });

  test('row 4: empty string yields no tokens', () => {
    assert.deepStrictEqual(tokenizeShellLike(''), []);
  });

  test('row 5: parity with git-cmd.js\'s current tokenize() on every existing #3129 fixture', () => {
    const fixtures = [
      'git commit -m "feat: add thing"',
      "git commit -m 'fix: typo'",
      'git commit --no-verify -m "wip"',
      'git -C /some/path commit -m "fix: x"',
      'GIT_AUTHOR_NAME=Alice git commit -m "fix"',
      '/usr/bin/git commit -m "feat: y"',
      'GIT_AUTHOR_NAME=A GIT_AUTHOR_EMAIL=b@c git commit -m "x"',
      'git --git-dir=.git commit -m "x"',
      'git --git-dir .git commit -m "x"',
      'git --no-pager commit -m "x"',
      '/usr/bin/git -C /proj commit -m "x"',
      'git -p commit -m "x"',
      'git push origin main',
      'git status',
      'git add .',
      'git log --oneline',
      'npm install',
      '',
      'git checkout main',
      'git -C /path push',
    ];
    for (const cmd of fixtures) {
      assert.deepStrictEqual(
        tokenizeShellLike(cmd),
        gitCmdTokenize(cmd),
        `tokenizeShellLike must match git-cmd.js's tokenize() for: ${JSON.stringify(cmd)}`,
      );
    }
  });
});

// ─── indentWidth — rows 6-10 ────────────────────────────────────────────────

describe('indentWidth', () => {
  test('row 6: no leading whitespace', () => {
    assert.strictEqual(indentWidth('- **D-01:** text'), 0);
  });

  test('row 7: counts leading spaces', () => {
    assert.strictEqual(indentWidth("  - **D-06's fix does not close this.** text"), 2);
  });

  test('row 8: a tab counts as one column, not expanded', () => {
    assert.strictEqual(indentWidth('\t- text'), 1);
  });

  test('row 9: empty string and no-leading-whitespace both return 0', () => {
    assert.strictEqual(indentWidth(''), 0);
    assert.strictEqual(indentWidth('no leading space'), 0);
  });

  test('row 10: all-whitespace line returns its full length', () => {
    assert.strictEqual(indentWidth('   '), 3);
  });
});

// ─── Property tests (TESTING-STANDARDS.md:169) ─────────────────────────────

describe('property: indentWidth counts exactly the generated leading-space run', () => {
  test('indentWidth(spaces + non-space content) === spaces.length', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/^[ \t]/.test(s)),
        (n, content) => {
          const line = ' '.repeat(n) + content;
          assert.strictEqual(indentWidth(line), n);
        },
      ),
    );
  });
});

describe('property: tokenizeShellLike is the inverse of joining whitespace-free words with single spaces', () => {
  test('tokenizeShellLike(words.join(" ")) deepStrictEqual words', () => {
    // A "word" here is any non-empty run with no whitespace and no quote
    // characters — the shape that round-trips through the tokenizer without
    // needing quoting to survive the join (quoting is exercised separately
    // by rows 1-2/5; this property covers the bijective unquoted case
    // TESTING-STANDARDS.md:169 asks for).
    const wordArb = fc
      .string({ minLength: 1, maxLength: 12 })
      .filter((s) => s.length > 0 && !/[\s'"]/.test(s));
    fc.assert(
      fc.property(fc.array(wordArb, { minLength: 0, maxLength: 10 }), (words) => {
        assert.deepStrictEqual(tokenizeShellLike(words.join(' ')), words);
      }),
    );
  });
});

'use strict';

/**
 * Property-based tests for scripts/require-issue-link-policy.cjs (#3211).
 *
 * See CLAUDE.md "Property-Based Testing": parsers/budget-limit/bijective
 * contracts require at least one fast-check property test. This module has
 * three such contracts: the closing-keyword parse, the tests/docs-only
 * carve-out, and the truncation-detection fail-closed guarantee.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { ISSUE_LINK_REASON, evaluateIssueLink } = require('../scripts/require-issue-link-policy.cjs');

describe('evaluateIssueLink — properties', () => {
  test('P1: any body containing a closing keyword yields OK_CLOSING_KEYWORD', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.integer({ min: 1, max: 99999 }),
        (pre, post, n) => {
          // Guard: a leading/trailing newline stops `pre`/`post` from gluing
          // onto the "Closes #<n>" token and changing what CLOSING_KEYWORD_REGEX
          // sees — the regex has no word-boundary anchors, so word characters
          // immediately adjacent to "Closes" are irrelevant to it either way,
          // but the newline keeps the constructed body unambiguous to read.
          const body = `${pre}\nCloses #${n}\n${post}`;
          const result = evaluateIssueLink({
            prBody: body,
            headRef: 'fix/1-something',
            sameRepo: false,
            changedFiles: ['src/init.cts'],
            changedFilesTotal: 1,
          });
          assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_CLOSING_KEYWORD);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('P2: a non-exempt path in the diff never yields OK_FOLLOWUP_REFERENCE', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom('tests/a.test.cjs', 'docs/guide.md'),
            fc.string({ minLength: 1, maxLength: 20 }).map((s) => `src/${s}.cts`),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (paths) => {
          // At least one path must actually be non-exempt for the property
          // to be meaningful; skip runs where fc happened to draw only
          // tests/docs paths. The exempt set is tests/, docs/, and root-level
          // markdown (see EXEMPT_PATH_PREFIXES / isRootLevelDoc), so this
          // filter names the non-exempt generator (`src/*.cts`) directly
          // rather than re-deriving the exempt predicate — re-deriving it
          // here would silently go stale the next time the exempt set grows.
          fc.pre(paths.some((p) => p.startsWith('src/')));
          const result = evaluateIssueLink({
            prBody: 'Refs #1',
            headRef: 'fix/1-something',
            sameRepo: false,
            changedFiles: paths,
            changedFilesTotal: paths.length,
          });
          assert.notStrictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('P3: changedFiles at/above the page cap with a mismatched total never yields OK_FOLLOWUP_REFERENCE', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 150 }),
        fc.integer({ min: 0, max: 300 }),
        (length, total) => {
          fc.pre(total !== length);
          const changedFiles = Array.from({ length }, (_, i) => `tests/generated-${i}.test.cjs`);
          const result = evaluateIssueLink({
            prBody: 'Refs #1',
            headRef: 'fix/1-something',
            sameRepo: false,
            changedFiles,
            changedFilesTotal: total,
          });
          assert.notStrictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
        },
      ),
      { numRuns: 200 },
    );
  });
});

'use strict';

// docs-guard-exempt: allPathsAreTestsOrDocs(['tests/a.cjs', 'docs/b.md']) below
// spot-checks a pure path-classifier predicate with string literals — no real
// docs/ file is ever read or asserted on for content.

/**
 * Tests for scripts/require-issue-link-policy.cjs (#3211, preserving #1389).
 *
 * All assertions are on the typed ISSUE_LINK_REASON enum, never on free
 * text — see CLAUDE.md "Mutation Score" / test conventions.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  ISSUE_LINK_REASON,
  hasClosingKeyword,
  hasFollowUpReference,
  allPathsAreTestsOrDocs,
  evaluateIssueLink,
  EXEMPT_PATH_PREFIXES,
  EXCLUDED_ROOT_DOCS,
} = require('../scripts/require-issue-link-policy.cjs');

const { fileListIsComplete } = require('../scripts/pr-changed-files.cjs');

function forkPr(overrides = {}) {
  return {
    prBody: '',
    headRef: 'fix/123-something',
    sameRepo: false,
    changedFiles: ['src/init.cts'],
    changedFilesTotal: 1,
    ...overrides,
  };
}

function testPaths(n) {
  return Array.from({ length: n }, (_, i) => `tests/generated-${i}.test.cjs`);
}

describe('evaluateIssueLink', () => {
  // 1. Real-world vector: a fork PR that adds regression coverage for an
  // issue without closing it.
  test('fork PR referencing an issue with a tests-only diff is OK_FOLLOWUP_REFERENCE', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269 — regression coverage.',
      changedFiles: ['tests/commit-files-pathspec.test.cjs'],
      changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
    assert.strictEqual(result.ok, true);
  });

  // 2. Every accepted reference form, including a lowercase variant.
  test('every accepted follow-up reference form passes with a tests-only diff', () => {
    const forms = [
      'Refs #1', 'Ref #1', 'References #1', 'Relates to #1',
      'Related to #1', 'Follow-up to #1', 'Follow up to #1', 'refs #1',
    ];
    for (const body of forms) {
      const result = evaluateIssueLink(forkPr({ prBody: body, changedFiles: ['tests/a.test.cjs'], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE, `form: ${body}`);
    }
  });

  // 3. Docs-only and mixed tests+docs diffs are both allowed.
  test('docs-only and mixed tests+docs diffs pass', () => {
    const docsOnly = evaluateIssueLink(forkPr({
      prBody: 'Refs #1', changedFiles: ['docs/CONFIGURATION.md'], changedFilesTotal: 1,
    }));
    assert.strictEqual(docsOnly.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);

    const mixed = evaluateIssueLink(forkPr({
      prBody: 'Refs #1', changedFiles: ['tests/a.test.cjs', 'docs/guide.md'], changedFilesTotal: 2,
    }));
    assert.strictEqual(mixed.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  // 4. Windows-style backslash path is normalized before the prefix check.
  test('backslash path is normalized and recognized as tests/', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #1', changedFiles: ['tests\\windows\\a.test.cjs'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  // 5. CRLF vs LF bodies must produce the same reason.
  test('CRLF and LF bodies with the same reference produce the same reason', () => {
    const lf = evaluateIssueLink(forkPr({ prBody: 'Refs #1\n\nMore prose.', changedFiles: ['tests/a.test.cjs'], changedFilesTotal: 1 }));
    const crlf = evaluateIssueLink(forkPr({ prBody: 'Refs #1\r\n\r\nMore prose.', changedFiles: ['tests/a.test.cjs'], changedFilesTotal: 1 }));
    assert.strictEqual(lf.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
    assert.strictEqual(crlf.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  // 6. No reference at all, even with a docs-only diff, fails.
  test('no reference at all fails even with a docs-only diff', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Just a description, no issue mentioned.', changedFiles: ['docs/guide.md'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE);
  });

  // 7 & 8. A reference (not a closing keyword) touching source files needs
  // an actual closing keyword instead.
  test('reference-only PR touching a source file fails needs-closing', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269', changedFiles: ['src/init.cts'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING);
  });

  test('reference-only PR with a mixed tests+source diff fails needs-closing', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269',
      changedFiles: ['tests/a.test.cjs', 'tests/b.test.cjs', 'src/b.cts'],
      changedFilesTotal: 3,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING);
  });

  // 9. Bodies that must NOT be recognized as any kind of issue reference.
  test('non-reference bodies fail with FAIL_NO_ISSUE_REFERENCE', () => {
    const bodies = ['see #123', '#123', 'unlike #123', 'issue 123', 'a #123 b'];
    for (const body of bodies) {
      const result = evaluateIssueLink(forkPr({ prBody: body, changedFiles: ['tests/a.test.cjs'], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE, `body: ${JSON.stringify(body)}`);
    }
  });

  // 10. Lookalike words that embed "ref"/"reference" inside a longer word
  // must not be treated as a reference.
  test('lookalike embedded-word bodies fail with FAIL_NO_ISSUE_REFERENCE', () => {
    const bodies = ['prefs #1', 'unreferenced #1', 'xref#1', 'preferences #1'];
    for (const body of bodies) {
      const result = evaluateIssueLink(forkPr({ prBody: body, changedFiles: ['tests/a.test.cjs'], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE, `body: ${JSON.stringify(body)}`);
    }
  });

  // 11. Directory-lookalike paths (tests-e2e/, src/tests/, testsuite/,
  // docsite/) must NOT be treated as tests/ or docs/.
  test('directory-lookalike paths are rejected, forcing needs-closing', () => {
    const paths = ['tests-e2e/src/a.ts', 'src/tests/x.ts', 'testsuite/y.cjs', 'docsite/z.md'];
    for (const p of paths) {
      const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: [p], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING, `path: ${p}`);
    }
  });

  // 12. A closing keyword on a source diff passes outright.
  test('Closes #123 with a source diff is OK_CLOSING_KEYWORD', () => {
    const result = evaluateIssueLink(forkPr({ prBody: 'Closes #123', changedFiles: ['src/init.cts'], changedFilesTotal: 1 }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_CLOSING_KEYWORD);
  });

  // 13. Closing keyword case/whitespace variants.
  test('closing keyword variants (case, whitespace) all pass', () => {
    const bodies = ['closes #1', 'FIXES #1', 'Resolves  #1', 'resolves\t#1'];
    for (const body of bodies) {
      const result = evaluateIssueLink(forkPr({ prBody: body, changedFiles: ['src/init.cts'], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_CLOSING_KEYWORD, `body: ${JSON.stringify(body)}`);
    }
  });

  // 14 & 15. #1389 anti-forgery property: the backmerge exemption requires
  // BOTH the branch prefix AND sameRepo === true.
  test('backmerge branch + sameRepo true is exempt with no reference at all', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: '', headRef: 'chore/backmerge-main-to-next-20260101', sameRepo: true,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_BACKMERGE_EXEMPT);
  });

  test('#1389 anti-forgery: backmerge branch name from a FORK (sameRepo false) is NOT exempt', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: '', headRef: 'chore/backmerge-main-to-next-20260101', sameRepo: false,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE);
  });

  // #4196: Dependabot has no mechanism to link a PR it opens to a repo
  // issue (its alerts live in the Security tab, not as issues) — exempt by
  // authenticated author login, with no reference and no source-file
  // restriction, mirroring the backmerge exemption's structure above.
  test('#4196: dependabot[bot] author is exempt with no reference at all, even on a source diff', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: '', authorLogin: 'dependabot[bot]', changedFiles: ['src/init.cts'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_DEPENDABOT_EXEMPT);
    assert.strictEqual(result.ok, true);
  });

  test('#4196 anti-forgery: an author login that merely CONTAINS "dependabot" is NOT exempt', () => {
    const lookalikes = ['dependabot', 'Dependabot[bot]', 'not-dependabot[bot]', 'dependabot[bot] '];
    for (const authorLogin of lookalikes) {
      const result = evaluateIssueLink(forkPr({ prBody: '', authorLogin, changedFiles: ['src/init.cts'], changedFilesTotal: 1 }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE, `authorLogin: ${JSON.stringify(authorLogin)}`);
    }
  });

  // 16. hasClosingKeyword corpus parity — expected values come from the
  // shipped shell grep this regex replaces:
  //   grep -qiE '(closes|fixes|resolves)\s+#[0-9]+'
  test('hasClosingKeyword corpus parity with the replaced shell grep', () => {
    const cases = [
      ['Closes #2269', true],
      ['closes #1', true],
      ['Fixes #12', true],
      ['Resolves #3', true],
      ['fixes  #4', true],
      ['Closes #123 and more prose', true],
      ['Refs #2269', false],
      ['Follow-up to #2269', false],
      ['no reference at all', false],
      ['Closes #', false],
      ['Closes123', false],
      ['closes issue 5', false],
    ];
    for (const [body, expected] of cases) {
      assert.strictEqual(hasClosingKeyword(body), expected, `body: ${JSON.stringify(body)}`);
    }
  });

  // 17-18. BOUNDARY: exactly at and just below the page cap, with a total
  // that matches, must pass.
  test('BOUNDARY 99 tests-only paths, total 99 passes', () => {
    const paths = testPaths(99);
    const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: paths, changedFilesTotal: 99 }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  test('BOUNDARY 100 tests-only paths, total 100 passes', () => {
    const paths = testPaths(100);
    const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: paths, changedFilesTotal: 100 }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  // 19. Real vector: PR #3202 — gh returns 100 of 118 changed files.
  test('BOUNDARY 100 tests-only paths, total 118 fails FAIL_FILE_LIST_INCOMPLETE (PR #3202 vector)', () => {
    const paths = testPaths(100);
    const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: paths, changedFilesTotal: 118 }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE);
  });

  test('100 tests-only paths, total undefined fails FAIL_FILE_LIST_INCOMPLETE', () => {
    const paths = testPaths(100);
    const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: paths, changedFilesTotal: undefined }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE);
  });

  // Reviewed BLOCKER: the old fileListIsComplete only consulted the total
  // when length >= FILE_LIST_PAGE_LIMIT, so ANY mechanism that shortens the
  // list below 100 went undetected. A $GITHUB_OUTPUT heredoc terminated
  // early by a file named after the delimiter is exactly such a mechanism —
  // it truncates the list well below the page cap, with the true total
  // still available from the separate, non-paginated `changedFiles` field.
  test('a list shorter than its authoritative total fails closed', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #1', changedFiles: ['CONTRIBUTING.md'], changedFilesTotal: 3,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE);
  });

  // A path containing a literal newline can inflate the parsed list past the
  // true total (e.g. a filename that itself looks like another path once
  // split on newlines) — the total is the authority in both directions.
  test('a list longer than its authoritative total fails closed', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #1',
      changedFiles: ['tests/a.test.cjs', 'tests/b.test.cjs', 'tests/c.test.cjs'],
      changedFilesTotal: 2,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE);
  });

  // 21. An empty changedFiles list cannot confirm anything.
  test('empty changedFiles fails FAIL_FILE_LIST_INCOMPLETE', () => {
    const result = evaluateIssueLink(forkPr({ prBody: 'Refs #1', changedFiles: [], changedFilesTotal: 0 }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE);
  });
});

describe('fileListIsComplete', () => {
  // 22. Direct table of (changedFiles, changedFilesTotal) -> expected.
  test('boundary table', () => {
    const cases = [
      [['a', 'b', 'c'], 3, true],
      [['a', 'b', 'c'], undefined, true],
      [testPaths(100), 100, true],
      [testPaths(100), 101, false],
      [testPaths(100), undefined, false],
      [[], 0, false],
      [undefined, 0, false],
      [testPaths(3), 5, false],
      [testPaths(5), 3, false],
      [testPaths(3), 3, true],
      [testPaths(3), undefined, true],
    ];
    for (const [changedFiles, changedFilesTotal, expected] of cases) {
      assert.strictEqual(
        fileListIsComplete(changedFiles, changedFilesTotal),
        expected,
        `changedFiles.length=${Array.isArray(changedFiles) ? changedFiles.length : changedFiles}, total=${changedFilesTotal}`,
      );
    }
  });
});

describe('hasFollowUpReference', () => {
  // 23. Direct spot checks on the raw predicate.
  test('rejects a closing keyword, accepts a reference', () => {
    assert.strictEqual(hasFollowUpReference('Closes #1'), false);
    assert.strictEqual(hasFollowUpReference('Refs #1'), true);
  });
});

describe('allPathsAreTestsOrDocs', () => {
  // 24. Direct spot checks on the raw predicate.
  test('true for tests/docs mix, false for a non-exempt path, false for empty', () => {
    assert.strictEqual(allPathsAreTestsOrDocs(['tests/a.cjs', 'docs/b.md']), true);
    assert.strictEqual(allPathsAreTestsOrDocs(['tests/a.cjs', '.github/workflows/x.yml']), false);
    assert.strictEqual(allPathsAreTestsOrDocs([]), false);
  });

  // 25. Root-level markdown is a third accepted shape; CHANGELOG.md is
  // excluded from it even though it is root-level markdown.
  test('root-level markdown is accepted, CHANGELOG.md and subdirectory markdown are not', () => {
    assert.strictEqual(allPathsAreTestsOrDocs(['CONTRIBUTING.md']), true);
    assert.strictEqual(allPathsAreTestsOrDocs(['CHANGELOG.md']), false);
    assert.strictEqual(allPathsAreTestsOrDocs(['agents/x.md']), false);
    assert.strictEqual(allPathsAreTestsOrDocs(['package.json']), false);
  });

  // The exclusion of CHANGELOG.md must not be defeatable by casing — the
  // extension test (`/\.md$/i`) is already case-insensitive, so the
  // exclusion lookup must match it rather than silently letting a
  // differently-cased CHANGELOG.md ride in on the docs carve-out.
  test('CHANGELOG.md exclusion is case-insensitive', () => {
    assert.strictEqual(allPathsAreTestsOrDocs(['changelog.md']), false);
    assert.strictEqual(allPathsAreTestsOrDocs(['CHANGELOG.MD']), false);
  });
});

describe('require-issue-link policy — root-level documentation (#2290 shape)', () => {
  // #2290 is the motivating PR the follow-up-reference exemption failed to
  // cover: its diff is CONTRIBUTING.md (root-level markdown) plus a tests/
  // file, and the old EXEMPT_PATH_PREFIXES-only predicate rejected it because
  // CONTRIBUTING.md is neither tests/ nor docs/-prefixed.
  test('the motivating PR #2290 shape qualifies', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269',
      changedFiles: ['CONTRIBUTING.md', 'tests/commit-files-pathspec.test.cjs'],
      changedFilesTotal: 2,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  test('a root-level README change qualifies', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269', changedFiles: ['README.md'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE);
  });

  // scripts/changeset/lint.cjs classes a direct CHANGELOG.md edit as
  // user-facing specifically to close a bypass — the docs carve-out here
  // must not undo that by treating CHANGELOG.md as ordinary documentation.
  test('a direct CHANGELOG.md edit does NOT qualify', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269', changedFiles: ['CHANGELOG.md'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING);
  });

  test('CHANGELOG.md alongside real docs still disqualifies', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269', changedFiles: ['docs/a.md', 'CHANGELOG.md'], changedFilesTotal: 2,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING);
  });

  // These are runtime-loaded text, deliberately gated by the same root-only
  // anchor pre-pr-gate.sh uses — a subdirectory .md file is not root-level.
  test('subdirectory markdown is not root-level documentation', () => {
    const paths = ['gsd-core/workflows/next.md', 'agents/reviewer.md', 'commands/gsd/plan.md', 'src/notes.md'];
    for (const p of paths) {
      const result = evaluateIssueLink(forkPr({
        prBody: 'Refs #2269', changedFiles: [p], changedFilesTotal: 1,
      }));
      assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING, `path: ${p}`);
    }
  });

  test('a root-level non-markdown file does not qualify', () => {
    const result = evaluateIssueLink(forkPr({
      prBody: 'Refs #2269', changedFiles: ['package.json'], changedFilesTotal: 1,
    }));
    assert.strictEqual(result.reason, ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING);
  });
});

describe('require-issue-link policy — the workflow guidance matches the rule', () => {
  // Parity assertion (CLAUDE.md "Generative Fix Divergence"): the sticky
  // comment's guidance text is generated separately from the predicate it
  // describes, and the two have already drifted once (the predicate widened
  // to accept root-level markdown while the guidance kept saying "nothing
  // outside tests/ and docs/"). Every expectation below is derived from the
  // module's actual exports, never hardcoded, so a future widening of the
  // predicate without a guidance update fails this test.
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'require-issue-link.yml');
  const workflowDoc = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
  const job = workflowDoc.jobs['check-issue-link'];
  const steps = job.steps;
  const lastStep = steps[steps.length - 1];
  const script = lastStep.with.script;

  // Non-vacuous guards: if these fail, the assertions below would otherwise
  // silently pass against zero-length input.
  test('the resolved script text and export lists are non-empty (guard)', () => {
    assert.strictEqual(typeof script, 'string');
    assert.ok(script.length > 200, `expected script.length > 200, got ${script.length}`);
    assert.ok(EXEMPT_PATH_PREFIXES.length > 0, 'EXEMPT_PATH_PREFIXES must be non-empty');
    assert.ok(EXCLUDED_ROOT_DOCS instanceof Set, 'EXCLUDED_ROOT_DOCS must be a Set');
    assert.ok(EXCLUDED_ROOT_DOCS.size > 0, 'EXCLUDED_ROOT_DOCS must be non-empty');
  });

  test('guidance names every EXEMPT_PATH_PREFIXES entry verbatim', () => {
    for (const prefix of EXEMPT_PATH_PREFIXES) {
      assert.ok(script.includes(prefix), `guidance script missing prefix: ${prefix}`);
    }
  });

  // isRootLevelDoc accepts root-level *.md — the guidance must say so; this
  // is the exact shape that drifted before.
  test('guidance mentions root-level markdown', () => {
    assert.ok(script.includes('root-level'), 'guidance script missing "root-level"');
  });

  test('guidance names every EXCLUDED_ROOT_DOCS entry verbatim', () => {
    for (const doc of EXCLUDED_ROOT_DOCS) {
      assert.ok(script.includes(doc), `guidance script missing excluded doc: ${doc}`);
    }
  });

  test('guidance mentions an accepted non-closing reference marker', () => {
    assert.ok(script.includes('Refs #'), 'guidance script missing "Refs #"');
  });
});

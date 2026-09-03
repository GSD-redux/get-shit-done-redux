#!/usr/bin/env node
'use strict';

/**
 * Require-issue-link policy (#3211, preserving #1389).
 *
 * Replaces the shell-only `grep -qiE '(closes|fixes|resolves)\s+#[0-9]+'`
 * step with a pure, testable `evaluateIssueLink` verdict function so a PR
 * that only REFERENCES an issue (rather than closing it — e.g. a follow-up
 * regression-coverage PR) is not forced to fabricate a closing keyword, while
 * two pre-existing constraints are preserved exactly:
 *
 *   1. (#1389, anti-forgery) The backmerge exemption only fires when the
 *      head ref carries the backmerge prefix AND the PR is same-repo (not a
 *      fork) — dropping the `sameRepo` conjunct would let a fork forge a
 *      branch name to bypass the issue-link requirement entirely.
 *   2. (#3211, truncation) `gh pr view --json files` truncates the file list
 *      at 100 entries with no in-band signal that it did so (see
 *      scripts/pr-changed-files.cjs). The reference-only carve-out below
 *      only applies when every changed file is a test/doc file, so a PR
 *      whose file list may be truncated must fail closed rather than let an
 *      unseen 101st+ file (which could touch `src/`) slip through.
 *
 * Tests assert on the typed ISSUE_LINK_REASON enum, never on free text.
 */

const { fileListIsComplete, parseChangedFilesEnv } = require('./pr-changed-files.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

const ISSUE_LINK_REASON = Object.freeze({
  OK_CLOSING_KEYWORD: 'ok_closing_keyword',
  OK_BACKMERGE_EXEMPT: 'ok_backmerge_exempt',
  OK_DEPENDABOT_EXEMPT: 'ok_dependabot_exempt',
  OK_FOLLOWUP_REFERENCE: 'ok_followup_reference',
  FAIL_NO_ISSUE_REFERENCE: 'fail_no_issue_reference',
  FAIL_REFERENCE_NEEDS_CLOSING: 'fail_reference_needs_closing',
  FAIL_FILE_LIST_INCOMPLETE: 'fail_file_list_incomplete',
});

// #1389: backmerge PRs are opened by CI against `next`, never by a human or a
// fork, so they are exempt from the issue-link requirement outright — but
// ONLY when combined with `sameRepo === true` below (see header comment).
const BACKMERGE_BRANCH_PREFIX = 'chore/backmerge-main-to-next-';

// #4196: Dependabot has no mechanism to link a PR it opens to a repo issue —
// its alerts live in the Security tab, not as issues, so there is nothing
// for it to reference. `pr.user.login` is authenticated by GitHub (not
// forgeable by a crafted title/branch), so this is safe without a sameRepo
// conjunct: no external actor can make GitHub report this login for a PR
// they opened.
const DEPENDABOT_LOGIN = 'dependabot[bot]';

// A follow-up-only PR (references an issue without closing it) is only
// allowed to skip the closing keyword when every changed file is a test or
// doc file — i.e. it cannot be the PR that actually implements the fix.
const EXEMPT_PATH_PREFIXES = ['tests/', 'docs/'];

// Root-level markdown is documentation — this mirrors the repo's own doc-only
// classifier (.claude/hooks/pre-pr-gate.sh:111), whose `[^/]+\.md` anchor is
// deliberately root-only so runtime-loaded text under a subdirectory
// (gsd-core/workflows/*.md, agents/*.md, commands/**/*.md) stays gated.
// CHANGELOG.md is excluded: scripts/changeset/lint.cjs classes a direct edit to
// it as user-facing precisely to close a bypass, so it must not ride in on the
// docs carve-out either.
const EXCLUDED_ROOT_DOCS = new Set(['CHANGELOG.md']);

// Case-insensitive lookup set derived from EXCLUDED_ROOT_DOCS. The exclusion
// check below is case-insensitive because the `.md` extension test above it
// already is (`/\.md$/i`) — `changelog.md` or `CHANGELOG.MD` would otherwise
// slip past the exclusion while still passing the extension test. In
// practice this is defense in depth rather than a live bypass: the GitHub
// API always reports the real path with its actual, fixed casing (the
// filesystem is case-sensitive on the runners this executes on), so a PR
// cannot rename CHANGELOG.md to bypass the check by casing alone.
const EXCLUDED_ROOT_DOCS_UPPER = new Set(
  Array.from(EXCLUDED_ROOT_DOCS, (name) => name.toUpperCase()),
);

function isRootLevelDoc(normalizedPath) {
  if (!normalizedPath) return false;
  if (normalizedPath.includes('/')) return false;
  if (!/\.md$/i.test(normalizedPath)) return false;
  if (EXCLUDED_ROOT_DOCS_UPPER.has(normalizedPath.toUpperCase())) return false;
  return true;
}

// Mirrors the shipped `grep -qiE '(closes|fixes|resolves)\s+#[0-9]+'` exactly:
// no additional keywords, no `\b` anchors (the shell grep it replaces has
// none either) — see the corpus-parity test in
// tests/require-issue-link-policy.test.cjs.
const CLOSING_KEYWORD_REGEX = /(?:closes|fixes|resolves)\s+#[0-9]+/i;

// Accepts a soft "this PR relates to #N" reference without claiming to close
// it. The leading `\b` prevents matching inside a longer word (e.g. `xref#1`,
// `prefs #1`) because there is no word-boundary transition between the
// preceding word character and the start of the alternative — verified
// explicitly for `preferences #1` / `unreferenced #1` in the test suite.
const FOLLOWUP_REFERENCE_REGEX = /\b(?:refs?|references?|relates\s+to|related\s+to|follow[-\s]?up\s+to)\s+#[0-9]+/i;

function hasClosingKeyword(body) {
  return CLOSING_KEYWORD_REGEX.test(String(body || ''));
}

function hasFollowUpReference(body) {
  return FOLLOWUP_REFERENCE_REGEX.test(String(body || ''));
}

// Path separator normalization — unconditional, per repo convention (see
// CLAUDE.md "Path-sep normalization"), so a Windows-style diff entry like
// `tests\windows\a.test.cjs` is still recognized as tests/-prefixed.
function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Returns true iff every changed file qualifies as a test/doc file, i.e. each
 * one is one of:
 *   1. under one of EXEMPT_PATH_PREFIXES (`tests/`, `docs/`) — the trailing
 *      slash on each prefix makes this directory-boundary aware, so
 *      lookalikes like `tests-e2e/`, `testsuite/`, or `docsite/` are
 *      correctly rejected (they are not `tests/` or `docs/`); or
 *   2. a root-level markdown file (no `/`, `.md` extension, case-insensitive)
 *      that is not in EXCLUDED_ROOT_DOCS — see isRootLevelDoc.
 */
function allPathsAreTestsOrDocs(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  return changedFiles.every((file) => {
    const normalized = normalizePath(file);
    if (EXEMPT_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
    return isRootLevelDoc(normalized);
  });
}

function evaluateIssueLink({ prBody, headRef, sameRepo, authorLogin, changedFiles, changedFilesTotal }) {
  if (authorLogin === DEPENDABOT_LOGIN) {
    return { ok: true, reason: ISSUE_LINK_REASON.OK_DEPENDABOT_EXEMPT };
  }

  if (hasClosingKeyword(prBody)) {
    return { ok: true, reason: ISSUE_LINK_REASON.OK_CLOSING_KEYWORD };
  }

  // #1389: `sameRepo === true` is required, not just the branch-name prefix —
  // a fork PR could otherwise name its branch to forge this exemption.
  if (String(headRef || '').startsWith(BACKMERGE_BRANCH_PREFIX) && sameRepo === true) {
    return { ok: true, reason: ISSUE_LINK_REASON.OK_BACKMERGE_EXEMPT };
  }

  if (!hasFollowUpReference(prBody)) {
    return { ok: false, reason: ISSUE_LINK_REASON.FAIL_NO_ISSUE_REFERENCE };
  }

  // #3211: a truncated file list cannot be trusted to prove "tests/docs
  // only" — fail closed rather than risk approving on an unseen file.
  if (!fileListIsComplete(changedFiles, changedFilesTotal)) {
    return { ok: false, reason: ISSUE_LINK_REASON.FAIL_FILE_LIST_INCOMPLETE };
  }

  if (allPathsAreTestsOrDocs(changedFiles)) {
    return { ok: true, reason: ISSUE_LINK_REASON.OK_FOLLOWUP_REFERENCE };
  }

  return { ok: false, reason: ISSUE_LINK_REASON.FAIL_REFERENCE_NEEDS_CLOSING };
}

function main() {
  const changedFiles = parseChangedFilesEnv(process.env.CHANGED_FILES);
  const parsedTotal = Number.parseInt(process.env.CHANGED_FILES_TOTAL, 10);
  const changedFilesTotal = Number.isNaN(parsedTotal) ? undefined : parsedTotal;

  const result = evaluateIssueLink({
    prBody: process.env.PR_BODY || '',
    headRef: process.env.HEAD_REF || '',
    sameRepo: process.env.SAME_REPO === 'true',
    authorLogin: process.env.PR_AUTHOR_LOGIN || '',
    changedFiles,
    changedFilesTotal,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('node:fs');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${result.ok ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `reason=${result.reason}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `result=${JSON.stringify(result)}\n`);
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = {
  ISSUE_LINK_REASON,
  BACKMERGE_BRANCH_PREFIX,
  DEPENDABOT_LOGIN,
  EXEMPT_PATH_PREFIXES,
  EXCLUDED_ROOT_DOCS,
  CLOSING_KEYWORD_REGEX,
  FOLLOWUP_REFERENCE_REGEX,
  hasClosingKeyword,
  hasFollowUpReference,
  normalizePath,
  isRootLevelDoc,
  allPathsAreTestsOrDocs,
  evaluateIssueLink,
};

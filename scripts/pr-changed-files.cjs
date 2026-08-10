'use strict';

/**
 * Shared truncation-detection helper for `gh pr view --json files` (#3211).
 *
 * GitHub's GraphQL `files` connection on a pull request is a paginated
 * connection. `gh pr view --json files` requests it with a single page at
 * `first: 100` and does NOT paginate through the rest — so any PR touching
 * more than 100 files silently returns only the first 100, with no error and
 * no indication in the `files` array itself that entries are missing.
 * `changedFiles` (a separate, non-paginated scalar field) reports the true
 * total. A policy that relaxes a gate based on "every changed file matches
 * pattern X" must treat a `files` list it cannot confirm is complete as
 * incomplete — i.e. fail closed — rather than silently approving a PR whose
 * 101st+ file might violate the policy.
 *
 * This file lives at the top level of scripts/ rather than in scripts/lib/
 * because scripts/lib/** is enumerated in bin/install.js and ships to users
 * on install; this is CI-only tooling with no reason to be installed.
 */

// GitHub's GraphQL `files` connection is requested at `first: 100` by
// `gh pr view --json files`; `gh` does not paginate this field.
const FILE_LIST_PAGE_LIMIT = 100;

/**
 * Returns true iff `changedFiles` can be trusted as the COMPLETE list of
 * files changed in the PR (i.e. it was not silently truncated).
 *
 * - An empty/non-array list cannot confirm anything about the PR — mirror
 *   the fail-closed stance `allPathsAreTooling` already takes on an empty
 *   list in scripts/pr-template-policy.cjs.
 * - When the true total is known it is the AUTHORITY, at every list size —
 *   not just when the list has hit the page cap. The 100-entry page cap is
 *   only ONE way a list can be short of the truth; a `$GITHUB_OUTPUT`
 *   heredoc terminated early by an attacker-named file, or a path
 *   containing a newline, truncates or inflates the list just as
 *   effectively, and at any length. Comparing against the total catches all
 *   of them without enumerating the mechanisms.
 * - Only when no total is supplied do we fall back to the page-cap
 *   heuristic: a list below the cap cannot have been truncated BY THE CAP,
 *   which is the only mechanism a caller without a total can rule out.
 */
function fileListIsComplete(changedFiles, changedFilesTotal) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  if (Number.isInteger(changedFilesTotal)) return changedFilesTotal === changedFiles.length;
  return changedFiles.length < FILE_LIST_PAGE_LIMIT;
}

/**
 * Parses a newline-delimited env var (as produced by `git diff --name-only`
 * or `gh pr view --json files -q '.files[].path'`) into a trimmed,
 * empty-line-free array. Returns [] for null/undefined/empty input.
 */
function parseChangedFilesEnv(value) {
  if (!value) return [];
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

module.exports = { fileListIsComplete, FILE_LIST_PAGE_LIMIT, parseChangedFilesEnv };

#!/usr/bin/env node
'use strict';

/**
 * Changeset-fragment lint (#2975).
 *
 * Pure verdict function evaluateLint({ changedFiles, labels }) returns
 * { ok, reason } using the LINT_REASON enum. The CLI wrapper calls it with
 * the PR diff (via `git diff --name-only origin/main...HEAD` or the GitHub
 * Actions event payload) and the labels list (via the GitHub event).
 *
 * Tests assert on the typed verdict, never on free text.
 */

// #2988: the repo's integration/default branch — the base every PR targets.
// Used as the local fallback when GITHUB_BASE_REF is unset (CI sets it).
const DEFAULT_BASE = 'next';

const LINT_REASON = Object.freeze({
  OK_FRAGMENT_PRESENT: 'ok_fragment_present',
  OK_OPT_OUT_LABEL: 'ok_opt_out_label',
  OK_NO_USER_FACING_CHANGES: 'ok_no_user_facing_changes',
  FAIL_MISSING_FRAGMENT: 'fail_missing_fragment',
  FAIL_INVALID_FRAGMENT: 'fail_invalid_fragment',
});

const OPT_OUT_LABEL = 'no-changelog';

// Files counted as "user-facing" — touching any of these requires either a
// fragment or an explicit opt-out label. Test/CI/docs/lock files do not.
const USER_FACING_PREFIXES = [
  'bin/',
  'gsd-core/',
  'src/',
  'agents/',
  'commands/',
  'hooks/',
  'sdk/src/',
  'sdk/prompts/',
];

// Exact-match user-facing files. Any direct edit to one of these without a
// fragment also fails the lint — closes the bypass where a contributor edits
// CHANGELOG.md directly to sneak past the new workflow.
const USER_FACING_FILES = new Set(['CHANGELOG.md']);

function isUserFacing(file) {
  if (USER_FACING_FILES.has(file)) return true;
  return USER_FACING_PREFIXES.some((p) => file.startsWith(p));
}

function isFragment(file) {
  return /^\.changeset\/[^/]+\.md$/.test(file) && !file.endsWith('/README.md');
}

function evaluateLint({ changedFiles, labels, fragmentFailures = [] }) {
  if (fragmentFailures.length > 0) {
    return { ok: false, reason: LINT_REASON.FAIL_INVALID_FRAGMENT, failures: fragmentFailures };
  }
  if (changedFiles.some(isFragment)) {
    return { ok: true, reason: LINT_REASON.OK_FRAGMENT_PRESENT };
  }
  if (labels.includes(OPT_OUT_LABEL)) {
    return { ok: true, reason: LINT_REASON.OK_OPT_OUT_LABEL };
  }
  if (!changedFiles.some(isUserFacing)) {
    return { ok: true, reason: LINT_REASON.OK_NO_USER_FACING_CHANGES };
  }
  return { ok: false, reason: LINT_REASON.FAIL_MISSING_FRAGMENT };
}

const { ExitError, runMain } = require('../lib/cli-exit.cjs');
const { parseFragment } = require('./parse.cjs');

function main() {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  // GitHub Actions event payload path
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let labels = [];
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      labels = (event.pull_request?.labels || []).map((l) => l.name);
    } catch { /* fall through */ }
  }
  // #2988: local fallback must match the repo's integration branch (`next`),
  // not the release branch (`main`). CI sets GITHUB_BASE_REF explicitly; the
  // fallback only fires locally, where `next` is the base every PR targets.
  const base = process.env.GITHUB_BASE_REF || DEFAULT_BASE;
  let changedFiles = [];
  try {
    // Use execFileSync with an argv array — the base ref is interpolated
    // into a refspec argument, but execFileSync does not invoke a shell, so
    // even a malicious GITHUB_BASE_REF cannot inject shell syntax. The
    // refspec-bound metacharacters that git itself rejects (e.g. spaces in
    // ref names) are caught by git's own arg parser.
    const out = cp.execFileSync(
      'git',
      ['diff', '--name-only', `origin/${base}...HEAD`],
      { encoding: 'utf8' },
    );
    changedFiles = out.split('\n').filter(Boolean);
  } catch (e) {
    throw new ExitError(2, `could not compute diff: ${e.message}`);
  }

  // Validate the content of every changed fragment file.
  const fragmentFailures = [];
  for (const file of changedFiles) {
    if (!isFragment(file)) continue;
    // A fragment path in the diff that no longer exists on disk was deleted in
    // this PR — a deletion can't be malformed, so skip it.
    if (!fs.existsSync(file)) continue;
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // Present in the diff but unreadable (broken symlink, permissions). A
      // changed fragment we cannot read is suspect — fail closed rather than
      // letting it slip through to the release-time CHANGELOG render.
      fragmentFailures.push({ file, reason: 'unreadable', detail: e.code || 'read_error' });
      continue;
    }
    const result = parseFragment(src);
    if (!result.ok) {
      fragmentFailures.push({ file, reason: result.reason, detail: result.detail });
    }
  }

  const verdict = evaluateLint({ changedFiles, labels, fragmentFailures });
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ...verdict, changedFiles, labels }, null, 2) + '\n');
  } else if (verdict.ok) {
    process.stdout.write(`ok changeset-lint: ${verdict.reason}\n`);
  } else if (verdict.reason === LINT_REASON.FAIL_INVALID_FRAGMENT) {
    process.stderr.write(`\nERROR changeset-lint: ${verdict.reason}\n`);
    process.stderr.write(`The following .changeset fragment(s) failed content validation:\n`);
    for (const f of verdict.failures) {
      const detail = f.detail !== undefined ? ` (${f.detail})` : '';
      process.stderr.write(`  ${f.file}: ${f.reason}${detail}\n`);
    }
    process.stderr.write(`Fix the fragment(s) above before merging.\n`);
  } else {
    process.stderr.write(`\nERROR changeset-lint: ${verdict.reason}\n`);
    process.stderr.write(`PR touches user-facing files but does not include a .changeset/*.md fragment.\n`);
    process.stderr.write(`Run \`npm run changeset\` to create one, or add the \`${OPT_OUT_LABEL}\` label\n`);
    process.stderr.write(`if this PR genuinely has no user-facing impact (test refactor, CI tweak, etc.).\n`);
  }
  return verdict.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = { evaluateLint, LINT_REASON, OPT_OUT_LABEL, isUserFacing, isFragment, DEFAULT_BASE };

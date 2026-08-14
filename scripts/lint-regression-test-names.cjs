#!/usr/bin/env node
'use strict';

/**
 * lint-regression-test-names.cjs — ban NEW top-level bug-NNNN/fix-NNNN/issue-NNNN test files.
 *
 * ## Why
 *
 * The 2026-06 CI audit found 244 one-off `tests/bug-NNNN-*.test.cjs` files —
 * ~38% of the suite. `node --test` spawns one child process per FILE, so file
 * count (not test count) is the unit of CI overhead, and it is worst on the
 * Windows lanes where every spawn is Defender-scanned. Each regression test
 * belongs in the owning module's main test file as a regression case (e.g. a
 * `describe('regressions')` block in `tests/<module>.test.cjs`), where it
 * costs zero additional processes.
 *
 * ## What this enforces
 *
 * Identity ratchet (scripts/lib/allowlist-ratchet.cjs) over basenames matching
 * /^(?:bug|fix|issue)-\d+.*\.test\.cjs$/ in tests/:
 *   - A NEW bug-*, fix-*, or issue-* file (not in the allowlist) fails: fold
 *     the regression into the owning module's test file instead.
 *   - A REMOVED bug-*, fix-*, or issue-* file with a stale allowlist entry
 *     also fails: prune the entry from
 *     scripts/lint-regression-test-names.allowlist.json so the baseline only
 *     ever shrinks.
 *
 * ## --update (allowlist drift repair)
 *
 * `node scripts/lint-regression-test-names.cjs --update` regenerates the
 * allowlist from the files currently in tests/ and reports what changed.
 * Use it when the failure is INHERITED drift, not your own new file — e.g.
 * the base branch merged bug-*, fix-*, or issue-* files without feeding the
 * allowlist (the #947/#948/#950 race after the ratchet landed), or after a
 * rebase. The
 * allowlist is a snapshot artifact: regenerate it AFTER rebasing, never
 * carry a pre-rebase copy through.
 *
 * See docs/TESTING-SUITES.md ("Regression tests") for the placement policy.
 */

const fs = require('fs');
const path = require('path');
const { assertWithinAllowlist } = require('./lib/allowlist-ratchet.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.join(__dirname, '..');
// Env overrides exist for the lint's own tests only (sandbox fixture dirs).
const TESTS_DIR = process.env.GSD_LINT_REGRESSION_TESTS_DIR || path.join(ROOT, 'tests');
const ALLOWLIST_PATH =
  process.env.GSD_LINT_REGRESSION_ALLOWLIST ||
  path.join(__dirname, 'lint-regression-test-names.allowlist.json');

const BUG_FILE_RE = /^(?:bug|fix|issue)-\d+.*\.test\.cjs$/;

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const unknown = args.filter(a => a !== '--update');
  if (unknown.length > 0) {
    throw new ExitError(2, `lint-regression-test-names: unknown argument(s): ${unknown.join(', ')}`);
  }

  const current = fs
    .readdirSync(TESTS_DIR)
    .filter(f => BUG_FILE_RE.test(f))
    .sort();
  const known = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

  if (update) {
    const knownSet = new Set(known);
    const currentSet = new Set(current);
    const added = current.filter(f => !knownSet.has(f));
    const pruned = known.filter(f => !currentSet.has(f));
    if (added.length === 0 && pruned.length === 0) {
      console.log(`lint-regression-test-names --update: allowlist already in sync (${current.length} entries)`);
      return;
    }
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(
      `lint-regression-test-names --update: ${known.length} -> ${current.length} entries` +
      (added.length ? ` | grandfathered: ${added.join(', ')}` : '') +
      (pruned.length ? ` | pruned: ${pruned.join(', ')}` : '')
    );
    console.log('Commit the regenerated allowlist with your change.');
    return;
  }

  const failures = [];
  const { novel } = assertWithinAllowlist({
    label: 'regression-test-names',
    current,
    known,
    fail: msg => failures.push(msg),
    pruneHint: 'edit scripts/lint-regression-test-names.allowlist.json',
  });

  if (failures.length > 0) {
    for (const msg of failures) console.error(msg);
    if (novel.length > 0) {
      console.error(
        '\nIf this PR added the file(s) above: new bug-NNNN/fix-NNNN/issue-NNNN ' +
        "test files are not accepted — add the regression case to the owning module's test file " +
        "(e.g. a describe('regressions') block in tests/<module>.test.cjs) instead.\n" +
        'If the file(s) came from the base branch (inherited allowlist drift, ' +
        'e.g. after a rebase): run ' +
        '`node scripts/lint-regression-test-names.cjs --update` and commit the ' +
        'regenerated allowlist. See docs/TESTING-SUITES.md.'
      );
    }
    throw new ExitError(1);
  }

  console.log(
    `ok lint-regression-test-names: ${current.length} grandfathered bug-*/fix-*/issue-* file(s), no novel offenders`
  );
}

runMain(main);

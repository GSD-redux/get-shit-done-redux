#!/usr/bin/env node
'use strict';

/**
 * lint-fix-has-regression-tests.cjs — gate: every fix(#NNNN) commit must
 * include at least one behavioral test file (tests/*.test.cjs) that is NOT
 * an auto-generated fixture/baseline.
 *
 * Renamed (was `lint-fix-has-regression-test.cjs`, singular): the old
 * basename matched Node's `*-test.EXT` test-collection pattern, so the
 * remote push-gate runner collected and executed this SOURCE file as a
 * test while GitHub CI (which globs only tests/**\/*.test.cjs) never saw
 * it — see scripts/lint-source-test-name-collision.cjs.
 *
 * ## Why
 *
 * CONTRIBUTING.md:47: "Fix it. Write a test that would have caught the bug."
 * CLAUDE.md: "Regression Protocol: Write the regression test first."
 *
 * Three merged PRs shipped without regression tests because the golden-fixture
 * regeneration (20+ files under tests/) camouflaged the absence of real
 * *.test.cjs changes. This gate makes the rule machine-enforced.
 *
 * ## What this enforces
 *
 * For every commit in `git log origin/next..HEAD` whose subject matches
 * /^fix\(#\d+\)/ or /^feat\(#\d+\)/, the cumulative diff must include at
 * least one file under tests/ matching /\.test\.cjs$/ that is NOT:
 *   - under tests/fixtures/
 *   - under tests/install-tree/
 *   - a *-baseline.json file
 *
 * If the filtered list is empty, the gate fails with a message naming the
 * fix commits and directing the author to add a regression test.
 *
 * ## Overrides
 *
 * Set GSD_SKIP_REGRESSION_TEST_GATE=1 for legitimate exceptions (e.g. a
 * pure-config or pure-refactor PR where no behavioral test is possible).
 * This env var is auditable in CI logs.
 */

const { execSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const FIX_OR_FEAT_RE = /^(?:fix|feat)\(#(\d+)\)/;

const EXCLUDE_PATTERNS = [
  /tests[\\/]fixtures[\\/]/,
  /tests[\\/]install-tree[\\/]/,
  /-baseline\.json$/,
];

function isRealTestFile(filePath) {
  if (!filePath.includes('tests/')) return false;
  if (!/\.test\.cjs$/.test(filePath)) return false;
  return !EXCLUDE_PATTERNS.some((re) => re.test(filePath));
}

function getFixCommits(baseRef) {
  const log = execSync(
    `git log ${baseRef}..HEAD --format='%H%x09%s' --no-merges`,
    { encoding: 'utf8', timeout: 10000 },
  );
  return log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\t');
      const match = subject.match(FIX_OR_FEAT_RE);
      return match ? { sha: sha.slice(0, 12), subject, issue: match[1] } : null;
    })
    .filter(Boolean);
}

function getChangedTestFiles(baseRef) {
  const diff = execSync(
    `git diff ${baseRef}...HEAD --name-only --no-merges`,
    { encoding: 'utf8', timeout: 10000 },
  );
  return diff
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(isRealTestFile);
}

function main() {
  if (process.env.GSD_SKIP_REGRESSION_TEST_GATE === '1') {
    console.log('lint-fix-has-regression-tests: SKIPPED (GSD_SKIP_REGRESSION_TEST_GATE=1)');
    return;
  }

  const baseRef = process.env.GSD_REGRESSION_GATE_BASE || 'origin/next';

  let fixCommits;
  try {
    fixCommits = getFixCommits(baseRef);
  } catch {
    console.log(`lint-fix-has-regression-tests: no fix/feat commits found vs ${baseRef}, skipping`);
    return;
  }

  if (fixCommits.length === 0) {
    console.log('lint-fix-has-regression-tests: no fix/feat commits, passing');
    return;
  }

  let testFiles;
  try {
    testFiles = getChangedTestFiles(baseRef);
  } catch {
    testFiles = [];
  }

  if (testFiles.length === 0) {
    const commitList = fixCommits
      .map((c) => `  ${c.sha} ${c.subject}`)
      .join('\n');
    throw new ExitError(1,
      `lint-fix-has-regression-tests: ${fixCommits.length} fix/feat commit(s) but ZERO behavioral test files (*.test.cjs) in the diff.\n` +
      `Auto-generated fixtures (tests/fixtures/, *-baseline.json) do NOT count.\n\n` +
      `Fix commits:\n${commitList}\n\n` +
      `CONTRIBUTING.md:47: "Write a test that would have caught the bug."\n` +
      `Add a regression test to an existing tests/*.test.cjs file, or set ` +
      `GSD_SKIP_REGRESSION_TEST_GATE=1 if no behavioral test is possible (auditable in CI).`
    );
  }

  console.log(
    `lint-fix-has-regression-tests: PASS — ${fixCommits.length} fix/feat commit(s), ` +
    `${testFiles.length} behavioral test file(s): ${testFiles.join(', ')}`
  );
}

runMain(main);

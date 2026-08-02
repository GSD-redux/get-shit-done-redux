'use strict';

/**
 * Regression test for #2657.
 *
 * Nine compiled `.cjs` artifacts under gsd-core/bin/lib/ were tracked in git
 * despite each having a matching src/*.cts source, violating ADR-457's
 * build-at-publish contract ("bin/lib/*.cjs" must be a gitignored build
 * artifact, never checked-in source of truth). A tracked compiled artifact
 * can silently drift from its source without anyone noticing — #2653
 * demonstrated exactly this for api-coverage.cjs, which shipped four days
 * behind its .cts with CI green throughout.
 *
 * This asserts the ADR-457 end state for all nine: none tracked, all
 * gitignored, and the regime-agnostic sync guard (added in #2656,
 * scripts/lint-compiled-artifact-sync.cjs) reports the empty tracked set.
 *
 * Two of the nine (markdown-table.cjs, write-set.cjs) already had a
 * .gitignore pattern before this fix (added by #2248) but were never
 * `git rm --cached`; the other seven had no .gitignore pattern at all. Both
 * gaps produce the same `git ls-files` symptom, so both are covered by the
 * same assertions here.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { trackedCompiledArtifacts } = require('../scripts/lint-compiled-artifact-sync.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = 'gsd-core/bin/lib';

const NINE_ARTIFACTS = [
  'api-coverage.cjs',
  'assumption-delta.cjs',
  'claude-orchestration-command-router.cjs',
  'claude-orchestration.cjs',
  'external-job.cjs',
  'markdown-table.cjs',
  'runtime-artifact-install-plan.cjs',
  'state-transition.cjs',
  'write-set.cjs',
].map((name) => `${LIB_DIR}/${name}`);

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

// Shared shape for both "none of the nine should still be in state X" checks
// below: derive the still-bad subset via `isBad`, then assert it's empty.
function assertNoneStillBad(isBad, failureLabel) {
  const stillBad = NINE_ARTIFACTS.filter(isBad);
  assert.deepEqual(
    stillBad,
    [],
    `expected none of the nine ${failureLabel}; still: ${stillBad.join(', ') || '(none)'}`,
  );
}

describe('fix-2657: compiled .cjs artifacts are gitignored, not tracked (ADR-457)', () => {
  test('none of the nine ADR-457 migration-gap artifacts are tracked by git', () => {
    const tracked = new Set(git(['ls-files', LIB_DIR]).split('\n').filter(Boolean));
    assertNoneStillBad((p) => tracked.has(p), 'to be tracked');
  });

  test('every one of the nine paths is ignored per git', () => {
    // Deliberately WITHOUT --no-index: git-check-ignore(1) operates on the
    // pathname alone and does not require the file to exist on disk (true
    // both with and without --no-index — this repo's gsd-test runner checks
    // out a fresh shallow clone per sha, where an untracked, gitignored path
    // exists as a pattern match only, never as a file on disk). Plain
    // check-ignore is preferred here over --no-index specifically because it
    // also honors git's "a still-TRACKED path is never reported ignored"
    // rule (check-ignore(1)) — which is exactly the property under test: a
    // path that still matches a .gitignore pattern while ALSO remaining
    // tracked (the pre-fix state for two of the nine, whose pattern
    // predates this fix per #2248) must still read as "not ignored," the
    // same as the seven with no pattern at all. --no-index would blur that
    // distinction by reporting the two as ignored regardless of tracking.
    const isNotIgnored = (artifact) => {
      try {
        git(['check-ignore', '-q', artifact]);
        return false;
      } catch {
        return true;
      }
    };
    assertNoneStillBad(isNotIgnored, 'to be reported not-ignored by git');
  });

  test('trackedCompiledArtifacts() reports the ADR-457 empty-set end state for the nine', () => {
    const stillPresentArtifacts = new Set(trackedCompiledArtifacts().map((p) => p.artifact));
    assertNoneStillBad((p) => stillPresentArtifacts.has(p), 'to appear in trackedCompiledArtifacts()');
  });

  test('lint-compiled-artifact-sync exits 0 with nothing left to check', () => {
    // Structured fact only (exit code) — execFileSync throws on non-zero
    // exit, so a clean return proves success without asserting on stdout
    // prose (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test Outputs").
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts', 'lint-compiled-artifact-sync.cjs')],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    });
  });
});

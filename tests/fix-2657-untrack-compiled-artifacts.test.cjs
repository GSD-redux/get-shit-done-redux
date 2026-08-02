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

describe('fix-2657: compiled .cjs artifacts are gitignored, not tracked (ADR-457)', () => {
  test('none of the nine ADR-457 migration-gap artifacts are tracked by git', () => {
    const tracked = new Set(git(['ls-files', LIB_DIR]).split('\n').filter(Boolean));
    const stillTracked = NINE_ARTIFACTS.filter((p) => tracked.has(p));
    assert.deepEqual(
      stillTracked,
      [],
      `expected none of the nine to be tracked; still tracked: ${stillTracked.join(', ') || '(none)'}`,
    );
  });

  test('every one of the nine paths matches a .gitignore pattern', () => {
    // --no-index bypasses git-check-ignore(1)'s "a tracked path is never
    // reported ignored" special-case, so this is accurate independent of
    // whether git rm --cached has (yet) run — it checks pattern match only.
    const unmatched = [];
    for (const artifact of NINE_ARTIFACTS) {
      try {
        git(['check-ignore', '--no-index', '-q', artifact]);
      } catch {
        unmatched.push(artifact);
      }
    }
    assert.deepEqual(
      unmatched,
      [],
      `expected all nine to match a .gitignore pattern; unmatched: ${unmatched.join(', ') || '(none)'}`,
    );
  });

  test('trackedCompiledArtifacts() reports the ADR-457 empty-set end state for the nine', () => {
    const pairs = trackedCompiledArtifacts();
    const stillPresent = pairs
      .map((p) => p.artifact)
      .filter((artifact) => NINE_ARTIFACTS.includes(artifact));
    assert.deepEqual(stillPresent, []);
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

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
 *
 * ── Diagnostics discipline ────────────────────────────────────────────────
 * Every git invocation below uses `spawnSync` (never throws) and every
 * assertion explicitly checks the exit status BEFORE interpreting output.
 * A git command that errors (bad cwd, dubious-ownership refusal, missing
 * binary, anything) must never be silently read as a legitimate "not
 * ignored" / "still tracked" answer — that conflates "the property does not
 * hold" with "I could not determine whether the property holds", which is a
 * distinct defect from the bug this file guards against. On any failure,
 * the assertion message includes the resolved cwd, exit status, and stderr,
 * so a red run is self-diagnosing without a second round-trip.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runGit, runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

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

/**
 * Run a command via the process seam (never throws) and return a legacy
 * `{status, stdout, stderr, signal}` shape. `cmd` is either `'git'` (routed
 * through `runGit`) or `process.execPath` (routed through `runNode`) — the
 * only two callers below. Throws immediately, with full context, only on a
 * genuine spawn failure (binary not found, etc.) — a condition no caller
 * here can meaningfully interpret as a match/no-match answer.
 */
function run(cmd, args, opts) {
  const options = { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS, ...opts };
  const result = cmd === 'git' ? runGit(args, options) : runNode(args, options);
  if (result.outcome === OUTCOME.SPAWN_FAILED) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed to spawn (cwd=${REPO_ROOT}): ${result.stderr || result.code}`,
    );
  }
  return { ...toLegacyResult(result), signal: result.signal };
}

/** Render a failed command's full context for an assertion message. */
function describeFailure(cmd, args, result) {
  return (
    `${cmd} ${args.join(' ')} (cwd=${REPO_ROOT}) exited ${result.status}` +
    (result.signal ? ` (signal ${result.signal})` : '') +
    `\n  stderr: ${(result.stderr || '(empty)').trim()}` +
    `\n  stdout: ${(result.stdout || '(empty)').trim()}`
  );
}

function git(args) {
  // -c safe.directory=REPO_ROOT: containerized CI checkouts are frequently
  // owned by a different uid than the one running node --test, and git
  // refuses to operate at all on such a repo ("detected dubious ownership")
  // unless explicitly trusted. Scoped per-invocation (not written to any
  // config file), matching the same fix applied to
  // scripts/lint-compiled-artifact-sync.cjs's own git() helper, which has
  // the identical defect (#2657 diagnostic run: `git ls-files` there failed
  // with the same "dubious ownership" fatal in the runner).
  return run('git', ['-c', `safe.directory=${REPO_ROOT}`, ...args]);
}

/** `git ls-files <LIB_DIR>`, asserting success before trusting the output. */
function trackedLibFiles() {
  const args = ['ls-files', LIB_DIR];
  const result = git(args);
  assert.equal(
    result.status,
    0,
    `git ls-files must exit 0 before its output can be trusted as "nothing tracked":\n${describeFailure('git', args, result)}`,
  );
  return new Set(result.stdout.split('\n').filter(Boolean));
}

/**
 * `git check-ignore -q <path>` has exactly two legitimate outcomes: exit 0
 * (ignored) and exit 1 (not ignored) — check-ignore(1). Any other exit code
 * or a signal is an infrastructure failure, not a "not ignored" answer, and
 * must not be conflated with one.
 */
function isIgnored(artifactPath) {
  const args = ['check-ignore', '-q', artifactPath];
  const result = git(args);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git check-ignore for ${artifactPath} returned neither a match (0) nor a legitimate ` +
      `no-match (1) exit code — this is an infrastructure failure, not evidence the path ` +
      `is unignored:\n${describeFailure('git', args, result)}`,
  );
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
    const tracked = trackedLibFiles();
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
    assertNoneStillBad((p) => !isIgnored(p), 'to be reported not-ignored by git');
  });

  test('trackedCompiledArtifacts() reports the ADR-457 empty-set end state for the nine', () => {
    let pairs;
    try {
      pairs = trackedCompiledArtifacts();
    } catch (err) {
      // trackedCompiledArtifacts() (scripts/lint-compiled-artifact-sync.cjs)
      // wraps its OWN internal `git ls-files gsd-core/bin/lib` call, with cwd
      // resolved from that script's own __dirname (should equal REPO_ROOT
      // here regardless of caller). A throw means THAT invocation failed —
      // not that any artifact is still tracked. Surface it, don't mask it.
      assert.fail(
        `trackedCompiledArtifacts() threw instead of returning a result — this indicates its ` +
          `internal git invocation failed, not that any of the nine is still tracked:\n` +
          `${err && err.stack ? err.stack : err}`,
      );
    }
    const stillPresentArtifacts = new Set(pairs.map((p) => p.artifact));
    assertNoneStillBad((p) => stillPresentArtifacts.has(p), 'to appear in trackedCompiledArtifacts()');
  });

  test('lint-compiled-artifact-sync exits 0 with nothing left to check', () => {
    const args = [path.join(REPO_ROOT, 'scripts', 'lint-compiled-artifact-sync.cjs')];
    const result = run(process.execPath, args);
    assert.equal(result.status, 0, describeFailure(process.execPath, args, result));
  });
});

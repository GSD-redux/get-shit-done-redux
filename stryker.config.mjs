/**
 * stryker.config.mjs
 *
 * Mutation testing configuration for gsd-core.
 *
 * Test runner: 'tap' (@stryker-mutator/tap-runner)
 *   Runs: node --test-reporter=tap over each per-shard test file (tap.testFiles,
 *   resolved by scripts/mutation-matrix.cjs's resolveMutationTestFiles), one
 *   process per covering test file per mutant.
 *
 * Mutate scope: bin/lib/**\/*.cjs, excluding generated files and test files.
 *
 * coverageAnalysis: 'perTest' — the tap runner supports per-mutant coverage
 * thresholds: high=80, low=60, break=per-shard MUTATION_BREAK (local fallback 60)
 * incremental: true — caches results; PR-scoped runs pass --mutate <changed-files>
 *
 * Reports:
 *   - html: reports/mutation/mutation.html
 *   - clear-text (console)
 *   - progress (spinner)
 *
 * NOTE: This is incremental / changed-files-only in CI (--mutate <changed-files>)
 * to stay bounded. Full runs are for local exploration only.
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
// resolveMutationBreak: fail-closed resolver for MUTATION_BREAK env var.
// undefined → 60 (local backstop); set-but-empty or non-numeric → throws.
// resolveMutationTestFiles: fail-closed resolver for MUTATION_TEST_FILES env var (#3915).
// undefined → the derived union of every COVERED module's tests (local backstop);
// set-but-empty, non-string, or naming a nonexistent file → throws. See that
// function's doc-comment in scripts/mutation-matrix.cjs for the full contract.
const { resolveMutationBreak, resolveMutationTestFiles } = _require('./scripts/mutation-matrix.cjs');

// ADR-457: bin/lib/*.cjs are gitignored build artifacts (compiled from
// src/*.cts by `npm run build:lib`, which the mutation CI job runs via `npm ci`
// → prepare before Stryker). Stryker mutates the *built* .cjs directly — the
// command runner runs the tests with NO rebuild, so each mutation to the
// shipped artifact is seen by the tests. (Mutating src/*.cts instead would
// force a full tsc rebuild per mutant — far too slow for the 30-min CI budget.)
// Large/low-coverage modules are excluded (the command's test set does not
// exercise them, so they would only ever produce survived mutants).
//
// KNOWN BLIND SPOT (2026-06 CI audit): this list excludes ~14.2k of ~29.8k
// lib lines (~48%), including the most central modules (state, core,
// commands, phase, verify). Mutation results therefore speak only for the
// well-tested half of the lib. Shrinking the list is deliberate tracked work:
// bring one module into scope per release by first giving it per-module
// *.unit.test.cjs / *.property.test.cjs coverage, then deleting its entry —
// never delete an entry without that coverage (it will only produce survived
// mutants and trip the break threshold).
const UNMUTATED = [
  '!gsd-core/bin/lib/command-aliases.cjs',
  '!gsd-core/bin/lib/commands.cjs',
  '!gsd-core/bin/lib/core.cjs',
  '!gsd-core/bin/lib/install-profiles.cjs',
  '!gsd-core/bin/lib/installer-migrations.cjs',
  '!gsd-core/bin/lib/phase.cjs',
  '!gsd-core/bin/lib/profile-output.cjs',
  '!gsd-core/bin/lib/state.cjs',
  '!gsd-core/bin/lib/verify.cjs',
  '!gsd-core/bin/lib/init.cjs',
  '!gsd-core/bin/lib/audit.cjs',
  '!gsd-core/bin/lib/gsd2-import.cjs',
];

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // ── Test runner ──────────────────────────────────────────────────────────────
  testRunner: 'tap',
  tap: {
    testFiles: resolveMutationTestFiles(process.env.MUTATION_TEST_FILES),
    // forceBail is OFF (MEASURED, #3915): a structural AST audit of all 26 shard test
    // files found 3 that spawn subprocesses — tests/config-schema.property.test.cjs
    // (6 runGsdTools calls), tests/core-utils.test.cjs (1), and
    // tests/feat-3881-yaml-parser-consequences.test.cjs (2 runGsdTools + 2 runNode).
    // @stryker-mutator/tap-runner's docs warn that with forceBail on, a runner that
    // spawns child processes can be terminated prematurely — bail fires on every KILLED
    // mutant (i.e. most of them), so leaving it on would kill hundreds of processes
    // mid-spawnSync per shard and orphan their children. The cost of leaving it off is
    // only INTRA-file early exit: Stryker's separate `disableBail` (unset, default false)
    // still skips the remaining FILES in tap.testFiles after a failure, so this is no
    // worse than the command runner's behaviour was.
    forceBail: false,
    // No nodeArgs, and no top-level buildCommand (ADR-457): the plugin's default argv,
    // ["--test-reporter=tap", "-r", "{{hookFile}}", "{{testFile}}"], contains no build
    // step, and ADR-457 requires Stryker to test the ALREADY-BUILT gsd-core/bin/lib/*.cjs
    // artifacts with no rebuild between mutation and test.
  },

  // ── Files to mutate ──────────────────────────────────────────────────────────
  // The built bin/lib/*.cjs artifacts (ADR-457). CI overrides this with
  // --mutate <changed, covered modules> computed in mutation.yml.
  mutate: [
    'gsd-core/bin/lib/**/*.cjs',
    '!gsd-core/bin/lib/**/*.test.cjs',
    ...UNMUTATED,
  ],

  // ── Coverage ─────────────────────────────────────────────────────────────────
  // 'perTest' (#3915): 'off' was required only because the command runner could not
  // instrument per-mutant coverage. @stryker-mutator/tap-runner is an official plugin
  // that does support it, so Stryker now re-runs only the test files that cover each
  // mutated line rather than the full per-shard test list for every mutant.
  //
  // Arithmetic note: 'perTest' makes Stryker able to report a mutant as NoCoverage, and
  // NoCoverage counts in the SAME denominator as Survived for `mutationScore` — so this
  // reclassification is score-neutral for both `thresholds.break` and
  // scripts/check-mutation-score-ratchet.cjs. Never gate on
  // `mutationScoreBasedOnCoveredCode`, which EXCLUDES NoCoverage and inflates sharply
  // under this setting.
  coverageAnalysis: 'perTest',

  // ── Thresholds ───────────────────────────────────────────────────────────────
  // ADR-456 / issue #1187: CI passes the per-module minScore (from
  // scripts/mutation-matrix.cjs) via the MUTATION_BREAK environment variable.
  // Each CI shard sets MUTATION_BREAK to its module's floor so Stryker enforces
  // the ratchet. Local runs without MUTATION_BREAK fall back to 60 (backstop).
  // Do NOT raise the fallback here; raise individual minScore values in
  // mutation-matrix.cjs instead.
  thresholds: {
    high: 80,
    low: 60,
    break: resolveMutationBreak(process.env.MUTATION_BREAK),
  },

  // ── Incremental mode ─────────────────────────────────────────────────────────
  // Cache mutation results; re-run only changed mutants on subsequent calls.
  // In CI the workflow computes changed files and passes: stryker run --incremental --mutate <list>
  incremental: true,
  incrementalFile: '.stryker-incremental.json',

  // ── Reporters ────────────────────────────────────────────────────────────────
  // 'json' (default path reports/mutation/mutation.json) is the machine-readable score
  // source for scripts/check-mutation-score-ratchet.cjs (#3881 follow-up, mutation-matrix
  // piece 3) — mutation.yml's `mutate` job reads it after `npx stryker run` to detect a
  // module whose achieved score has drifted above its floor by more than the documented
  // slack, so a stale-but-passing floor gets a loud CI failure instead of sitting forever.
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/mutation.html',
  },

  // ── Temp directory ───────────────────────────────────────────────────────────
  tempDirName: '.stryker-tmp',

  // ── Ignore patterns ──────────────────────────────────────────────────────────
  ignorePatterns: [
    'node_modules',
    'reports',
    '.stryker-tmp',
    'coverage',
    'hooks/dist',
  ],
};

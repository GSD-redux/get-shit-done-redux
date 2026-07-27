/**
 * stryker.config.mjs
 *
 * Mutation testing configuration for gsd-core.
 *
 * Test runner: 'command' (built into @stryker-mutator/core)
 *   Runs: node --test over the lib test files via the repo's run-tests invocation.
 *
 * Mutate scope: bin/lib/**\/*.cjs, excluding generated files and test files.
 *
 * coverageAnalysis: 'off' — command runner does not support per-mutant coverage
 * thresholds: high=80, low=60, break=50
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
const { resolveMutationBreak } = _require('./scripts/mutation-matrix.cjs');

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

// Full test command used by local runs and as the fallback when CI does not
// inject a per-shard command via MUTATION_TEST_CMD.
// Keep this list in sync with the tests arrays in scripts/mutation-matrix.cjs COVERED.
const DEFAULT_TEST_CMD = 'node --test tests/context-utilization.property.test.cjs tests/prompt-budget.property.test.cjs tests/frontmatter.property.test.cjs tests/adr-parser.property.test.cjs tests/config-schema.property.test.cjs tests/adr-parser.test.cjs tests/active-workstream-store.test.cjs tests/active-workstream-store.unit.test.cjs tests/prompt-budget.unit.test.cjs tests/adr-parser.unit.test.cjs tests/frontmatter.unit.test.cjs tests/unusable-input.test.cjs tests/core-utils.test.cjs tests/broken-windows.test.cjs';

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // ── Test runner ──────────────────────────────────────────────────────────────
  testRunner: 'command',
  commandRunner: {
    // Run property + unit tests over lib only (avoids the slow integration
    // suite). NO build step here: Stryker mutates the already-built .cjs and the
    // tests load it directly — adding a build would rebuild over the mutation.
    // In CI each matrix shard injects MUTATION_TEST_CMD with only its own tests.
    command: process.env.MUTATION_TEST_CMD || DEFAULT_TEST_CMD,
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
  // 'off' is required for the command test runner — it cannot instrument per-mutant.
  coverageAnalysis: 'off',

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
  reporters: ['html', 'clear-text', 'progress'],
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

#!/usr/bin/env node
'use strict';

/**
 * scripts/check-mutation-score-ratchet.cjs
 *
 * #3881 follow-up ("one YAML parser" mutation-matrix piece 3): makes each
 * module's `minScore` floor (scripts/mutation-matrix.cjs COVERED) ratchet
 * UPWARD instead of sitting wherever it was last hand-set.
 *
 * Two halves of "never lowerable without a reasoned marker":
 *   1. `tests/mutation-matrix-ratchet.test.cjs`'s RATCHET_BASELINE already
 *      enforces the DOWN side: any change to a module's minScore — up or
 *      down — must land in the same diff as a matching RATCHET_BASELINE
 *      edit, making the change visible in code review (mirrors this repo's
 *      other shrink-only baselines, e.g. scripts/lint-unreachable-guard-drift.cjs's
 *      $comment convention: a number cannot move silently).
 *   2. THIS script enforces the UP side: after a real CI Stryker run, if the
 *      module's ACHIEVED mutation score exceeds its declared floor by more
 *      than RATCHET_SLACK points, that is not "run-to-run variance" (this
 *      file's own header documents variance as 1-2 points; see
 *      scripts/mutation-matrix.cjs's "Floors are measured scores minus 1-2
 *      pts") — it is unclaimed headroom, and the floor should have been
 *      raised. Exits 1 telling the author exactly what to raise it to, so a
 *      module that improves cannot silently keep a stale, low bar forever.
 *
 * Consumes Stryker's `json` reporter output (mutation-testing-report-schema
 * document; stryker.config.mjs's `reporters` includes `'json'`, default path
 * `reports/mutation/mutation.json`) via `mutation-testing-metrics` — the same
 * package Stryker itself uses internally to compute a report's score — rather
 * than re-deriving killed/survived counts by hand.
 *
 * Wired into `.github/workflows/mutation.yml`'s `mutate` job as a step AFTER
 * `npx stryker run`, gated on the shard having passed (a shard that failed
 * MUTATION_BREAK is a floor problem, not a ratchet problem — Stryker's own
 * exit code already reports that).
 *
 * CLI:
 *   node scripts/check-mutation-score-ratchet.cjs --module <name> [--report <path>] [--matrix <path>]
 * `--report` defaults to reports/mutation/mutation.json (Stryker's own default).
 * `--matrix` defaults to this repo's own scripts/mutation-matrix.cjs; it is an injectable seam
 * so tests can point the CLI at a synthetic COVERED fixture instead of the real, live-ratcheting
 * config (see tests/mutation-score-ratchet.test.cjs — a test asserting this script's fail/pass
 * behaviour must never hardcode a real module's numeric floor, because that floor is exactly
 * what this mechanism exists to move).
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// Slack, in mutation-score points, above a module's declared minScore floor before this
// ratchet demands the floor be raised. Deliberately larger than the 1-2 point run-to-run
// TIMEOUT variance margin scripts/mutation-matrix.cjs's floors are already set with (its own
// header: "Floors are measured scores minus 1-2 pts for run-to-run variance") — that smaller
// margin is calibrated for the noise BETWEEN two runs of the SAME test list against the SAME
// source. RATCHET_SLACK instead has to tolerate the noise this file's own history already
// shows for the frontmatter module across genuine measurement events (63.35 -> 66.67 ->
// 60.58 -> pending, each a real CI measurement, not pure jitter, spanning >3 points on its
// own). 5 points sits comfortably above that observed band without being so wide that a
// module sitting well above TARGET_MUTATION_SCORE (80) could coast for years without its
// floor ever being asked to move.
const RATCHET_SLACK = 5;

/**
 * Pure: does `achievedScore` (0-100) exceed `floor` (minScore) by more than `slack`?
 * Returns `{ shouldRatchet, suggestedFloor }` — `suggestedFloor` follows the SAME formula
 * scripts/mutation-matrix.cjs's own header documents for setting a floor from a measured
 * score: `floor(measured) - 1`.
 */
function evaluateRatchet(achievedScore, floor, slack = RATCHET_SLACK) {
  const shouldRatchet = achievedScore - floor > slack;
  return {
    shouldRatchet,
    suggestedFloor: shouldRatchet ? Math.floor(achievedScore) - 1 : floor,
  };
}

/**
 * Extract the achieved mutation score from a Stryker `json` reporter document via
 * `mutation-testing-metrics` (the same library Stryker itself uses to compute scores).
 * Throws a descriptive error if the document has no scoreable mutants at all (an empty
 * `files` map, or every file having zero mutants) — that is a wiring bug in the caller
 * (wrong report path, or the shard mutated nothing), never a score of 0.
 */
function extractAchievedScore(report) {
  // Lazy require: this dependency is only needed on the actual score-extraction path, not
  // when this module is required purely for evaluateRatchet (used by unit tests without the
  // mutation-testing-metrics package's schema-validation overhead).
  const { calculateMutationTestMetrics } = require('mutation-testing-metrics');
  const metrics = calculateMutationTestMetrics(report);
  const score = metrics && metrics.systemUnderTestMetrics && metrics.systemUnderTestMetrics.metrics
    ? metrics.systemUnderTestMetrics.metrics.mutationScore
    : undefined;
  if (typeof score !== 'number' || Number.isNaN(score)) {
    throw new Error('mutation report produced no scoreable mutants — check --report points at the right shard\'s reports/mutation/mutation.json');
  }
  return score;
}

function parseArgs(argv) {
  const out = { module: null, report: 'reports/mutation/mutation.json', matrix: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--module') {
      out.module = argv[++i];
    } else if (arg === '--report') {
      out.report = argv[++i];
    } else if (arg === '--matrix') {
      out.matrix = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.module) throw new Error('--module <name> is required');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixPath = args.matrix ? path.resolve(args.matrix) : path.join(__dirname, 'mutation-matrix.cjs');
  const { COVERED } = require(matrixPath);
  const entry = COVERED[args.module];
  if (!entry) {
    throw new ExitError(1, `check-mutation-score-ratchet: unknown module '${args.module}' — not in ${args.matrix ? matrixPath : 'scripts/mutation-matrix.cjs'} COVERED`);
  }

  const reportPath = path.resolve(args.report);
  if (!fs.existsSync(reportPath)) {
    throw new ExitError(1, `check-mutation-score-ratchet: report not found at ${reportPath} — run \`npx stryker run\` first (with the 'json' reporter enabled)`);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new ExitError(1, `check-mutation-score-ratchet: ${reportPath} is not valid JSON: ${err.message}`);
  }

  const achieved = extractAchievedScore(report);
  const { shouldRatchet, suggestedFloor } = evaluateRatchet(achieved, entry.minScore);

  if (!shouldRatchet) {
    console.log(`ok mutation-score-ratchet: ${args.module} achieved ${achieved.toFixed(2)}% against floor ${entry.minScore} (within ${RATCHET_SLACK}-point slack)`);
    return;
  }

  console.error(`mutation-score-ratchet: ${args.module} achieved ${achieved.toFixed(2)}%, more than ${RATCHET_SLACK} points above its declared floor (${entry.minScore}).`);
  console.error(`  This is unclaimed headroom, not run-to-run variance — raise the floor.`);
  console.error(`  remedy: in scripts/mutation-matrix.cjs, set COVERED['${args.module}'].minScore = ${suggestedFloor} (floor(achieved) - 1, this file's own convention),`);
  console.error(`  and update the matching entry in tests/mutation-matrix-ratchet.test.cjs's RATCHET_BASELINE in the same diff.`);
  throw new ExitError(1);
}

module.exports = { RATCHET_SLACK, evaluateRatchet, extractAchievedScore };

if (require.main === module) runMain(main);

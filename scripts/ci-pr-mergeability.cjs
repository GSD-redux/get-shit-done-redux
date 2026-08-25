#!/usr/bin/env node
'use strict';

// ci-pr-mergeability.cjs — #3833 PR mergeability preflight.
//
// Risk asymmetry drives this design: a false positive (a clean PR wrongly
// classified CONFLICTED) skips every gated compute lane in all eight gated
// workflows on EVERY PR — a repo-wide outage. A false negative (a real
// conflict missed) is today's behavior; the per-job scripts/ci-rebase-check.cjs
// backstop still catches it there. So the weight is entirely on the
// false-positive surface: the single predicate `mergeable === false`, and
// every falsy-but-not-false value around it.
//
// GitHub's `mergeable` field on GET /repos/:owner/:repo/pulls/:number is a
// documented tri-state: `true`, `false`, or `null` while a background
// computation is still running. `null` is falsy — `if (!mergeable)` would
// misclassify "still computing" as "conflicted" and would have red every PR
// in the repo the moment this job started running. Only strict `=== false`
// counts as a conflict.
//
// `mergeable_state` is read only for the human-facing annotation, never for
// the verdict: its `blocked` value means "required checks have not passed",
// which is true for every PR while THIS preflight job itself is one of the
// required checks still running — classifying on it would self-deadlock the
// pipeline (the gate can never go green because it is itself ungreen).
//
// Because `mergeable` starts null and GitHub computes it asynchronously, this
// polls with linear backoff up to a small budget, then fails OPEN
// (INDETERMINATE => exit 0) rather than blocking the world on an API that
// hasn't finished thinking.

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const VERDICT = Object.freeze({
  MERGEABLE: 'MERGEABLE',
  CONFLICTED: 'CONFLICTED',
  INDETERMINATE: 'INDETERMINATE',
  SKIPPED_NOT_A_PR: 'SKIPPED_NOT_A_PR',
});

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

/**
 * Pure, total classifier: payload -> VERDICT atom. Never throws.
 * Deliberately reads ONLY `mergeable`, and only with strict equality — see
 * the header comment for why `mergeable_state` and truthiness are excluded.
 */
function classifyMergeability(payload) {
  if (payload === null || typeof payload !== 'object') return VERDICT.INDETERMINATE;
  if (payload.mergeable === true) return VERDICT.MERGEABLE;
  if (payload.mergeable === false) return VERDICT.CONFLICTED;
  return VERDICT.INDETERMINATE;
}

/**
 * Linear backoff: attempt 1..N-1 gives 1x..(N-1)x baseMs. Non-positive/NaN
 * attempts clamp to one base interval rather than producing 0 or NaN delays.
 */
function nextDelayMs(attempt, { baseMs = BASE_DELAY_MS } = {}) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  return baseMs * n;
}

/**
 * Dependency-injected poll loop. Resolves as soon as GitHub reports a
 * definite mergeable/conflicted state, or gives up after maxAttempts and
 * reports INDETERMINATE (fail-open).
 *
 * @returns {Promise<{verdict:string, attempts:number, payload:*, reason:string}>}
 */
async function resolveMergeability({
  fetchPr,
  sleep,
  eventName,
  prNumber,
  maxAttempts = MAX_ATTEMPTS,
  baseDelayMs = BASE_DELAY_MS,
} = {}) {
  if (eventName !== 'pull_request') {
    return { verdict: VERDICT.SKIPPED_NOT_A_PR, attempts: 0, payload: null, reason: 'not-a-pull-request' };
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { verdict: VERDICT.INDETERMINATE, attempts: 0, payload: null, reason: 'no-pr-number' };
  }

  let attempts = 0;
  let lastPayload = null;
  let lastError = null;

  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;
    let payload;
    try {
      payload = await fetchPr(prNumber);
      lastPayload = payload;
      lastError = null;
    } catch (err) {
      lastError = err;
      payload = null;
    }

    const verdict = classifyMergeability(payload);
    if (verdict === VERDICT.MERGEABLE || verdict === VERDICT.CONFLICTED) {
      return { verdict, attempts, payload, reason: 'resolved' };
    }

    if (i < maxAttempts) {
      await sleep(nextDelayMs(i, { baseMs: baseDelayMs }));
    }
  }

  return {
    verdict: VERDICT.INDETERMINATE,
    attempts,
    payload: lastPayload,
    reason: lastError ? 'fetch-failed' : 'mergeability-not-computed',
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-pr-mergeability.cjs',
    '',
    'CI-only preflight: polls the GitHub API for a PR\'s mergeable state and',
    'fails the job (exit 1) only on a definite conflict. Everything else',
    '(unknown, unreadable, not a PR) fails open (exit 0).',
    '',
    'Environment variables read:',
    '  GITHUB_EVENT_NAME    workflow trigger event; only "pull_request" is polled',
    '  GITHUB_REPOSITORY    owner/repo',
    '  GITHUB_TOKEN         optional bearer token for the API read',
    '  GITHUB_BASE_REF      PR base branch name (default: next)',
    '  GITHUB_API_URL       GitHub API base URL (default: https://api.github.com)',
    '  PR_NUMBER            the pull request number',
    '  GITHUB_OUTPUT        path to append verdict=/mergeable= step outputs to',
    '  GITHUB_STEP_SUMMARY  path to append a human-readable summary to',
    '  GSD_PR_MERGEABILITY_BASE_DELAY_MS  optional numeric override of the base backoff, for tests',
  ].join('\n');
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      throw new ExitError(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
}

function writeOutput(lines) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath !== 'string' || outputPath === '') return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(outputPath, `${lines.join('\n')}\n`);
  } catch (err) {
    // A failure while REPORTING the verdict must never invert the gate.
    process.stderr.write(`::warning::failed to write GITHUB_OUTPUT: ${err.message}\n`);
  }
}

function writeSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath !== 'string' || summaryPath === '') return;
  try {
    const fs = require('node:fs');
    fs.appendFileSync(summaryPath, `${text}\n`);
  } catch (err) {
    process.stderr.write(`::warning::failed to write GITHUB_STEP_SUMMARY: ${err.message}\n`);
  }
}

// `argv` defaults to real CLI argv but is a parameter so tests can call
// main() in-process (e.g. main([])) without inheriting the test runner's own
// argv, which would otherwise trip parseArgs's "unknown argument" branch.
async function main(argv = process.argv.slice(2)) {
  parseArgs(argv);

  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const baseBranch = process.env.GITHUB_BASE_REF || 'next';
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const prNumberRaw = process.env.PR_NUMBER;
  const prNumber = Number.parseInt(prNumberRaw, 10);

  const overrideDelay = Number(process.env.GSD_PR_MERGEABILITY_BASE_DELAY_MS);
  const baseDelayMs = Number.isFinite(overrideDelay) && overrideDelay >= 0 ? overrideDelay : BASE_DELAY_MS;

  const fetchPr = async (number) => {
    const url = `${apiBase}/repos/${repo}/pulls/${number}`;
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gsd-core-ci-pr-mergeability',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const result = await resolveMergeability({
    fetchPr,
    sleep,
    eventName,
    prNumber: Number.isNaN(prNumber) ? NaN : prNumber,
    maxAttempts: MAX_ATTEMPTS,
    baseDelayMs,
  });

  const mergeable = result.verdict === VERDICT.CONFLICTED ? 'false' : 'true';
  writeOutput([`verdict=${result.verdict}`, `mergeable=${mergeable}`]);
  writeSummary(`PR mergeability preflight: ${result.verdict}`);

  if (result.verdict === VERDICT.CONFLICTED) {
    process.stderr.write(
      `::error::This pull request cannot cleanly merge ${baseBranch}. Rebase onto current ${baseBranch} and push again; no CI will run until the conflict is resolved.\n`,
    );
    const state = result.payload && typeof result.payload === 'object' ? result.payload.mergeable_state : undefined;
    if (state) {
      process.stderr.write(`::error::mergeable_state: ${state}\n`);
    }
    return 1;
  }

  if (result.verdict === VERDICT.INDETERMINATE) {
    process.stderr.write(
      '::warning::GitHub did not report mergeability within the polling budget; proceeding (fail-open). scripts/ci-rebase-check.cjs remains the in-job backstop.\n',
    );
    return 0;
  }

  process.stdout.write(`PR mergeability preflight: ${result.verdict}\n`);
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  VERDICT,
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  classifyMergeability,
  nextDelayMs,
  resolveMergeability,
  main,
};

#!/usr/bin/env node
'use strict';

// ci-next-health.cjs — #4422 base-branch health gate.
//
// Risk asymmetry drives this design, same shape as scripts/ci-pr-mergeability.cjs
// but pointed the other direction: on 2026-09-06 three unrelated PRs merged on
// top of an already-broken `next` before anyone noticed, because nothing checked
// the base branch's OWN health before letting a PR land on it. A false positive
// here (a healthy `next` wrongly reported RED) blocks every PR merge in the repo
// until a human notices and applies the `fix-next` bypass label — annoying, but
// loud and immediately actionable. A false negative (a broken `next` reported
// healthy) reproduces the #4422 incident exactly. So, unlike the mergeability
// preflight, this gate does NOT fail open on a definite red signal — it fails
// open only when the signal itself is unavailable or inapplicable (wrong event,
// no resolvable base ref, an API read that throws). Once GitHub actually answers
// with a non-success conclusion for the base branch's last push-triggered Tests
// run, that is treated as authoritative and blocks — with one explicit, visible,
// human-operated escape hatch (the `fix-next` label) for the PR that is itself
// the fix-forward.
//
// Every non-success conclusion (`failure`, `cancelled`, `timed_out`,
// `action_required`, ...) is treated as RED, not just `failure` — a cancelled or
// timed-out run on the base branch is not evidence the branch is healthy, it is
// evidence nobody knows yet.

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const VERDICT = Object.freeze({
  CLEAN: 'CLEAN',
  RED: 'RED',
  BYPASSED: 'BYPASSED',
  SKIPPED_NOT_APPLICABLE: 'SKIPPED_NOT_APPLICABLE',
  INDETERMINATE: 'INDETERMINATE',
});

const APPLICABLE_EVENTS = new Set(['pull_request', 'merge_group']);
const BYPASS_LABEL = 'fix-next';
const TESTS_WORKFLOW_FILE = 'test.yml';

/**
 * Pure, total classifier: the GitHub "list workflow runs" response payload ->
 * CLEAN | RED | INDETERMINATE. Never throws.
 *
 * - Not an object, or `workflow_runs` isn't an array -> INDETERMINATE: the
 *   shape we depend on is not present, so nothing can be concluded.
 * - No completed push runs found yet (e.g. a brand-new `release/**`/`hotfix/**`
 *   branch with no Tests history) -> CLEAN: absence of evidence of red is not
 *   evidence of red, and a brand-new branch must not be permanently unmergeable.
 * - The most recent run's `conclusion === 'success'` -> CLEAN.
 * - Anything else (failure, cancelled, timed_out, action_required, ...) -> RED.
 */
function classifyRunConclusion(payload) {
  if (payload === null || typeof payload !== 'object') return VERDICT.INDETERMINATE;
  if (!Array.isArray(payload.workflow_runs)) return VERDICT.INDETERMINATE;
  if (payload.workflow_runs.length === 0) return VERDICT.CLEAN;
  const [latest] = payload.workflow_runs;
  if (latest && latest.conclusion === 'success') return VERDICT.CLEAN;
  return VERDICT.RED;
}

/**
 * Dependency-injected orchestrator. `fetchLatestRun` is an async function
 * taking the resolved base branch name and returning the parsed API payload
 * (or throwing) — injected so tests never touch the network.
 *
 * @returns {Promise<{verdict:string, payload:*, reason:string}>}
 */
async function resolveNextHealth({ fetchLatestRun, eventName, baseRef, labels } = {}) {
  if (!APPLICABLE_EVENTS.has(eventName)) {
    return { verdict: VERDICT.SKIPPED_NOT_APPLICABLE, payload: null, reason: 'not-applicable-event' };
  }

  if (typeof baseRef !== 'string' || baseRef.trim() === '') {
    return { verdict: VERDICT.INDETERMINATE, payload: null, reason: 'no-base-ref' };
  }

  let payload = null;
  try {
    payload = await fetchLatestRun(baseRef);
  } catch (err) {
    return { verdict: VERDICT.INDETERMINATE, payload: null, reason: `fetch-failed: ${err.message}` };
  }

  const classified = classifyRunConclusion(payload);
  if (classified !== VERDICT.RED) {
    return { verdict: classified, payload, reason: 'resolved' };
  }

  // Escape hatch. `labels` is empty/absent for merge_group — that event has no
  // label surface today, which means a queued merge-group commit cannot use
  // this bypass. Known gap, not solved here: a maintainer must land the
  // fix-forward as a direct pull_request merge (where the label IS readable)
  // rather than through the merge queue, until GitHub exposes an equivalent
  // signal for merge_group.
  const labelList = Array.isArray(labels) ? labels : [];
  if (labelList.includes(BYPASS_LABEL)) {
    return { verdict: VERDICT.BYPASSED, payload, reason: 'bypass-label' };
  }

  return { verdict: VERDICT.RED, payload, reason: 'red' };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ci-next-health.cjs',
    '',
    'CI-only gate: checks whether the PR/merge-group\'s base branch\'s own last',
    'push-triggered Tests run is red, and fails the job (exit 1) when it is —',
    'unless the PR carries the "fix-next" bypass label. Every other case',
    '(wrong event, no resolvable base ref, an unreadable API read) fails open',
    '(exit 0).',
    '',
    'Environment variables read:',
    '  GITHUB_EVENT_NAME     workflow trigger event; only "pull_request" and',
    '                        "merge_group" are checked',
    '  GITHUB_REPOSITORY     owner/repo',
    '  GITHUB_TOKEN          optional bearer token for the API read',
    '  GITHUB_BASE_REF       PR base branch name (pull_request events; set',
    '                        automatically by GitHub Actions)',
    '  MERGE_GROUP_BASE_REF  merge-group base ref (merge_group events; the',
    '                        caller workflow must populate this from',
    '                        github.event.merge_group.base_ref — a leading',
    '                        "refs/heads/" prefix is stripped if present)',
    '  GITHUB_API_URL        GitHub API base URL (default: https://api.github.com)',
    '  PR_LABELS             comma-separated PR label names (pull_request events;',
    '                        the caller workflow must populate this from',
    '                        github.event.pull_request.labels.*.name); checked',
    '                        for the literal "fix-next" bypass label',
    '  GITHUB_OUTPUT         path to append verdict= step output to',
    '  GITHUB_STEP_SUMMARY   path to append a human-readable summary to',
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

function resolveBaseRef(eventName) {
  if (eventName === 'pull_request') {
    return process.env.GITHUB_BASE_REF || '';
  }
  if (eventName === 'merge_group') {
    const raw = process.env.MERGE_GROUP_BASE_REF || '';
    return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  }
  return '';
}

function parseLabels(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function runUrlOf(payload) {
  const run = payload && Array.isArray(payload.workflow_runs) ? payload.workflow_runs[0] : undefined;
  return run && typeof run.html_url === 'string' ? run.html_url : '(unknown run URL)';
}

// `argv` defaults to real CLI argv but is a parameter so tests can call
// main() in-process (e.g. main([])) without inheriting the test runner's own
// argv, which would otherwise trip parseArgs's "unknown argument" branch.
async function main(argv = process.argv.slice(2)) {
  parseArgs(argv);

  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
  const baseRef = resolveBaseRef(eventName);
  const labels = parseLabels(process.env.PR_LABELS);

  const fetchLatestRun = async (branch) => {
    const url = `${apiBase}/repos/${repo}/actions/workflows/${TESTS_WORKFLOW_FILE}/runs`
      + `?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=1`;
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gsd-core-ci-next-health',
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

  const result = await resolveNextHealth({ fetchLatestRun, eventName, baseRef, labels });

  writeOutput([`verdict=${result.verdict}`]);
  writeSummary(`Base branch health: ${result.verdict}`);

  if (result.verdict === VERDICT.RED) {
    const runUrl = runUrlOf(result.payload);
    process.stderr.write(
      `::error::the base branch "${baseRef}"'s own last Tests run is red: ${runUrl} — `
      + 'wait for a fix-forward merge, or if THIS pull request is the fix, ask a '
      + `maintainer to apply the "${BYPASS_LABEL}" label to explicitly override this gate.\n`,
    );
    return 1;
  }

  if (result.verdict === VERDICT.BYPASSED) {
    const runUrl = runUrlOf(result.payload);
    process.stderr.write(
      `::warning::the base branch "${baseRef}"'s own last Tests run is red: ${runUrl} — `
      + `a human applied the "${BYPASS_LABEL}" label to explicitly override this gate.\n`,
    );
    return 0;
  }

  if (result.verdict === VERDICT.INDETERMINATE) {
    process.stderr.write(
      `::warning::could not determine "${baseRef || '(no base ref)'}"'s Tests health (${result.reason}); `
      + 'proceeding (fail-open).\n',
    );
    return 0;
  }

  process.stdout.write(`Base branch health: ${result.verdict}\n`);
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  VERDICT,
  BYPASS_LABEL,
  TESTS_WORKFLOW_FILE,
  classifyRunConclusion,
  resolveNextHealth,
  main,
};

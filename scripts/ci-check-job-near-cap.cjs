#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { computeElapsedPct, isNearCap, formatNearCapNotice } = require('./lib/ci-job-timing.cjs');

function run(env = process.env, nowMs = Date.now(), appendFileSync = fs.appendFileSync) {
  const label = env.CI_JOB_LABEL;
  const startEpochMs = Number(env.CI_JOB_START_EPOCH_MS);
  const timeoutMinutes = Number(env.CI_JOB_TIMEOUT_MINUTES);

  if (!label || !Number.isFinite(startEpochMs) || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    console.error(
      'ci-check-job-near-cap: missing or invalid CI_JOB_LABEL / CI_JOB_START_EPOCH_MS / '
      + 'CI_JOB_TIMEOUT_MINUTES — skipping near-cap check (advisory only, not a failure).',
    );
    return { skipped: true };
  }

  const { elapsedMs, capMs, pct } = computeElapsedPct({
    startedAt: new Date(startEpochMs).toISOString(),
    completedAt: new Date(nowMs).toISOString(),
    timeoutMinutes,
  });

  if (!isNearCap(pct)) {
    return { skipped: false, nearCap: false, pct };
  }

  const { warningLine, summaryMarkdown } = formatNearCapNotice({ label, pct, elapsedMs, capMs });
  console.log(warningLine);

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${summaryMarkdown}\n`);
    } catch (err) {
      console.error(`ci-check-job-near-cap: could not write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }

  return { skipped: false, nearCap: true, pct };
}

module.exports = { run };

if (require.main === module) {
  run();
  process.exitCode = 0;
}

'use strict';

/**
 * scripts/lib/ci-job-timing.cjs
 *
 * Pure budget-percentage arithmetic shared by the in-job near-cap check
 * (scripts/ci-check-job-near-cap.cjs) and the scheduled trending report
 * (scripts/ci-timeout-report.cjs). See #4036.
 */

/** A job at or above this fraction of its `timeout-minutes` cap is "near-cap". */
const THRESHOLD_PCT = 0.9;

/**
 * @param {{startedAt: string, completedAt: string, timeoutMinutes: number}} args
 * @returns {{elapsedMs: number, capMs: number, pct: number}}
 */
function computeElapsedPct({ startedAt, completedAt, timeoutMinutes }) {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(`timeoutMinutes must be a positive finite number, got ${timeoutMinutes}`);
  }

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(completedAt).getTime();

  if (!Number.isFinite(startMs)) {
    throw new Error(`startedAt is not a valid timestamp: ${startedAt}`);
  }
  if (!Number.isFinite(endMs)) {
    throw new Error(`completedAt is not a valid timestamp: ${completedAt}`);
  }

  const elapsedMs = endMs - startMs;
  if (elapsedMs < 0) {
    throw new Error(`completedAt (${completedAt}) is before startedAt (${startedAt})`);
  }

  const capMs = timeoutMinutes * 60000;
  return { elapsedMs, capMs, pct: elapsedMs / capMs };
}

/**
 * @param {number} pct
 * @param {number} [threshold]
 * @returns {boolean}
 */
function isNearCap(pct, threshold = THRESHOLD_PCT) {
  return pct >= threshold;
}

/**
 * @param {{label: string, pct: number, elapsedMs: number, capMs: number}} args
 * @returns {{warningLine: string, summaryMarkdown: string}}
 */
function formatNearCapNotice({ label, pct, elapsedMs, capMs }) {
  const pctStr = `${Math.round(pct * 100)}%`;
  const elapsedMin = (elapsedMs / 60000).toFixed(1);
  const capMin = (capMs / 60000).toFixed(1);
  const detail = `${label} at ${pctStr} of its ${capMin}m cap (${elapsedMin}m elapsed)`;

  return {
    warningLine: `::warning title=CI budget::${detail}`,
    summaryMarkdown: `- **${label}** — ${pctStr} of ${capMin}m cap (${elapsedMin}m elapsed)`,
  };
}

module.exports = {
  THRESHOLD_PCT,
  computeElapsedPct,
  isNearCap,
  formatNearCapNotice,
};

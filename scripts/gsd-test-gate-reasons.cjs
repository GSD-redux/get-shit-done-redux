'use strict';

// Renamed (was `test-failure-reasons.cjs`): the old basename matched Node's
// `test-*.EXT` test-collection pattern, so the remote push-gate runner
// collected and executed this SOURCE file as a test while GitHub CI (which
// globs only tests/**/*.test.cjs) never saw it — see
// scripts/lint-source-test-name-collision.cjs.

const TEST_GATE_REASON = Object.freeze({
  PASS: 'pass',
  TEST_FAILURE: 'test_failure',
  INFRA_FAILURE: 'infra_failure',
  UNKNOWN_FAILURE: 'unknown_failure',
});

/**
 * Classify gsd-test style output + exit code into a typed reason.
 * @param {{exitCode:number, output?:string}} input
 * @returns {{ok:boolean, reason:string}}
 */
function classifyTestGateResult(input) {
  const exitCode = Number(input?.exitCode ?? 0);
  const output = String(input?.output ?? '');

  if (exitCode === 0) return { ok: true, reason: TEST_GATE_REASON.PASS };

  // gsd-test/gsd-test-summary infrastructure class (exit 2)
  if (exitCode === 2 || /infrastructure failure|worktree\.Construct/i.test(output)) {
    return { ok: false, reason: TEST_GATE_REASON.INFRA_FAILURE };
  }

  // test failures (non-zero plus explicit FAIL lines)
  if (/\bFAIL\b|\d+\s+failures?\)|failed\)/i.test(output)) {
    return { ok: false, reason: TEST_GATE_REASON.TEST_FAILURE };
  }

  return { ok: false, reason: TEST_GATE_REASON.UNKNOWN_FAILURE };
}

module.exports = { TEST_GATE_REASON, classifyTestGateResult };

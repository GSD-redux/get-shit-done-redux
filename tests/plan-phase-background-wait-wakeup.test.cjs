// allow-test-rule: source-text-is-the-product — see #2650, #4079
// Workflow markdown is the installed orchestration contract.

'use strict';

/**
 * #4079 — background-wait pattern lets the orchestrator reach for the host's
 * `ScheduleWakeup` tool with partial arguments.
 *
 * On Claude Code, a `ScheduleWakeup` tool is surfaced in-session (the /loop
 * dynamic-pacing surface). While a GSD workflow waits on a background subagent
 * (researcher / pattern-mapper synchronous Agent() stop-and-wait, the
 * planner/checker/revision `gsd_stall_watch` polling waits, or the manager
 * dashboard's background dispatch), the orchestrator model could spontaneously
 * literalize "I'll wait" by calling `ScheduleWakeup` — a tool GSD never
 * documents — with incomplete arguments, surfacing the host's red validation
 * error: "`prompt` is required when `stop` is not true."
 *
 * The fix is contract-level, not code-level: every wait-instruction site now
 * carries an explicit prohibition — never call `ScheduleWakeup` or any host
 * wake/sleep-scheduling tool to literalize a wait; the sanctioned mechanisms
 * (blocking Agent() return, `gsd_stall_watch` bash polling) ARE the wait.
 *
 * These are content-contract tests over the shipped workflow text (same
 * "source text is the product" pattern as tests/plan-phase-stall-detection
 * .test.cjs) — they fail on any future edit that drops the guard.
 *
 * Seam: gsd-core/workflows/plan-phase.md,
 *       gsd-core/workflows/plan-phase/steps/stall-detection-helpers.md,
 *       gsd-core/workflows/manager.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readFileNormalized } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PLAN_PHASE_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md');
const STALL_HELPERS_PATH = path.join(
  REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase', 'steps', 'stall-detection-helpers.md'
);
const MANAGER_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'manager.md');

// The phase6 shrink-only line for plan-phase.md (tests/phase6-capstone-
// conformance.test.cjs PRE_PHASE6) — mirrored here so a guard sentence can
// never quietly push the file past it. #3771/#3916 raised the authoritative
// PRE_PHASE6 value (94519 -> 96700 -> 98300) for the REVISION_CONFLICT
// persistence/routing gate before this file's own next-merge landed; keep
// this mirror equal to that constant, not a stale snapshot of it.
const PLAN_PHASE_PHASE6_LINE = 98300;

function lfByteCount(p) {
  return Buffer.byteLength(readFileNormalized(p), 'utf-8');
}

/** Split plan-phase.md into its ORCHESTRATOR RULE blocks. */
function orchestratorRules(content) {
  return content.split('\n')
    .filter((line) => line.includes('ORCHESTRATOR RULE'))
    .map((line) => line.trim());
}

describe('#4079 background-wait wake-tool guard', () => {
  test('every synchronous stop-and-wait ORCHESTRATOR RULE in plan-phase.md forbids ScheduleWakeup (#4079)', () => {
    const content = readFileNormalized(PLAN_PHASE_PATH);
    const stopAndWaitRules = orchestratorRules(content).filter(
      (rule) => /stop working on this task immediately/.test(rule)
    );
    assert.ok(
      stopAndWaitRules.length >= 2,
      `expected at least 2 stop-and-wait ORCHESTRATOR RULEs (researcher + pattern mapper), found ${stopAndWaitRules.length}`
    );
    const missing = stopAndWaitRules.filter((rule) => !/ScheduleWakeup/.test(rule));
    assert.deepEqual(
      missing,
      [],
      `every synchronous stop-and-wait rule must forbid ScheduleWakeup (${missing.length} do not). ` +
      'A model told only to "wait" reaches for any in-session scheduling tool with partial args (#4079).'
    );
  });

  test('stall-detection-helpers.md forbids ScheduleWakeup between gsd_stall_watch cycles (#4079)', () => {
    const content = readFileNormalized(STALL_HELPERS_PATH);
    assert.match(
      content,
      /ScheduleWakeup/,
      'the stall-wait fragment (read+executed at step 7.99 before every stall-watch wait) ' +
      'must name ScheduleWakeup so the prohibition is loaded exactly when the wait happens'
    );
    assert.match(
      content,
      /gsd_stall_watch[\s\S]{0,400}ScheduleWakeup|ScheduleWakeup[\s\S]{0,400}gsd_stall_watch/,
      'the prohibition must be tied to the gsd_stall_watch wait cycle, not float disconnected'
    );
    assert.match(
      content,
      /never part of|not part of|Do NOT call/i,
      'the fragment must state the wait tool is never part of the sanctioned wait'
    );
  });

  test('manager.md background-dispatch wait rules forbid ScheduleWakeup (#4079)', () => {
    const content = readFileNormalized(MANAGER_PATH);
    const dispatchRules = content.split('\n')
      .filter((line) => line.includes('ORCHESTRATOR RULE — BACKGROUND DISPATCH'))
      .map((line) => line.trim());
    assert.ok(
      dispatchRules.length >= 2,
      `expected at least 2 BACKGROUND DISPATCH rules (plan + execute), found ${dispatchRules.length}`
    );
    const missing = dispatchRules.filter((rule) => !/ScheduleWakeup/.test(rule));
    assert.deepEqual(
      missing,
      [],
      'every background-dispatch wait rule must forbid ScheduleWakeup — the dashboard wait ' +
      'is exactly where the model literalizes "I\'ll wait" with a partial-args wake call (#4079)'
    );
  });

  test('plan-phase.md still uses gsd_stall_watch at all three stall-watch sites (negative space)', () => {
    const content = readFileNormalized(PLAN_PHASE_PATH);
    const stallWatchRules = orchestratorRules(content).filter(
      (rule) => rule.includes('gsd_stall_watch')
    );
    assert.ok(
      stallWatchRules.length >= 3,
      `expected >= 3 gsd_stall_watch ORCHESTRATOR RULEs (planner, checker, revision), found ${stallWatchRules.length}`
    );
    // The sanctioned mechanism is unchanged — the guard only closes the escape hatch.
    assert.match(content, /marker_received/);
    assert.match(content, /stalled/);
  });

  test('plan-phase.md stays under the phase6 shrink-only line (#4079 guard)', () => {
    const bytes = lfByteCount(PLAN_PHASE_PATH);
    assert.ok(
      bytes < PLAN_PHASE_PHASE6_LINE,
      `plan-phase.md is ${bytes} LF bytes — must stay < ${PLAN_PHASE_PHASE6_LINE} ` +
      '(tests/phase6-capstone-conformance.test.cjs PRE_PHASE6)'
    );
  });

  test('manager.md background-dispatch semantics unchanged (FLATTEN gate preserved)', () => {
    const content = readFileNormalized(MANAGER_PATH);
    assert.match(content, /dispatch-should-flatten/, 'FLATTEN resolution must be preserved');
    assert.match(
      content,
      /Return to the dashboard immediately and wait for the background agent to report back/,
      'the dashboard-return wait semantics must be preserved'
    );
  });
});

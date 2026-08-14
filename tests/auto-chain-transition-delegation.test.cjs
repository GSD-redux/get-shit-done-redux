// allow-test-rule: source-text-is-the-product (see #1526)
// execute-phase.md and transition.md are shipped workflows whose deployed text IS what the
// runtime loads — asserting their cross-workflow delegation tests the deployed contract.

/**
 * #1526 — auto-chain completion must delegate post-processing to the transition workflow.
 *
 * Previously execute-phase's completion called `phase.complete` then a LIGHT inline set
 * (a partial PROJECT.md update + offer-next) and never invoked the transition workflow,
 * silently skipping graduation scan, session-continuity, project-reference, accumulated-
 * context, and the current-position/progress update. The normal transition path ran all of
 * those, so the two paths left different project state behind.
 *
 * Chosen fix (user decision, 2026-08-13): delegate — execute-phase invokes transition.md in
 * a post-completion mode that skips `verify_completion` + `update_roadmap_and_state`
 * (phase.complete already ran; avoids double-write) and begins at `evolve_project`.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXEC = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const TRANS = path.join(__dirname, '..', 'gsd-core', 'workflows', 'transition.md');

describe('#1526: auto-chain completion delegates post-processing to transition', () => {
  const exec = fs.readFileSync(EXEC, 'utf8');
  const trans = fs.readFileSync(TRANS, 'utf8');

  test('execute-phase delegates to transition.md after phase.complete (post-completion)', () => {
    // The delegation step must include the transition workflow and name post-completion mode.
    const delegateIdx = exec.indexOf('delegate_post_completion_to_transition');
    const includeIdx = exec.indexOf('@~/.claude/gsd-core/workflows/transition.md');
    assert.notEqual(delegateIdx, -1, 'execute-phase must have a delegation step');
    assert.notEqual(includeIdx, -1, 'execute-phase must @-include transition.md');
    assert.ok(includeIdx > delegateIdx, 'the transition include must be inside the delegation step');
  });

  test('the delegation skips re-running phase.complete (no double-write) and re-verification', () => {
    // Slice the delegation step and assert it names the skip set.
    const start = exec.indexOf('<step name="delegate_post_completion_to_transition');
    const end = exec.indexOf('</step>', start);
    const step = exec.slice(start, end);
    assert.ok(step.length > 0, 'delegation step must exist');
    assert.match(step, /post-completion mode/i, 'must name post-completion mode');
    assert.match(step, /verify_completion/, 'must reference the verify step to skip');
    assert.match(step, /update_roadmap_and_state/, 'must reference the roadmap/state step to skip');
    assert.match(step, /evolve_project/, 'must name evolve_project as the delegation start');
  });

  test('execute-phase no longer carries the lighter standalone update_project_md step', () => {
    // The partial inline PROJECT.md evolution was superseded by transition's evolve_project.
    // The delegation replaced it; the old standalone step name must be gone.
    assert.equal(
      exec.indexOf('<step name="update_project_md"'),
      -1,
      'the standalone update_project_md step must be removed (delegated to transition.evolve_project)',
    );
  });

  test('transition.md declares a post-completion mode that skips verify + roadmap/state', () => {
    const modeIdx = trans.indexOf('<step name="post_completion_mode"');
    assert.notEqual(modeIdx, -1, 'transition.md must have a post_completion_mode step');
    const modeEnd = trans.indexOf('</step>', modeIdx);
    const mode = trans.slice(modeIdx, modeEnd);
    assert.match(mode, /SKIP\s+`verify_completion`\s+and\s+`update_roadmap_and_state`/i, 'mode must name the exact skip set');
    assert.match(mode, /evolve_project/, 'mode must begin at evolve_project');
  });

  test('transition.md still documents standalone mode (full verify → complete → post-process)', () => {
    // Negative space: the normal transition path must remain a full run.
    const modeIdx = trans.indexOf('<step name="post_completion_mode"');
    const modeEnd = trans.indexOf('</step>', modeIdx);
    const mode = trans.slice(modeIdx, modeEnd);
    assert.match(mode, /Standalone transition/i, 'standalone (mode 1) must still be documented');
  });
});

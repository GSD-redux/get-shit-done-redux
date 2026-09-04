// allow-test-rule: source-text-is-the-product (see #4040)
// Workflow .md files — their text IS what the runtime loads. Testing text
// content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tools Tests - #4040 partial-init routing contract
 *
 * Validates that the progress / resume-project / new-project workflows route
 * an interrupted bootstrap (`init_incomplete` from the init.progress /
 * init.resume payload) to initialization RECOVERY, and that this branch runs
 * BEFORE the branches that mis-classified the state pre-fix:
 *   - progress.md Route F ("between milestones": PROJECT.md present,
 *     ROADMAP.md missing)
 *   - progress.md "no planning structure found" (project_exists=false while
 *     .planning/ exists)
 *   - resume-project.md "reconstruct STATE.md"
 *   - new-project.md "project already initialized" error
 *
 * Closes: #4040
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('#4040 partial-init routing', () => {
  const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
  const progressMd = () => fs.readFileSync(path.join(workflowsDir, 'progress.md'), 'utf8');
  const resumeMd = () => fs.readFileSync(path.join(workflowsDir, 'resume-project.md'), 'utf8');
  const newProjectMd = () => fs.readFileSync(path.join(workflowsDir, 'new-project.md'), 'utf8');

  test('progress.md routes init_incomplete to initialization recovery before Route F', () => {
    const content = progressMd();
    const recoveryIdx = content.indexOf('init_incomplete');
    assert.ok(recoveryIdx > -1, 'progress.md must branch on init_incomplete');
    const routeFIdx = content.indexOf('Route F: Between milestones');
    assert.ok(routeFIdx > -1, 'Route F definition must exist');
    assert.ok(
      recoveryIdx < routeFIdx,
      'the init_incomplete recovery branch must appear before the Route F (between milestones) definition'
    );
    const recoverySlice = content.slice(recoveryIdx, recoveryIdx + 1200);
    assert.ok(
      /REQUIREMENTS\.md/.test(recoverySlice) && /ROADMAP\.md/.test(recoverySlice) && /STATE\.md/.test(recoverySlice),
      'the recovery branch must name the missing REQUIREMENTS.md / ROADMAP.md / STATE.md artifacts'
    );
    assert.ok(
      recoverySlice.includes('new-project'),
      'the recovery branch must route to /gsd:new-project to resume initialization'
    );
  });

  test('progress.md init_context no-planning branch is gated on planning_exists', () => {
    const content = progressMd();
    const noPlanningIdx = content.indexOf('No planning structure found');
    assert.ok(noPlanningIdx > -1, 'no-planning branch must exist');
    const branchSlice = content.slice(Math.max(0, noPlanningIdx - 600), noPlanningIdx);
    assert.ok(
      branchSlice.includes('planning_exists'),
      'the no-planning branch must check planning_exists so an existing-but-partial .planning/ is not reported as absent'
    );
  });

  test('resume-project.md routes init_incomplete to initialization recovery before STATE reconstruction', () => {
    const content = resumeMd();
    const recoveryIdx = content.indexOf('init_incomplete');
    assert.ok(recoveryIdx > -1, 'resume-project.md must branch on init_incomplete');
    const reconstructIdx = content.indexOf('Offer to reconstruct STATE.md');
    assert.ok(reconstructIdx > -1, 'STATE reconstruction branch must exist');
    assert.ok(
      recoveryIdx < reconstructIdx,
      'the init_incomplete recovery branch must appear before the reconstruct-STATE.md branch'
    );
    const parseIdx = content.indexOf('Parse JSON for');
    const parseSlice = content.slice(parseIdx, parseIdx + 400);
    assert.ok(
      parseSlice.includes('init_incomplete'),
      'the resume parse list must include init_incomplete (payload is the source of truth)'
    );
  });

  test('new-project.md resumes initialization when init_incomplete instead of erroring', () => {
    const content = newProjectMd();
    const gateIdx = content.indexOf('project_already');
    const gateText = 'If `project_exists` is true';
    const gate = gateIdx > -1 ? gateIdx : content.indexOf(gateText);
    assert.ok(gate > -1, 'the project_exists gate must exist');
    const gateSlice = content.slice(gate, gate + 1500);
    assert.ok(
      gateSlice.includes('init_incomplete'),
      'the project_exists gate must discriminate on init_incomplete (resume a partial bootstrap instead of erroring)'
    );
  });
});

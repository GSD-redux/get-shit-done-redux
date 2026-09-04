// allow-test-rule: source-text-is-the-product (see #4051)
// Workflow .md and command .md files — their text IS what the runtime loads.
// Testing text content tests the deployed contract. Per CONTRIBUTING.md
// exception matrix.

/**
 * GSD Tools Tests - #4051 freeform routing specificity contract
 *
 * Validates that the `/gsd:progress --do` dispatcher workflow
 * (gsd-core/workflows/do.md):
 *   1. Orders specific routing rules BEFORE the generic rules they shadow
 *      (brownfield onboarding before greenfield "set up"; spike/sketch
 *      wrap-up before generic spike/sketch).
 *   2. Routes existing command families distinctly: code review, docs
 *      update, plan review, audit, UI review, security, SDD phase
 *      execution, and multi-phase (roadmap phase CRUD) management.
 *   3. Confirms the displayed route before dispatch (REQ-DO-03 of the
 *      freeform-routing feature requirements), with a TEXT_MODE equivalent.
 *   4. Forwards only arguments the selected command accepts.
 *
 * Also validates that the command frontmatter descriptions distinguish
 * SDD execution (execute-phase) from multi-phase coordination (phase).
 *
 * Negative-space guard: generic fallback routes (greenfield setup, new
 * spikes/sketches, verify-work quality concerns, debug, quick) MUST keep
 * existing after the specific rows — this fix must not over-suppress.
 *
 * Closes: #4051
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('#4051 freeform routing specificity', () => {
  const repoRoot = path.join(__dirname, '..');
  const doMd = () => fs.readFileSync(path.join(repoRoot, 'gsd-core', 'workflows', 'do.md'), 'utf8');
  const commandMd = (name) =>
    fs.readFileSync(path.join(repoRoot, 'commands', 'gsd', `${name}.md`), 'utf8');

  test('do.md orders specific routes before the generic rules they shadow', () => {
    const content = doMd();

    // Specific brownfield onboarding BEFORE generic greenfield "set up" —
    // "set up this existing codebase" must not first-match the greenfield row.
    const onboardIdx = content.indexOf('/gsd:onboard');
    const newProjectIdx = content.indexOf('/gsd:new-project');
    assert.ok(onboardIdx > -1, 'do.md must route to /gsd:onboard');
    assert.ok(newProjectIdx > -1, 'do.md must route to /gsd:new-project');
    assert.ok(
      onboardIdx < newProjectIdx,
      'the brownfield onboarding (/gsd:onboard) rule must precede the greenfield (/gsd:new-project) "set up" rule so "set up this existing codebase" matches onboarding first'
    );

    // Spike/sketch wrap-up BEFORE the generic spike/sketch rows —
    // "wrap up the spike findings" must not first-match "start a new spike".
    const spikeWrapIdx = content.indexOf('/gsd:spike --wrap-up');
    const sketchWrapIdx = content.indexOf('/gsd:sketch --wrap-up');
    assert.ok(spikeWrapIdx > -1, 'do.md must route spike wrap-up to /gsd:spike --wrap-up');
    assert.ok(sketchWrapIdx > -1, 'do.md must route sketch wrap-up to /gsd:sketch --wrap-up');
    const genericSpikeIdx = content.indexOf('| `/gsd:spike` |');
    const genericSketchIdx = content.indexOf('| `/gsd:sketch` |');
    assert.ok(genericSpikeIdx > -1, 'do.md must keep the generic /gsd:spike route');
    assert.ok(genericSketchIdx > -1, 'do.md must keep the generic /gsd:sketch route');
    assert.ok(
      spikeWrapIdx < genericSpikeIdx,
      'the spike wrap-up rule must precede the generic spike rule'
    );
    assert.ok(
      sketchWrapIdx < genericSketchIdx,
      'the sketch wrap-up rule must precede the generic sketch rule'
    );

    // Source review must be routable to /gsd:code-review, not only the
    // generic verify-work fallback.
    const codeReviewIdx = content.indexOf('/gsd:code-review');
    const verifyWorkIdx = content.indexOf('| `/gsd:verify-work` |');
    assert.ok(codeReviewIdx > -1, 'do.md must route source review to /gsd:code-review');
    assert.ok(verifyWorkIdx > -1, 'do.md must keep the generic /gsd:verify-work route');
    assert.ok(
      codeReviewIdx < verifyWorkIdx,
      'the source code review rule must precede the generic verify-work quality rule'
    );
  });

  test('do.md routes existing command families distinctly', () => {
    const content = doMd();
    const requiredRoutes = [
      ['/gsd:onboard', 'brownfield onboarding'],
      ['/gsd:code-review', 'source code review'],
      ['/gsd:review', 'plan review (cross-AI peer review)'],
      ['/gsd:docs-update', 'documentation update'],
      ['/gsd:audit-milestone', 'milestone audit'],
      ['/gsd:audit-fix', 'autonomous audit-to-fix pass'],
      ['/gsd:ui-review', 'UI review'],
      ['/gsd:secure-phase', 'security verification'],
      ['/gsd:execute-phase', 'SDD phase execution'],
      ['/gsd:phase', 'multi-phase (roadmap CRUD) management'],
    ];
    for (const [route, family] of requiredRoutes) {
      assert.ok(content.includes(route), `do.md routing table must cover ${family} via ${route}`);
    }
  });

  test('do.md confirms the route before dispatch (REQ-DO-03)', () => {
    const content = doMd();
    const displayIdx = content.indexOf('<step name="display">');
    const confirmIdx = content.indexOf('<step name="confirm">');
    const dispatchIdx = content.indexOf('<step name="dispatch">');
    assert.ok(displayIdx > -1, 'do.md must have a display step');
    assert.ok(dispatchIdx > -1, 'do.md must have a dispatch step');
    assert.ok(confirmIdx > -1, 'do.md must have a confirm step (REQ-DO-03: confirm before executing)');
    assert.ok(
      displayIdx < confirmIdx && confirmIdx < dispatchIdx,
      'the confirm step must sit between display and dispatch'
    );
    const confirmSlice = content.slice(confirmIdx, dispatchIdx);
    assert.ok(
      /AskUserQuestion/.test(confirmSlice),
      'the confirm step must ask via AskUserQuestion'
    );
    assert.ok(
      /TEXT_MODE/.test(confirmSlice),
      'the confirm step must provide a TEXT_MODE numbered-list equivalent'
    );
    assert.ok(
      /proceed|dispatch/i.test(confirmSlice) && /cancel|stop/i.test(confirmSlice),
      'the confirm step must offer proceed and cancel choices'
    );
  });

  test('do.md forwards only arguments the selected command accepts', () => {
    const content = doMd();
    const dispatchIdx = content.indexOf('<step name="dispatch">');
    assert.ok(dispatchIdx > -1, 'do.md must have a dispatch step');
    const dispatchSlice = content.slice(dispatchIdx);
    assert.ok(
      /argument-hint|accepted argument/i.test(dispatchSlice),
      'the dispatch step must derive arguments from the target command argument-hint / accepted arguments'
    );
    assert.ok(
      !/passing \$ARGUMENTS as args/.test(dispatchSlice),
      'the dispatch step must not forward $ARGUMENTS wholesale'
    );
    assert.ok(
      /freeform task description|freeform description/i.test(dispatchSlice),
      'the dispatch step must carve out commands that explicitly accept a freeform task description'
    );
  });

  test('command descriptions distinguish SDD execution and multi-phase coordination', () => {
    const executePhase = commandMd('execute-phase');
    const executeDesc = /description:\s*(.+)/.exec(executePhase)?.[1] ?? '';
    assert.ok(
      /SDD|spec-driven|specification-driven/i.test(executeDesc) && /wave|parallel|dependency/i.test(executeDesc),
      `execute-phase description must name SDD/spec-driven dependency-aware execution, got: "${executeDesc}"`
    );

    const phase = commandMd('phase');
    const phaseDesc = /description:\s*(.+)/.exec(phase)?.[1] ?? '';
    assert.ok(
      /multi-phase|phase management|add, insert, remove, or edit phases/i.test(phaseDesc),
      `phase description must name multi-phase management, got: "${phaseDesc}"`
    );
  });

  test('do.md keeps generic fallback routes dispatching (no over-suppression)', () => {
    const content = doMd();
    const genericRoutes = [
      ['| `/gsd:new-project` |', 'greenfield project setup'],
      ['| `/gsd:spike` |', 'new spike'],
      ['| `/gsd:sketch` |', 'new sketch'],
      ['| `/gsd:verify-work` |', 'generic quality concern fallback'],
      ['| `/gsd:debug` |', 'bug investigation'],
      ['| `/gsd:quick` |', 'small actionable task'],
      ['| `/gsd:explore` |', 'research / how-does-X-work'],
      ['| `/gsd:progress` |', 'status check'],
      ['| `/gsd:capture` |', 'note capture'],
    ];
    for (const [marker, family] of genericRoutes) {
      assert.ok(content.includes(marker), `do.md must keep routing ${family} (${marker})`);
    }
  });

  test('do.md success criteria require confirmation and argument-aware dispatch', () => {
    const content = doMd();
    const criteriaIdx = content.indexOf('<success_criteria>');
    assert.ok(criteriaIdx > -1, 'do.md must have success criteria');
    const criteria = content.slice(criteriaIdx);
    assert.ok(
      /confirm/i.test(criteria),
      'success criteria must require confirming the route before dispatch'
    );
    assert.ok(
      /argument/i.test(criteria),
      'success criteria must require argument-aware dispatch'
    );
  });
});

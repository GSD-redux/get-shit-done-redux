/**
 * Tests that autonomous.md includes ui-phase and ui-review steps for frontend phases.
 *
 * Issue #1375: autonomous workflow skips ui-phase and ui-review for frontend phases.
 * The per-phase execution loop should be: discuss -> ui-phase -> plan -> execute -> verify -> ui-review
 * for phases with frontend indicators.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'autonomous.md');
const UI_DESIGN_CONTRACT_REF_PATH = path.join(
  __dirname, '..', 'gsd-core', 'references', 'autonomous-ui-design-contract.md'
);

/**
 * #2994 fragmentization moved §3a.5's body out of autonomous.md into
 * gsd-core/references/autonomous-ui-design-contract.md, leaving an
 * unconditional `Read and execute:` pointer in the host. Splice the
 * reference file's content back in at the pointer's position so §3a.5
 * slicing/ordering assertions still see the real step body.
 */
function readAutonomousCombined() {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const pointerRe = /Read and execute: `\$HOME\/\.claude\/gsd-core\/references\/autonomous-ui-design-contract\.md`/;
  assert.ok(pointerRe.test(raw), 'autonomous.md must still contain the §3a.5 reference pointer');
  const refContent = fs.readFileSync(UI_DESIGN_CONTRACT_REF_PATH, 'utf-8');
  return raw.replace(pointerRe, refContent);
}

describe('autonomous workflow ui-phase and ui-review integration (#1375)', () => {
  let content;

  beforeEach(() => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/autonomous.md should exist');
    assert.ok(fs.existsSync(UI_DESIGN_CONTRACT_REF_PATH), 'references/autonomous-ui-design-contract.md should exist');
    content = readAutonomousCombined();
  });

  describe('step 3a.5 — UI design contract before planning', () => {
    // Helper: extract the §3a.5 section text (from heading to the next "**3b." heading)
    function getSection3a5(c) {
      const start = c.indexOf('**3a.5.');
      const end = c.indexOf('**3b.', start);
      assert.ok(start !== -1, '§3a.5 heading must be present in autonomous.md');
      assert.ok(end !== -1, '**3b. must follow §3a.5 in autonomous.md');
      return c.slice(start, end);
    }

    test('autonomous.md contains a UI design contract step between discuss and plan', () => {
      assert.ok(
        content.includes('3a.5'),
        'should have step 3a.5 for UI design contract'
      );
    });

    test('§3a.5 dispatches loop render-hooks plan:pre to resolve active capability hooks', () => {
      // Phase 5.6/ui-phase cutover: §3a.5 now dispatches render-hooks plan:pre instead of
      // inlining ui-safety-gate.cjs RUNTIME_DIR probe + config-get workflow.ui_phase.
      const section = getSection3a5(content);
      assert.ok(
        section.includes('loop render-hooks plan:pre'),
        '§3a.5 must dispatch `loop render-hooks plan:pre` to resolve active capability hooks'
      );
    });

    test('§3a.5 uses check ui-plan-gate to determine frontend and hasUiSpec', () => {
      const section = getSection3a5(content);
      assert.ok(
        section.includes('check ui-plan-gate'),
        '§3a.5 must call `check ui-plan-gate` to gate on frontend indicators and existing UI-SPEC'
      );
      assert.ok(
        section.includes('frontend'),
        '§3a.5 must read the `frontend` field from the gate result'
      );
      assert.ok(
        section.includes('hasUiSpec'),
        '§3a.5 must read the `hasUiSpec` field from the gate result'
      );
    });

    test('§3a.5 constructs skill via gsd-${ref.skill} prefix (capability-driven dispatch)', () => {
      const section = getSection3a5(content);
      assert.ok(
        section.includes('gsd-${ref.skill}'),
        '§3a.5 must construct skill name via `gsd-${ref.skill}` prefix (matches §3d.5 style)'
      );
    });

    test('§3a.5 checks for existing UI-SPEC.md', () => {
      const section = getSection3a5(content);
      assert.ok(
        section.includes('UI-SPEC.md'),
        '§3a.5 must check for existing UI-SPEC.md'
      );
    });

    test('§3a.5 does NOT inline ui-safety-gate.cjs or RUNTIME_DIR probe (replaced by registry)', () => {
      const section = getSection3a5(content);
      assert.ok(
        !section.includes('ui-safety-gate.cjs'),
        '§3a.5 must NOT inline ui-safety-gate.cjs (replaced by check ui-plan-gate)'
      );
      assert.ok(
        !section.includes('RUNTIME_DIR'),
        '§3a.5 must NOT probe RUNTIME_DIR (replaced by check ui-plan-gate via capability registry)'
      );
    });

    test('§3a.5 does NOT inline config-get workflow.ui_phase (resolved by registry via render-hooks)', () => {
      const section = getSection3a5(content);
      assert.ok(
        !section.includes('config-get workflow.ui_phase'),
        '§3a.5 must NOT inline `config-get workflow.ui_phase` — toggle is owned by the capability registry'
      );
    });

    test('§3a.5 is step-only and non-blocking — no gate-halt or exit', () => {
      const section = getSection3a5(content);
      // Must not introduce blocking gate language
      assert.ok(
        !section.includes('EXIT') && !section.includes('exit the') && !section.includes('halt'),
        '§3a.5 must NOT introduce any gate-halt or exit — it is step-only and non-blocking'
      );
      // Must be explicitly non-blocking
      assert.ok(
        section.includes('NON-BLOCKING') || section.includes('non-blocking') || section.includes('continue') || section.includes('proceed'),
        '§3a.5 must be explicitly non-blocking (warning + continue)'
      );
    });

    test('§3a.5 skip condition is "no active step hooks" — not "empty activeHooks"', () => {
      // Equivalence-preservation fix (#1031): the skip must key on KIND=="step" hooks,
      // not on activeHooks being empty. A gate-only result (ui_phase=false +
      // ui_safety_gate=true → activeHooks=[{kind:"gate"}]) must also skip silently.
      const section = getSection3a5(content);

      // Must compute active step hooks (kind=="step") before deciding to skip
      assert.ok(
        section.includes('kind == "step"') || section.includes("kind == 'step'") || section.includes('kind=="step"'),
        '§3a.5 must gate the skip decision on kind=="step" entries'
      );

      // The skip condition must explicitly mention "no active step" (or equivalent),
      // NOT "empty or absent" (which was the old incorrect condition)
      assert.ok(
        section.includes('NO active step') || section.includes('no active step') || section.includes('no active UI step'),
        '§3a.5 skip condition must reference "no active step hook(s)" — not just empty activeHooks'
      );

      // The prose must NOT use the old "empty or absent" language as the skip guard
      assert.ok(
        !section.includes('empty or absent'),
        '§3a.5 must NOT use "empty or absent" as the skip condition — that misses gate-only sets'
      );
    });

    test('§3a.5 gate-only case: {ui_phase:false, ui_safety_gate:true} → silent skip, no warning', () => {
      // Scenario: workflow.ui_phase=false AND workflow.ui_safety_gate=true.
      // render-hooks plan:pre returns activeHooks=[{kind:"gate"}] (gate is controlled
      // separately by ui_safety_gate, default true). There are NO step hooks.
      // §3a.5 must skip silently to 3b — no warning, no gate run, no skill dispatch.
      // The warning must ONLY be reachable after an active step hook actually fired.
      const section = getSection3a5(content);

      // The gate-only/ui_phase=false case must be documented as a silent skip
      assert.ok(
        section.includes('ui_phase') || section.includes('ui_safety_gate') || section.includes('gate-only'),
        '§3a.5 must document the gate-only / ui_phase=false silent-skip case'
      );

      // Must NOT invoke check ui-plan-gate before filtering for step hooks
      // i.e. the step-hook filter must appear before the GATE command in prose order
      const stepCheckPos = section.indexOf('kind == "step"');
      const gateRunPos = section.indexOf('check ui-plan-gate');
      assert.ok(
        stepCheckPos !== -1 && gateRunPos !== -1,
        '§3a.5 must contain both kind=="step" check and check ui-plan-gate'
      );
      assert.ok(
        stepCheckPos < gateRunPos,
        '§3a.5 must check for active step hooks BEFORE running check ui-plan-gate — ' +
        'gate-only case (no step hooks) must skip before the gate command is reached'
      );

      // Confirm gate entries are explicitly excluded from dispatch
      assert.ok(
        section.includes('gate') && (section.includes('ignored') || section.includes('silently')),
        '§3a.5 must explicitly note kind=="gate" entries are silently ignored'
      );
    });

    test('§3a.5 appears before plan step (3b)', () => {
      const uiPhasePos = content.indexOf('3a.5');
      const planPos = content.indexOf('**3b. Plan**');
      assert.ok(
        uiPhasePos < planPos,
        'step 3a.5 (UI design contract) should appear before step 3b (plan)'
      );
    });
  });

  describe('step 3d.5 — UI review after execution', () => {
    test('autonomous.md contains a UI review step after execution', () => {
      assert.ok(
        content.includes('3d.5'),
        'should have step 3d.5 for UI review'
      );
    });

    test('UI review step dispatches loop render-hooks verify:post', () => {
      // Phase 6 cutover: §3d.5 now dispatches render-hooks verify:post instead of
      // inlining a direct skill="gsd-ui-review" call.
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('loop render-hooks verify:post'),
        'UI review step should dispatch loop render-hooks verify:post to resolve active hooks'
      );
    });

    test('UI review step constructs skill via gsd- prefix dispatch and is non-blocking', () => {
      // Phase 6 cutover: §3d.5 dispatches loop render-hooks verify:post, invokes skills via
      // gsd-${ref.skill} prefix, gates on UI_SPEC_FILE for consumes:UI-SPEC.md hooks,
      // and is explicitly advisory/non-blocking.
      // All four properties must be present within the §3d.5 section itself.
      const sectionStart = content.indexOf('3d.5');
      // Bound to the closing </step> tag of the execute_phase step
      const sectionEnd = content.indexOf('</step>', sectionStart);
      assert.ok(sectionStart !== -1, '§3d.5 heading must be present in autonomous.md');
      assert.ok(sectionEnd !== -1, '</step> must follow §3d.5');
      const reviewSection = content.slice(sectionStart, sectionEnd);

      assert.ok(
        reviewSection.includes('loop render-hooks verify:post'),
        '§3d.5 must dispatch `loop render-hooks verify:post` to resolve active capability hooks'
      );
      assert.ok(
        reviewSection.includes('gsd-${ref.skill}'),
        '§3d.5 must construct skill name via `gsd-${ref.skill}` prefix (capability-driven dispatch)'
      );
      assert.ok(
        reviewSection.includes('UI_SPEC_FILE'),
        '§3d.5 must gate on UI_SPEC_FILE for hooks that consume UI-SPEC.md'
      );
      assert.ok(
        reviewSection.includes('advisory') || reviewSection.includes('non-blocking') || reviewSection.includes('regardless of result'),
        '§3d.5 must be explicitly advisory/non-blocking'
      );
    });

    test('UI review step gates on UI-SPEC file via consumes check', () => {
      // The consumes:[UI-SPEC.md] gate is still enforced; UI_SPEC_FILE is still defined
      // and used as the precondition for hooks that consume UI-SPEC.md.
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('UI_SPEC_FILE'),
        'UI review step should still gate on UI_SPEC_FILE for hooks that consume UI-SPEC.md'
      );
      assert.ok(
        reviewSection.includes('consumes'),
        'UI review step should reference hook consumes array for the UI-SPEC gate'
      );
    });

    test('UI review step respects workflow.ui_review config toggle (resolved via render-hooks)', () => {
      // Phase 6 cutover: workflow.ui_review is no longer inlined as `config-get workflow.ui_review`.
      // Instead, §3d.5 calls `loop render-hooks verify:post` which internally honours the
      // `when: workflow.ui_review` field declared in the capability registry.
      // The §3d.5 section must use render-hooks (not a literal `config-get workflow.ui_review`)
      // so the toggle is resolved by the capability system, not duplicated inline.
      const sectionStart = content.indexOf('3d.5');
      const sectionEnd = content.indexOf('</step>', sectionStart);
      assert.ok(sectionStart !== -1, '§3d.5 heading must be present in autonomous.md');
      assert.ok(sectionEnd !== -1, '</step> must follow §3d.5');
      const reviewSection = content.slice(sectionStart, sectionEnd);

      assert.ok(
        reviewSection.includes('render-hooks'),
        '§3d.5 must resolve the workflow.ui_review toggle via render-hooks (not inline config-get)'
      );
      assert.ok(
        !reviewSection.includes('config-get workflow.ui_review'),
        '§3d.5 must NOT inline `config-get workflow.ui_review` — the toggle is owned by the capability registry'
      );
    });

    test('UI review is advisory (non-blocking)', () => {
      const reviewSection = content.slice(content.indexOf('3d.5'));
      assert.ok(
        reviewSection.includes('advisory') || reviewSection.includes('non-blocking') || reviewSection.includes('regardless of result'),
        'UI review should be advisory and not block phase progression'
      );
    });

    test('UI review step appears after execution routing (3d)', () => {
      const executeRouting = content.indexOf('**3d. Post-Execution Routing**');
      const uiReviewPos = content.indexOf('3d.5');
      assert.ok(
        uiReviewPos > executeRouting,
        'step 3d.5 (UI review) should appear after step 3d (post-execution routing)'
      );
    });
  });

  describe('success criteria updated', () => {
    test('success criteria includes UI-aware flow', () => {
      assert.ok(
        content.includes('ui-phase') && content.includes('ui-review'),
        'success criteria should reference ui-phase and ui-review'
      );
    });

    test('success criteria mentions frontend phases get UI-SPEC before planning', () => {
      assert.ok(
        content.includes('Frontend phases') || content.includes('frontend phases'),
        'success criteria should mention frontend phases'
      );
    });

    test('success criteria notes UI review is advisory', () => {
      const criteriaSection = content.slice(content.indexOf('<success_criteria>'));
      assert.ok(
        criteriaSection.includes('advisory') || criteriaSection.includes('non-blocking'),
        'success criteria should note UI review is advisory/non-blocking'
      );
    });
  });
});

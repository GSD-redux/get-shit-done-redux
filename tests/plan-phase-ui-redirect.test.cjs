// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('plan-phase §5.6 UI Design Contract Gate', () => {
  const workflowPath = path.join(
    __dirname,
    '..',
    'gsd-core',
    'workflows',
    'plan-phase.md'
  );

  // Load once
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(workflowPath), `Expected workflow file at ${workflowPath}`);
  });

  // ── Capability-driven dispatch ─────────────────────────────────────────────

  test('§5.6 dispatches loop render-hooks plan:pre (capability-driven)', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      section.includes('loop render-hooks plan:pre'),
      '§5.6 must dispatch `loop render-hooks plan:pre` to resolve active capability hooks'
    );
  });

  test('§5.6 invokes gsd_run check ui-plan-gate UNCONDITIONALLY (not inside a gate loop)', () => {
    const section = extractSection56(workflowPath);
    // The fix for {ui_phase:true, ui_safety_gate:false}: the check must be run
    // UNCONDITIONALLY — established before any per-hook branching — so the step's
    // frontend/UI-SPEC precondition is available even when no gate hook is active.
    // The literal `check ui-plan-gate` must appear in the section.
    assert.ok(
      section.includes('check ui-plan-gate'),
      '§5.6 must run `gsd_run check ui-plan-gate` unconditionally (not gated inside a kind==gate loop)'
    );
    // The "including the step-only case" wording proves the unconditional intent.
    assert.ok(
      section.includes('step-only case'),
      '§5.6 must document "step-only case" to prove the check runs independently of gate presence'
    );
  });

  test('§5.6 establishes GATE= before any branch-5 step dispatch (check precedes step)', () => {
    const section = extractSection56(workflowPath);
    // GATE= must be assigned before Branch 5 fires step hooks.
    // Both must be present; GATE= must appear earlier in the section text.
    const gateIdx = section.indexOf('GATE=$(gsd_run check ui-plan-gate');
    const branch5Idx = section.indexOf('Branch 5');
    assert.ok(gateIdx !== -1, '§5.6 must contain `GATE=$(gsd_run check ui-plan-gate` assignment');
    assert.ok(branch5Idx !== -1, '§5.6 must contain Branch 5');
    assert.ok(
      gateIdx < branch5Idx,
      `§5.6 GATE= check must appear BEFORE Branch 5 step dispatch (gateIdx=${gateIdx} branch5Idx=${branch5Idx})`
    );
  });

  test('§5.6 invokes gsd_run check with gate check.query (generic dispatch — ui.plan-gate or ui-plan-gate)', () => {
    const section = extractSection56(workflowPath);
    // The dispatch MUST use the `check` verb and reference the gate query.
    // OLD: hardcoded `check ui-plan-gate` inside gate loop
    // NEW: unconditional `check ui-plan-gate` — literal command; check.query = "ui.plan-gate"
    // Both forms must be accepted: the section references either the literal query or the
    // generic pattern. The check router normalizes dots to hyphens so both are equivalent.
    assert.ok(
      section.includes('check ui-plan-gate') ||
      section.includes('check ui.plan-gate') ||
      (section.includes('check') && section.includes('check.query')),
      '§5.6 must invoke `gsd_run check` with the gate\'s check.query (generic dispatch — not hardcoded for a specific check)'
    );
  });

  test('§5.6 reads frontend, hasUiSpec, block from gate result', () => {
    const section = extractSection56(workflowPath);
    assert.ok(section.includes('frontend'), '§5.6 must read `frontend` from gate result');
    assert.ok(section.includes('hasUiSpec'), '§5.6 must read `hasUiSpec` from gate result');
    assert.ok(section.includes('block'), '§5.6 must read `block` from gate result');
  });

  test('§5.6 does NOT inline config-get workflow.ui_phase (toggle owned by registry)', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      !section.includes('config-get workflow.ui_phase'),
      '§5.6 must NOT inline `config-get workflow.ui_phase` — toggle is resolved by render-hooks'
    );
  });

  test('§5.6 does NOT inline config-get workflow.ui_safety_gate (toggle owned by registry)', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      !section.includes('config-get workflow.ui_safety_gate'),
      '§5.6 must NOT inline `config-get workflow.ui_safety_gate` — toggle is resolved by render-hooks'
    );
  });

  // ── 6-branch equivalence ───────────────────────────────────────────────────

  test('Branch 1: activeHooks empty → skip to step 6 (NOT §5.7)', () => {
    const section = extractSection56(workflowPath);
    // Branch 1 (both toggles off) MUST skip to step 6 — NOT §5.7.
    // OLD §5.6 branch-1 target was "step 6". §5.7 (Schema Push) is NOT skipped
    // when both UI toggles are off — schema detection is independent.
    assert.ok(
      section.includes('activeHooks'),
      '§5.6 Branch 1 must reference activeHooks'
    );
    // The skip target must be step 6
    assert.ok(
      section.match(/activeHooks[^.]*?step 6/s) ||
      section.match(/empty[^.]*?step 6/s) ||
      section.match(/absent[^.]*?step 6/s) ||
      /Branch 1[^.]*?step 6/s.test(section),
      '§5.6 Branch 1 (both-off / empty activeHooks) must skip to step 6, NOT §5.7'
    );
  });

  test('Branch 2: no frontend indicators → skip silently to step 6 (§5.7 removed)', () => {
    const section = extractSection56(workflowPath);
    assert.ok(section.includes('frontend'), '§5.6 Branch 2 must reference frontend');
    assert.ok(
      /Branch 2[\s\S]*?step 6/.test(section),
      '§5.6 Branch 2 must skip to step 6 (§5.7 schema-gate section was removed; schema-gate is now a capability)'
    );
  });

  test('Branch 3: hasUiSpec true → sets UI_SPEC_PATH, displays using-contract message', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      section.includes('hasUiSpec') && section.includes('UI_SPEC_PATH') && section.includes('Using UI design contract'),
      '§5.6 Branch 3 must set UI_SPEC_PATH and display the using-contract message'
    );
  });

  test('Branch 4: --skip-ui in $ARGUMENTS → skip to step 6', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    assert.ok(
      content.includes('--skip-ui'),
      '§5.6 must include --skip-ui bypass option (Branch 4)'
    );
  });

  test('Branch 5: AUTO_CHAIN=true → step hooks dispatched via gsd-${ref.skill}', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      section.includes('AUTO_CHAIN') && section.includes('gsd-${ref.skill}'),
      '§5.6 Branch 5 must dispatch step hooks via gsd-${ref.skill} in pipeline mode'
    );
  });

  test('Branch 5: pipeline dispatch uses kind=="step" and ref.skill filter', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      section.includes('kind') && section.includes('ref.skill'),
      '§5.6 Branch 5 must filter activeHooks by kind=="step" and ref.skill'
    );
  });

  test('Branch 5: step hooks fire independently of whether a gate is active ({ui_phase:T,ui_safety_gate:F} regression guard)', () => {
    const section = extractSection56(workflowPath);
    // KEY REGRESSION GUARD: the step must fire even when ui_safety_gate=false (no gate hook).
    // The new wording "independently of whether a gate is active" makes this explicit.
    assert.ok(
      section.includes('independently of whether a gate is active'),
      '§5.6 Branch 5 must state step hooks fire "independently of whether a gate is active" — guards {ui_phase:T,ui_safety_gate:F} regression'
    );
  });

  test('Branch 6: AUTO_CHAIN=false → generic gate handling (kind==gate, blocking, block→exit; no active gate→continue)', () => {
    const section = extractSection56(workflowPath);
    assert.ok(
      section.includes('AUTO_CHAIN'),
      '§5.6 Branch 6 must read AUTO_CHAIN flag'
    );
    // Branch 6 is the generic gate-handling branch:
    // - iterates activeHooks where kind=="gate" and blocking:true
    // - only EXITs when block:true is set on that gate
    // - if no active blocking gate is present (e.g. ui_safety_gate off), continues to step 6
    assert.ok(
      section.includes('kind == "gate"') || section.includes('kind=="gate"'),
      '§5.6 Branch 6 must filter by kind=="gate" (generic gate-handling)'
    );
    assert.ok(
      /blocking.*true/i.test(section),
      '§5.6 Branch 6 must check `blocking` is true for the gate'
    );
    // Must halt on block:true — both "Exit the plan-phase workflow" AND "Do not continue" are required
    assert.ok(
      section.includes('Exit the plan-phase workflow'),
      '§5.6 Branch 6 must say "Exit the plan-phase workflow"'
    );
    assert.ok(
      section.includes('Do not continue'),
      '§5.6 Branch 6 must say "Do not continue"'
    );
    // If no active blocking gate → continue (no block when ui_safety_gate is off)
    assert.ok(
      section.includes('no active blocking gate') || section.includes('no block'),
      '§5.6 Branch 6 must document: no active blocking gate → continue to step 6 (no block)'
    );
  });

  test('Branch 6: recommendation block contains EXACT warning heading + /gsd:ui-phase + --skip-ui', () => {
    const section = extractSection56(workflowPath);
    // Assert the EXACT halt recommendation block text, not substring-OR
    assert.ok(
      section.includes('⚠ UI-SPEC.md missing for Phase'),
      '§5.6 must include the "⚠ UI-SPEC.md missing for Phase" warning heading'
    );
    assert.ok(
      section.includes('Recommended next step'),
      '§5.6 must include the "Recommended next step" label in the recommendation block'
    );
    assert.ok(
      section.includes('/gsd:ui-phase'),
      '§5.6 must include /gsd:ui-phase recommendation in the block'
    );
    assert.ok(
      section.includes('--skip-ui'),
      '§5.6 must include --skip-ui as bypass option in the recommendation block'
    );
    // The "Also available" line must be present (shows the skip-ui option)
    assert.ok(
      section.includes('Also available'),
      '§5.6 recommendation block must include the "Also available" section'
    );
  });

  // ── Generic gate-dispatch contract ────────────────────────────────────────

  test('§5.6 documents gate check.query binding (check.query="ui.plan-gate" → check ui-plan-gate)', () => {
    const section = extractSection56(workflowPath);
    // The section must document WHERE "ui-plan-gate" comes from — it is the gate hook's
    // check.query value "ui.plan-gate" normalized to a hyphen form by the check router.
    // The literal `check ui-plan-gate` command is acceptable (and now required by bug-3706),
    // but the section must also document the check.query binding so the contract is auditable.
    assert.ok(
      section.includes('check.query') || section.includes('check ui-plan-gate'),
      '§5.6 must reference check.query or the literal check ui-plan-gate command (gate binding contract)'
    );
  });

  test('§5.6 documents that check router normalizes dots to hyphens (ui.plan-gate → ui-plan-gate)', () => {
    const section = extractSection56(workflowPath);
    // The dot-normalization rule must be documented so the declared check.query is runnable
    assert.ok(
      section.includes('ui.plan-gate') || section.includes('normalizes dots') || section.includes('dots to hyphens'),
      '§5.6 must document that the check router normalizes dots to hyphens for the declared check.query'
    );
  });

  test('§5.6 partial-off case: ui_phase=true, ui_safety_gate=false → step fires, gate does NOT block', () => {
    const section = extractSection56(workflowPath);
    // The intended behavior change: ui_phase gates the step, ui_safety_gate gates the block.
    // When only ui_safety_gate is false, the step fires but the gate doesn't halt.
    // Document this in the section.
    assert.ok(
      section.includes('workflow.ui_phase') || section.includes('ui_phase'),
      '§5.6 must reference workflow.ui_phase (step hook config key)'
    );
    assert.ok(
      section.includes('workflow.ui_safety_gate') || section.includes('ui_safety_gate'),
      '§5.6 must reference workflow.ui_safety_gate (gate hook config key)'
    );
  });

  // ── Legacy pattern that must NOT appear ────────────────────────────────────

  test('does NOT contain hard-blocking exit redirect to /gsd-ui-phase (old pattern)', () => {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const hardExitPattern = /Generate UI-SPEC first.*Exit workflow/s;
    assert.ok(
      !hardExitPattern.test(content),
      'plan-phase.md must NOT contain a hard "Generate UI-SPEC first → Exit workflow" redirect'
    );
  });

  test('does NOT inline the shell-based ui-safety-gate.cjs path-search block (old §5.6)', () => {
    const section = extractSection56(workflowPath);
    // The old §5.6 resolved the gate helper via a for-loop over path candidates
    assert.ok(
      !section.includes('UI_GATE_JS=$(for _c in'),
      '§5.6 must NOT contain the old shell-based ui-safety-gate.cjs path-search (now delegated to check ui-plan-gate)'
    );
  });
});

/**
 * Extract the text of §5.6 through (but not including) §5.7.
 * Scoped to avoid false positives from other parts of the file.
 */
function extractSection56(workflowPath) {
  const content = fs.readFileSync(workflowPath, 'utf8');
  const start = content.indexOf('## 5.6.');
  assert.ok(start !== -1, '§5.6 heading must be present in plan-phase.md');
  const end = content.indexOf('\n## 6.', start);
  assert.ok(end !== -1, '## 6. heading must follow §5.6 in plan-phase.md (§5.7 was removed; schema-gate is now a capability)');
  return content.slice(start, end);
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3072-optional-sketch-findings-guard.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3072-optional-sketch-findings-guard (consolidation epic #1969 B4 #1973)", () => {
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..', 'gsd-core', 'workflows');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function extractFindingsProbesFromBashBlocks(markdown) {
  const probes = [];
  const markdownLines = markdown.split(/\r?\n/);
  const bashBlocks = scanFencedBlocks(markdownLines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash');

  for (const fenced of bashBlocks) {
    const baseLine = fenced.openLineIdx + 1;
    const lines = markdownLines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx);

    lines.forEach((line, idx) => {
      if (!line.includes('.claude/skills/')) return;
      const kind = line.includes('sketch-findings-*/SKILL.md')
        ? 'sketch'
        : line.includes('spike-findings-*/SKILL.md')
          ? 'spike'
          : null;
      if (!kind) return;

      probes.push({
        lineNumber: baseLine + idx,
        commandText: line.trim(),
        kind,
        hasNonFatalGuard: /\|\|\s*true/.test(line),
      });
    });
  }

  return probes;
}

describe('bug #3072: optional sketch/spike findings probes are non-fatal', () => {
  test('all sketch/spike findings SKILL.md ls probes include || true', () => {
    const files = ['ui-phase.md', 'plan-phase.md', 'discuss-phase.md', 'new-project.md'];
    const offenders = [];

    for (const file of files) {
      const content = read(file);
      const probes = extractFindingsProbesFromBashBlocks(content);
      for (const probe of probes) {
        if (!probe.hasNonFatalGuard) {
          offenders.push(`${file}:${probe.lineNumber} ${probe.commandText}`);
        }
      }
    }

    assert.deepStrictEqual(offenders, [], `missing non-fatal guard on optional findings probe:\n${offenders.join('\n')}`);
  });
});
  });
}

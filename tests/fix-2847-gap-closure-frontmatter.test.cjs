'use strict';

// allow-test-rule: source-text-is-the-product (see #2847)
// agents/gsd-planner.md is the deployed runtime prompt contract — the planner
// agent literally executes this markdown. Testing its text content tests the
// deployed contract, per the CONTRIBUTING.md exception matrix and the existing
// precedent in tests/plan-phase-drift-guard.test.cjs and
// tests/edge-probe-planner-contract.test.cjs.

/**
 * Regression tests for #2847
 *
 * "--gaps does not load planner-gap-closure.md, so generated gap plans may
 * miss gap_closure metadata"
 *
 * Root cause: the planner's only machine-checked validation gate
 * (`gsd_run query frontmatter.validate "$PLAN_PATH" --schema plan`) never
 * required `gap_closure`. The only place `gap_closure: true` was actually
 * documented as required was prose in a conditionally-loaded reference file
 * (gsd-core/references/planner-gap-closure.md) plus an unvalidated checklist
 * item — neither backed by a deterministic gate.
 *
 * Fix:
 * - src/frontmatter.cts: new `plan-gap-closure` FRONTMATTER_SCHEMAS entry
 *   (covered behaviorally in tests/frontmatter-cli.test.cjs and
 *   tests/frontmatter.unit.test.cjs — this file covers the prompt-level wiring
 *   that selects it).
 * - agents/gsd-planner.md `<step name="validate_plan">`: selects
 *   `--schema plan-gap-closure` when gap_closure mode is active, `--schema plan`
 *   otherwise (unchanged for standard/reviews mode).
 *
 * Deliberately NOT touched: gsd-core/workflows/plan-phase.md's
 * `<downstream_consumer>` block. An earlier draft of this fix added a
 * gap_closure mention there too (mirroring plan-phase.md's existing
 * `<review_incorporation_contract>` mode-scoped-block pattern for reviews
 * mode), but plan-phase.md sits only 36 bytes under the hard ADR-857
 * PRE_PHASE6 ceiling (tests/phase6-capstone-conformance.test.cjs,
 * `PRE_PHASE6['plan-phase.md'] = 94519`) and cannot absorb the ~330-byte
 * addition. The `<step name="validate_plan">` fix in gsd-planner.md is the
 * actual call site and is sufficient on its own: the planner already tracks
 * gap_closure mode internally (its own `<step name="identify_phase">` switches
 * to gap_closure_mode on `--gaps`), so the schema selection does not depend on
 * plan-phase.md's prose at all. See .gsd/bug/fix-2847-gap-closure-frontmatter/10-diagnosis.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLANNER_AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-planner.md');
const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const GAP_CLOSURE_REF_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planner-gap-closure.md');

function readFile(p) {
  return fs.readFileSync(p, 'utf-8');
}

function extractStep(content, stepName) {
  const marker = `<step name="${stepName}">`;
  const start = content.indexOf(marker);
  if (start === -1) return null;
  const end = content.indexOf('</step>', start);
  if (end === -1) return null;
  return content.slice(start, end + '</step>'.length);
}

// ─── agents/gsd-planner.md: validate_plan step is mode-aware (#2847) ─────────

describe('#2847: gsd-planner.md validate_plan step selects schema by mode', () => {
  const plannerContent = readFile(PLANNER_AGENT_PATH);
  const validateStep = extractStep(plannerContent, 'validate_plan');

  test('validate_plan step exists', () => {
    assert.ok(validateStep, '<step name="validate_plan"> must exist in agents/gsd-planner.md');
  });

  test('validate_plan step references the plan-gap-closure schema', () => {
    assert.ok(
      validateStep.includes('plan-gap-closure'),
      'validate_plan step must reference the plan-gap-closure schema so gap-closure-mode plans are validated against it'
    );
  });

  test('validate_plan step still references the unmodified plan schema for standard/reviews mode', () => {
    assert.match(
      validateStep,
      /--schema plan\b(?!-)/,
      'validate_plan step must still validate with --schema plan (not plan-gap-closure) for standard/reviews mode — AC(3)'
    );
  });

  test('validate_plan step conditions schema selection on gap_closure mode', () => {
    assert.ok(
      /gap_closure mode is active/i.test(validateStep) || /gap.closure/i.test(validateStep),
      'validate_plan step must condition --schema plan-gap-closure selection on gap_closure mode being active, not apply it unconditionally'
    );
  });

  test('validate_plan step documents gap_closure as an additional requirement, not a replacement', () => {
    assert.ok(
      validateStep.includes('gap_closure'),
      'validate_plan step required-fields list must mention gap_closure for gap closure mode'
    );
    // The original 8-field list must still be intact (AC(3): no change to the base contract).
    for (const field of ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves']) {
      assert.ok(
        validateStep.includes(field),
        `validate_plan step must still list "${field}" among required plan frontmatter fields`
      );
    }
  });
});

// ─── Cross-file consistency: schema name used by both files matches (#2847) ──

describe('#2847: schema name consistency between gsd-planner.md and src/frontmatter.cts', () => {
  test('gsd-planner.md references the exact schema name "plan-gap-closure"', () => {
    const plannerContent = readFile(PLANNER_AGENT_PATH);
    assert.ok(
      plannerContent.includes('plan-gap-closure'),
      'agents/gsd-planner.md must reference the literal schema name "plan-gap-closure" ' +
      '(the exact key registered in FRONTMATTER_SCHEMAS in src/frontmatter.cts) — a ' +
      'mismatched name would fail at runtime with "Unknown schema"'
    );
  });
});

// ─── Existing gap-closure-mode reference file is unmodified and still correct ─
// (Not-the-bug per diagnosis: planner-gap-closure.md's YAML template already
// documented gap_closure: true correctly — that file was never the defect.)

describe('#2847: planner-gap-closure.md reference is untouched and still documents gap_closure: true', () => {
  test('planner-gap-closure.md YAML template still shows gap_closure: true', () => {
    const content = readFile(GAP_CLOSURE_REF_PATH);
    assert.ok(
      content.includes('gap_closure: true'),
      'gsd-core/references/planner-gap-closure.md must still document gap_closure: true in its plan-frontmatter template'
    );
  });
});

// ─── plan-phase.md is deliberately untouched (ADR-857 PRE_PHASE6 byte ceiling) ─

describe('#2847: plan-phase.md is deliberately unmodified by this fix (byte-cap conflict)', () => {
  test('plan-phase.md downstream_consumer block does not gain a gap_closure mention', () => {
    // This is a NEGATIVE assertion pinning a deliberate design choice, not a symptom of
    // the bug: plan-phase.md sits within 36 bytes of the hard PRE_PHASE6 ceiling
    // (tests/phase6-capstone-conformance.test.cjs), so the fix for #2847 lives entirely
    // in gsd-planner.md's validate_plan step (the actual call site) instead. If a future
    // change adds gap_closure prose here, the PRE_PHASE6 test is the gate that must be
    // satisfied first (shrink elsewhere or raise the frozen ceiling deliberately).
    const workflowContent = readFile(PLAN_PHASE_PATH);
    const start = workflowContent.indexOf('<downstream_consumer>');
    const end = workflowContent.indexOf('</downstream_consumer>', start);
    const downstreamBlock = start === -1 || end === -1
      ? ''
      : workflowContent.slice(start, end + '</downstream_consumer>'.length);
    assert.ok(downstreamBlock.length > 0, '<downstream_consumer> block must still exist in plan-phase.md');
    assert.ok(
      !downstreamBlock.includes('gap_closure'),
      'plan-phase.md downstream_consumer must not mention gap_closure — see the file-level comment above for why'
    );
  });
});

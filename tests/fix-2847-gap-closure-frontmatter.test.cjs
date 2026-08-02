'use strict';

// allow-test-rule: source-text-is-the-product
// agents/gsd-planner.md and gsd-core/workflows/plan-phase.md are the deployed
// runtime prompt contracts — the planner agent and the plan-phase orchestrator
// literally execute this markdown. Testing their text content tests the
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
 * required `gap_closure`, and the always-visible `<downstream_consumer>`
 * frontmatter contract in plan-phase.md never mentioned it either — both
 * unconditionally listed the same 4 fields (wave, depends_on, files_modified,
 * autonomous) regardless of mode. The only place `gap_closure: true` was
 * actually documented as required was prose in a conditionally-loaded
 * reference file (gsd-core/references/planner-gap-closure.md) plus an
 * unvalidated checklist item — neither backed by a deterministic gate.
 *
 * Fix:
 * - src/frontmatter.cts: new `plan-gap-closure` FRONTMATTER_SCHEMAS entry
 *   (covered behaviorally in tests/frontmatter-cli.test.cjs and
 *   tests/frontmatter.unit.test.cjs — this file covers the prompt-level wiring
 *   that selects it).
 * - agents/gsd-planner.md `<step name="validate_plan">`: selects
 *   `--schema plan-gap-closure` when gap_closure mode is active, `--schema plan`
 *   otherwise (unchanged for standard/reviews mode).
 * - gsd-core/workflows/plan-phase.md `<downstream_consumer>`: states the
 *   gap_closure requirement inline for gap_closure mode, mirroring the
 *   existing `<review_incorporation_contract>` mode-scoped-block precedent
 *   already used for reviews mode.
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

function extractSection(content, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = content.indexOf(open);
  const end = content.indexOf(close, start);
  if (start === -1 || end === -1) return null;
  return content.slice(start, end + close.length);
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

// ─── gsd-core/workflows/plan-phase.md: downstream_consumer states the contract (#2847) ─

describe('#2847: plan-phase.md downstream_consumer states gap_closure requirement for gap_closure mode', () => {
  const workflowContent = readFile(PLAN_PHASE_PATH);
  const downstreamBlock = extractSection(workflowContent, 'downstream_consumer');

  test('downstream_consumer block exists', () => {
    assert.ok(downstreamBlock, '<downstream_consumer> block must exist in plan-phase.md');
  });

  test('downstream_consumer block mentions gap_closure for gap_closure mode', () => {
    assert.ok(
      downstreamBlock.includes('gap_closure'),
      'downstream_consumer block must state the gap_closure requirement for gap_closure mode — the always-visible ' +
      'frontmatter contract must not omit it the way it did pre-#2847 (silent parity gap with plan-gap-closure schema)'
    );
  });

  test('downstream_consumer block still lists the base frontmatter fields unconditionally', () => {
    for (const field of ['wave', 'depends_on', 'files_modified', 'autonomous']) {
      assert.ok(
        downstreamBlock.includes(field),
        `downstream_consumer block must still list "${field}" as a base frontmatter requirement (AC(3): unchanged for standard/reviews mode)`
      );
    }
  });

  test('downstream_consumer gap_closure mention is scoped to gap_closure mode, not stated as universally required', () => {
    assert.ok(
      /Mode is gap_closure/i.test(downstreamBlock) || /gap.closure mode/i.test(downstreamBlock),
      'the gap_closure mention must be scoped to gap_closure mode (mirroring the existing mode-scoped ' +
      '<review_incorporation_contract> precedent for reviews mode), not presented as a universal requirement'
    );
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

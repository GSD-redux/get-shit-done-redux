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
 * - agents/gsd-planner.md `<step name="validate_plan">`: the bash invocation
 *   now reads `--schema "$SCHEMA"` — a real shell-variable reference, bound in
 *   the same style as the file's existing `"$PLAN_PATH"` convention — instead
 *   of a hardcoded literal. An earlier revision left the bash line unconditional
 *   (`--schema plan)`, a copy-executable no-op) while only the prose sentence
 *   above it mentioned the conditional; that revision satisfied every
 *   substring-presence check but never actually selected plan-gap-closure at
 *   runtime. Caught by review, not by tests — see the describe block below for
 *   the executable-content assertions written specifically to catch it.
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

/**
 * Extract the FIRST ```bash ... ``` fenced block from a step's text. Returns null
 * if no fenced bash block is found.
 */
function extractFirstBashBlock(stepText) {
  const m = /```bash\n([\s\S]*?)```/.exec(stepText);
  return m ? m[1] : null;
}

/**
 * Find the literal line, within a bash block, that invokes `frontmatter.validate`.
 * Returns null if not found.
 */
function findValidateInvocationLine(bashBlock) {
  if (!bashBlock) return null;
  return bashBlock.split('\n').find((l) => l.includes('frontmatter.validate')) || null;
}

// ─── agents/gsd-planner.md: validate_plan step BINDS schema to mode (#2847) ──
//
// This describe block asserts on the EXECUTABLE content of the step — the literal
// argument passed to `--schema` in the fenced bash block the agent actually runs —
// not on whether explanatory words appear anywhere in the step's prose. A prose
// sentence like "use plan-gap-closure in gap_closure mode, else plan" sitting next
// to an UNCONDITIONAL `--schema plan)` line satisfies every substring-presence
// check imaginable while the agent still only ever executes `--schema plan`. That
// exact shape shipped in an earlier revision of this fix and was caught by review,
// not by tests — these tests are written specifically to catch it mechanically:
// verified RED against that revision (`--schema plan)` hardcoded in the bash
// block, `--schema plan-gap-closure` only in the prose sentence above it) before
// the bash block was changed to `--schema "$SCHEMA"`.

describe('#2847: gsd-planner.md validate_plan step BINDS --schema to gap_closure mode (executable content, not prose)', () => {
  const plannerContent = readFile(PLANNER_AGENT_PATH);
  const validateStep = extractStep(plannerContent, 'validate_plan');
  const bashBlock = extractFirstBashBlock(validateStep || '');
  const invocationLine = findValidateInvocationLine(bashBlock);

  test('validate_plan step exists and has a fenced bash block invoking frontmatter.validate', () => {
    assert.ok(validateStep, '<step name="validate_plan"> must exist in agents/gsd-planner.md');
    assert.ok(bashBlock, 'validate_plan step must have a ```bash fenced block');
    assert.ok(invocationLine, 'validate_plan step bash block must invoke frontmatter.validate');
  });

  test('the --schema argument in the bash invocation is NOT a hardcoded literal', () => {
    // This is the exact regression: a prior revision had this line read
    // `--schema plan)` verbatim — a plain, hardcoded, always-the-same-value
    // literal that an agent executes as-is regardless of mode. Reject BOTH
    // possible hardcoded literals explicitly, not just one, so a fix that
    // flips the hardcoded default to plan-gap-closure (breaking standard mode
    // instead of gap_closure mode) is caught too.
    assert.ok(
      !/--schema\s+plan\)/.test(invocationLine),
      `bash invocation must not hardcode --schema plan — found: ${invocationLine}`
    );
    assert.ok(
      !/--schema\s+plan-gap-closure\)/.test(invocationLine),
      `bash invocation must not hardcode --schema plan-gap-closure — found: ${invocationLine}`
    );
  });

  test('the --schema argument in the bash invocation IS a shell variable reference', () => {
    // A variable reference means the value is resolved at execution time from
    // whatever the agent has bound it to, not printed once in the template and
    // copy-executed unchanged. Matches --schema "$SCHEMA", --schema $SCHEMA,
    // or --schema "${SCHEMA}".
    const varMatch = /--schema\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\)/.exec(invocationLine);
    assert.ok(
      varMatch,
      `bash invocation's --schema argument must be a shell variable (e.g. --schema "$SCHEMA"), not a literal — found: ${invocationLine}`
    );
  });

  test('the bound variable is actually conditioned on gap_closure mode in the step prose, and both target schema names are named', () => {
    const varMatch = /--schema\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\)/.exec(invocationLine);
    assert.ok(varMatch, 'precondition: --schema must reference a variable (see previous test)');
    const varName = varMatch[1];

    // The SAME variable name the bash block reads must appear in the step's prose
    // (outside the bash block) — otherwise the "binding" is a variable nothing
    // ever explains how to set, which is not meaningfully better than a literal.
    const proseOutsideBash = validateStep.replace(/```bash\n[\s\S]*?```/, '');
    assert.ok(
      proseOutsideBash.includes(`$${varName}`) || proseOutsideBash.includes(`\`$${varName}\``),
      `step prose must explain how $${varName} is set — the bash block references it but nothing binds it`
    );

    // Both concrete schema names this variable can resolve to must be named
    // somewhere in the step, and gap_closure mode must be the stated condition
    // for choosing between them.
    assert.ok(validateStep.includes('plan-gap-closure'), 'step must name the plan-gap-closure schema');
    assert.ok(
      /\bplan\b(?!-gap-closure)/.test(validateStep.replace('plan-gap-closure', '')),
      'step must name the plain plan schema as the other branch'
    );
    assert.ok(/gap_closure mode/i.test(validateStep), 'step must condition the choice on gap_closure mode by name');
  });

  test('the plan-structure validation call below (unrelated step) is unaffected', () => {
    // Regression guard for the fix itself: confirm the edit did not touch the
    // sibling verify.plan-structure invocation in the same step.
    assert.ok(
      validateStep.includes('verify.plan-structure "$PLAN_PATH"'),
      'validate_plan step must still invoke verify.plan-structure unchanged'
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
    // Anchor on the tag starting its own line — plan-phase.md's prose elsewhere refers to
    // "the `<downstream_consumer>` lift below" (backtick-quoted, mid-sentence) TWICE before
    // the real opening tag. A plain indexOf('<downstream_consumer>') matches the first prose
    // mention instead of the real tag, producing a wildly over-broad slice that swallows
    // unrelated content (including the `**Mode:** {standard | gap_closure | reviews}` line) —
    // exactly the false failure this anchor prevents.
    const openMatch = /^<downstream_consumer>$/m.exec(workflowContent);
    const start = openMatch ? openMatch.index : -1;
    const end = start === -1 ? -1 : workflowContent.indexOf('</downstream_consumer>', start);
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

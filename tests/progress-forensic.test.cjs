// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for --forensic flag on /gsd-progress (#2189)
 *
 * The --forensic flag appends a 6-check integrity audit after the standard
 * progress report. Default behavior (no flag) is unchanged.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// #2994 fragmentization moved the --forensic-gated forensic_audit step out of
// progress.md into gsd-core/workflows/progress/steps/forensic-audit.md behind
// a section marker. Tests that need the step BODY read that step file
// directly (it is the sole remaining source of the step's content); the
// step-presence check below is the only one that must also confirm the host
// still wires up the marker that reads it.
const FORENSIC_AUDIT_STEP_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'progress', 'steps', 'forensic-audit.md'
);

describe('#2189: progress --forensic flag', () => {
  test('progress command argument-hint includes --forensic', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'), 'utf8'
    );
    assert.ok(command.includes('--forensic'), 'argument-hint should include --forensic');
  });

  test('progress workflow has a forensic_audit step', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
    const step = fs.readFileSync(FORENSIC_AUDIT_STEP_PATH, 'utf8');
    assert.ok(
      workflow.includes('id="forensic-audit"'),
      'progress.md must wire up the forensic-audit section marker'
    );
    assert.ok(
      step.includes('<step name="forensic_audit">'),
      'progress/steps/forensic-audit.md should have a forensic_audit step'
    );
  });

  test('forensic_audit step is only triggered when --forensic is present', () => {
    const forensicStep = fs.readFileSync(FORENSIC_AUDIT_STEP_PATH, 'utf8');
    assert.ok(
      forensicStep.includes('--forensic'),
      'forensic_audit step should be gated on --forensic flag'
    );
    assert.ok(
      forensicStep.includes('Skip') || forensicStep.includes('skip') || forensicStep.includes('exit'),
      'forensic_audit step should skip when --forensic is not present'
    );
  });

  test('forensic_audit step includes all 6 checks', () => {
    const forensicStep = fs.readFileSync(FORENSIC_AUDIT_STEP_PATH, 'utf8');
    // Check 1: STATE vs artifact consistency
    assert.ok(
      forensicStep.includes('STATE') && (forensicStep.includes('artifact') || forensicStep.includes('consistent')),
      'forensic step should check STATE vs artifact consistency (check 1)'
    );
    // Check 2: Orphaned handoff files
    assert.ok(
      forensicStep.includes('HANDOFF') || forensicStep.includes('handoff'),
      'forensic step should check for orphaned handoff files (check 2)'
    );
    // Check 3: Deferred scope drift
    assert.ok(
      forensicStep.includes('deferred') || forensicStep.includes('defer'),
      'forensic step should check for deferred scope drift (check 3)'
    );
    // Check 4: Memory-flagged pending work
    assert.ok(
      forensicStep.includes('MEMORY') || forensicStep.includes('memory') || forensicStep.includes('pending'),
      'forensic step should check memory-flagged pending work (check 4)'
    );
    // Check 5: Blocking todos
    assert.ok(
      forensicStep.includes('todo') || forensicStep.includes('Todo') || forensicStep.includes('TODO'),
      'forensic step should check blocking operational todos (check 5)'
    );
    // Check 6: Uncommitted code
    assert.ok(
      forensicStep.includes('uncommitted') || forensicStep.includes('git status'),
      'forensic step should check for uncommitted code (check 6)'
    );
  });

  test('forensic_audit step produces a CLEAN or INTEGRITY ISSUE(S) FOUND verdict', () => {
    const forensicStep = fs.readFileSync(FORENSIC_AUDIT_STEP_PATH, 'utf8');
    assert.ok(
      forensicStep.includes('CLEAN'),
      'forensic step should produce a CLEAN verdict when all checks pass'
    );
    assert.ok(
      forensicStep.includes('INTEGRITY ISSUE') || forensicStep.includes('integrity issue'),
      'forensic step should surface INTEGRITY ISSUE when checks fail'
    );
  });

  test('forensic_audit step does not change default progress behavior', () => {
    // The forensic step must explicitly say default behavior is unchanged
    const forensicStep = fs.readFileSync(FORENSIC_AUDIT_STEP_PATH, 'utf8');
    assert.ok(
      forensicStep.includes('unchanged') || forensicStep.includes('standard report'),
      'forensic step should clarify that default behavior is unchanged'
    );
  });

  test('COMMANDS.md documents --forensic flag for gsd-progress', () => {
    const commands = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'COMMANDS.md'), 'utf8'
    );
    assert.ok(
      commands.includes('--forensic'),
      'COMMANDS.md should document --forensic flag for gsd-progress'
    );
  });
});

/**
 * Regression — issue #1107
 *
 * /gsd-progress reported a phase as complete and routed to the next phase even
 * when its VERIFICATION.md ended `human_needed` / `gaps_found`, because routing
 * derived completeness from plan/summary counts only and never consulted the
 * `verification.status` query (built in #651). The fix adds a Step 1.7 consult
 * and routing rows that send non-`passed` phases back to close the debt.
 */
describe('#1107: progress routing consults verification.status before reporting complete', () => {
  function readWorkflow() {
    return fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'progress.md'), 'utf8'
    );
  }

  test('workflow consults verification.status for the current phase', () => {
    const workflow = readWorkflow();
    assert.ok(
      workflow.includes('verification.status'),
      'progress workflow must query verification.status (the #651 seam)'
    );
    assert.ok(
      workflow.includes('verification_status'),
      'progress workflow must track a verification_status value for routing'
    );
    assert.ok(
      workflow.includes('stale verification'),
      'progress workflow must document that verification.status projects stale verification'
    );
  });

  test('routing table has gaps_found and human_needed rows BEFORE the generic complete row', () => {
    const workflow = readWorkflow();
    const missingIdx = workflow.indexOf('verification_status = missing');
    const unknownIdx = workflow.indexOf('verification_status = unknown');
    const staleIdx = workflow.indexOf('verification_status = stale');
    const gapsIdx = workflow.indexOf('verification_status = gaps_found');
    const humanIdx = workflow.indexOf('verification_status = human_needed');
    const completeIdx = workflow.indexOf('Phase complete (verification passed)');
    assert.ok(missingIdx > -1, 'routing table must have a missing verification row');
    assert.ok(unknownIdx > -1, 'routing table must have an unknown verification row');
    assert.ok(staleIdx > -1, 'routing table must have a stale verification row');
    assert.ok(gapsIdx > -1, 'routing table must have a gaps_found row');
    assert.ok(humanIdx > -1, 'routing table must have a human_needed row');
    assert.ok(completeIdx > -1, 'routing table must keep a generic complete row');
    assert.ok(
      missingIdx < completeIdx &&
        unknownIdx < completeIdx &&
        staleIdx < completeIdx &&
        gapsIdx < completeIdx &&
        humanIdx < completeIdx,
      'verification rows must precede the generic "summaries = plans" complete row (first-match-wins)'
    );
  });

  test('gaps_found routes to plan-phase --gaps (Route V.gaps)', () => {
    const workflow = readWorkflow();
    // Anchor on the definition heading (`**Route V.gaps:`), not the routing-table
    // reference (`Go to **Route V.gaps**`).
    assert.ok(workflow.includes('**Route V.gaps:'), 'must define a Route V.gaps section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.gaps:'),
      workflow.indexOf('**Route V.human:')
    );
    assert.ok(
      route.includes('--gaps') && route.includes('plan-phase'),
      'Route V.gaps must route to /gsd:plan-phase {phase} --gaps'
    );
  });

  test('human_needed routes to verify-work (Route V.human)', () => {
    const workflow = readWorkflow();
    assert.ok(workflow.includes('**Route V.human:'), 'must define a Route V.human section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.human:'),
      workflow.indexOf('**Step 3', workflow.indexOf('**Route V.human:'))
    );
    assert.ok(
      route.includes('verify-work'),
      'Route V.human must route to /gsd:verify-work {phase}'
    );
  });

  test('stale verification routes to verify-work (Route V.stale)', () => {
    const workflow = readWorkflow();
    assert.ok(workflow.includes('**Route V.stale:'), 'must define a Route V.stale section');
    const route = workflow.slice(
      workflow.indexOf('**Route V.stale:'),
      workflow.indexOf('**Route V.gaps:')
    );
    assert.ok(
      route.includes('verify-work'),
      'Route V.stale must route to /gsd:verify-work {phase}'
    );
  });

  test('missing and unknown verification do not route as complete', () => {
    const workflow = readWorkflow();
    assert.ok(
      workflow.includes('Phase complete (verification passed)'),
      'the generic complete row must only cover passed verification'
    );
    assert.ok(!workflow.includes('verification passed, missing, or n/a'),
      'missing or unknown verification must not be documented as complete');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3418-progress-flag-routing.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3418-progress-flag-routing (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3418)
// The command markdown is loaded directly by runtime prompt assembly.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('#3418: /gsd-progress flag routing prompt contract', () => {
  test('progress command surfaces raw arguments on a dedicated line before routing parse', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      command.includes('Arguments provided: "$ARGUMENTS"'),
      'progress.md must surface $ARGUMENTS on a dedicated line for stable flag parsing'
    );
  });

  test('progress command must not inline-substitute $ARGUMENTS into parse instruction text', () => {
    const command = fs.readFileSync(
      path.join(__dirname, '..', 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      !command.includes('Parse the first token of $ARGUMENTS:'),
      'progress.md must keep parse instructions independent from argument interpolation'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2912-progress-context-authority.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2912-progress-context-authority (consolidation epic #1969 B4 #1973)", () => {
/**
 * Tests for issue #2912 — /gsd-progress can use stale CLAUDE.md project block
 * instead of GSD tracking files as authoritative source.
 *
 * Fix: the `report` step in gsd-core/workflows/progress.md must contain
 * an explicit "context authority" directive establishing PROJECT.md, STATE.md,
 * and ROADMAP.md as the authoritative sources for the progress report, and
 * forbidding the use of CLAUDE.md `## Project` blocks as a source for any
 * report field.
 *
 * These tests parse the workflow markdown structurally (locate the
 * <step name="report"> ... </step> block, then locate the blockquote-style
 * directive inside it). They do NOT use `.includes()` over the whole file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'progress.md'
);

/** Extract the body of a <step name="..."> ... </step> block by parsing tags. */
function extractStep(workflow, stepName) {
  const openTag = `<step name="${stepName}">`;
  const start = workflow.indexOf(openTag);
  if (start === -1) return null;
  const bodyStart = start + openTag.length;
  // Find the matching </step> — workflow steps in this file do not nest.
  const end = workflow.indexOf('</step>', bodyStart);
  if (end === -1) return null;
  return workflow.slice(bodyStart, end);
}

/**
 * Extract contiguous markdown blockquote blocks from a chunk of markdown.
 * A blockquote is a run of consecutive lines starting with '>' (after any
 * leading whitespace). Returns the joined text of each blockquote with the
 * leading '>' markers stripped.
 */
function extractBlockquotes(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*>\s?(.*)$/);
    if (m) {
      if (current === null) current = [];
      current.push(m[1]);
    } else {
      if (current !== null) {
        blocks.push(current.join('\n'));
        current = null;
      }
    }
  }
  if (current !== null) blocks.push(current.join('\n'));
  return blocks;
}

describe('#2912: progress report step has explicit context-authority directive', () => {
  test('progress.md workflow file exists and is readable', () => {
    const stat = fs.statSync(WORKFLOW_PATH);
    assert.ok(stat.isFile(), 'workflow file should exist');
  });

  test('progress.md has a <step name="report"> section', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'workflow should contain a report step');
    assert.ok(reportStep.length > 0, 'report step body should not be empty');
  });

  test('report step contains a blockquote directive about context authority', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must be present');

    const blockquotes = extractBlockquotes(reportStep);
    assert.ok(
      blockquotes.length > 0,
      'report step should contain at least one blockquote (the context-authority directive)'
    );

    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(
      authorityBlock,
      'report step should contain a blockquote whose text includes "Context authority"'
    );
  });

  test('context-authority directive names PROJECT.md, STATE.md, and ROADMAP.md as authoritative', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must exist');
    const blockquotes = extractBlockquotes(reportStep);
    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(authorityBlock, 'authority blockquote must exist');

    assert.match(
      authorityBlock,
      /PROJECT\.md/,
      'directive should name PROJECT.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /STATE\.md/,
      'directive should name STATE.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /ROADMAP\.md/,
      'directive should name ROADMAP.md as authoritative'
    );
    assert.match(
      authorityBlock,
      /authoritative/i,
      'directive should describe these files as authoritative'
    );
  });

  test('context-authority directive forbids using CLAUDE.md project block as a source', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const reportStep = extractStep(workflow, 'report');
    assert.ok(reportStep, 'report step must exist');
    const blockquotes = extractBlockquotes(reportStep);
    const authorityBlock = blockquotes.find((b) => /context\s+authority/i.test(b));
    assert.ok(authorityBlock, 'authority blockquote must exist');

    assert.match(
      authorityBlock,
      /CLAUDE\.md/,
      'directive should explicitly mention CLAUDE.md'
    );
    // Must explicitly forbid CLAUDE.md as a source — look for a NOT/do not directive
    // co-located with the CLAUDE.md mention.
    assert.match(
      authorityBlock,
      /(do\s+NOT|do\s+not|must\s+NOT|must\s+not|never)/i,
      'directive should contain an explicit prohibition (do NOT / must not / never)'
    );
    assert.match(
      authorityBlock,
      /## Project/,
      'directive should call out the CLAUDE.md "## Project" block specifically'
    );
  });
});
  });
}

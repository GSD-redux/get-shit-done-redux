// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Execute-phase active flag prompt tests
 *
 * Guards against prompt wording that makes optional flags look active by default.
 * This is especially important for weaker runtimes that may infer `--gaps-only`
 * from the command docs instead of the literal user arguments.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'execute-phase.md');

describe('execute-phase command: active flags are explicit', () => {
  test('command file exists', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), 'commands/gsd/execute-phase.md should exist');
  });

  test('objective says documented flags are not implied active', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const objectiveMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    assert.ok(objectiveMatch, 'should have <objective> section');
    assert.ok(
      objectiveMatch[1].includes('available behaviors, not implied active behaviors'),
      'objective should state that documented flags are not automatically active'
    );
    assert.ok(
      objectiveMatch[1].includes('appears in `$ARGUMENTS`'),
      'objective should tie flag activation to literal $ARGUMENTS presence'
    );
  });

  test('context separates available flags from active flags', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    assert.ok(
      content.includes('Available optional flags (documentation only'),
      'context should clearly label flags as documentation only'
    );
    assert.ok(
      content.includes('Active flags must be derived from `$ARGUMENTS`'),
      'context should have a separate active-flags section'
    );
  });

  test('context explicitly warns against inferring inactive flags', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    assert.ok(
      content.includes('Do not infer that a flag is active just because it is documented in this prompt'),
      'context should forbid inferring flags from documentation alone'
    );
    assert.ok(
      content.includes('`--interactive` is active only if the literal `--interactive` token is present in `$ARGUMENTS`'),
      'context should apply the same active-flag rule to --interactive'
    );
    assert.ok(
      content.includes('If none of these tokens appear, run the standard full-phase execution flow'),
      'context should define the no-flags fallback behavior'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2396-makefile-test-priority.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2396-makefile-test-priority (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2396)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2396: hardcoded host-level test commands bypass
 * container-only project Makefiles.
 *
 * Fix: execute-phase.md, verify-phase.md, and audit-fix.md must check for
 * Makefile with a test target (and other wrappers) before falling through
 * to hardcoded language-sniffed commands.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const VERIFY_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-phase.md');
const AUDIT_FIX_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'audit-fix.md');
// #1857: execute-phase's regression-gate test-command resolution was extracted
// to this step file (execute-phase.md is size-frozen — phase-6 capstone).
const REGRESSION_GATE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate.md');

function assertMakefileCheckBeforeNpmTest(filePath, label) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Must check for Makefile with test target
  const hasMakefileCheck = /Makefile.*grep.*test:|grep.*test:.*Makefile/s.test(content) ||
    (content.includes('Makefile') && content.includes('"^test:"'));
  assert.ok(
    hasMakefileCheck,
    `${label}: must check for Makefile with test: target before falling through to hardcoded commands`
  );

  // make test must appear before npm test in the file
  const makeTestIdx = content.indexOf('make test');
  const npmTestIdx = content.indexOf('npm test');
  assert.ok(makeTestIdx !== -1, `${label}: must contain "make test"`);
  assert.ok(npmTestIdx !== -1, `${label}: must still contain "npm test" as fallback`);
  assert.ok(
    makeTestIdx < npmTestIdx,
    `${label}: "make test" must appear before "npm test" (Makefile takes priority)`
  );
}

function assertConfigGetBeforeMakefile(filePath, label) {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Must check workflow.test_command config before Makefile sniff.
  // Verify within each bash code block: the workflow.test_command lookup
  // appears before the Makefile grep in the same block.
  assert.ok(
    content.includes('workflow.test_command'),
    `${label}: must check workflow.test_command config before Makefile/language sniff`
  );

  // Extract bash blocks to check ordering within each block.
  // Use the actual Makefile test ([ -f "Makefile" ]) not just the word "Makefile"
  // (which appears in comments before the config-get call).
  const bashBlockRe = /```bash([\s\S]*?)```/g;
  let match;
  let anyBlockCorrectlyOrdered = false;
  while ((match = bashBlockRe.exec(content)) !== null) {
    const block = match[1];
    if (block.includes('workflow.test_command') && block.includes('[ -f "Makefile"')) {
      const configIdx = block.indexOf('workflow.test_command');
      const makefileIdx = block.indexOf('[ -f "Makefile"');
      if (configIdx < makefileIdx) {
        anyBlockCorrectlyOrdered = true;
        break;
      }
    }
  }
  assert.ok(
    anyBlockCorrectlyOrdered,
    `${label}: within a bash block, workflow.test_command config check must appear before Makefile test ([ -f "Makefile" ])`
  );
}

describe('bug-2396: Makefile test target must take priority over hardcoded commands', () => {
  test('execute-phase.md exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PHASE_PATH), 'execute-phase.md should exist');
  });

  test('verify-phase.md exists', () => {
    assert.ok(fs.existsSync(VERIFY_PHASE_PATH), 'verify-phase.md should exist');
  });

  test('audit-fix.md exists', () => {
    assert.ok(fs.existsSync(AUDIT_FIX_PATH), 'audit-fix.md should exist');
  });

  test('regression-gate step: Makefile check precedes npm test (#1857 — extracted from execute-phase.md)', () => {
    assertMakefileCheckBeforeNpmTest(REGRESSION_GATE_PATH, 'regression-gate.md');
  });

  test('verify-phase.md: Makefile check precedes npm test', () => {
    assertMakefileCheckBeforeNpmTest(VERIFY_PHASE_PATH, 'verify-phase.md');
  });

  test('audit-fix.md: Makefile check precedes npm test', () => {
    assertMakefileCheckBeforeNpmTest(AUDIT_FIX_PATH, 'audit-fix.md');
  });

  test('regression-gate step: workflow.test_command config checked first (within bash block) (#1857)', () => {
    assertConfigGetBeforeMakefile(REGRESSION_GATE_PATH, 'regression-gate.md');
  });

  test('verify-phase.md: workflow.test_command config checked first (within bash block)', () => {
    assertConfigGetBeforeMakefile(VERIFY_PHASE_PATH, 'verify-phase.md');
  });

  test('audit-fix.md: workflow.test_command config checked first (within bash block)', () => {
    assertConfigGetBeforeMakefile(AUDIT_FIX_PATH, 'audit-fix.md');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2516-inherit-model-execute-phase.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2516-inherit-model-execute-phase (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2516)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for bug #2516
 *
 * When `.planning/config.json` has `model_profile: "inherit"`, the
 * `init.execute-phase` query returns `executor_model: "inherit"`. The
 * execute-phase workflow was passing this literal string directly to the
 * Task tool via `model="{executor_model}"`, causing Task to fall back to
 * its default model instead of inheriting the orchestrator model.
 *
 * Fix: the workflow must document that when `executor_model` is `"inherit"`,
 * the `model=` parameter must be OMITTED from Task() calls entirely.
 * Omitting `model=` causes Claude Code to inherit the current orchestrator
 * model automatically.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);

describe('bug #2516: executor_model "inherit" must not be passed literally to Task()', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/execute-phase.md should exist');
  });

  test('workflow contains instructions for handling the "inherit" case', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/execute-phase.md should exist');
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const hasInheritInstruction =
      content.includes('"inherit"') &&
      (content.includes('omit') || content.includes('Omit') || content.includes('omitting') || content.includes('Omitting'));
    assert.ok(
      hasInheritInstruction,
      'execute-phase.md must document that when executor_model is "inherit", ' +
      'the model= parameter must be omitted from Task() calls. ' +
      'Found "inherit" mention: ' + content.includes('"inherit"') + '. ' +
      'Found omit mention: ' + (content.includes('omit') || content.includes('Omit'))
    );
  });

  test('workflow does not instruct passing model="inherit" literally to Task', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/execute-phase.md should exist');
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // The workflow must not have an unconditional model="{executor_model}" template
    // that would pass "inherit" through. It should document conditional logic.
    const hasConditionalModelParam =
      content.includes('inherit') &&
      (
        content.includes('Only set `model=`') ||
        content.includes('only set `model=`') ||
        content.includes('Only set model=') ||
        content.includes('omit the `model=`') ||
        content.includes('omit the model=') ||
        content.includes('omit `model=`') ||
        content.includes('omit model=')
      );
    const lines = content.split(/\r?\n/);
    const hasLiteralInheritInTask = lines.some(line => {
      if (!/model\s*=\s*["']inherit["']/.test(line)) return false;
      // Exclude instructional/explanatory lines that document what NOT to do
      return !/\b(not|NOT|don'?t|do not|DO NOT|never|NEVER)\b/.test(line);
    });
    assert.ok(
      !hasLiteralInheritInTask,
      'execute-phase workflow must not pass literal "inherit" string to Task() model parameter'
    );
    assert.ok(
      hasConditionalModelParam && !hasLiteralInheritInTask,
      'execute-phase.md must conditionally omit model= when executor_model is "inherit", never pass it literally. ' +
      'The unconditional model="{executor_model}" template would pass the literal ' +
      'string "inherit" to Task(), which falls back to the default model instead ' +
      'of the orchestrator model (root cause of #2516).'
    );
    // Guard against a future contributor adding an unconditional model="{executor_model}"
    // template alongside the conditional docs — that would pass "inherit" literally to Task().
    const hasUnsafeTemplate = lines.some(line => {
      if (!/model\s*=\s*['"]\{executor_model\}['"]/.test(line)) return false;
      return !/\b(not|NOT|do not|DO NOT|don'?t|never|NEVER|omit)\b/i.test(line);
    });
    assert.ok(!hasUnsafeTemplate,
      'execute-phase.md must not contain an unconditional model="{executor_model}" template — ' +
      'it would pass "inherit" literally to Task() when executor_model is "inherit"'
    );
  });

  test('workflow documents that omitting model= causes inheritance from orchestrator', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/execute-phase.md should exist');
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const hasInheritanceExplanation =
      content.includes('inherit') &&
      (
        content.includes('orchestrator model') ||
        content.includes('orchestrator\'s model') ||
        content.includes('inherits the') ||
        content.includes('inherit the current')
      );
    assert.ok(
      hasInheritanceExplanation,
      'execute-phase.md must explain that omitting model= causes Claude Code to ' +
      'inherit the current orchestrator model — this is the mechanism that makes ' +
      '"inherit" work correctly.'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2002-offer-next-context.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2002-offer-next-context (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression tests for bug #2002
 *
 * offer_next in execute-phase.md must present conditional next steps
 * based on whether CONTEXT.md already exists for the next phase.
 * The previous flat list offered all options equally with no primary
 * recommendation, leaving agents without guidance on the correct first step.
 *
 * Fixed: offer_next now checks for {next}-CONTEXT.md in the phase directory.
 * - If CONTEXT.md is missing: primary suggestion is /gsd-discuss-phase
 * - If CONTEXT.md exists: primary suggestion is /gsd-plan-phase
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'
);

describe('bug #2002: offer_next checks CONTEXT.md before suggesting next step', () => {
  // offer_next body extracted to references/offer-next.md (#2537); content tests
  // read the reference file. The <step name="offer_next"> tag + @-reference remain
  // in execute-phase.md.
  const offerNextRefPath = path.join(__dirname, '..', 'gsd-core', 'references', 'offer-next.md');
  let content;

  test('setup: offer-next reference file is readable', () => {
    content = fs.readFileSync(offerNextRefPath, 'utf-8');
    assert.ok(content.length > 0, 'offer-next.md must not be empty');
  });

  test('execute-phase.md still carries the offer_next step + @-reference', () => {
    const wf = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(wf.includes('<step name="offer_next">'), 'offer_next step tag must remain in execute-phase.md');
    assert.ok(wf.includes('references/offer-next.md'), 'execute-phase.md must @-reference the extracted offer-next.md');
  });

  test('offer_next section checks for CONTEXT.md existence', () => {
    content = content || fs.readFileSync(offerNextRefPath, 'utf-8');
    assert.ok(
      content.includes('CONTEXT.md'),
      'offer_next must reference CONTEXT.md to determine primary next step'
    );
  });

  test('offer_next presents /gsd-discuss-phase when CONTEXT.md does not exist', () => {
    content = content || fs.readFileSync(offerNextRefPath, 'utf-8');
    assert.ok(
      /CONTEXT\.md.*does not exist|CONTEXT\.md.*not.*exist|If CONTEXT\.md does/i.test(content) ||
      /gsd-discuss-phase.*recommended|recommended.*gsd-discuss-phase/i.test(content),
      'offer_next must present /gsd-discuss-phase as primary when CONTEXT.md does not exist'
    );
  });

  test('offer_next presents /gsd-plan-phase when CONTEXT.md exists', () => {
    content = content || fs.readFileSync(offerNextRefPath, 'utf-8');
    assert.ok(
      /CONTEXT\.md.*exists|exists.*CONTEXT\.md|If CONTEXT\.md/i.test(content),
      'offer_next must present /gsd-plan-phase as primary when CONTEXT.md exists'
    );
  });

  test('offer_next section contains at least one conditional guard before listing commands', () => {
    content = content || fs.readFileSync(offerNextRefPath, 'utf-8');
    assert.ok(
      /If CONTEXT\.md/i.test(content),
      'offer_next must contain at least one "If CONTEXT.md" conditional guard'
    );
  });
});
  });
}

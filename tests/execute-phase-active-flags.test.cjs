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
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'execute-phase.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const SESSION_DISPATCH_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'session-survivability-dispatch.md');
const ISOLATION_DISPATCH_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md');

describe('execute-phase command: active flags are explicit', () => {
  test('command file exists', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), 'commands/gsd/execute-phase.md should exist');
  });

  test('objective says documented flags are not implied active', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own command .md content, fixed-size author-controlled content
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

describe('#3159: session-survivability executor dispatch', () => {
  test('resolves once and supplies literal opposite-control harness branches', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const dispatch = fs.readFileSync(SESSION_DISPATCH_PATH, 'utf8');
    assert.match(workflow, /SESSION_OUTLIVES_TURN=\$\(gsd_run query config-get workflow\.session_outlives_turn/);
    assert.match(workflow, /session-survivability-dispatch\.md/);
    const trueAnchor = dispatch.indexOf('When `SESSION_OUTLIVES_TURN` is `true`');
    const falseAnchor = dispatch.indexOf('When `SESSION_OUTLIVES_TURN` is `false`');
    const nextSectionAnchor = dispatch.indexOf('## orchestrator-worktree process dispatch');
    assert.ok(trueAnchor !== -1, 'true anchor must exist in dispatch fragment');
    assert.ok(falseAnchor !== -1, 'false anchor must exist in dispatch fragment');
    assert.ok(nextSectionAnchor !== -1, 'next section anchor must exist in dispatch fragment');
    assert.ok(trueAnchor < falseAnchor, 'true branch precedes false branch');
    assert.ok(falseAnchor < nextSectionAnchor, 'false branch precedes next section');

    const trueRegion = dispatch.slice(trueAnchor, falseAnchor);
    const falseRegion = dispatch.slice(falseAnchor, nextSectionAnchor);

    assert.match(trueRegion, /run_in_background\s*=\s*true/);
    assert.doesNotMatch(trueRegion, /run_in_background\s*=\s*false/);
    assert.match(trueRegion, /model="\{executor_model\}"/);
    assert.match(trueRegion, /\{harnessFlag\}/);
    assert.match(trueRegion, /<required_reading>/);
    assert.doesNotMatch(trueRegion, /\{EXECUTOR_PROMPT\}/);

    assert.match(falseRegion, /run_in_background\s*=\s*false/);
    assert.match(falseRegion, /synchronously/);
    assert.doesNotMatch(falseRegion, /run_in_background\s*=\s*true/);
    assert.match(falseRegion, /model="\{executor_model\}"/);
    assert.match(falseRegion, /\{harnessFlag\}/);
    assert.match(falseRegion, /<required_reading>/);
    assert.doesNotMatch(falseRegion, /\{EXECUTOR_PROMPT\}/);
  });

  test('carries the resolved mode to worktree process dispatch and verifier dispatch', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const dispatch = fs.readFileSync(SESSION_DISPATCH_PATH, 'utf8');
    const isolation = fs.readFileSync(ISOLATION_DISPATCH_PATH, 'utf8');
    assert.match(isolation, /already-resolved `SESSION_OUTLIVES_TURN` mode without re-reading configuration/);
    assert.match(isolation, /true.*background[\s\S]*false.*synchronously[\s\S]*wait/s);
    assert.doesNotMatch(isolation, /workflow\.session_outlives_turn/);
    const verifierStart = dispatch.indexOf('## verifier Agent dispatch');
    const verifierEnd = dispatch.indexOf('<!-- end verifier Agent dispatch -->', verifierStart);
    assert.ok(verifierStart !== -1, 'verifier dispatch section must exist');
    assert.ok(verifierEnd !== -1, 'verifier dispatch section must have an end marker');
    assert.ok(verifierStart < verifierEnd, 'verifier dispatch boundaries must be ordered');
    const verifierRegion = dispatch.slice(verifierStart, verifierEnd);
    const trueAnchor = verifierRegion.indexOf('When `SESSION_OUTLIVES_TURN` is `true`');
    const falseAnchor = verifierRegion.indexOf('When `SESSION_OUTLIVES_TURN` is `false`');
    assert.ok(trueAnchor !== -1, 'verifier true branch must exist');
    assert.ok(falseAnchor !== -1, 'verifier false branch must exist');
    assert.ok(trueAnchor < falseAnchor, 'verifier true branch precedes false branch');

    const trueBranch = verifierRegion.slice(trueAnchor, falseAnchor);
    const falseBranch = verifierRegion.slice(falseAnchor);
    const trueAgentStart = trueBranch.indexOf('Agent(');
    const trueAgentEnd = trueBranch.indexOf('\n)', trueAgentStart);
    const falseAgentStart = falseBranch.indexOf('Agent(');
    const falseAgentEnd = falseBranch.indexOf('\n)', falseAgentStart);
    assert.ok(trueAgentStart !== -1 && trueAgentEnd !== -1, 'true verifier Agent() call must exist');
    assert.ok(falseAgentStart !== -1 && falseAgentEnd !== -1, 'false verifier Agent() call must exist');

    const trueAgent = trueBranch.slice(trueAgentStart, trueAgentEnd);
    const falseAgent = falseBranch.slice(falseAgentStart, falseAgentEnd);
    assert.match(trueAgent, /subagent_type="gsd-verifier"/);
    assert.match(trueAgent, /run_in_background\s*=\s*true/);
    assert.doesNotMatch(trueAgent, /run_in_background\s*=\s*false/);
    assert.match(falseAgent, /subagent_type="gsd-verifier"/);
    assert.match(falseAgent, /run_in_background\s*=\s*false/);
    assert.doesNotMatch(falseAgent, /run_in_background\s*=\s*true/);
    assert.match(workflow, /literal verifier `Agent\(\)` branch/);

    const wfVerifierStart = workflow.indexOf('<step name="verify_phase_goal">');
    const wfVerifierEnd = workflow.indexOf('</step>', wfVerifierStart);
    assert.ok(wfVerifierStart !== -1 && wfVerifierEnd !== -1, 'verifier step in workflow must exist');
    const wfVerifier = workflow.slice(wfVerifierStart, wfVerifierEnd);
    assert.match(wfVerifier, /run_in_background=\{SESSION_OUTLIVES_TURN_BOOL\}/);
  });

  test('uses foreground dispatch when a session-survivability config read is malformed or fails', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.match(workflow, /workflow\.session_outlives_turn --raw 2>\/dev\/null \|\| echo "false"/);
    assert.match(workflow, /\[ "\$SESSION_OUTLIVES_TURN" = "true" \] \|\| SESSION_OUTLIVES_TURN="false"/);
  });

  test('applies session survivability to the no-isolation sequential path', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const sequential = workflow.slice(workflow.indexOf('**Sequential mode**'), workflow.indexOf('4. **Wait for all agents'));
    assert.match(sequential, /already-resolved `SESSION_OUTLIVES_TURN` mode/);
    assert.match(sequential, /run_in_background=false/);
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
 * Fix: execute-phase.md and audit-fix.md must check for
 * Makefile with a test target (and other wrappers) before falling through
 * to hardcoded language-sniffed commands.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const AUDIT_FIX_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'audit-fix.md');
// #1857: execute-phase's regression-gate test-command resolution was extracted
// to this step file (execute-phase.md is size-frozen — phase-6 capstone).
// #2932: steps/regression-gate.md now only discovers prior-phase test files and
// delegates (via "Read and execute") to steps/regression-gate-run.md, which
// carries the actual test-command resolution (Makefile/config-get priority).
const REGRESSION_GATE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'regression-gate-run.md');

function assertMakefileCheckBeforeNpmTest(filePath, label) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Must check for Makefile with test target
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
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
  const lines = content.split(/\r?\n/);
  let anyBlockCorrectlyOrdered = false;
  for (const fenced of scanFencedBlocks(lines)) {
    if (fenced.closeLineIdx === -1) continue;
    if ((fenced.infoString || '').trim() !== 'bash') continue;
    const block = lines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');
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

  test('audit-fix.md exists', () => {
    assert.ok(fs.existsSync(AUDIT_FIX_PATH), 'audit-fix.md should exist');
  });

  test('regression-gate step: Makefile check precedes npm test (#1857 — extracted from execute-phase.md)', () => {
    assertMakefileCheckBeforeNpmTest(REGRESSION_GATE_PATH, 'regression-gate.md');
  });

  test('audit-fix.md: Makefile check precedes npm test', () => {
    assertMakefileCheckBeforeNpmTest(AUDIT_FIX_PATH, 'audit-fix.md');
  });

  test('regression-gate step: workflow.test_command config checked first (within bash block) (#1857)', () => {
    assertConfigGetBeforeMakefile(REGRESSION_GATE_PATH, 'regression-gate.md');
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

describe('bug #2002: next-step suggestion checks CONTEXT.md (now via transition offer_next_phase, reached by execute-phase post-completion delegation — #1526)', () => {
  // #1526: execute-phase no longer carries an inline offer_next step — it delegates
  // post-completion to the transition workflow, whose offer_next_phase step performs
  // the #2002 CONTEXT.md-gated next-step suggestion. These tests track that behavior
  // in its new home (transition.md) and assert the delegation reaches it.
  const transPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'transition.md');
  let offerNextPhase;

  test('setup: transition.md offer_next_phase section is readable', () => {
    const trans = fs.readFileSync(transPath, 'utf-8');
    const start = trans.indexOf('<step name="offer_next_phase">');
    const end = trans.indexOf('</step>', start);
    assert.notEqual(start, -1, 'transition.md must have an offer_next_phase step');
    offerNextPhase = trans.slice(start, end);
    assert.ok(offerNextPhase.length > 0, 'offer_next_phase section must be non-empty');
  });

  test('#1526: execute-phase delegates post-completion to transition (no inline offer_next step)', () => {
    const wf = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(wf.includes('delegate_post_completion_to_transition'), 'execute-phase must delegate post-completion to transition');
    assert.ok(wf.includes('@~/.claude/gsd-core/workflows/transition.md'), 'execute-phase must @-include transition.md');
    assert.equal(wf.includes('<step name="offer_next">'), false, 'inline offer_next step is intentionally removed (delegated to transition.offer_next_phase)');
  });

  test('offer_next_phase checks for CONTEXT.md existence (#2002 preserved)', () => {
    assert.ok(
      offerNextPhase.includes('CONTEXT.md'),
      'offer_next_phase must reference CONTEXT.md to determine primary next step'
    );
  });

  test('offer_next_phase presents /gsd-discuss-phase when CONTEXT.md does not exist', () => {
    assert.ok(
      /CONTEXT\.md.*does not exist|CONTEXT\.md.*not.*exist|If CONTEXT\.md does/i.test(offerNextPhase) ||
      /discuss-phase/i.test(offerNextPhase),
      'offer_next_phase must present /gsd-discuss-phase as primary when CONTEXT.md does not exist'
    );
  });

  test('offer_next_phase presents /gsd-plan-phase when CONTEXT.md exists', () => {
    assert.ok(
      /CONTEXT\.md.*exists|exists.*CONTEXT\.md|If CONTEXT\.md/i.test(offerNextPhase),
      'offer_next_phase must present /gsd-plan-phase as primary when CONTEXT.md exists'
    );
  });

  test('offer_next_phase contains at least one conditional guard before listing commands', () => {
    assert.ok(
      /If CONTEXT\.md/i.test(offerNextPhase),
      'offer_next_phase must contain at least one "If CONTEXT.md" conditional guard'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-3177-execute-phase-dispatch-claim.test.cjs — test hygiene #3334 (H3)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-3177-execute-phase-dispatch-claim (test hygiene #3334 H3)", () => {
// allow-test-rule: runtime-contract-is-the-product #3177 — the workflow markdown is loaded
// verbatim into the agent's context and the matrix/descriptor ARE the negotiated host
// contract; asserting agreement between those documents is behavioral, not source-grep.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const MATRIX = path.join(ROOT, 'docs', 'reference', 'host-integration-capability-matrix.md');
const DESCRIPTOR = path.join(ROOT, 'capabilities', 'claude', 'capability.json');

const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8');

/**
 * Value of `| <field> | <value> | …` inside the `## <host>` section of the matrix.
 *
 * Anchored on a whole heading LINE, not a substring: `## claude` must never match
 * `## claude-local`, and the section must end at the next `## ` heading so a field
 * absent from this host can never be answered from the next host's table.
 *
 * @param {string} matrix - full matrix document text
 * @param {string} host - section name, e.g. `claude`
 * @param {string} field - row label, e.g. `dispatch.background`
 * @returns {string|null} trimmed cell value, or null when the section or row is absent
 */
function matrixField(matrix, host, field) {
  const lines = matrix.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${host}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const row = lines.slice(start + 1, end).find((l) => l.startsWith(`| ${field} |`));
  if (!row) return null;
  return row.split('|')[2].trim();
}

describe('#3177: execute-phase.md states Claude Code dispatch truthfully', () => {
  test('execute-phase.md never claims Claude Code Agent() blocks or returns synchronously', () => {
    // Row 1 — the failing-first regression. Both stale sentences, by their own text.
    const text = workflowText();
    const stale = ['blocks until complete', 'returns synchronously'];
    const present = stale.filter((phrase) => text.includes(phrase));
    assert.deepEqual(
      present, [],
      'execute-phase.md still asserts synchronous Claude Code dispatch. Claude Code backgrounds '
      + 'subagents by default (v2.1.198+); `run_in_background: false` is the opt-out.',
    );
  });

  test('the Claude Code dispatch bullet states the background-by-default model', () => {
    // Row 2 — the corrected sentence must actually SAY the true thing, not merely
    // omit the false one. A deletion would pass row 1 while teaching nothing.
    const bullet = workflowText()
      .split('\n')
      .find((l) => l.startsWith('- **Claude Code:**'));
    assert.ok(bullet, 'the <runtime_compatibility> Claude Code bullet must exist');
    assert.match(
      bullet, /backgrounded by default/,
      'the bullet must state that dispatch is backgrounded by default',
    );
    assert.match(
      bullet, /verify completion/,
      'the bullet must point at completion verification. This workflow deliberately backgrounds '
      + 'its executors (the multi-plan path prescribes run_in_background: true), so the blocking '
      + 'opt-out is not the guidance here — confirming completion is.',
    );
    assert.ok(
      bullet.includes('Agent(subagent_type="gsd-executor"'),
      'the bullet must still carry the dispatch mechanism the rest of the file depends on',
    );
  });

  test('the workflow prose and the capability matrix agree on claude dispatch.background', () => {
    // Row 3 — the parity guard. This is the assertion that outlives the wording:
    // flip the matrix to `false` without touching the prose (or vice versa) and this reds.
    const declared = matrixField(fs.readFileSync(MATRIX, 'utf8'), 'claude', 'dispatch.background');
    assert.equal(declared, 'true', 'matrix must document claude dispatch.background');

    const bullet = workflowText()
      .split('\n')
      .find((l) => l.startsWith('- **Claude Code:**'));
    const proseSaysBackground = /backgrounded by default/.test(bullet ?? '');
    assert.equal(
      proseSaysBackground, declared === 'true',
      'execute-phase.md and the host-integration matrix disagree about whether claude backgrounds '
      + 'its subagent dispatch. They describe the same runtime; exactly one of them is wrong (#3177).',
    );
  });

  test('the claude descriptor and the matrix agree on dispatch.background', () => {
    // Row 4 — the other half of the divergence class. The matrix is generated from
    // the descriptor, so this pins the generator's output to its input.
    const descriptor = JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8'));
    const declared = matrixField(fs.readFileSync(MATRIX, 'utf8'), 'claude', 'dispatch.background');
    assert.equal(
      String(descriptor.runtime.hostIntegration.dispatch.background), declared,
      'capabilities/claude/capability.json and the rendered matrix disagree',
    );
  });

  test('the Codex orchestrator rule is not swept by the Claude Code correction', () => {
    // Row 5 — negative space. Codex dispatch IS synchronous. A regex sweep for
    // "return its result" would introduce a NEW falsehood here; this catches that.
    const text = workflowText();
    const codexRules = text
      .split('\n')
      .filter((l) => l.includes('ORCHESTRATOR RULE — CODEX RUNTIME'));
    assert.ok(codexRules.length >= 2, 'both Codex orchestrator rules must survive');
    for (const rule of codexRules) {
      assert.ok(
        rule.includes('Wait for the subagent to return its result'),
        'Codex dispatch is genuinely synchronous — its wait rule must not be corrected away',
      );
    }
  });

  test('the Copilot and multi-plan dispatch rules survive the correction', () => {
    // Row 6 — negative space. These were already true and are adjacent to the edit.
    const text = workflowText();
    assert.ok(
      text.includes('- **Copilot:** Subagent spawning does not reliably return completion signals.'),
      'the Copilot bullet must survive verbatim',
    );
    assert.ok(
      text.includes('one at a time with `run_in_background: true`'),
      'the multi-plan wave prescription must survive verbatim',
    );
    assert.ok(
      text.includes('If `Agent` IS available (top-level Claude'),
      'the spawn mandate is derived from TOOL AVAILABILITY, not from blocking — it must survive',
    );
  });
});

describe('#3177: matrix section extraction is bounded by its heading', () => {
  const matrix = () => fs.readFileSync(MATRIX, 'utf8');

  test('section extraction — first row of the section', () => {
    // limit-1: the row immediately after the `## claude` heading is INSIDE.
    assert.equal(matrixField(matrix(), 'claude', 'embeddingMode'), 'imperative');
  });

  test('section extraction — last row before the next heading', () => {
    // limit: the final row of `## claude` is still INSIDE.
    assert.ok(matrixField(matrix(), 'claude', 'dispatch.isolation').startsWith('harness-worktree'));
  });

  test('section extraction — a row in the next section never leaks in', () => {
    // limit+1: a field absent from claude must be null rather than silently
    // resolved from `## codex` below it, and two hosts with different values
    // must never resolve to the same cell.
    const doc = matrix();
    assert.equal(matrixField(doc, 'claude', 'dispatch.background'), 'true');
    assert.equal(matrixField(doc, 'claude', '__definitely_not_a_field__'), null);
    assert.notEqual(
      matrixField(doc, 'claude', 'effortSurface'),
      matrixField(doc, 'kilo', 'effortSurface'),
      'two hosts with different values must not resolve to the same cell',
    );
  });

  test('fc property: field extraction never leaks across ## boundaries', () => {
    const hostArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
    const valueArb = fc.stringMatching(/^[a-z0-9]{1,10}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(hostArb, valueArb), {
          minLength: 2, maxLength: 6, selector: ([h]) => h,
        }),
        fc.nat(),
        (sections, pick) => {
          const doc = sections
            .map(([host, value]) => `## ${host}\n\n| axis | value |\n| f | ${value} |\n`)
            .join('\n');
          const [host, value] = sections[pick % sections.length];
          // Exactly the requested section's value, never a neighbor's.
          assert.equal(matrixField(doc, host, 'f'), value);
          // A longer name that merely EXTENDS a real heading resolves to nothing.
          // `_` is outside hostArb's alphabet, so this probe can NEVER collide with
          // another generated section — the `-local` form could, and did.
          assert.equal(matrixField(doc, `${host}_x`, 'f'), null);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('#3177: debug.md dispatches its session manager in the foreground', () => {
  const DEBUG_WF = path.join(ROOT, 'gsd-core', 'workflows', 'debug.md');
  const debugText = () => fs.readFileSync(DEBUG_WF, 'utf8');

  /**
   * Every fenced `Agent( … )` block in debug.md that dispatches the session manager.
   *
   * Anchored on a line that is exactly `Agent(` so the PROSE mention of
   * `Agent(subagent_type="gsd-debug-session-manager", …)` inside the blockquote at
   * :206 is not mistaken for a dispatch. Positional selection (first match wins) was
   * the original bug here: it silently checked the continue path while the
   * new-session path went unexamined.
   */
  function sessionManagerDispatches(text) {
    const blocks = [];
    for (const m of text.matchAll(/^Agent\($/gm)) {
      const close = text.indexOf('\n)', m.index);
      if (close === -1) continue;
      const block = text.slice(m.index, close);
      if (block.includes('subagent_type="gsd-debug-session-manager"')) blocks.push(block);
    }
    return blocks;
  }

  test('every session-manager spawn carries the run_in_background: false opt-out', () => {
    // #2196 required this dispatch be foreground and blocking so the orchestrator
    // receives the session summary inline; debug.md still says "Wait for it; do not
    // background it" and "Display the compact summary returned by the session
    // manager". Claude Code backgrounds subagents by DEFAULT, so that intent only
    // holds if each call states the opt-out explicitly — prose alone silently
    // reinstated the exact lost-handoff failure #2196 was filed to fix.
    const blocks = sessionManagerDispatches(debugText());
    assert.equal(
      blocks.length, 2,
      'debug.md dispatches the session manager on BOTH the new-session and continue paths; '
      + 'a change to that count means a dispatch was added or removed and must be re-checked.',
    );
    for (const block of blocks) {
      assert.match(
        block, /run_in_background\s*=\s*false/,
        'every gsd-debug-session-manager dispatch must pass run_in_background=false — without '
        + 'it Claude Code backgrounds the spawn and the compact summary never returns (#2196).',
      );
    }
  });

  test('debug.md does not assert the spawn is inherently foreground', () => {
    // The old premise ("is FOREGROUND and BLOCKING") was a property claim about the
    // host, not an instruction — and it was false for the same reason as #3177.
    assert.ok(
      !debugText().includes('is FOREGROUND and BLOCKING'),
      'debug.md must not claim the Agent() call is inherently foreground; it must name the '
      + 'run_in_background: false opt-out that actually makes it so.',
    );
  });
});
  });
}

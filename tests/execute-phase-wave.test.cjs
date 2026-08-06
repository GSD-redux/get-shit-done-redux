/**
 * Execute-phase wave filter tests
 *
 * Validates the /gsd-execute-phase --wave feature contract:
 * - Command frontmatter advertises --wave
 * - Workflow parses WAVE_FILTER
 * - Workflow enforces lower-wave safety
 * - Partial wave runs do not mark the phase complete
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'execute-phase.md');
const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const COMMANDS_DOC_PATH = path.join(__dirname, '..', 'docs', 'COMMANDS.md');
// After #3039, the comprehensive command reference moved to help/modes/full.md.
const HELP_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'help', 'modes', 'full.md');

// allow-test-rule: source-text-is-the-product
// The workflow and command .md files are the installed AI instructions — their text content
// IS what executes. String presence tests guard against accidental deletion of critical clauses.
// See #2692 for the missing behavioral test for --wave N argument parsing.
describe('execute-phase command: --wave flag', () => {
  test('command file exists', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), 'commands/gsd/execute-phase.md should exist');
  });

  test('argument-hint includes --wave, --gaps-only, and --interactive', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const hintLine = content.split(/\r?\n/).find(l => l.includes('argument-hint'));
    assert.ok(hintLine, 'should have argument-hint line');
    assert.ok(hintLine.includes('--wave N'), 'argument-hint should include --wave N');
    assert.ok(hintLine.includes('--gaps-only'), 'argument-hint should keep --gaps-only');
    assert.ok(hintLine.includes('--interactive'), 'argument-hint should preserve --interactive');
  });

  test('objective describes wave-filter execution', () => {
    const content = fs.readFileSync(COMMAND_PATH, 'utf-8');
    const objectiveMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    assert.ok(objectiveMatch, 'should have <objective> section');
    assert.ok(objectiveMatch[1].includes('--wave N'), 'objective should mention --wave N');
    assert.ok(
      objectiveMatch[1].includes('no incomplete plans remain'),
      'objective should mention phase completion guardrail'
    );
  });
});

describe('execute-phase workflow: wave filtering', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('workflow parses WAVE_FILTER from arguments', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('WAVE_FILTER'), 'workflow should reference WAVE_FILTER');
    assert.ok(content.includes('Optional `--wave N`'), 'workflow should parse --wave N');
  });

  test('workflow enforces lower-wave safety', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('Wave safety check'),
      'workflow should contain a wave safety check section'
    );
    assert.ok(
      content.includes('finish earlier waves first'),
      'workflow should block later-wave execution when lower waves are incomplete'
    );
  });

  test('workflow has partial-wave completion guardrail', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // handle_partial_wave_execution was extracted to
    // gsd-core/workflows/execute-phase/steps/partial-wave.md. The parent now only
    // references it via a <gsd:section> pointer, so assert the pointer is present here
    // and then read the actual step body from the extracted file below.
    assert.ok(
      content.includes('gsd-core/workflows/execute-phase/steps/partial-wave.md'),
      'workflow should reference the extracted partial-wave step file'
    );

    const PARTIAL_WAVE_STEP_PATH = path.join(
      __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'partial-wave.md'
    );
    assert.ok(fs.existsSync(PARTIAL_WAVE_STEP_PATH), 'partial-wave step file should exist');
    const stepContent = fs.readFileSync(PARTIAL_WAVE_STEP_PATH, 'utf-8');

    assert.ok(
      stepContent.includes('<step name="handle_partial_wave_execution">'),
      'workflow should have a partial wave handling step'
    );
    assert.ok(
      stepContent.includes('Do NOT run phase verification'),
      'partial wave step should skip phase verification'
    );
    assert.ok(
      stepContent.includes('Do NOT mark the phase complete'),
      'partial wave step should skip phase completion'
    );
  });
});

// #2868: a phase whose plans are ALL summarized but which never reached
// verify_phase_goal (most commonly a retired checkpoint plan that still wrote a
// SUMMARY) must resume at the phase gates instead of exiting unconditionally —
// the prior behavior made `code_review_gate`, `regression_gate`, and
// `verify_phase_goal` (the only producer of *-VERIFICATION.md) unreachable.
describe('execute-phase workflow: #2868 stranded-phase resume on discover_and_group_plans', () => {
  test('W1: all-filtered outcome is no longer an unconditional exit; it consults verification status', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      !content.includes('If all filtered: "No matching incomplete plans" → exit.'),
      'the old unconditional all-filtered exit line must be gone (#2868)'
    );
    assert.ok(
      content.includes('VERIFY_STATUS'),
      'discover_and_group_plans should consult VERIFY_STATUS before exiting on all-filtered'
    );
    assert.ok(
      content.includes('verification status'),
      'discover_and_group_plans should call the verification status query'
    );
  });

  test('W2: the resume path names both code_review_gate and regression_gate', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    assert.ok(
      discoverSection.includes('code_review_gate'),
      'discover_and_group_plans should name code_review_gate as the resume target'
    );
    assert.ok(
      discoverSection.includes('regression_gate'),
      'discover_and_group_plans should name regression_gate so a future rename breaks this test ' +
        'instead of silently orphaning the resume path'
    );
  });

  test('W3: the resume path is gated off when a filter is active (--gaps-only or WAVE_FILTER)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    const filterIdx = discoverSection.indexOf('A filter is active');
    assert.ok(filterIdx >= 0, 'discover_and_group_plans should describe a filter-active branch');
    // Both flags must be mentioned near the filter-active branch, not merely
    // anywhere in the step (e.g. in the pre-existing filtering prose above).
    const filterClause = discoverSection.substring(filterIdx, filterIdx + 200);
    assert.ok(
      filterClause.includes('--gaps-only'),
      'filter-active branch should mention --gaps-only'
    );
    assert.ok(
      filterClause.includes('WAVE_FILTER'),
      'filter-active branch should mention WAVE_FILTER'
    );
  });

  test('W4: the resume decision is gated on the absence of blocked_by-skipped plans', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    // Scope to the resume-decision text specifically (from the "If all filtered" marker
    // onward), not the pre-existing #2830 filtering prose above it that already mentions
    // blocked_by unconditionally — otherwise this assertion would be vacuous.
    const decisionIdx = discoverSection.indexOf('If all filtered');
    assert.ok(decisionIdx >= 0, 'discover_and_group_plans should have an all-filtered decision block');
    const decisionText = discoverSection.substring(decisionIdx);

    assert.ok(
      decisionText.includes('blocked_by'),
      'the resume-decision text must reference blocked_by so an all-blocked phase is never ' +
        'reported as finished (#2868 finding 1)'
    );
    assert.ok(
      /stuck/i.test(decisionText),
      'the resume-decision text must call out the blocked-and-incomplete case as stuck, ' +
        'distinct from genuinely finished'
    );
  });

  test('W5: the resume path enters at aggregate_results, not code_review_gate', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const discoverIdx = content.indexOf('<step name="discover_and_group_plans">');
    const discoverEnd = content.indexOf('</step>', discoverIdx) + '</step>'.length;
    assert.ok(discoverIdx >= 0, 'discover_and_group_plans step should exist');
    const discoverSection = content.substring(discoverIdx, discoverEnd);

    const continueMatch = discoverSection.match(/continue (?:directly )?at\s+`([a-zA-Z_]+)`/);
    assert.ok(continueMatch, 'resume decision should state which step it continues at');
    assert.strictEqual(
      continueMatch[1],
      'aggregate_results',
      'the resume path must enter at aggregate_results (the only step running the ' +
        'SECURITY_FILE / secure-phase threats-open gate), not code_review_gate — skipping ' +
        'aggregate_results silently drops the only security gate (#2868 finding 3)'
    );
    assert.notStrictEqual(
      continueMatch[1],
      'code_review_gate',
      'resume entry point must not be code_review_gate'
    );
  });

  test('W6: RESUME_TAIL_ONLY (dead, write-only state) must not appear anywhere in the workflow', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      !content.includes('RESUME_TAIL_ONLY'),
      'RESUME_TAIL_ONLY was set but never read anywhere in the workflow or its steps files ' +
        '(#2868 finding 2) — remove it; the imperative instruction at the decision point is ' +
        'what actually carries control flow'
    );
  });
});

describe('execute-phase docs: user-facing wave flag', () => {
  test('COMMANDS.md documents --wave usage', () => {
    const content = fs.readFileSync(COMMANDS_DOC_PATH, 'utf-8');
    assert.ok(content.includes('`--wave N`'), 'COMMANDS.md should mention --wave N');
    assert.ok(
      content.includes('/gsd-execute-phase 1 --wave 2'),
      'COMMANDS.md should include a wave-filter example'
    );
  });

  test('help workflow documents --wave behavior', () => {
    const content = fs.readFileSync(HELP_PATH, 'utf-8');
    assert.ok(
      content.includes('Optional `--wave N` flag executes only Wave `N`'),
      'help.md should describe wave-specific execution'
    );
    assert.ok(
      content.includes('Usage: `/gsd:execute-phase 5 --wave 2`') || content.includes('Usage: `/gsd-execute-phase 5 --wave 2`'),
      'help.md should include wave-filter usage'
    );
  });

  test('workflow supports use_worktrees config toggle', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('USE_WORKTREES'),
      'workflow should reference USE_WORKTREES variable'
    );
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'workflow should read use_worktrees from config'
    );
    assert.ok(
      content.includes('Sequential mode'),
      'workflow should document sequential mode when worktrees disabled'
    );
  });
});

describe('phase-plan-index: wave grouping behavior', () => {
  test('phase-plan-index groups plans by wave (DAG-bucketing: P002 depends on P001)', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = createTempProject();
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });

      // Wave 1 plan — no dependencies
      fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
        '---',
        'wave: 1',
        'objective: First wave task',
        'autonomous: true',
        'depends_on: []',
        '---',
        '',
        '# Plan 001',
        '',
        '<objective>First wave task</objective>',
        '',
        '<task>Do the thing</task>',
      ].join('\n'));

      // Wave 2 plan — depends on P001 so DAG places it in level 1 → wave 2
      fs.writeFileSync(path.join(phaseDir, 'P002-PLAN.md'), [
        '---',
        'wave: 2',
        'objective: Second wave task',
        'autonomous: true',
        'depends_on:',
        '  - P001',
        '---',
        '',
        '# Plan 002',
        '',
        '<objective>Second wave task</objective>',
        '',
        '<task>Do the other thing</task>',
      ].join('\n'));

      const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
      assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);

      const data = JSON.parse(result.output);

      // Wave grouping must be present
      assert.ok(data.waves, 'output should have a waves property');
      assert.deepEqual(data.waves['1'], ['P001'], 'wave 1 should contain P001');
      assert.deepEqual(data.waves['2'], ['P002'], 'wave 2 should contain P002');

      // Individual plan records must carry their wave numbers
      const p001 = data.plans.find(p => p.id === 'P001');
      const p002 = data.plans.find(p => p.id === 'P002');
      assert.ok(p001, 'P001 should be in plans array');
      assert.ok(p002, 'P002 should be in plans array');
      assert.equal(p001.wave, 1, 'P001 should have wave=1');
      assert.equal(p002.wave, 2, 'P002 should have wave=2');
      // No mismatch warning: declared wave 2 matches topo level 2
      assert.strictEqual(data.warnings, undefined, 'no warnings when declared wave matches DAG');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('phase-plan-index defaults missing wave frontmatter to wave 1', () => {
    const fs = require('fs');
    const path = require('path');
    const tmpDir = createTempProject();
    try {
      const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });

      // Plan with no wave field in frontmatter
      fs.writeFileSync(path.join(phaseDir, 'P001-PLAN.md'), [
        '---',
        'objective: No wave specified',
        'autonomous: true',
        '---',
        '',
        '# Plan 001',
        '',
        '<task>Some work</task>',
      ].join('\n'));

      const result = runGsdTools(['phase-plan-index', '1', '--raw'], tmpDir);
      assert.ok(result.success, `phase-plan-index should succeed: ${result.error}`);

      const data = JSON.parse(result.output);
      const p001 = data.plans.find(p => p.id === 'P001');
      assert.ok(p001, 'P001 should appear in plans');
      assert.equal(p001.wave, 1, 'plan with no wave frontmatter should default to wave 1');
      assert.deepEqual(data.waves['1'], ['P001'], 'defaulted plan should land in wave 1 group');
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('use_worktrees config: cross-workflow structural coverage', () => {
  const QUICK_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
  const DIAGNOSE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
  const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');
  const PLANNING_CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'planning-config.md');

  test('quick workflow reads USE_WORKTREES from config', () => {
    const content = fs.readFileSync(QUICK_PATH, 'utf-8');
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'quick.md should read use_worktrees from config'
    );
    assert.ok(
      content.includes('USE_WORKTREES'),
      'quick.md should reference USE_WORKTREES variable'
    );
  });

  test('diagnose-issues workflow reads USE_WORKTREES from config', () => {
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    assert.ok(
      content.includes('config-get workflow.use_worktrees'),
      'diagnose-issues.md should read use_worktrees from config'
    );
    assert.ok(
      content.includes('USE_WORKTREES'),
      'diagnose-issues.md should reference USE_WORKTREES variable'
    );
  });

  test('execute-plan workflow references use_worktrees config', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    assert.ok(
      content.includes('workflow.use_worktrees'),
      'execute-plan.md should reference workflow.use_worktrees'
    );
  });

  test('planning-config reference documents use_worktrees', () => {
    const content = fs.readFileSync(PLANNING_CONFIG_PATH, 'utf-8');
    assert.ok(
      content.includes('workflow.use_worktrees'),
      'planning-config.md should document workflow.use_worktrees'
    );
    assert.ok(
      content.includes('worktree'),
      'planning-config.md should describe worktree behavior'
    );
  });

  test('config-set accepts workflow.use_worktrees', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools('config-set workflow.use_worktrees true', tmpDir);
      assert.ok(result.success, `config-set should accept workflow.use_worktrees: ${result.error}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2410-stream-checkpoint-heartbeats.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2410-stream-checkpoint-heartbeats (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2410)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #2410 — /gsd:manager background execute-phase Task fails with
 * "Stream idle timeout" on multi-plan phases.
 *
 * Fix: execute-phase.md instructs the orchestrator to emit `[checkpoint]`
 * heartbeat lines at every wave boundary AND every plan boundary so the
 * Claude API SSE stream never idles long enough to trigger the platform
 * timeout. This test validates the workflow contract that backs that fix.
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
  'execute-phase.md'
);
const COMMANDS_DOC_PATH = path.join(__dirname, '..', 'docs', 'COMMANDS.md');

describe('bug #2410: execute-phase emits checkpoint heartbeats', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow references the stream idle timeout symptom by name', () => {
    assert.ok(
      /Stream idle timeout/.test(workflow),
      'workflow should name the API error it is preventing'
    );
    assert.ok(
      workflow.includes('#2410'),
      'workflow should cite the tracking issue for future maintainers'
    );
  });

  test('workflow defines a [checkpoint] heartbeat line format', () => {
    assert.ok(
      workflow.includes('[checkpoint]'),
      'workflow should document the [checkpoint] marker prefix'
    );
  });

  test('workflow emits a wave-start heartbeat (A: wave-boundary checkpoint)', () => {
    assert.ok(
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} starting/.test(workflow),
      'workflow should emit a wave-start [checkpoint] marker before spawning agents'
    );
  });

  test('workflow emits a wave-complete heartbeat (A: wave-boundary checkpoint)', () => {
    assert.ok(
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} complete/.test(workflow),
      'workflow should emit a wave-complete [checkpoint] marker after spot-checks'
    );
  });

  test('workflow emits a plan-start heartbeat (B: plan-boundary checkpoint)', () => {
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} starting/.test(workflow),
      'workflow should emit a plan-start [checkpoint] marker before each Task() dispatch'
    );
  });

  test('workflow emits a plan-complete heartbeat (B: plan-boundary checkpoint)', () => {
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} complete/.test(workflow),
      'workflow should emit a plan-complete [checkpoint] marker after executor returns'
    );
  });

  test('workflow handles plan failure and checkpoint-gate heartbeats too', () => {
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} failed/.test(workflow),
      'workflow should emit a plan-failed [checkpoint] marker on executor error'
    );
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} checkpoint/.test(workflow),
      'workflow should emit a heartbeat when a plan returns a human-gate checkpoint'
    );
  });

  test('heartbeats include a monotonic plans-done counter', () => {
    // The {P}/{Q} counter lets grep-based recovery tools reconstruct progress
    // from a truncated transcript if the agent dies mid-phase.
    assert.ok(
      /\{P\}\/\{Q\} plans done/.test(workflow),
      'heartbeats should include a {P}/{Q} phase-wide completed-plan counter'
    );
  });

  test('wave-start heartbeat precedes the "Describe what\'s being built" text', () => {
    const describeIdx = workflow.indexOf("Describe what's being built");
    const heartbeatIdx = workflow.indexOf(
      '[checkpoint] phase {PHASE_NUMBER} wave {N}/{M} starting'
    );
    assert.ok(describeIdx !== -1, 'workflow should still have the describe step');
    assert.ok(heartbeatIdx !== -1, 'wave-start heartbeat template should be present');
    // The instruction to emit the heartbeat appears in step 2, which is the
    // step titled "Describe what's being built". The actual sentinel text we
    // look for is the inline literal template — it must be emitted BEFORE any
    // tool calls in that step.
    const step2 = workflow.slice(
      describeIdx,
      workflow.indexOf('3. **Spawn executor agents', describeIdx)
    );
    assert.ok(
      step2.includes('[checkpoint]'),
      'step 2 should instruct the orchestrator to emit a [checkpoint] heartbeat'
    );
    assert.ok(
      /before any further reasoning or spawning/i.test(step2) ||
        /before any tool call/i.test(step2) ||
        /no tool call/i.test(step2),
      'step 2 should make clear the heartbeat is an assistant-text line, not a tool call'
    );
  });

  test('plan-start heartbeat is inside the spawn step', () => {
    const spawnIdx = workflow.indexOf('3. **Spawn executor agents');
    const waitIdx = workflow.indexOf('4. **Wait for all agents', spawnIdx);
    assert.ok(spawnIdx !== -1 && waitIdx !== -1, 'spawn and wait steps must exist');
    const step3 = workflow.slice(spawnIdx, waitIdx);
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} starting/.test(step3),
      'plan-start heartbeat should be emitted inside step 3 (spawn executor agents)'
    );
  });

  test('plan-complete and wave-complete heartbeats are inside the wait/report steps', () => {
    const waitIdx = workflow.indexOf('4. **Wait for all agents');
    const hookIdx = workflow.indexOf('5. **Post-wave hook validation', waitIdx);
    assert.ok(waitIdx !== -1 && hookIdx !== -1, 'wait + hook steps must exist');
    const step4 = workflow.slice(waitIdx, hookIdx);
    assert.ok(
      /\[checkpoint\][^\r\n]*plan \{plan_id\} complete/.test(step4),
      'plan-complete heartbeat should be emitted in step 4 (wait for agents)'
    );

    const reportIdx = workflow.indexOf('6. **Report completion');
    const failureIdx = workflow.indexOf('7. **Handle failures', reportIdx);
    assert.ok(reportIdx !== -1 && failureIdx !== -1, 'report + failure steps must exist');
    const step6 = workflow.slice(reportIdx, failureIdx);
    assert.ok(
      /\[checkpoint\][^\r\n]*wave \{N\}\/\{M\} complete/.test(step6),
      'wave-complete heartbeat should be emitted in step 6 (report completion)'
    );
  });
});

describe('bug #2410: checkpoint heartbeat format is user-documented', () => {
  const commandsDoc = fs.readFileSync(COMMANDS_DOC_PATH, 'utf-8');

  test('COMMANDS.md documents the [checkpoint] format under /gsd-manager', () => {
    const managerIdx = commandsDoc.indexOf('### `/gsd-manager`');
    assert.ok(managerIdx !== -1, '/gsd-manager section should exist');
    const section = commandsDoc.slice(managerIdx, managerIdx + 4000);
    assert.ok(
      /\[checkpoint\]/.test(section),
      'COMMANDS.md /gsd-manager section should document [checkpoint] heartbeat markers'
    );
    assert.ok(
      /Stream idle timeout/i.test(section),
      'COMMANDS.md should explain what the heartbeats prevent'
    );
    assert.ok(
      /#2410/.test(section),
      'COMMANDS.md should reference the tracking issue'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1369-wave-stale-base.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1369-wave-stale-base (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product #1369
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1369: execute-phase worktree agents fork from stale base after
 * a wave merge advances orchestrator HEAD past origin/HEAD.
 *
 * Steps 0.5 and 7b+7c are extracted to reference files to satisfy the ADR-857 size cap.
 * execute-phase.md contains @-reference pointers; the reference files hold the content.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const WAVE_GUARD_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-wave-guard.md');
const BETWEEN_WAVE_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-between-wave-reset.md');

describe('execute-phase: inter-wave worktree base re-check (#1369)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('wave-guard reference file exists', () => {
    assert.ok(fs.existsSync(WAVE_GUARD_PATH), 'references/execute-phase-wave-guard.md should exist');
  });

  test('workflow contains @-reference pointer to wave-guard (step 0.5 injected at runtime)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-wave-guard.md'),
      'execute-phase.md must have an @-reference to execute-phase-wave-guard.md'
    );
  });

  test('workflow contains step 0.5 inter-wave base re-check section', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('0.5.') && content.includes('Inter-wave worktree base re-check'),
      'execute-phase-wave-guard.md must have step 0.5 "Inter-wave worktree base re-check"'
    );
  });

  test('step 0.5 references #1369', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 0.5 must reference #1369 for traceability');
  });

  test('step 0.5 runs worktree.base-check inside the For-each-wave loop', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    assert.ok(forEachIdx !== -1, '"For each wave:" section must exist in execute-phase.md');
    assert.ok(refIdx !== -1, '@-reference to wave-guard must exist in execute-phase.md');
    assert.ok(refIdx > forEachIdx, 'wave-guard @-reference must appear AFTER "For each wave:" so step 0.5 runs per-wave');
  });

  test('step 0.5 runs worktree.base-check command', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('worktree.base-check'), 'step 0.5 must invoke worktree.base-check');
  });

  test('step 0.5 sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('USE_WORKTREES=false'), 'step 0.5 must override USE_WORKTREES=false when base divergence is detected');
  });

  test('step 0.5 appears before step 1 (intra-wave overlap check)', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    const step1Idx = workflow.indexOf('1. **Intra-wave', forEachIdx);
    assert.ok(refIdx !== -1, 'wave-guard @-reference must exist');
    assert.ok(step1Idx !== -1, 'step 1 (intra-wave overlap check) must exist');
    assert.ok(refIdx < step1Idx, 'wave-guard @-reference must appear before step 1');
  });

  test('step 0.5 guards on RUNTIME=claude (worktree isolation is Claude Code-specific)', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('RUNTIME') && (content.includes('"claude"') || content.includes("'claude'")),
      'step 0.5 must guard on RUNTIME=claude'
    );
  });

  test('step 0.5 explains root cause: wave merges advance HEAD past origin/HEAD', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('origin/HEAD'), 'step 0.5 must name origin/HEAD as the stale fork base');
  });

  test('step 0.5 cross-references #683 for worktree.baseRef configuration', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#683'), 'step 0.5 must cross-reference #683');
  });

  test('step 0.5 mentions worktree.baseRef:"head" as permanent fix', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('worktree.baseRef') && content.includes('head'),
      'step 0.5 must mention worktree.baseRef:"head"'
    );
  });
});

describe('execute-phase: between-wave manifest reset (#1369, #3384)', () => {
  test('between-wave reference file exists', () => {
    assert.ok(fs.existsSync(BETWEEN_WAVE_PATH), 'references/execute-phase-between-wave-reset.md should exist');
  });

  test('workflow contains @-reference pointer to between-wave-reset', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-between-wave-reset.md'),
      'execute-phase.md must have an @-reference to execute-phase-between-wave-reset.md'
    );
  });

  test('step 7c exists with between-wave manifest reset (#1369)', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('7c.') && content.includes('Between-wave manifest reset'),
      'execute-phase-between-wave-reset.md must have step 7c "Between-wave manifest reset"'
    );
  });

  test('step 7c unsets WAVE_WORKTREE_MANIFEST between waves', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('unset WAVE_WORKTREE_MANIFEST'), 'step 7c must unset WAVE_WORKTREE_MANIFEST');
  });

  test('step 7c references #1369 and #3384 for traceability', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 7c must reference #1369');
    assert.ok(content.includes('#3384'), 'step 7c must reference #3384');
  });

  test('step 7c calls worktree.set-baseref to re-assert head config', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('worktree.set-baseref'), 'step 7c must call worktree.set-baseref');
  });

  test('step 7c appears after step 7b and before step 8 in the wave loop', () => {
    const ref = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const idx7b = ref.indexOf('7b.');
    const idx7c = ref.indexOf('7c.');
    const refPtr = workflow.indexOf('execute-phase-between-wave-reset.md');
    const idx8 = workflow.indexOf('8. **Execute checkpoint', refPtr);
    assert.ok(idx7b !== -1, 'step 7b must exist in between-wave reference file');
    assert.ok(idx7c !== -1, 'step 7c must exist in between-wave reference file');
    assert.ok(idx8 !== -1, 'step 8 must exist in execute-phase.md after the between-wave @-reference');
    assert.ok(idx7b < idx7c, 'step 7c must appear after step 7b');
    assert.ok(refPtr < idx8, 'between-wave @-reference must appear before step 8');
  });

  test('step 7c guards on RUNTIME=claude for worktree-specific operations', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('RUNTIME') && (content.includes('"claude"') || content.includes("'claude'")),
      'step 7c must guard on RUNTIME=claude'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3096-ai-integration-phase-parallel-race.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3096-ai-integration-phase-parallel-race (consolidation epic #1969 B4 #1973)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #3096)
// Reads product workflow markdown (ai-integration-phase.md) to verify
// structural ordering contract.

// Regression guard for bug #3096.
//
// ai-integration-phase.md listed Steps 7+8 (gsd-ai-researcher +
// gsd-domain-researcher) without an explicit sequential ordering constraint.
// An orchestrator optimizing for speed could reasonably parallelize them
// since the sections appeared disjoint. When parallelized, gsd-domain-researcher's
// Write call at finalization replaced the whole AI-SPEC.md file with its
// in-memory copy (pre-researcher state), silently overwriting Sections 3/4.
//
// Confirmed at 40% incidence rate on a real run (2 of 5 worktree agents hit it).
// Recovery cost: one extra ai-researcher dispatch (~18 min wall).
//
// Fix:
//   1. Explicit "MUST run sequentially" note on Steps 7 and 8
//   2. Edit-only tool discipline injected into both agent prompts

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'ai-integration-phase.md'),
  'utf8',
);

describe('bug #3096: ai-integration-phase sequential ordering and Edit-only discipline', () => {
  test('Step 7 documents sequential ordering requirement', () => {
    assert.ok(
      src.includes('sequentially') || src.includes('sequential'),
      'Steps 7+8 ordering note is missing — parallel dispatch race can recur',
    );
  });

  test('Step 7 gsd-ai-researcher prompt includes Edit-only tool discipline', () => {
    // The discipline block must appear before </objective> for gsd-ai-researcher
    const step7Idx = src.indexOf('## 7. Spawn gsd-ai-researcher');
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    assert.ok(step7Idx !== -1, 'Step 7 not found');
    assert.ok(step8Idx !== -1, 'Step 8 not found');
    const step7Block = src.slice(step7Idx, step8Idx);
    assert.ok(
      step7Block.includes('Edit tool') && step7Block.includes('NEVER use Write'),
      'Step 7 agent prompt missing Edit-only tool discipline',
    );
  });

  test('Step 8 gsd-domain-researcher prompt includes Edit-only tool discipline', () => {
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    const step9Idx = src.indexOf('## 9. Spawn gsd-eval-planner');
    assert.ok(step8Idx !== -1, 'Step 8 not found');
    assert.ok(step9Idx !== -1, 'Step 9 not found');
    const step8Block = src.slice(step8Idx, step9Idx);
    assert.ok(
      step8Block.includes('Edit tool') && step8Block.includes('NEVER use Write'),
      'Step 8 agent prompt missing Edit-only tool discipline',
    );
  });

  test('Step 8 references the wait instruction', () => {
    const step8Idx = src.indexOf('## 8. Spawn gsd-domain-researcher');
    const step9Idx = src.indexOf('## 9. Spawn gsd-eval-planner');
    const step8Block = src.slice(step8Idx, step9Idx);
    assert.ok(
      step8Block.includes('Wait') || step8Block.includes('wait') || step8Block.includes('complete'),
      'Step 8 does not instruct orchestrator to wait for Step 7',
    );
  });
});
  });
}

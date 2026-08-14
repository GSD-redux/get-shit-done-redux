// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Execute-phase worktree shared artifact ownership tests
 *
 * Guards against bug #1571: worktree executor agents independently writing
 * STATE.md and ROADMAP.md, causing last-merge-wins overwrites.
 *
 * Fix: In parallel worktree mode, remove STATE.md/ROADMAP.md update requirements
 * from the executor agent success_criteria. The orchestrator owns those writes
 * after each wave via single-writer post-wave commands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const QUICK_WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
const RECOVERY_POLICY_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase',
  'steps',
  'worktree-recovery-policy.md'
);

describe('execute-phase worktree: shared artifact ownership (#1571)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('worktree executor agent success_criteria does NOT include STATE.md update', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

    // Extract the worktree Task() block (between "Worktree mode" and "Sequential mode")
    const worktreeMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      /\*\*Worktree mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/
    );
    assert.ok(worktreeMatch, 'should find success_criteria inside the worktree mode Task block');

    const criteria = worktreeMatch[1];
    assert.ok(
      !criteria.includes('STATE.md'),
      'worktree executor success_criteria must NOT reference STATE.md (orchestrator owns this write)'
    );
  });

  test('worktree executor agent success_criteria does NOT include ROADMAP.md update', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

    // Extract the worktree Task() block
    const worktreeMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      /\*\*Worktree mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/
    );
    assert.ok(worktreeMatch, 'should find success_criteria inside the worktree mode Task block');

    const criteria = worktreeMatch[1];
    assert.ok(
      !criteria.includes('ROADMAP.md'),
      'worktree executor success_criteria must NOT reference ROADMAP.md (orchestrator owns this write)'
    );
  });

  test('worktree executor agent success_criteria includes SUMMARY.md creation', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

    // SUMMARY.md is plan-local and safe for worktree agents to create
    const worktreeMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      /\*\*Worktree mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/
    );
    assert.ok(worktreeMatch, 'should find success_criteria inside the worktree mode Task block');

    const criteria = worktreeMatch[1];
    assert.ok(
      criteria.includes('SUMMARY.md'),
      'worktree executor success_criteria should still require SUMMARY.md creation'
    );
  });

  test('post-wave orchestrator runs roadmap update-plan-progress for each completed plan', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('roadmap update-plan-progress'),
      'post-wave section should contain orchestrator-owned roadmap update-plan-progress command'
    );
    // Confirm it is in a post-wave context, not only inside an agent prompt
    const postWaveIdx = content.indexOf('roadmap update-plan-progress');
    const worktreeAgentStart = content.indexOf('isolation="worktree"');
    const worktreeAgentEnd = content.indexOf('**Sequential mode**');
    assert.ok(
      postWaveIdx < worktreeAgentStart || postWaveIdx > worktreeAgentEnd,
      'roadmap update-plan-progress must appear outside the worktree agent prompt (orchestrator-owned)'
    );
  });

  test('ghost state update-position command removed from post-wave section (#1627)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      !content.includes('state update-position'),
      'state update-position was a ghost reference (command never existed in CLI dispatcher) — should be removed'
    );
  });

  test('sequential mode executor agent success_criteria still includes STATE.md update', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

    // Extract the sequential mode Task() block
    const seqMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      /\*\*Sequential mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/
    );
    assert.ok(seqMatch, 'should find success_criteria inside the sequential mode Task block');

    const criteria = seqMatch[1];
    assert.ok(
      criteria.includes('STATE.md'),
      'sequential executor success_criteria should still require STATE.md update (no conflict risk)'
    );
  });

  test('sequential mode executor agent success_criteria still includes ROADMAP.md update', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

    // Extract the sequential mode Task() block
    const seqMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
      /\*\*Sequential mode\*\*[\s\S]*?<success_criteria>([\s\S]*?)<\/success_criteria>/
    );
    assert.ok(seqMatch, 'should find success_criteria inside the sequential mode Task block');

    const criteria = seqMatch[1];
    assert.ok(
      criteria.includes('ROADMAP.md'),
      'sequential executor success_criteria should still require ROADMAP.md update (no conflict risk)'
    );
  });
});

describe('isolated-run recovery fail-safe (#1292)', () => {
  test('worktree-recovery-policy.md fragment exists', () => {
    assert.ok(
      fs.existsSync(RECOVERY_POLICY_PATH),
      'execute-phase/steps/worktree-recovery-policy.md must exist (ADR-857 extraction pattern)'
    );
  });

  test('execute-phase.md references the worktree-recovery-policy.md fragment', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase/steps/worktree-recovery-policy.md'),
      'execute-phase.md must reference the extracted worktree-recovery-policy.md fragment'
    );
    assert.ok(
      content.includes('#1292'),
      'execute-phase.md must reference #1292 in the worktree recovery policy pointer'
    );
  });

  test('worktree-recovery-policy.md fragment contains ISOLATED-RUN RECOVERY guardrail referencing #1292', () => {
    const content = fs.readFileSync(RECOVERY_POLICY_PATH, 'utf-8');
    assert.ok(
      content.includes('ISOLATED-RUN RECOVERY'),
      'worktree-recovery-policy.md must contain the ISOLATED-RUN RECOVERY guardrail label'
    );
    assert.ok(
      content.includes('#1292'),
      'worktree-recovery-policy.md ISOLATED-RUN RECOVERY guardrail must reference #1292'
    );
  });

  test('worktree-recovery-policy.md fragment forbids defaulting recovery to main/primary checkout', () => {
    const content = fs.readFileSync(RECOVERY_POLICY_PATH, 'utf-8');
    assert.ok(
      content.includes('never the proposed or default'),
      'worktree-recovery-policy.md guardrail must state editing main is "never the proposed or default" option'
    );
  });

  test('worktree-recovery-policy.md fragment offers fresh narrowly-scoped worktree as recovery path', () => {
    const content = fs.readFileSync(RECOVERY_POLICY_PATH, 'utf-8');
    assert.ok(
      content.includes('fresh, narrowly-scoped worktree'),
      'worktree-recovery-policy.md guardrail must offer a "fresh, narrowly-scoped worktree" as recovery path'
    );
  });

  test('worktree-recovery-policy.md fragment requires explicit confirmation before editing primary checkout', () => {
    const content = fs.readFileSync(RECOVERY_POLICY_PATH, 'utf-8');
    assert.ok(
      content.includes('explicit, clearly-labeled confirmation'),
      'worktree-recovery-policy.md guardrail must require "explicit, clearly-labeled confirmation" before editing the primary checkout'
    );
  });

  test('worktree-recovery-policy.md fragment contains FAIL-CLOSED rule (#48) with exit-42 content', () => {
    const content = fs.readFileSync(RECOVERY_POLICY_PATH, 'utf-8');
    assert.ok(
      content.includes('worktree_branch_check'),
      'worktree-recovery-policy.md must contain "worktree_branch_check" from the FAIL-CLOSED rule (#48)'
    );
    assert.ok(
      content.includes('42'),
      'worktree-recovery-policy.md must contain "42" (exit 42) from the FAIL-CLOSED rule (#48)'
    );
  });

  test('execute-phase.md step 5.5 decline/over-reach sentence references fragment and forbids main-default', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('declines to merge a worktree'),
      'execute-phase.md step 5.5 pointer must mention "declines to merge a worktree" as the trigger for fail-safe policy'
    );
    assert.ok(
      content.includes('never default to editing'),
      'execute-phase.md step 5.5 pointer must state "never default to editing" main'
    );
  });

  test('quick.md contains ISOLATED-RUN RECOVERY guardrail referencing #1292', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('ISOLATED-RUN RECOVERY'),
      'quick.md must contain the ISOLATED-RUN RECOVERY guardrail label'
    );
    assert.ok(
      content.includes('#1292'),
      'quick.md ISOLATED-RUN RECOVERY guardrail must reference #1292'
    );
  });

  test('quick.md guardrail forbids defaulting recovery to main/primary checkout', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('never the proposed or default'),
      'quick.md guardrail must state editing main is "never the proposed or default" option'
    );
  });

  test('quick.md guardrail offers fresh narrowly-scoped worktree as recovery path', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('fresh, narrowly-scoped worktree'),
      'quick.md guardrail must offer a "fresh, narrowly-scoped worktree" as recovery path'
    );
  });

  test('quick.md guardrail requires explicit confirmation before editing primary checkout', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('explicit, clearly-labeled confirmation'),
      'quick.md guardrail must require "explicit, clearly-labeled confirmation" before editing the primary checkout'
    );
  });
});

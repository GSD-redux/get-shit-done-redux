// allow-test-rule: source-text-is-the-product #2649
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception
// matrix. Mirrors tests/fix-1941-quick-worktree-stale-base.test.cjs.

/**
 * Regression tests for bug #2649: /gsd-verify-work's UAT-gap diagnosis step
 * (workflows/diagnose-issues.md) and execute-phase's single-plan interactive
 * dispatch (workflows/execute-plan.md Pattern A) spawn worktree-isolated
 * subagents without first checking whether the harness's worktree fork base has
 * diverged from live local HEAD — unlike every other worktree-dispatch site.
 *
 * Root cause: Claude Code's isolation="worktree" forks new worktrees from
 * origin/HEAD, not the live local HEAD. When local commits advance HEAD without
 * an intervening `git push` (the documented GSD steady state), origin/HEAD is
 * pinned to a stale ancestor and the subagent's worktree_branch_check guard
 * halts with a base-mismatch fatal mid-investigation, with no auto-degrade. The
 * fix ports the worktree.base-check auto-degrade pattern (execute-phase #683/
 * #1369, quick #1941) into these two not-yet-covered dispatch sites.
 *
 * The triage for #2649 found execute-plan.md's Pattern A has the identical gap;
 * per the bug's acceptance criterion 5 it is fixed in the same change (same bug
 * class, same one-line gate) rather than filed as a separate follow-up.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIAGNOSE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');

describe('diagnose-issues: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(DIAGNOSE_PATH), 'workflows/diagnose-issues.md should exist');
  });

  test('spawn_agents step runs worktree.base-check before the Agent() dispatch', () => {
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist in diagnose-issues.md');
    const baseCheckIdx = content.indexOf('worktree.base-check', spawnIdx);
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within the spawn_agents step');
    // The load-bearing invariant is "base-check BEFORE the Agent() dispatch" so the
    // degrade decision can drop isolation from the spawn. (Where EXPECTED_BASE is
    // captured relative to the check is cosmetic — the check only reads HEAD, never
    // mutates it — so assert the real invariant, not a loose disjunction.)
    const agentIdx = content.indexOf('Agent(', spawnIdx);
    assert.ok(agentIdx !== -1, 'spawn_agents must contain an Agent() dispatch');
    assert.ok(
      baseCheckIdx < agentIdx,
      'worktree.base-check must run before the Agent() dispatch so the degrade decision can drop isolation from the spawn',
    );
  });

  test('verify-only worktree_branch_check backstop remains embedded in the Agent() prompt', () => {
    // Acceptance criterion #4: the base-check is a PRE-DISPATCH degrade; the
    // <worktree_branch_check> guard is a POST-FORK fail-closed backstop. Both
    // layers must survive — a future edit that dropped the backstop embedding
    // would re-open the silent-stale-base class. Guard its continued presence.
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist');
    assert.ok(
      content.indexOf('worktree-branch-check.md', spawnIdx) !== -1,
      'spawn_agents must still materialize the <worktree_branch_check> backstop after the base-check gate (#2649 acceptance criterion 4)',
    );
  });

  test('degrade check sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 600);
    assert.ok(
      block.includes('shouldDegrade') && block.includes('USE_WORKTREES=false'),
      'degrade check must override USE_WORKTREES=false when shouldDegrade is true',
    );
  });

  test('degrade check references #2649 for traceability', () => {
    const content = fs.readFileSync(DIAGNOSE_PATH, 'utf-8');
    assert.ok(content.includes('#2649'), 'diagnose-issues.md must reference #2649');
  });
});

describe('execute-plan Pattern A: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PLAN_PATH), 'workflows/execute-plan.md should exist');
  });

  test('Pattern A runs the worktree base-check before spawning the executor', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    assert.ok(patternAIdx !== -1, '"Pattern A:" must exist in execute-plan.md');
    // The base-check instruction must appear within the Pattern A description,
    // before the isolation="worktree" embedding instruction.
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      patternA.includes('#2649') && /worktree\.base-check|base-check/.test(patternA),
      'Pattern A must run the #2649 worktree base-check before dispatching the executor',
    );
    assert.ok(
      patternA.includes('shouldDegrade'),
      'Pattern A base-check must consult shouldDegrade',
    );
  });

  test('Pattern A documents the auto-degrade (drop isolation on shouldDegrade)', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      /degrad|sequential/i.test(patternA),
      'Pattern A must document auto-degrading to sequential mode when shouldDegrade is true',
    );
  });
});

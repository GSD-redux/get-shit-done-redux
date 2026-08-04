/**
 * GSD Quick Workflow — Commit Boundary Tests (#1503)
 *
 * Validates that the quick workflow correctly separates executor
 * responsibilities (code commits) from orchestrator responsibilities
 * (docs artifact commit), preventing PLAN.md from being left untracked
 * when the executor runs without worktree isolation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

describe('quick workflow commit boundary (#1503)', () => {
  const quickPath = path.join(WORKFLOWS_DIR, 'quick.md');
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(quickPath), 'workflows/quick.md should exist');
    content = fs.readFileSync(quickPath, 'utf-8');
  });

  test('executor constraints prohibit committing docs artifacts', () => {
    assert.ok(
      content.includes('Do NOT commit docs artifacts'),
      'executor constraints should prohibit committing SUMMARY.md, STATE.md, PLAN.md'
    );
  });

  test('Step 8 explicitly stages artifacts with git add before commit', () => {
    assert.ok(
      content.includes('git add ${file_list}'),
      'Step 8 should explicitly git add the file list before gsd-tools commit'
    );
  });

  test('Step 8 includes PLAN.md in file list', () => {
    assert.ok(
      content.includes('${QUICK_DIR}/${quick_id}-PLAN.md'),
      'Step 8 file list must include PLAN.md'
    );
  });

  test('Step 8 runs unconditionally', () => {
    assert.ok(
      content.includes('MUST always run'),
      'Step 8 should state it must always run regardless of executor commits'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2432-quick-plan-predispatch-commit.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2432-quick-plan-predispatch-commit (consolidation epic #1969 B4 #1973)", () => {
/**
 * Bug #2432: quick.md PLAN.md timing — worktree executor can't read PLAN.md
 *
 * The orchestrator must commit PLAN.md to the base branch BEFORE spawning the
 * worktree-isolated executor. Without this, the executor's first Read resolves
 * to a main-repo absolute path (not a worktree path), which primes CC's path
 * cache and causes subsequent Edit/Write calls to silently target the main repo
 * instead of the worktree (CC issue #36182 amplifier).
 *
 * Fix: Step 5.6 commits PLAN.md pre-dispatch when USE_WORKTREES is active.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
const REPO_ROOT_FOR_SECTIONS = path.join(__dirname, '..');

/**
 * #2994 fragmentization moved Steps 4.5/4.75/5.5/5.6/6.5 out of quick.md into
 * gsd-core/workflows/quick/steps/*.md behind section markers. A plain
 * `content.indexOf('Step 5.6')` against the host now matches an unrelated
 * later CROSS-REFERENCE to "Step 5.6" (a mention inside the worktree-branch
 * guard prose), not the real heading — silently vacuous, since that
 * mis-anchored slice still happens to contain USE_WORKTREES/commit_docs/
 * PLAN.md/git add/git commit substrings from unrelated surrounding text.
 * Expand each `<!-- gsd:section id="X" ... -->...<!-- /gsd:section -->`
 * marker IN PLACE with its step file's content so Step 5.5/5.6/6/6.5 land
 * back at their original logical positions and ordering/slicing assertions
 * see the real step bodies again.
 */
function expandWorkflowSections(workflowPath) {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const markerRe = /<!-- gsd:section id="[\w-]+" when="[^"]*" -->[\s\S]*?<!-- \/gsd:section -->/g;
  return raw.replace(markerRe, (block) => {
    const pathMatch = block.match(/`([^`]+\.md)`/);
    if (!pathMatch) return block;
    const stepPath = path.join(REPO_ROOT_FOR_SECTIONS, pathMatch[1]);
    if (!fs.existsSync(stepPath)) return block;
    return fs.readFileSync(stepPath, 'utf8');
  });
}

describe('quick.md pre-dispatch PLAN.md commit (#2432)', () => {
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(QUICK_MD), 'gsd-core/workflows/quick.md must exist');
    content = expandWorkflowSections(QUICK_MD);
  });

  test('Step 5.6 exists between Step 5.5 and Step 6', () => {
    const step55 = content.indexOf('Step 5.5');
    const step56 = content.indexOf('Step 5.6');
    const step6  = content.indexOf('Step 6:');
    assert.ok(step55 !== -1, 'Step 5.5 must exist');
    assert.ok(step56 !== -1, 'Step 5.6 must exist');
    assert.ok(step6  !== -1, 'Step 6 must exist');
    assert.ok(step56 > step55, 'Step 5.6 must appear after Step 5.5');
    assert.ok(step56 < step6,  'Step 5.6 must appear before Step 6');
  });

  test('Step 5.6 is gated on USE_WORKTREES', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('USE_WORKTREES'),
      'Step 5.6 must be gated on USE_WORKTREES — only commit pre-dispatch in worktree mode'
    );
  });

  test('Step 5.6 is gated on commit_docs', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('commit_docs'),
      'Step 5.6 must respect commit_docs config — skip pre-dispatch commit when commit_docs is false'
    );
  });

  test('Step 5.6 stages and commits PLAN.md', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('PLAN.md'),
      'Step 5.6 must reference PLAN.md in the pre-dispatch commit'
    );
    assert.ok(
      step56Block.includes('git add') || step56Block.includes('git commit'),
      'Step 5.6 must include git add/commit to stage and commit PLAN.md'
    );
  });

  test('Step 5.6 uses --no-verify to avoid hook interference', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('--no-verify'),
      'Step 5.6 pre-dispatch commit must use --no-verify to avoid hook interference'
    );
  });

  test('executor prompt references PLAN.md via relative (worktree-rooted) path', () => {
    // QUICK_DIR is always set to ".planning/quick/..." (relative) so ${QUICK_DIR}/...PLAN.md
    // resolves relative to the worktree root, not the main repo absolute path.
    // Verify the executor prompt uses QUICK_DIR variable (not a hardcoded absolute path).
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    // Find the files_to_read block near the executor spawn
    const filesBlock = content.lastIndexOf('<files_to_read>', executorTask);
    const filesBlockEnd = content.indexOf('</files_to_read>', filesBlock);
    const filesContent = content.slice(filesBlock, filesBlockEnd);
    assert.ok(
      filesContent.includes('QUICK_DIR') || filesContent.includes('.planning/quick'),
      'executor files_to_read must reference PLAN.md via relative QUICK_DIR path'
    );
    assert.ok(
      !filesContent.match(/\/home\/|\/Users\/|\/root\//),
      'executor files_to_read must NOT contain hardcoded absolute paths'
    );
  });

  test('#1265 records both parent base and plan commit for worktree dispatch', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    const step6Block = content.slice(step6Start, content.indexOf('After executor returns:', step6Start));

    assert.ok(
      step56Block.includes('QUICK_PLAN_PARENT'),
      'quick worktree mode must record the pre-dispatch parent SHA before committing PLAN.md (#1265)'
    );
    assert.ok(
      step56Block.includes('QUICK_PLAN_COMMIT'),
      'quick worktree mode must record the PLAN.md commit SHA after the pre-dispatch commit (#1265)'
    );
    assert.ok(
      step6Block.includes('EXPECTED_BASE_ALTERNATE'),
      'executor guard embed must carry the alternate accepted base for parent-vs-plan worktree forks (#1265)'
    );
  });

  test('#1265 executor materializes PLAN.md from the plan commit when worktree starts at parent', () => {
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    const promptStart = content.lastIndexOf('prompt="', executorTask);
    const promptEnd = content.indexOf('subagent_type="gsd-executor"', promptStart);
    const executorPrompt = content.slice(promptStart, promptEnd);

    assert.ok(
      executorPrompt.includes('git show') && executorPrompt.includes('QUICK_PLAN_COMMIT'),
      'executor prompt must materialize PLAN.md from git show <plan-commit>:<plan-path> when absent (#1265)'
    );
    assert.ok(
      executorPrompt.indexOf('git show') < executorPrompt.indexOf('<files_to_read>'),
      'PLAN.md materialization must be a first action before files_to_read can prime paths (#1265)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2523-quick-deferred-items.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2523-quick-deferred-items (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression test for bug #2523
 *
 * workflows/quick.md Step 8 ("Build file list") listed PLAN.md, SUMMARY.md,
 * STATE.md, and mode-conditional CONTEXT.md / RESEARCH.md / VERIFICATION.md —
 * but omitted deferred-items.md. When an executor logs out-of-scope findings
 * to ${QUICK_DIR}/${quick_id}-deferred-items.md during task execution, that
 * file was left untracked after the final commit even with commit_docs: true.
 *
 * Fix: add a file-existence-gated entry for deferred-items.md to Step 8.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('bug #2523: quick-task final commit includes deferred-items.md', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'gsd-core/workflows/quick.md must exist');
  });

  test('Step 8 file list references deferred-items.md', () => {
    const step8Idx = content.indexOf('Step 8: Final commit');
    assert.notEqual(step8Idx, -1, 'Step 8 section must exist in quick.md');

    const step8Section = content.slice(step8Idx, step8Idx + 2000);
    assert.ok(
      step8Section.includes('deferred-items.md'),
      'Step 8 file list must include deferred-items.md. ' +
      'Without this, any out-of-scope findings logged by the executor to ' +
      '${QUICK_DIR}/${quick_id}-deferred-items.md are left untracked after commit (bug #2523).'
    );
  });

  test('deferred-items.md entry is conditional on file existence', () => {
    const deferredIdx = content.indexOf('deferred-items.md');
    assert.notEqual(deferredIdx, -1, 'deferred-items.md must be mentioned in the workflow');

    const surroundingContext = content.slice(Math.max(0, deferredIdx - 200), deferredIdx + 200);
    const isConditional =
      surroundingContext.toLowerCase().includes('exist') ||
      surroundingContext.toLowerCase().includes('if ');
    assert.ok(
      isConditional,
      'The deferred-items.md entry must be gated on file existence (not a mode flag). ' +
      'deferred-items.md can be created in any quick-task run, regardless of mode.'
    );
  });
});
  });
}

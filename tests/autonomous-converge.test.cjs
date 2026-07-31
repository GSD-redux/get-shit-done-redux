// allow-test-rule: source-text-is-the-product
// The autonomous command and workflow markdown are runtime-loaded contracts.
// Checking their text verifies the shipped slash-command behavior.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'gsd', 'autonomous.md');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'autonomous.md');
const COMMANDS_DOC_PATH = path.join(REPO_ROOT, 'docs', 'COMMANDS.md');
const HOW_TO_PATH = path.join(REPO_ROOT, 'docs', 'how-to', 'run-phases-autonomously.md');
const TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('autonomous --converge flag (#711)', () => {
  test('command advertises --converge and documents --cross-ai as alias', () => {
    const command = read(COMMAND_PATH);

    assert.match(
      command,
      /^argument-hint:.*--converge/m,
      'autonomous command should advertise --converge in argument-hint',
    );
    assert.match(command, /--cross-ai/, 'autonomous command should document --cross-ai alias');
    assert.match(
      command,
      /workflow\.plan_review_convergence=true/,
      'autonomous command should mention the existing convergence feature gate',
    );
  });

  test('workflow parses converge aliases into a plan strategy', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(workflow, /PLAN_STRATEGY="local"/, 'workflow should default to local planning');
    assert.match(workflow, /PLAN_STRATEGY="converge"/, 'workflow should opt into converge planning');
    assert.match(workflow, /converge\|cross-ai/, 'workflow should accept --converge and --cross-ai');
  });

  test('workflow fails fast when convergence is requested but disabled', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /config-get workflow\.plan_review_convergence/,
      'workflow should check workflow.plan_review_convergence before planning',
    );
    assert.match(
      workflow,
      /gsd config-set workflow\.plan_review_convergence true/,
      'workflow should print the enable command instead of silently downgrading',
    );
  });

  test('workflow routes planning through plan-review-convergence when enabled', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /Skill\(skill="gsd-plan-review-convergence", args="\$\{PHASE_NUM\} \$\{CONVERGENCE_ARGS\}"\)/,
      'non-interactive converge mode should call gsd-plan-review-convergence',
    );
    assert.match(
      workflow,
      /Run plan convergence for phase \$\{PHASE_NUM\}: Skill\(skill=\\"gsd-plan-review-convergence\\"/,
      'interactive converge mode should dispatch plan convergence in the background agent',
    );
    assert.match(
      workflow,
      /Skill\(skill="gsd-plan-phase", args="\$\{PHASE_NUM\}"\)/,
      'local planning path should remain available for default autonomous runs',
    );
  });

  test('workflow forwards reviewer flags and max cycles to convergence', () => {
    const workflow = read(WORKFLOW_PATH);
    // Non-lane convergence controls remain hand-written literals in the workflow.
    const convergenceControls = ['--all', '--text'];
    // Reviewer lane flags that were formerly hand-enumerated in the workflow text.
    // They must now be DERIVED at runtime via `gsd_run review-lane flags`, not listed.
    const formerlyHardcodedLaneFlags = [
      '--codex',
      '--gemini',
      '--claude',
      '--opencode',
      '--ollama',
      '--lm-studio',
      '--llama-cpp',
    ];
    // The literal-absence guard below excludes '--claude': the runtime-launcher
    // preamble legitimately contains an unrelated "npx ... --claude --local"
    // install-runtime flag, so a substring match on '--claude' would false-positive
    // against that literal, not against a re-added reviewer-flag list.
    const antiParityLaneFlags = formerlyHardcodedLaneFlags.filter((flag) => flag !== '--claude');

    assert.match(workflow, /CONVERGENCE_ARGS/, 'workflow should build convergence pass-through args');
    assert.match(
      workflow,
      /gsd_run review-lane flags/,
      'workflow should derive reviewer flags from the review-lane roster instead of hand-listing them',
    );
    for (const flag of convergenceControls) {
      assert.ok(workflow.includes(flag), `workflow should pass through ${flag}`);
    }
    assert.match(workflow, /--max-cycles/, 'workflow should pass through --max-cycles N');

    // Anti-parity guard (deliberately inverted polarity): the whole point of the
    // review-lane-flags derivation is that reviewer lane flags are declared ONCE
    // (in the review-lane roster) and never hand-listed again in workflow prose.
    // If a future edit re-adds a hardcoded reviewer-flag list here, that is the
    // regression this test exists to catch — so this assertion must FAIL when
    // any of these flags reappear as literals in the workflow text.
    for (const flag of antiParityLaneFlags) {
      assert.ok(
        !workflow.includes(flag),
        `workflow should NOT hand-enumerate reviewer lane flag ${flag}; it must be derived via review-lane flags`,
      );
    }

    // Behavioral coverage: prove the roster the workflow derives from actually
    // yields the flags this test used to hardcode, so the derivation is not vacuous.
    const laneFlags = cp
      .execFileSync(process.execPath, [TOOLS, 'review-lane', 'flags'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const flag of formerlyHardcodedLaneFlags) {
      assert.ok(laneFlags.includes(flag), `review-lane flags should include ${flag}`);
    }
  });

  test('docs show autonomous convergence usage', () => {
    const commandsDoc = read(COMMANDS_DOC_PATH);
    const howTo = read(HOW_TO_PATH);

    assert.match(commandsDoc, /--converge/, 'COMMANDS.md should document --converge');
    assert.match(commandsDoc, /--cross-ai/, 'COMMANDS.md should document --cross-ai alias');
    assert.match(howTo, /\/gsd-autonomous --only 4 --converge/, 'how-to should show single-phase converge usage');
  });
});

describe('autonomous verification deferral contract', () => {
  test('workflow records explicit deferred states instead of silently advancing (#1525)', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(workflow, /verification_deferred_human/);
    assert.match(workflow, /verification_deferred_gaps/);
    assert.match(workflow, /Deferred Verification/);
    assert.match(workflow, /gsd:verify-work \$\{PHASE_NUM\}/);
    assert.match(workflow, /gsd:plan-phase \$\{PHASE_NUM\} --gaps/);
    assert.match(
      workflow,
      /\| \$\{PHASE_NUM\} \| verification_deferred_human \| \/gsd:verify-work \$\{PHASE_NUM\} \|/,
      'human deferral must persist the exact deferred STATE row',
    );
    assert.match(
      workflow,
      /\| \$\{PHASE_NUM\} \| verification_deferred_gaps \| \/gsd:plan-phase \$\{PHASE_NUM\} --gaps \|/,
      'gap deferral must persist the exact deferred STATE row',
    );
    assert.doesNotMatch(
      workflow,
      /Human validation deferred` and proceed to iterate step/,
      'human-needed deferral must not silently proceed to the next phase',
    );
    assert.doesNotMatch(
      workflow,
      /Gaps deferred` and proceed to iterate step/,
      'gap deferral must not silently proceed to the next phase',
    );
    assert.match(
      workflow,
      /Skip deferred phases on autonomous re-entry/,
      'reruns must explicitly skip deferred verification phases',
    );
    assert.match(
      workflow,
      /Deferred Verification \(Skipped on Re-entry\)/,
      'workflow should surface skipped deferred phases and their resume commands',
    );
  });

  test('workflow runs normal transition post-processing after passed verification (#1526)', () => {
    const workflow = read(WORKFLOW_PATH);
    const passedIdx = workflow.indexOf('**If `passed`:**');
    const transitionIdx = workflow.indexOf('transition.md', passedIdx);
    const iterateIdx = workflow.indexOf('Proceed to iterate step', passedIdx);

    assert.ok(transitionIdx > passedIdx, 'passed verification must invoke transition.md');
    assert.ok(
      transitionIdx < iterateIdx,
      'normal transition post-processing must run before autonomous iterates',
    );
  });

  test('workflow reads canonical verification status before human-needed promotion (#1522)', () => {
    const workflow = read(WORKFLOW_PATH);
    const waitIdx = workflow.indexOf('After execute, read canonical verification');
    const humanNeededIdx = workflow.indexOf('**If `human_needed`:**', waitIdx);
    const promoteIdx = workflow.indexOf('set VERIFICATION frontmatter `status: passed`', humanNeededIdx);
    const section = workflow.slice(waitIdx, humanNeededIdx);

    assert.ok(waitIdx !== -1, 'workflow must document the post-execution verification read');
    assert.ok(humanNeededIdx > waitIdx, 'human_needed branch must follow verification status read');
    assert.ok(promoteIdx > humanNeededIdx, 'human_needed branch must contain the promotion action');
    // #2589: the verification read uses the native --pick flag (no jq dependency).
    // String-based check (not a regex literal) so the assertion stays robust to
    // shell metacharacters in the snippet and parses cleanly under espree.
    assert.ok(
      section.includes('VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null || true)'),
      'autonomous must route human validation through canonical verification.status via the native --pick flag',
    );
    assert.doesNotMatch(
      section,
      /grep "\^status:"/,
      'autonomous must not route stale human_needed reports from raw frontmatter',
    );
  });

  test('workflow discovers incomplete phases from canonical verification projection (#1522)', () => {
    const workflow = read(WORKFLOW_PATH);
    const discoverStart = workflow.indexOf('<step name="discover_phases">');
    const discoverEnd = workflow.indexOf('</step>', discoverStart);
    const iterateStart = workflow.indexOf('<step name="iterate">');
    const iterateEnd = workflow.indexOf('</step>', iterateStart);
    const discoverStep = workflow.slice(discoverStart, discoverEnd);
    const iterateStep = workflow.slice(iterateStart, iterateEnd);

    assert.match(discoverStep, /INIT_MANAGER=\$\(gsd_run query init\.manager\)/);
    assert.ok(
      discoverStep.includes('if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi'),
      'autonomous discovery must dereference large init.manager payloads before parsing',
    );
    assert.match(discoverStep, /phase_complete !== true/);
    assert.match(discoverStep, /verification_status !== "passed"/);
    assert.match(discoverStep, /STATE_CONTENT=\$\(cat \.planning\/STATE\.md 2>\/dev\/null \|\| true\)/);
    assert.match(discoverStep, /drop any phase whose number appears in the deferred-phase map/);
    assert.doesNotMatch(discoverStep, /ROADMAP=\$\(gsd_run query roadmap\.analyze\)/);
    assert.doesNotMatch(discoverStep, /disk_status !== "complete"/);

    assert.match(iterateStep, /INIT_MANAGER=\$\(gsd_run query init\.manager\)/);
    assert.ok(
      iterateStep.includes('if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi'),
      'autonomous iteration must dereference large init.manager payloads before parsing',
    );
    assert.match(iterateStep, /phase_complete !== true/);
    assert.match(iterateStep, /verification_status !== "passed"/);
    assert.match(iterateStep, /STATE_CONTENT=\$\(cat \.planning\/STATE\.md 2>\/dev\/null \|\| true\)/);
    assert.match(iterateStep, /drop deferred phases from the autonomous queue/);
  });
});

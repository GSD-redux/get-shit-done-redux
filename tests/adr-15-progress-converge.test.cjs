// allow-test-rule: source-text-is-the-product #1190
// The progress command and next workflow markdown are runtime-loaded contracts.
// Checking their text verifies the shipped slash-command behavior.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'gsd', 'progress.md');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'next.md');
const FULL_MD_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'help', 'modes', 'full.md');
const COMMANDS_DOC_PATH = path.join(REPO_ROOT, 'docs', 'COMMANDS.md');
const HOW_TO_PATH = path.join(REPO_ROOT, 'docs', 'how-to', 'run-phases-autonomously.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('ADR-15: /gsd:progress --next --auto --converge (#1190)', () => {
  test('progress command advertises --converge, --auto, and notes --cross-ai alias', () => {
    const command = read(COMMAND_PATH);

    assert.match(
      command,
      /^argument-hint:.*--converge/m,
      'progress command should advertise --converge in argument-hint',
    );
    assert.match(
      command,
      /^argument-hint:.*--auto/m,
      'progress command should advertise --auto in argument-hint',
    );
    assert.match(command, /--cross-ai/, 'progress command should document --cross-ai alias');
    assert.match(
      command,
      /workflow\.plan_review_convergence=true/,
      'progress command should mention the convergence feature gate',
    );
  });

  test('next workflow parses converge aliases into a plan strategy', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(workflow, /PLAN_STRATEGY="local"/, 'workflow should default to local planning');
    assert.match(workflow, /PLAN_STRATEGY="converge"/, 'workflow should opt into converge planning');
    assert.match(workflow, /converge\|cross-ai/, 'workflow should accept --converge and --cross-ai');
  });

  test('next workflow fails fast when convergence is requested but disabled', () => {
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

  test('next workflow routes Route 3 through plan-review-convergence when PLAN_STRATEGY=converge', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /\/gsd:plan-review-convergence/,
      'next workflow should reference /gsd:plan-review-convergence for the converge route',
    );
    assert.match(
      workflow,
      /PLAN_STRATEGY=converge/,
      'next workflow should check PLAN_STRATEGY for the converge override',
    );
    assert.match(
      workflow,
      /gsd:plan-phase/,
      'local planning path should remain available for default next runs',
    );
    // Args-forwarding contract: Route 3 invocation must pass ${CONVERGENCE_ARGS} to the convergence
    // command — not just route to the command name but actually forward the built args variable.
    assert.match(
      workflow,
      /\/gsd:plan-review-convergence[^\n]*\$\{CONVERGENCE_ARGS\}/,
      'Route 3 convergence invocation must include ${CONVERGENCE_ARGS} on the same line as the command',
    );
  });

  test('next workflow forwards reviewer flags and max cycles to convergence', () => {
    const workflow = read(WORKFLOW_PATH);
    const reviewerFlags = [
      '--codex',
      '--gemini',
      '--agy',
      '--antigravity',
      '--claude',
      '--opencode',
      '--cursor',
      '--qwen',
      '--ollama',
      '--lm-studio',
      '--llama-cpp',
      '--all',
      '--text',
    ];

    assert.match(workflow, /CONVERGENCE_ARGS/, 'workflow should build convergence pass-through args');
    for (const flag of reviewerFlags) {
      assert.ok(workflow.includes(flag), `workflow should pass through ${flag}`);
    }
    assert.match(workflow, /--max-cycles/, 'workflow should pass through --max-cycles N');
  });

  test('next workflow preserves --auto re-invocation chaining', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /--auto/,
      'workflow should document the --auto chaining behavior',
    );
    assert.match(
      workflow,
      /\/gsd:progress --next --auto/,
      'workflow should re-invoke /gsd:progress --next --auto for chaining',
    );
    // Forwarding contract: the --auto re-invocation must explicitly state that --converge/--cross-ai
    // and reviewer flags are forwarded — not just re-invoke --auto alone.
    assert.match(
      workflow,
      /\/gsd:progress --next --auto[^\n]*(forwarding|--converge)/,
      'workflow --auto re-invocation should document forwarding --converge/--cross-ai and reviewer flags',
    );
  });

  test('full.md documents --converge, --auto, and --cross-ai for /gsd:progress', () => {
    const fullMd = read(FULL_MD_PATH);

    assert.match(
      fullMd,
      /\/gsd:progress --next --auto --converge/,
      'full.md should show /gsd:progress --next --auto --converge usage',
    );
    assert.match(
      fullMd,
      /--auto/,
      'full.md should document --auto for progress',
    );
    assert.match(
      fullMd,
      /--cross-ai/,
      'full.md should mention --cross-ai alias for convergence',
    );
  });

  test('COMMANDS.md documents progress convergence flags and usage', () => {
    const commandsDoc = read(COMMANDS_DOC_PATH);

    assert.match(
      commandsDoc,
      /\/gsd-progress --next --auto --converge/,
      'COMMANDS.md should show /gsd-progress --next --auto --converge usage example',
    );
    assert.match(commandsDoc, /--converge/, 'COMMANDS.md should document --converge for progress');
    assert.match(commandsDoc, /--cross-ai/, 'COMMANDS.md should document --cross-ai alias for progress');
  });

  test('how-to shows /gsd-progress --next --auto --converge usage', () => {
    const howTo = read(HOW_TO_PATH);

    assert.match(
      howTo,
      /\/gsd-progress --next --auto --converge/,
      'how-to should show /gsd-progress --next --auto --converge usage',
    );
  });
});

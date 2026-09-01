// Quick workflow Markdown is the installed orchestration contract.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const WORKFLOW_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const QUICK_PATH = path.join(WORKFLOW_DIR, 'quick.md');
const REVISION_PATH = path.join(WORKFLOW_DIR, 'quick', 'steps', 'plan-checker-loop.md');

function sliceBetween(content, startAnchor, endAnchor, label) {
  const start = content.indexOf(startAnchor);
  assert.notEqual(start, -1, `${label}: missing start anchor ${JSON.stringify(startAnchor)}`);
  const bodyStart = start + startAnchor.length;
  const end = content.indexOf(endAnchor, bodyStart);
  assert.notEqual(end, -1, `${label}: missing end anchor ${JSON.stringify(endAnchor)}`);
  assert.ok(end > bodyStart, `${label}: anchors must enclose non-empty text`);
  return content.slice(bodyStart, end);
}

function initialPlannerPrompt(quick) {
  const step = sliceBetween(
    quick,
    '**Step 5: Spawn planner (quick mode)**',
    '<!-- gsd:section id="plan-checker-loop"',
    'initial planner step',
  );
  return sliceBetween(
    step,
    'Agent(\n  prompt="\n',
    '\n",\n  subagent_type="gsd-planner"',
    'initial planner prompt',
  );
}

function revisionPlannerPrompt(revision) {
  return sliceBetween(
    revision,
    'Revision prompt:\n\nReuse the `PLAN_PRE_HOOKS_JSON` snapshot captured by Quick Step 5; do not render hooks again.\n\n```markdown\n',
    '\n```\n\n```\nAgent(\n  prompt=revision_prompt',
    'revision planner prompt',
  );
}

function contributionInstruction(prompt, label) {
  const lines = prompt.split('\n');
  const matches = lines.filter((line) => line.startsWith('{For each active entry in `PLAN_PRE_HOOKS_JSON`'));
  assert.equal(matches.length, 1, `${label}: expected exactly one planner contribution instruction`);
  return matches[0];
}

function assertPlannerContributionContract(prompt, label) {
  const instruction = contributionInstruction(prompt, label);
  const skillsIndex = prompt.indexOf('${AGENT_SKILLS_PLANNER}');
  const instructionIndex = prompt.indexOf(instruction);

  assert.notEqual(skillsIndex, -1, `${label}: missing planner skills anchor`);
  assert.ok(skillsIndex < instructionIndex, `${label}: contribution instruction must follow planner skills`);
  assert.match(instruction, /kind == "contribution"/, `${label}: must filter contribution kind`);
  assert.match(instruction, /into == "planner"/, `${label}: must filter planner target`);
  assert.match(instruction, /in array order/, `${label}: must preserve registry order`);
  assert.match(instruction, /fragment\.inline/, `${label}: must inject materialised fragment text`);
  assert.match(instruction, /configValues/, `${label}: must surface resolved config values`);
  assert.match(
    instruction,
    /no active planner contributions exist.*omit this block entirely/i,
    `${label}: empty or inactive input must be a silent no-op`,
  );
  assert.doesNotMatch(
    instruction,
    /(?:capId|plugin|runtime)\s*={2,3}/,
    `${label}: generic dispatch must not specialize by capability or runtime`,
  );
}

describe('quick workflow: plan:pre planner contributions (#3778)', () => {
  test('initial and revision Quick planners reuse one ordered plan:pre contribution snapshot', () => {
    const quick = readFileNormalized(QUICK_PATH);
    const revision = readFileNormalized(REVISION_PATH);
    const initialPrompt = initialPlannerPrompt(quick);
    const revisionPrompt = revisionPlannerPrompt(revision);

    assertPlannerContributionContract(initialPrompt, 'initial planner');
    assertPlannerContributionContract(revisionPrompt, 'revision planner');

    assert.equal(
      contributionInstruction(revisionPrompt, 'revision planner'),
      contributionInstruction(initialPrompt, 'initial planner'),
      'both planner paths must apply the byte-identical filtering and injection contract',
    );
    assert.equal((quick.match(/loop render-hooks plan:pre --raw/g) || []).length, 1);
    assert.equal((revision.match(/loop render-hooks plan:pre --raw/g) || []).length, 0);
    const initialStep = quick.indexOf('**Step 5: Spawn planner (quick mode)**');
    const revisionGate = quick.indexOf('<!-- gsd:section id="plan-checker-loop" when="flag:--validate" -->');
    assert.notEqual(initialStep, -1, 'standard initial planner step must exist');
    assert.ok(initialStep < revisionGate, 'initial planner must run before the optional revision gate');
    assert.match(quick, /--full.*\$VALIDATE_MODE=true/, '--full must enable the validate path');
    assert.match(quick, /--validate.*\$VALIDATE_MODE=true/, '--validate must enable the validate path');
    assert.match(revision, /Revision loop \(max 2 iterations\)/, 'validate path must contain revision loop');
    assert.equal((quick.match(/subagent_type="gsd-planner"/g) || []).length, 1);
    assert.equal((revision.match(/subagent_type="gsd-planner"/g) || []).length, 1);
  });
});

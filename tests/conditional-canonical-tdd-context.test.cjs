// allow-test-rule: source-text-is-the-product
// Executor prompts are assembled from these shipped workflow templates.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const WORKTREE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md');
const EXECUTOR = path.join(ROOT, 'agents', 'gsd-executor.md');
const EXECUTE_PLAN = path.join(ROOT, 'gsd-core', 'workflows', 'execute-plan.md');
const TDD_REFERENCE = path.join(ROOT, 'gsd-core', 'references', 'tdd.md');

const fixtures = {
  nonTdd: `---\nphase: 1\ntype: execute\n---\n\nExamples may say type: tdd and tdd="true".\n`,
  dedicatedTdd: `---\nphase: 1\ntype: tdd\n---\n\n<objective>Dedicated cycle</objective>\n`,
  mixedTdd: `---\nphase: 1\ntype: execute\n---\n\n<task type="auto" tdd="true">\n  <name>Cycle</name>\n</task>\n`,
};

function planNeedsTddContext(plan) {
  const frontmatter = plan.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  return /^type:\s*tdd\s*$/m.test(frontmatter) || /<task\b[^>]*\btdd="true"[^>]*>/i.test(plan);
}

function composerSource(file) {
  return fs.readFileSync(file, 'utf8');
}

function assertConditionalComposer(source, name) {
  assert.match(source, /selected PLAN\.md|selected plan/i, `${name} must inspect the selected plan at compose time`);
  assert.match(source, /frontmatter[^\n]*type:\s*tdd|type:\\s\*tdd/i, `${name} must include dedicated TDD plans`);
  assert.match(source, /<task\\b[^\n]*tdd=\\"true\\"|task opening tag[^\n]*tdd="true"/i, `${name} must include mixed TDD plans`);
  assert.match(source, /conditional[^\n]*tdd\.md|tdd\.md[^\n]*conditional/i, `${name} must conditionally embed the canonical reference`);
  assert.doesNotMatch(source, /TDD_MODE[^\n]{0,160}(?:tdd\.md|canonical)|(?:tdd\.md|canonical)[^\n]{0,160}TDD_MODE/i,
    `${name} must not use phase-wide TDD_MODE as selected-plan eligibility`);
}

describe('conditional canonical TDD executor context', () => {
  test('selected-plan fixtures distinguish dedicated, mixed, and prose-only TDD tokens', () => {
    assert.equal(planNeedsTddContext(fixtures.nonTdd), false);
    assert.equal(planNeedsTddContext(fixtures.dedicatedTdd), true);
    assert.equal(planNeedsTddContext(fixtures.mixedTdd), true);
  });

  test('both dispatch backends conditionally compose the canonical reference from the selected plan', () => {
    assertConditionalComposer(composerSource(HARNESS), 'harness-worktree prompt');
    assertConditionalComposer(composerSource(WORKTREE), 'orchestrator-worktree prompt');
  });

  test('tdd.md is the only shipped owner of the complete RED/GREEN/REFACTOR procedure', () => {
    const canonical = fs.readFileSync(TDD_REFERENCE, 'utf8');
    assert.match(canonical, /RED[\s\S]*GREEN[\s\S]*REFACTOR/, 'canonical reference must retain the procedure');

    for (const [name, file] of [['executor role', EXECUTOR], ['execute-plan workflow', EXECUTE_PLAN]]) {
      const source = composerSource(file);
      assert.match(source, /tdd\.md/, `${name} must point to the canonical reference`);
      assert.doesNotMatch(source, /\*\*2\. RED:\*\*[\s\S]{0,500}\*\*3\. GREEN:\*\*[\s\S]{0,500}\*\*4\. REFACTOR/,
        `${name} must not duplicate the complete canonical procedure`);
    }
  });
});

// allow-test-rule: source-text-is-the-product (#3990)
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
  crlfQuotedTdd: `---\r\nphase: 1\r\ntype: "tdd"\r\n---\r\n\r\n<objective>Dedicated cycle</objective>\r\n`,
  bomCrlfQuotedTdd: `\uFEFF---\r\nphase: 1\r\ntype: 'tdd'\r\n---\r\n\r\n<objective>Dedicated cycle</objective>\r\n`,
  mixedTdd: `---\nphase: 1\ntype: execute\n---\n\n<task type="auto" tdd = 'true'>\n  <name>Cycle</name>\n</task>\n`,
  multilineTdd: `---\nphase: 1\ntype: execute\n---\n\n<task\n  type="auto"\n  tdd = "true"\n>\n  <name>Cycle</name>\n</task>\n`,
  fencedTaskExample: `---\nphase: 1\ntype: execute\n---\n\n\`\`\`xml\n<task type="auto" tdd="true">\n</task>\n\`\`\`\n`,
  tildeFencedTaskExample: `---\nphase: 1\ntype: execute\n---\n\n~~~xml\n<task type="auto" tdd="true">\n</task>\n~~~\n`,
  proseTaskExample: `---\nphase: 1\ntype: execute\n---\n\nA literal <task type="auto" tdd="true"> example is not a task.\n`,
};

function planNeedsTddContext(plan) {
  plan = plan.replace(/^\uFEFF/, '');
  const frontmatter = plan.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  if (/^type:\s*(?:tdd|"tdd"|'tdd')\s*$/m.test(frontmatter)) return true;

  let fenced = false;
  let taskOpening = '';
  for (const line of plan.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!taskOpening && /^\s*<task\b/i.test(line)) taskOpening = line;
    else if (taskOpening) taskOpening += `\n${line}`;
    if (taskOpening.includes('>')) {
      if (/\btdd\s*=\s*["']true["']/i.test(taskOpening)) return true;
      taskOpening = '';
    }
  }
  return false;
}

function composerSource(file) {
  return fs.readFileSync(file, 'utf8');
}

function compositionScope(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, 'executor prompt composition bounds must exist');
  return source.slice(start, end);
}

function assertConditionalComposer(source, name, startMarker, endMarker) {
  source = compositionScope(source, startMarker, endMarker);
  assert.match(source, /selected PLAN\.md|selected plan/i, `${name} must inspect the selected plan at compose time`);
  assert.match(source, /frontmatter[^\n]*type:\s*tdd|type:\\s\*tdd/i, `${name} must include dedicated TDD plans`);
  assert.match(source, /<task\\b[^\n]*tdd=\\"true\\"|task opening tag[^\n]*tdd="true"/i, `${name} must include mixed TDD plans`);
  assert.match(source, /quoted scalar/i, `${name} must accept YAML-quoted type: tdd`);
  assert.match(source, /optional BOM/i, `${name} must accept a BOM before frontmatter`);
  assert.match(source, /whitespace[^\n]*=/i, `${name} must accept whitespace around task attributes`);
  assert.match(source, /multiline task opening tag/i, `${name} must accept multiline task opening tags`);
  assert.match(source, /fenced[^\n]*prose|prose[^\n]*fenced/i, `${name} must reject literal task examples`);
  assert.match(source, /tildes/i, `${name} must reject tilde-fenced literal task examples`);
  assert.match(source, /conditional[^\n]*tdd\.md|tdd\.md[^\n]*conditional/i, `${name} must conditionally embed the canonical reference`);
  assert.doesNotMatch(source, /TDD_MODE[^\n]{0,160}(?:tdd\.md|canonical)|(?:tdd\.md|canonical)[^\n]{0,160}TDD_MODE/i,
    `${name} must not use phase-wide TDD_MODE as selected-plan eligibility`);
}

describe('conditional canonical TDD executor context', () => {
  test('selected-plan fixtures accept supported syntax and reject literal examples', () => {
    assert.equal(planNeedsTddContext(fixtures.nonTdd), false);
    assert.equal(planNeedsTddContext(fixtures.dedicatedTdd), true);
    assert.equal(planNeedsTddContext(fixtures.crlfQuotedTdd), true);
    assert.equal(planNeedsTddContext(fixtures.bomCrlfQuotedTdd), true);
    assert.equal(planNeedsTddContext(fixtures.mixedTdd), true);
    assert.equal(planNeedsTddContext(fixtures.multilineTdd), true);
    assert.equal(planNeedsTddContext(fixtures.fencedTaskExample), false);
    assert.equal(planNeedsTddContext(fixtures.tildeFencedTaskExample), false);
    assert.equal(planNeedsTddContext(fixtures.proseTaskExample), false);
  });

  test('both dispatch backends conditionally compose the canonical reference from the selected plan', () => {
    const backends = [
      ['harness-worktree prompt', composerSource(HARNESS), 'subagent_type="{EXECUTOR_TYPE}"', 'After each `Agent()` returns'],
      ['orchestrator-worktree prompt', composerSource(WORKTREE), 'First build the executor prompt', 'Then create the worktree'],
    ];
    for (const [name, source, start, end] of backends) {
      assertConditionalComposer(source, name, start, end);
    }
  });

  test('orchestrator-worktree rejects an unresolved TDD marker before it can spawn an executor', () => {
    const source = composerSource(WORKTREE);
    const composition = compositionScope(source, 'EXECUTOR_PROMPT=', 'Then create the worktree');

    assert.match(composition, /\$\{PLAN_TDD_CONTEXT:\+- tdd\.md\}/,
      'the prompt must retain the conditional marker until the orchestrator embeds it');
    assert.match(composition, /printf '%s' "\$EXECUTOR_PROMPT" \| grep -Fq "/,
      'the real pre-spawn checks must detect an unresolved PLAN_TDD_CONTEXT marker');
    assert.match(composition, /FATAL: executor prompt[^\n]*PLAN_TDD_CONTEXT[^\n]*Halting/i,
      'an unresolved marker must halt instead of reaching a spawned executor');
  });

  test('harness-worktree halts before Agent dispatch when the TDD marker survives composition', () => {
    const composition = compositionScope(composerSource(HARNESS), 'subagent_type="{EXECUTOR_TYPE}"', 'After each `Agent()` returns');

    assert.match(composition, /\$\{PLAN_TDD_CONTEXT[^\n]*survives[^\n]*halt/i,
      'the harness path must halt rather than send an unresolved marker to Agent()');
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

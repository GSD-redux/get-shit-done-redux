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
  assert.match(source, /task opening tag[^\n]*tdd="true"/i, `${name} must include mixed TDD plans`);
  assert.match(source, /quoted scalar/i, `${name} must accept YAML-quoted type: tdd`);
  assert.match(source, /optional BOM/i, `${name} must accept a BOM before frontmatter`);
  assert.match(source, /whitespace[^\n]*=/i, `${name} must accept whitespace around task attributes`);
  assert.match(source, /task opening tag[^\n]*may be multiline/i, `${name} must accept single-line and multiline task opening tags`);
  assert.match(source, /repository root[^\n]*\{phase_dir\}\/\{plan_file\}/i, `${name} must use a compose-time path, not an executor-only variable`);
  assert.match(source, /fenced[^\n]*prose|prose[^\n]*fenced/i, `${name} must reject literal task examples`);
  assert.match(source, /tildes/i, `${name} must reject tilde-fenced literal task examples`);
  assert.match(source, /conditional[^\n]*tdd\.md|tdd\.md[^\n]*conditional/i, `${name} must conditionally embed the canonical reference`);
  assert.doesNotMatch(source, /TDD_MODE[^\n]{0,160}(?:tdd\.md|canonical)|(?:tdd\.md|canonical)[^\n]{0,160}TDD_MODE/i,
    `${name} must not use phase-wide TDD_MODE as selected-plan eligibility`);
}

describe('conditional canonical TDD executor context', () => {
  test('both dispatch backends conditionally compose the canonical reference from the selected plan', () => {
    const backends = [
      ['harness-worktree prompt', composerSource(HARNESS), 'subagent_type="{EXECUTOR_TYPE}"', 'After each `Agent()` returns'],
      ['orchestrator-worktree prompt', composerSource(WORKTREE), 'First build the executor prompt', 'Then create the worktree'],
    ];
    for (const [name, source, start, end] of backends) {
      assertConditionalComposer(source, name, start, end);
    }
  });

  test('orchestrator resolves selected-plan eligibility before embedding conditional files', () => {
    const steps = compositionScope(composerSource(WORKTREE), '# ORCHESTRATOR BUILD-TIME EMBEDS', 'EXECUTOR_PROMPT=');
    const eligibility = steps.indexOf('Set `PLAN_TDD_CONTEXT=true`');
    const inline = steps.indexOf('Inline each file');

    assert.ok(eligibility !== -1 && inline !== -1 && eligibility < inline,
      'selected-plan eligibility must be known before the conditional file list is embedded');
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

  test('harness-worktree uses the conditional TDD entry with an empty false arm', () => {
    const composition = compositionScope(composerSource(HARNESS), 'subagent_type="{EXECUTOR_TYPE}"', 'After each `Agent()` returns');

    assert.match(composition, /\$\{PLAN_TDD_CONTEXT \? '- `~\/\.claude\/gsd-core\/references\/tdd\.md`' : ''\}/,
      'the harness TDD entry must be conditional, with no tdd.md entry when the selected plan is ineligible');
  });

  test('tdd.md is the only shipped owner of the complete RED/GREEN/REFACTOR procedure', () => {
    const canonical = fs.readFileSync(TDD_REFERENCE, 'utf8');
    assert.match(canonical, /RED[\s\S]*GREEN[\s\S]*REFACTOR/, 'canonical reference must retain the procedure');

    for (const [name, file] of [['executor role', EXECUTOR], ['execute-plan workflow', EXECUTE_PLAN]]) {
      const source = composerSource(file);
      assert.match(source, /tdd\.md/, `${name} must point to the canonical reference`);
      assert.match(source, /embedded in (?:the |your )?execution context/i,
        `${name} must use the canonical procedure already embedded by the orchestrator`);
      assert.doesNotMatch(source, /(?:read and follow[^\n]*tdd\.md|tdd\.md[^\n]*Read that reference)/i,
        `${name} must not ask the executor to reread a host-only TDD path`);
      assert.doesNotMatch(source, /\*\*2\. RED:\*\*[\s\S]{0,500}\*\*3\. GREEN:\*\*[\s\S]{0,500}\*\*4\. REFACTOR/,
        `${name} must not duplicate the complete canonical procedure`);
    }
  });
});

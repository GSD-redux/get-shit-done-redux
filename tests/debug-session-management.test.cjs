// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('debug session management implementation', () => {
  test('DEBUG.md template contains reasoning_checkpoint field', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/templates/DEBUG.md'),
      'utf8'
    );
    assert.ok(content.includes('reasoning_checkpoint'), 'DEBUG.md must contain reasoning_checkpoint field');
  });

  test('DEBUG.md template contains tdd_checkpoint field', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/templates/DEBUG.md'),
      'utf8'
    );
    assert.ok(content.includes('tdd_checkpoint'), 'DEBUG.md must contain tdd_checkpoint field');
  });

  test('debug command contains list subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=list') || content.includes('"list"'),
      'debug.md must contain list subcommand logic'
    );
  });

  test('debug command contains continue subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=continue') || content.includes('"continue"'),
      'debug.md must contain continue subcommand logic'
    );
  });

  test('debug command contains status subcommand logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('SUBCMD=status') || content.includes('"status"'),
      'debug.md must contain status subcommand logic'
    );
  });

  test('debug command contains TDD gate logic', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('TDD_MODE') || content.includes('tdd_mode'),
      'debug.md must contain TDD gate logic'
    );
  });

  test('debug.md reads tdd_mode via workflow.tdd_mode key (not bare tdd_mode)', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    // #3149: tdd_mode now arrives on the `init.debug` bundle rather than a
    // `config-get` call in this workflow, so the old literal-call assertion no
    // longer describes reality. The invariant it protected is unchanged and is
    // asserted at its new home: `cmdInitDebug` resolves `config.workflow`'s
    // `tdd_mode`, never a bare top-level key — proven behaviorally in
    // tests/init-debug.test.cjs ('honors workflow.tdd_mode, ignores a bare
    // top-level tdd_mode'). What must remain true HERE is only that this
    // workflow never reintroduces a bare-key read of its own.
    assert.ok(
      !content.includes('config-get tdd_mode'),
      'debug.md must not use bare "tdd_mode" key — use "workflow.tdd_mode" to match every other consumer'
    );
    assert.ok(
      content.includes('tdd_mode'),
      'debug.md must still consume tdd_mode (now from the init.debug bundle)'
    );
  });

  test('debug command contains security hardening', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(content.includes('DATA_START'), 'debug.md must contain DATA_START injection boundary marker');
  });

  test('debug command surfaces next_action before spawn', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'gsd-core/workflows/debug.md'),
      'utf8'
    );
    assert.ok(
      content.includes('[debug] Next:') || content.includes('next_action'),
      'debug.md must surface next_action before agent spawn'
    );
  });

  test('gsd-debugger contains structured reasoning checkpoint', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('reasoning_checkpoint'), 'gsd-debugger.md must contain reasoning_checkpoint');
  });

  test('gsd-debugger contains TDD checkpoint mode', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('tdd_mode'), 'gsd-debugger.md must contain tdd_mode');
    assert.ok(content.includes('TDD CHECKPOINT'), 'gsd-debugger.md must contain TDD CHECKPOINT return format');
  });

  test('gsd-debugger contains delta debugging technique', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('Delta Debugging'), 'gsd-debugger.md must contain Delta Debugging technique');
  });

  test('gsd-debugger contains security note about DATA_START', () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), 'agents/gsd-debugger.md'),
      'utf8'
    );
    assert.ok(content.includes('DATA_START'), 'gsd-debugger.md must contain DATA_START security reference');
  });
});

// Tests for #2148 and #2151
describe('debug skill dispatch and sub-orchestrator (#2148, #2151)', () => {
  test('gsd-debugger ROOT CAUSE FOUND format includes specialist_hint field', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debugger.md'), 'utf8');
    assert.ok(content.includes('specialist_hint'), 'gsd-debugger missing specialist_hint in ROOT CAUSE FOUND');
    assert.ok(content.includes('swift_concurrency'), 'gsd-debugger missing specialist_hint derivation guidance');
  });

  test('debug.md orchestrator has specialist skill dispatch step', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('specialist_hint'), 'debug.md missing specialist dispatch logic');
    assert.ok(content.includes('typescript-expert'), 'debug.md missing skill dispatch mapping');
  });

  test('debug.md specialist dispatch prompt uses DATA_START/DATA_END boundaries', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('DATA_START') && content.includes('DATA_END'),
      'debug.md specialist dispatch prompt missing security boundaries');
  });

  test('gsd-debug-session-manager agent exists with correct tools', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('Agent'), 'gsd-debug-session-manager missing Agent tool');
    assert.ok(content.includes('AskUserQuestion'), 'gsd-debug-session-manager missing AskUserQuestion tool');
  });

  test('gsd-debug-session-manager spawns debugger with Agent() dispatcher', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('\nAgent('), 'session manager must dispatch debugger with Agent(');
  });

  test('gsd-debug-session-manager uses DATA_START/DATA_END for checkpoint responses', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('DATA_START') && content.includes('DATA_END'),
      'gsd-debug-session-manager missing security boundaries on checkpoint responses');
  });

  test('gsd-debug-session-manager has compact summary output format', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('DEBUG SESSION COMPLETE'), 'session manager missing compact summary format');
  });

  test('gsd-debug-session-manager includes anti-heredoc rule', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debug-session-manager.md'), 'utf8');
    assert.ok(content.includes('heredoc'), 'session manager missing anti-heredoc rule');
  });

  test('debug.md delegates to gsd-debug-session-manager', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core', 'workflows', 'debug.md'), 'utf8');
    assert.ok(content.includes('gsd-debug-session-manager'),
      'debug.md does not delegate to session manager');
  });

  test('DEBUG.md reasoning_checkpoint field-count claim matches gsd-debugger.md YAML keys (parity)', () => {
    // Parallel-surface drift guard (DEFECT.GENERATIVE-FIX): the field-count
    // claim in the DEBUG.md section_rules prose must equal the number of keys
    // enumerated in the gsd-debugger.md reasoning_checkpoint YAML block.
    // CRLF-safe regex/split per DEFECT.WINDOWS-TEST-PORTABILITY. Accepts either
    // digit ("7-field") or word ("seven-field") count form.
    const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const debugContent = fs.readFileSync(path.join(process.cwd(), 'gsd-core', 'templates', 'DEBUG.md'), 'utf8');
    const agentContent = fs.readFileSync(path.join(process.cwd(), 'agents', 'gsd-debugger.md'), 'utf8');
    const debugMatch = debugContent.match(/reasoning_checkpoint[^.\r\n]*?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)-field structured reasoning record/i);
    assert.ok(debugMatch, 'DEBUG.md must state a "N-field structured reasoning record" claim for reasoning_checkpoint');
    const claimedCount = /^\d+$/.test(debugMatch[1]) ? parseInt(debugMatch[1], 10) : NUMWORDS[debugMatch[1].toLowerCase()];
    assert.ok(typeof claimedCount === 'number', `unrecognized field-count token: ${debugMatch[1]}`);
    const yamlBlock = agentContent.match(/reasoning_checkpoint:\s*\r?\n([\s\S]*?)```/);
    assert.ok(yamlBlock, 'gsd-debugger.md must define a fenced reasoning_checkpoint YAML block');
    const keys = new Set();
    for (const line of yamlBlock[1].split(/\r?\n/)) {
      // Match 2-space-indented YAML keys (with OR without an inline value —
      // array-valued keys like confirming_evidence: have no trailing space).
      const m = line.match(/^ {2}([a-z_]+):/);
      if (m) keys.add(m[1]);
    }
    assert.strictEqual(
      keys.size,
      claimedCount,
      `parity drift: DEBUG.md claims ${claimedCount}-field but gsd-debugger.md enumerates ${keys.size} keys (${[...keys].join(', ')}). Update BOTH surfaces together.`
    );
  });

  // #2376: debug_file_path handed to the spawned gsd-debug-session-manager
  // must resolve regardless of that subagent's own cwd, which may differ
  // from the orchestrator's — debug.md must reference the absolute
  // {debug_dir} field from `state load`, not a bare .planning/debug/...
  // literal, in both the `continue` and new-session Agent() spawns.
  test('debug.md session_params reference {debug_dir}/{slug}.md, not bare .planning/debug/... literals (#2376)', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'gsd-core/workflows/debug.md'), 'utf8');
    assert.ok(content.includes('debug_file_path: {debug_dir}/{SLUG}.md'),
      'debug.md continue-subcommand spawn must reference {debug_dir}/{SLUG}.md, not a bare .planning/debug/{SLUG}.md literal');
    assert.ok(content.includes('debug_file_path: {debug_dir}/{slug}.md'),
      'debug.md new-session spawn must reference {debug_dir}/{slug}.md, not a bare .planning/debug/{slug}.md literal');
    assert.ok(!content.includes('debug_file_path: .planning/debug/'),
      'debug.md session_params must not hardcode .planning/debug/... as debug_file_path (#2376)');
  });
});

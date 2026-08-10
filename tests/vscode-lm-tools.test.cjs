'use strict';

/**
 * VS Code Language Model Tools test — #2103 UPGRADE 1.
 *
 * Proves the GSD extension's Language Model Tools are keystone-WIRED:
 *   1. contributes.languageModelTools is present in package.json and its
 *      `name` entries match the runtime registration names (extension.js's
 *      LM_TOOLS / browser.js's LM_TOOL_NAMES) exactly — a mismatch here would
 *      mean VS Code rejects the tool registration at activation.
 *   2. registerLanguageModelTools() calls vscode.lm.registerTool for every
 *      manifest entry (mock vscode.lm — no real VS Code host available in CI).
 *   3. A registered tool's invoke() dispatches through the SAME shared
 *      dispatchGsdCommand as gsd.invoke (desktop) and returns REAL output —
 *      the "user can invoke X" proof, matching the reachability-test pattern.
 *   4. The desktop and web entries register the identical tool NAME set (only
 *      the invoke() behavior differs — real dispatch vs. honest web-mode message).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../vscode/package.json');
const extension = require('../vscode/extension.js');
const browser = require('../vscode/browser.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

class FakeTextPart {
  constructor(text) { this.text = text; }
}
class FakeToolResult {
  constructor(parts) { this.parts = parts; }
}

function mockVscodeLm() {
  const registered = [];
  return {
    lm: {
      registerTool(name, impl) {
        registered.push({ name, impl });
        return { dispose() {} };
      },
    },
    LanguageModelTextPart: FakeTextPart,
    LanguageModelToolResult: FakeToolResult,
    registered,
  };
}

test('package.json contributes.languageModelTools is present with well-formed entries', () => {
  assert.ok(pkg.contributes && Array.isArray(pkg.contributes.languageModelTools),
    'contributes.languageModelTools must be an array');
  assert.ok(pkg.contributes.languageModelTools.length > 0, 'must declare at least one tool');
  for (const tool of pkg.contributes.languageModelTools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.toolReferenceName, 'string');
    assert.equal(typeof tool.displayName, 'string');
    assert.equal(typeof tool.modelDescription, 'string');
    assert.equal(typeof tool.userDescription, 'string');
    assert.equal(tool.canBeReferencedInPrompt, true);
    assert.ok(Array.isArray(tool.tags));
    assert.equal(typeof tool.inputSchema, 'object');
  }
});

test('manifest tool names exactly match extension.js LM_TOOLS registration names', () => {
  const manifestNames = pkg.contributes.languageModelTools.map((t) => t.name).sort();
  const runtimeNames = extension.LM_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(runtimeNames, manifestNames,
    'a mismatch here means VS Code would reject the runtime registerTool call against the manifest');
});

test('manifest tool names exactly match browser.js LM_TOOL_NAMES (web entry registers the same surface)', () => {
  const manifestNames = pkg.contributes.languageModelTools.map((t) => t.name).sort();
  assert.deepEqual([...browser.LM_TOOL_NAMES].sort(), manifestNames);
});

test('REACHABILITY (desktop): registerLanguageModelTools registers every manifest tool via vscode.lm.registerTool', () => {
  const mock = mockVscodeLm();
  const context = { subscriptions: [] };
  const count = extension.registerLanguageModelTools(mock, context);
  assert.equal(count, pkg.contributes.languageModelTools.length);
  assert.equal(mock.registered.length, pkg.contributes.languageModelTools.length);
  assert.equal(context.subscriptions.length, pkg.contributes.languageModelTools.length);
  assert.deepEqual(mock.registered.map((r) => r.name).sort(), extension.LM_TOOLS.map((t) => t.name).sort());
});

test('REACHABILITY (desktop): gsd_progress tool.invoke() dispatches through the hub and returns REAL output', async () => {
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version
    // token) is COMPLETE scope for windowing (§7.1) — without this, a
    // bare temp dir has no ROADMAP.md at all (UNREADABLE) and `percent`
    // is withheld (null), breaking this reachability proxy.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const mock = mockVscodeLm();
    extension.registerLanguageModelTools(mock, { subscriptions: [] });
    const progressTool = mock.registered.find((r) => r.name === 'gsd_progress');
    assert.ok(progressTool, 'gsd_progress must be registered');
    const result = await progressTool.impl.invoke({ input: {}, cwd: dir }, {});
    assert.ok(result instanceof FakeToolResult, 'invoke must return a LanguageModelToolResult');
    assert.ok(Array.isArray(result.parts) && result.parts.length === 1);
    assert.ok(result.parts[0] instanceof FakeTextPart, 'result part must be a LanguageModelTextPart');
    const parsed = JSON.parse(result.parts[0].text);
    assert.equal(typeof parsed.percent, 'number', 'the real progress command ran (engine reached, not a stub)');
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY (desktop): gsd_plan_phase tool.invoke() forwards the "phase" input through dispatch (real, not UnknownCommand)', async () => {
  const dir = createTempDir();
  try {
    const mock = mockVscodeLm();
    extension.registerLanguageModelTools(mock, { subscriptions: [] });
    const planPhaseTool = mock.registered.find((r) => r.name === 'gsd_plan_phase');
    assert.ok(planPhaseTool);
    const result = await planPhaseTool.impl.invoke({ input: { phase: 'nonexistent-phase-8675309' }, cwd: dir }, {});
    const parsed = JSON.parse(result.parts[0].text);
    // Real dispatch reaches gsd-tools.cjs and returns a structured "phase not
    // found" response (proves the engine was reached) — not the manifest's
    // own family/subcommand rejected as unknown.
    assert.equal(parsed.phase, 'nonexistent-phase-8675309');
    assert.ok('error' in parsed || 'plans' in parsed, 'expected a real phase-plan-index response shape');
  } finally {
    cleanup(dir);
  }
});

test('gsd_workstreams tool.invoke() dispatches through the hub and returns REAL output', async () => {
  const dir = createTempDir();
  try {
    const mock = mockVscodeLm();
    extension.registerLanguageModelTools(mock, { subscriptions: [] });
    const wsTool = mock.registered.find((r) => r.name === 'gsd_workstreams');
    const result = await wsTool.impl.invoke({ input: {}, cwd: dir }, {});
    const parsed = JSON.parse(result.parts[0].text);
    assert.ok('workstreams' in parsed || 'mode' in parsed, 'expected a real workstream list response shape');
  } finally {
    cleanup(dir);
  }
});

test('registerLanguageModelTools fails soft (returns 0, does not throw) when vscode.lm is absent', () => {
  assert.doesNotThrow(() => {
    const count = extension.registerLanguageModelTools({}, { subscriptions: [] });
    assert.equal(count, 0);
  });
});

test('WEB MODE: browser.js registerLanguageModelTools registers the same names but invoke() returns an honest web-mode message (no engine dispatch)', async () => {
  const mock = mockVscodeLm();
  const count = browser.registerLanguageModelTools(mock, { subscriptions: [] });
  assert.equal(count, browser.LM_TOOL_NAMES.length);
  const progressTool = mock.registered.find((r) => r.name === 'gsd_progress');
  const result = await progressTool.impl.invoke({ input: {} }, {});
  assert.match(result.parts[0].text, /web mode/i);
  assert.match(result.parts[0].text, /MCP server/);
});

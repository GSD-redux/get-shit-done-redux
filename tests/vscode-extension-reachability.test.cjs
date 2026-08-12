'use strict';

/**
 * VS Code extension reachability test — ADR-1239 Phase D / #1942, upgraded #2103.
 *
 * Proves the VS Code extension is keystone-WIRED: the gsd.invoke handler
 * dispatches through gsd-tools.cjs (subprocess-reuse — the shared
 * `dispatchGsdCommand` in gsd-core/bin/lib/shell-command-projection.cjs) and
 * returns REAL output, not just a registration on a stub. The handler is
 * exported separately from activate() so it is testable WITHOUT a VS Code host.
 *
 * The original cut called `createHub()` with NO args — no hub factory in the
 * tree fully populates a hub, so every dispatch silently answered
 * UnknownCommand. The prior version of this test only asserted the result was
 * "a JSON object" — a VACUOUS assertion that passed whether or not dispatch
 * actually worked. Dispatch is now exercised with a real read-only
 * family/subcommand (progress/json) against a real temp project, matching the
 * sibling tests/pi-extension-reachability.test.cjs pattern — no fake
 * dispatcher injected, because the whole point of "reachability" is that the
 * real engine is reached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const extension = require('../vscode/extension.js');
const { activate, dispatchGsdCommand, resolveEngineRoot, resolveWorkspaceCwd } = extension;
const { createTempDir, cleanup } = require('./helpers.cjs');
const shellCommandProjection = require('../gsd-core/bin/lib/shell-command-projection.cjs');

test('the extension exports activate + dispatchGsdCommand + resolveEngineRoot', () => {
  assert.equal(typeof activate, 'function');
  assert.equal(typeof dispatchGsdCommand, 'function');
  assert.equal(typeof resolveEngineRoot, 'function');
});

test('REACHABILITY: dispatchGsdCommand dispatches a real family/subcommand through gsd-tools.cjs and returns REAL output (keystone wired, not UnknownCommand)', async () => {
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version
    // token) is COMPLETE scope for windowing (§7.1) — without this, a
    // bare temp dir has no ROADMAP.md at all (UNREADABLE) and `percent`
    // is withheld (null), breaking this reachability proxy.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const result = await dispatchGsdCommand({ family: 'progress', subcommand: 'json', cwd: dir });
    assert.equal(typeof result, 'string', 'returns a string result');
    const parsed = JSON.parse(result);
    assert.ok(parsed !== null && typeof parsed === 'object', 'dispatch produced a result object');
    assert.equal(parsed.ok, true, `expected ok:true (real dispatch), got: ${result}`);
    assert.equal(typeof parsed.stdout, 'string');
    assert.ok(parsed.stdout.length > 0, 'stdout must be non-empty');
    const inner = JSON.parse(parsed.stdout);
    assert.equal(typeof inner.percent, 'number',
      'the real progress command ran (proves the engine was reached — not UnknownCommand)');
    assert.equal(parsed.code, 0);
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: an unknown family surfaces ok:false without throwing (not a silent UnknownCommand success)', async () => {
  const dir = createTempDir();
  try {
    const result = await dispatchGsdCommand({ family: 'no-such-family-8675309', cwd: dir });
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, false);
    assert.match(parsed.stderr, /no-such-family-8675309|Unknown command/);
  } finally {
    cleanup(dir);
  }
});

test('dispatchGsdCommand works with default args (no args → gsd-tools.cjs --help, a real working default)', async () => {
  const result = await dispatchGsdCommand();
  assert.equal(typeof result, 'string');
  const parsed = JSON.parse(result); // must be valid JSON
  assert.equal(parsed.ok, true, `expected the --help default to be ok:true, got: ${result}`);
  assert.match(parsed.stdout, /Usage: gsd-tools/, 'the --help default produced real usage output');
});

test('resolveEngineRoot finds the gsd-core/ dir from the extension location', () => {
  const root = resolveEngineRoot(__dirname + '/../vscode');
  const fs = require('fs');
  assert.ok(fs.existsSync(require('path').join(root, 'gsd-core')),
    'resolveEngineRoot finds a dir containing gsd-core/');
});

test('the extension manifest declares the gsd.invoke command', () => {
  const pkg = require('../vscode/package.json');
  assert.ok(pkg.contributes && pkg.contributes.commands, 'manifest has commands');
  const cmd = pkg.contributes.commands.find((c) => c.command === 'gsd.invoke');
  assert.ok(cmd, 'manifest declares gsd.invoke');
  assert.ok(pkg.engines && pkg.engines.vscode, 'manifest declares VS Code engine');
  assert.equal(pkg.main, './extension.js', 'manifest main points to extension.js');
});

// ── #2103 FIX (adversarial review, MAJOR): all three desktop dispatch
// surfaces previously called dispatchGsdCommand WITHOUT a cwd, silently
// defaulting to the extension host's own process.cwd() instead of the user's
// project — meaning GSD ran against the wrong directory. resolveWorkspaceCwd
// resolves vscode.workspace.workspaceFolders[0].uri.fsPath, computed fresh
// per-invocation (never cached at activate() time). ─────────────────────────

test('resolveWorkspaceCwd resolves workspaceFolders[0].uri.fsPath when a workspace is open', () => {
  const mockVscode = { workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/some-workspace' } }] } };
  assert.equal(resolveWorkspaceCwd(mockVscode), '/tmp/some-workspace');
});

test('resolveWorkspaceCwd falls back to process.cwd() when no workspace folder is open (fail-soft, never throws)', () => {
  assert.doesNotThrow(() => {
    assert.equal(resolveWorkspaceCwd({ workspace: { workspaceFolders: [] } }), process.cwd());
    assert.equal(resolveWorkspaceCwd({ workspace: {} }), process.cwd());
    assert.equal(resolveWorkspaceCwd({}), process.cwd());
  });
});

test('#2103 FIX: all three desktop dispatch surfaces (gsd.invoke command, @gsd chat participant, LM tool invoke) thread the resolved workspace folder as cwd — not process.cwd()', async () => {
  // Spy on the SHARED subprocess-shim dispatchGsdCommand (the one every
  // surface ultimately calls via extension.js's own dispatchGsdCommand) so we
  // observe the actual `cwd` each surface passes, without needing a real
  // gsd-tools.cjs project rooted at the mock workspace path.
  const originalShimDispatch = shellCommandProjection.dispatchGsdCommand;
  const calls = [];
  shellCommandProjection.dispatchGsdCommand = (args) => {
    calls.push(args);
    return originalShimDispatch(args);
  };

  const registeredCommands = {};
  let chatHandler = null;
  const toolImpls = [];
  const mockVscode = {
    commands: {
      registerCommand(id, handler) { registeredCommands[id] = handler; return { dispose() {} }; },
    },
    chat: {
      createChatParticipant(id, handler) { chatHandler = handler; return { id, dispose() {} }; },
    },
    lm: {
      registerTool(name, impl) { toolImpls.push({ name, impl }); return { dispose() {} }; },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/tmp/mock-gsd-workspace' } }],
      getConfiguration: () => ({ get: () => undefined }),
    },
    LanguageModelTextPart: class { constructor(t) { this.text = t; } },
    LanguageModelToolResult: class { constructor(parts) { this.parts = parts; } },
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.call(this, request, ...rest);
  };

  const extensionPath = path.join(__dirname, '..', 'vscode', 'extension.js');
  const hostBindingPath = path.join(__dirname, '..', 'vscode', 'host-binding.js');
  try {
    delete require.cache[extensionPath];
    delete require.cache[hostBindingPath];
    const freshExtension = require(extensionPath);
    const context = {
      subscriptions: [],
      globalState: { get: () => undefined, update: () => Promise.resolve() },
    };
    freshExtension.activate(context);

    // Surface 1: gsd.invoke command handler.
    calls.length = 0;
    await registeredCommands['gsd.invoke']({ family: 'progress', subcommand: 'json' });
    assert.equal(calls.length, 1, 'gsd.invoke handler must dispatch exactly once');
    assert.equal(calls[0].cwd, '/tmp/mock-gsd-workspace', 'gsd.invoke must thread the workspace folder as cwd');

    // Surface 1b: an explicit args.cwd still takes precedence over the resolved workspace.
    calls.length = 0;
    await registeredCommands['gsd.invoke']({ family: 'progress', subcommand: 'json', cwd: '/explicit/override' });
    assert.equal(calls[0].cwd, '/explicit/override', 'an explicit cwd argument must still override the resolved workspace folder');

    // Surface 2: @gsd chat participant handler.
    calls.length = 0;
    let markdownOut = '';
    await chatHandler({ prompt: 'progress json' }, {}, { markdown: (t) => { markdownOut += t; } }, {});
    assert.equal(calls.length, 1, 'the chat participant handler must dispatch exactly once');
    assert.equal(calls[0].cwd, '/tmp/mock-gsd-workspace', 'the chat participant must thread the workspace folder as cwd');
    assert.ok(markdownOut.length > 0);

    // Surface 3: Language Model Tool invoke().
    calls.length = 0;
    const progressTool = toolImpls.find((t) => t.name === 'gsd_progress');
    assert.ok(progressTool, 'gsd_progress tool must be registered');
    await progressTool.impl.invoke({ input: {} }, {});
    assert.equal(calls.length, 1, 'the LM tool invoke() must dispatch exactly once');
    assert.equal(calls[0].cwd, '/tmp/mock-gsd-workspace', 'the LM tool invoke() must thread the workspace folder as cwd');
  } finally {
    Module._load = originalLoad;
    shellCommandProjection.dispatchGsdCommand = originalShimDispatch;
    delete require.cache[extensionPath];
    delete require.cache[hostBindingPath];
  }
});

'use strict';

/**
 * pi extension reachability test — ADR-1239 Phase D / #1944, upgraded #2102.
 *
 * Proves the pi extension is keystone-WIRED: the registered /gsd command's
 * `handler(args, ctx)` (pi's REAL ExtensionAPI shape — NOT the `execute(ctx)`
 * shape the original #1944 cut used) dispatches through gsd-tools.cjs
 * (subprocess-reuse — dispatchGsdCommand) and returns real output, not just a
 * registration on a mock. This is the "user can invoke X" proof.
 *
 * Dispatch is exercised with a real read-only family/subcommand
 * (progress/json) against a real temp project, matching the sibling
 * tests/vscode-extension-reachability.test.cjs pattern — no fake dispatcher
 * injected, because the whole point of "reachability" is that the real
 * engine is reached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gsdPiExtension = require('../pi/gsd.cjs');
const { _internals } = require('../pi/gsd.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: {} };
  return {
    registerCommand(name, def) { recorded.commands[name] = def; },
    registerTool(def) { if (def && def.name) recorded.tools[def.name] = def; },
    on(event, handler) { (recorded.events[event] = recorded.events[event] || []).push(handler); },
    _recorded: recorded,
  };
}

test('the pi extension registers /gsd (with getArgumentCompletions + handler) + gsd_invoke + the event surface via ExtensionAPI', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const gsdCommand = pi._recorded.commands['gsd'];
  assert.ok(gsdCommand, 'registers /gsd command');
  assert.equal(typeof gsdCommand.handler, 'function', '/gsd registers a handler(args, ctx) — pi\'s REAL ExtensionAPI shape, not execute(ctx)');
  assert.equal(typeof gsdCommand.getArgumentCompletions, 'function', '/gsd registers getArgumentCompletions');
  assert.ok(pi._recorded.tools['gsd_invoke'], 'registers gsd_invoke tool');
  assert.equal(typeof pi._recorded.tools['gsd_invoke'].execute, 'function');
  assert.ok(pi._recorded.events['tool_call'], 'subscribes to tool_call');
  assert.ok(pi._recorded.events['before_provider_request'], 'subscribes to before_provider_request');
});

test('REACHABILITY: parseGsdCommandArgs tokenizes a raw args string into {family, subcommand, args}', () => {
  const parsed = _internals.parseGsdCommandArgs('phase add --name test');
  assert.deepEqual(parsed, { family: 'phase', subcommand: 'add', args: ['--name', 'test'] });
});

test('REACHABILITY: empty args dispatch a working default (gsd-tools.cjs --help), not the broken "query help"', () => {
  const parsed = _internals.parseGsdCommandArgs('');
  assert.equal(parsed.family, '--help');
  assert.equal(parsed.subcommand, undefined);
});

test('REACHABILITY: the /gsd handler dispatches a real family through gsd-tools.cjs and returns real output (keystone wired)', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    const result = await pi._recorded.commands['gsd'].handler('progress json', { cwd: dir });
    // #2991: handler returns { content: [{ type: 'text', text }] } (Pi's display shape), not a bare string.
    assert.ok(result && Array.isArray(result.content) && result.content[0].type === 'text',
      `/gsd handler must return Pi's display shape { content: [{ type: 'text', text }] }; got: ${JSON.stringify(result).slice(0, 200)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(typeof parsed.percent, 'number', '/gsd dispatch reached gsd-tools.cjs for real (the engine was reached)');
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: an unknown family surfaces a clear GSD error, not a throw', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    const result = await pi._recorded.commands['gsd'].handler('no-such-family-8675309', { cwd: dir });
    // #2991: handler returns { content: [{ type: 'text', text }] } (Pi's display shape).
    assert.ok(result && Array.isArray(result.content) && result.content[0].type === 'text',
      `error result must carry Pi's display shape; got: ${JSON.stringify(result).slice(0, 200)}`);
    const text = result.content[0].text;
    assert.match(text, /GSD error:/);
    assert.match(text, /no-such-family-8675309|Unknown command/);
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: the gsd_invoke tool dispatches through the engine and returns real content', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    const result = await pi._recorded.tools['gsd_invoke'].execute(
      'call-1',
      { family: 'progress', subcommand: 'json' },
      null,
      null,
      { cwd: dir },
    );
    assert.ok(result && Array.isArray(result.content), 'gsd_invoke returns {content:[...]}');
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(typeof parsed.percent, 'number', 'gsd_invoke dispatch reached gsd-tools.cjs for real');
  } finally {
    cleanup(dir);
  }
});

test('gsd_invoke rejects a missing "family" without dispatching', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = await pi._recorded.tools['gsd_invoke'].execute('call-2', {}, null, null, {});
  assert.match(result.content[0].text, /requires a non-empty string "family"/);
});

test('gsdPiExtension throws without pi ExtensionAPI (fail-closed)', () => {
  assert.throws(() => gsdPiExtension(null), /ExtensionAPI is required/);
});

'use strict';

/**
 * pi extension reachability test — ADR-1239 Phase D / #1944, upgraded #2102.
 *
 * Proves the pi extension is keystone-WIRED: the registered /gsd command's
 * `handler(args, ctx)` (pi's REAL ExtensionAPI shape — NOT the `execute(ctx)`
 * shape the original #1944 cut used) dispatches through gsd-tools.cjs
 * (subprocess-reuse — dispatchGsdCommand) and renders real output through
 * `ctx.ui.notify` (#3456 — Pi discards command-handler return values), not
 * just a registration on a mock. This is the "user can invoke X" proof.
 *
 * Dispatch is exercised with a real read-only family/subcommand
 * (progress/json) against a real temp project, matching the sibling
 * tests/vscode-extension-reachability.test.cjs pattern — no fake dispatcher
 * injected, because the whole point of "reachability" is that the real
 * engine is reached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

// #3456: Pi's command dispatcher does `await command.handler(args, ctx);
// return true;` — it DISCARDS the handler's return value in any shape. The
// only command-output mechanism Pi consumes is `ctx.ui.notify(message, type)`
// (earendil-works/pi docs: extensions.md#piregistercommandname-options). The
// #3097 tests asserted on the discarded return object, so they passed while
// `/gsd` stayed mute in real Pi. These tests invoke the handler exactly as
// Pi's dispatcher does (await + discard) and assert the notify side effect.
function makePiCtx(dir) {
  const notifications = [];
  return {
    ctx: {
      cwd: dir,
      ui: {
        notify(message, type) { notifications.push({ message, type }); },
      },
    },
    notifications,
  };
}

test('REACHABILITY: the /gsd handler dispatches a real family through gsd-tools.cjs and renders output via ctx.ui.notify (keystone wired)', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): a free-form ROADMAP.md (no version
    // token) is COMPLETE scope for windowing (§7.1) — without this, a
    // bare temp dir has no ROADMAP.md at all (UNREADABLE) and `percent`
    // is withheld (null), breaking this reachability proxy.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const { ctx, notifications } = makePiCtx(dir);
    // Invoke EXACTLY as Pi's dispatcher does: await, then discard the return.
    const returned = await pi._recorded.commands['gsd'].handler('progress json', ctx);
    assert.equal(notifications.length, 1, `/gsd must push exactly one ui.notify; got ${notifications.length}`);
    assert.equal(notifications[0].type, 'info', 'successful dispatch notifies with type "info"');
    const parsed = JSON.parse(notifications[0].message);
    assert.equal(typeof parsed.percent, 'number', '/gsd dispatch reached gsd-tools.cjs for real (the engine was reached)');
    assert.equal(returned, undefined, 'the handler return value is the boundary Pi discards — the output must travel via ctx.ui.notify, not a return (#3456)');
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: an unknown family renders a clear GSD error via ctx.ui.notify, not a throw', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    const { ctx, notifications } = makePiCtx(dir);
    const returned = await pi._recorded.commands['gsd'].handler('no-such-family-8675309', ctx);
    assert.equal(notifications.length, 1, `failed dispatch must push exactly one ui.notify; got ${notifications.length}`);
    assert.equal(notifications[0].type, 'error', 'failed dispatch notifies with type "error"');
    assert.match(notifications[0].message, /GSD error:/);
    assert.match(notifications[0].message, /no-such-family-8675309|Unknown command/);
    assert.equal(returned, undefined, 'the error text must travel via ctx.ui.notify, not the discarded return (#3456)');
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: the /gsd handler tolerates a ctx without ui (older Pi host) without throwing', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    // No assert on output — a host without ctx.ui has no renderable channel;
    // this only proves the handler does not crash such a host.
    await pi._recorded.commands['gsd'].handler('progress json', { cwd: dir });
  } finally {
    cleanup(dir);
  }
});

test('REACHABILITY: the gsd_invoke tool dispatches through the engine and returns real content', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const dir = createTempDir();
  try {
    // #3217 (ADR-3180 §7.6 rule 4): see the /gsd handler reachability test
    // above — a bare temp dir has no ROADMAP.md (UNREADABLE), withholding
    // `percent`.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
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

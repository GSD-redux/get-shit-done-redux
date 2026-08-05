'use strict';
/**
 * Tests for the companion MCP server (ADR-1239 Phase C-2, #1681 slice 3a).
 * Pins: initialize handshake, tools/list, tools/call dispatch to the hub +
 * stateIO seam, method-not-found, notification = no response, parse error in
 * runServer, and a full injectable-stream round-trip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const {
  handleMessage,
  runServer,
  PROTOCOL_VERSION,
  SERVER_NAME,
} = require('../gsd-core/bin/lib/mcp-server.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

test('initialize: returns protocolVersion + capabilities + serverInfo', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.strictEqual(res.jsonrpc, '2.0');
  assert.strictEqual(res.id, 1);
  assert.strictEqual(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(res.result.capabilities && res.result.capabilities.tools, 'must advertise tools capability');
  assert.strictEqual(res.result.serverInfo.name, SERVER_NAME);
});

test('tools/list: advertises the 3 interface-point tools', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names.sort(), ['gsd_invoke_command', 'gsd_read_state', 'gsd_write_state']);
});

test('tools/call gsd_read_state + gsd_write_state: round-trip through the stateIO seam (point 5)', () => {
  const dir = createTempDir();
  try {
    const file = path.join(dir, 'STATE.md');
    const writeRes = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gsd_write_state', arguments: { path: file, content: '# State\n' } } });
    assert.strictEqual(writeRes.result.isError, undefined, 'write must succeed');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# State\n', 'write went through to fs');
    const readRes = handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gsd_read_state', arguments: { path: file } } });
    assert.strictEqual(readRes.result.content[0].text, '# State\n', 'read returns the written content');
  } finally {
    cleanup(dir);
  }
});

test('tools/call gsd_invoke_command: dispatches to the command hub (point 1); unknown family returns a hub error, not a crash', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: { family: 'no-such-family', subcommand: 'x' } } }, { cwd: createTempDirClean() });
  // The hub returns a structured result (ok:false unknown-command) surfaced as text content, not a JSON-RPC error.
  assert.strictEqual(res.jsonrpc, '2.0');
  const payload = JSON.parse(res.result.content[0].text);
  assert.strictEqual(payload.ok, false, 'an unknown command dispatches to the hub and returns ok:false');
  assert.strictEqual(res.result.isError, true, 'unknown family surfaces as isError:true (#2102)');
});

// REGRESSION #2102: gsd_invoke_command previously called
// `commandRoutingHub.createHub()` with NO arguments, which always hits
// `if (!_cjsRegistry) return makeUnknownCommand()` — every dispatch, valid
// family or not, returned UnknownCommand. The test above (family:
// 'no-such-family') could not catch this: an UnknownCommand result is
// EXACTLY what an unknown family is supposed to return, whether or not
// dispatch actually worked — it is vacuous by construction. This test proves
// the fix: a VALID read-only family/subcommand must reach gsd-tools.cjs for
// real and come back with actual data (not a crash, not UnknownCommand).
test('tools/call gsd_invoke_command: REGRESSION #2102 — a valid read-only family dispatches for real (not the createHub()-with-no-args UnknownCommand bug)', () => {
  const dir = createTempDir();
  try {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'gsd_invoke_command', arguments: { family: 'progress', subcommand: 'json' } } },
      { cwd: dir },
    );
    assert.strictEqual(res.jsonrpc, '2.0');
    assert.notStrictEqual(res.result.isError, true, 'a valid family must not surface as an error');
    const text = res.result.content[0].text;
    const parsed = JSON.parse(text);
    // Fail-first proof: under the bug, this would be
    // { ok: false, kind: 'UnknownCommand', command: 'progress json' } instead
    // of the real progress payload — `percent` would not exist.
    assert.strictEqual(typeof parsed.percent, 'number', 'the real "progress json" command ran (the engine was reached)');
  } finally {
    cleanup(dir);
  }
});

test('tools/call: unknown tool name surfaces a tool error (isError), not a JSON-RPC protocol error', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gsd_bogus' } });
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown tool/);
});

test('tools/call: missing tool name is a JSON-RPC invalid-params error', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} });
  assert.strictEqual(res.error.code, -32602);
  assert.match(res.error.message, /requires string "name"/);
});

// Previously used 'resources/read' as the example unknown method, but that
// stopped being unknown once the served catalog shipped in #3072.
// 'resources/subscribe' is DELIBERATELY not implemented and deliberately NOT
// advertised in initialize's capabilities, because the server never sends the
// corresponding notification. So this assertion now pins a real contract --
// the advertised capability surface and the implemented method surface agree
// -- rather than an arbitrary method name that a future feature could
// invalidate the same way.
test('unknown method: JSON-RPC method-not-found (-32601)', () => {
  const res = handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/subscribe' });
  assert.strictEqual(res.error.code, -32601);
  assert.match(res.error.message, /Method not found/);
});

test('notification (no id): returns null (no response per JSON-RPC)', () => {
  assert.strictEqual(handleMessage({ jsonrpc: '2.0', method: 'initialize' }), null);
  assert.strictEqual(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('runServer: line-delimited JSON-RPC round-trip over injectable streams', async () => {
  const input = Readable.from([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n',
    'not json\n',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
  ]);
  const out = [];
  const output = { write: (s) => { out.push(s); return true; } };
  await runServer({ input, output });
  const joined = out.join('');
  const responses = joined.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(responses.length, 3);
  assert.strictEqual(responses[0].result.protocolVersion, PROTOCOL_VERSION, 'initialize handled');
  assert.strictEqual(responses[1].error.code, -32700, 'parse error surfaced');
  assert.ok(Array.isArray(responses[2].result.tools), 'tools/list handled');
});

// tiny helper to get a throwaway cwd without polluting the assertion helpers import above
function createTempDirClean() {
  const os = require('node:os');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cwd-'));
}

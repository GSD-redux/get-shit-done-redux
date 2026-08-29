'use strict';
/**
 * Process-lifecycle test for the gsd-mcp-server bin entry (ADR-1239 Phase C-2,
 * #1681 slice 3b / AC4). Spawns the shim, feeds line-delimited JSON-RPC over
 * stdin, asserts stdout responses + clean exit on stdin EOF. Synchronous +
 * bounded (the server exits when stdin closes — no orphan process).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PROTOCOL_VERSION } = require('../gsd-core/bin/lib/mcp-server.cjs');

const SHIM = path.join(__dirname, '..', 'bin', 'gsd-mcp-server.js');

function run(stdin) {
  return spawnSync(process.execPath, [SHIM], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });
}

test('gsd-mcp-server bin: initialize handshake + tools/list over stdio, then clean exit', () => {
  const stdin = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  const res = run(stdin);
  assert.strictEqual(res.status, 0, `clean exit; stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2, 'one response per request');
  assert.strictEqual(lines[0].id, 1);
  assert.strictEqual(lines[0].result.protocolVersion, PROTOCOL_VERSION, 'initialize returns the protocol version');
  assert.ok(Array.isArray(lines[1].result.tools) && lines[1].result.tools.length === 6, 'tools/list advertises the 6 tools');
});

test('gsd-mcp-server bin: a malformed line surfaces a JSON-RPC parse error; the server keeps running', () => {
  const stdin = [
    'this is not json',
    JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' }),
  ].join('\n') + '\n';
  const res = run(stdin);
  assert.strictEqual(res.status, 0, `server survives the bad line; stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines[0].error.code, -32700, 'bad line → JSON-RPC parse error');
  assert.strictEqual(lines[1].result.protocolVersion, PROTOCOL_VERSION, 'subsequent valid request still handled');
});

test('gsd-mcp-server bin: empty/whitespace-only stdin → clean exit, no output', () => {
  const res = run('\n  \n');
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '', 'no requests → no responses');
});

test('gsd-mcp-server bin: handles a final frame without a newline', () => {
  const res = run(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'initialize' }));
  assert.strictEqual(res.status, 0, `clean exit; stderr: ${res.stderr}`);
  assert.strictEqual(JSON.parse(res.stdout).id, 11);
});

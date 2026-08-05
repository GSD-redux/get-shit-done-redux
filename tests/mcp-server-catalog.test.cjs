'use strict';

/**
 * Failing-first protocol-surface tests for the MCP served catalog — issue
 * #3072 (epic #1671 Phase B), `.gsd/phase/feat-3072-mcp-served-catalog/
 * 40-design.md`.
 *
 * Covers 50-test-matrix.md rows 1-3 and 31-36: `resources`/`prompts`
 * capability advertisement, tool-surface independence, and the
 * `prompts/list` / `prompts/get` JSON-RPC surface — all exercised through
 * `handleMessage` (`src/mcp-server.cts`, compiled to
 * `gsd-core/bin/lib/mcp-server.cjs`), mirroring `tests/gsd-mcp-server.test.cjs`'s
 * own structure and require path.
 *
 * `handleMessage` does not yet route `resources/*`/`prompts/*` at all — every
 * such request currently falls through to the generic `METHOD_NOT_FOUND`
 * (-32601) default case. Rows that expect a SPECIFIC refusal (not just "any
 * error") therefore assert the JSON-RPC error code is NOT -32601, so the
 * assertion cannot pass by accident against today's blanket fallthrough
 * (rows 33, 35). No source-grep (CONTRIBUTING.md): every assertion is on
 * typed JSON-RPC response fields, never on rendered prose.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage } = require('../gsd-core/bin/lib/mcp-server.cjs');

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ─── initialize / capabilities (rows 1-3) ───────────────────────────────────

describe('initialize / capabilities', () => {
  test('initialize advertises resources and prompts (row 1)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.ok(res.result, 'initialize must succeed');
    const caps = res.result.capabilities;
    assert.ok(caps && typeof caps.tools === 'object', 'capabilities.tools must remain declared');
    assert.ok(caps && typeof caps.resources === 'object', 'capabilities.resources must be declared alongside tools');
    assert.ok(caps && typeof caps.prompts === 'object', 'capabilities.prompts must be declared alongside tools');
  });

  test('initialize does not advertise unimplemented notifications (row 2)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const resourcesCap = res.result && res.result.capabilities && res.result.capabilities.resources;
    assert.ok(resourcesCap && typeof resourcesCap === 'object', 'capabilities.resources must exist before its shape can be checked');
    assert.equal(Object.prototype.hasOwnProperty.call(resourcesCap, 'subscribe'), false, 'resources capability must not declare subscribe — nothing ever sends the notification');
    assert.equal(Object.prototype.hasOwnProperty.call(resourcesCap, 'listChanged'), false, 'resources capability must not declare listChanged — nothing ever sends the notification');
  });

  test('catalog addition does not disturb the tool surface (row 3)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(res.result, 'tools/list must succeed');
    const names = res.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['gsd_invoke_command', 'gsd_read_state', 'gsd_write_state']);
  });
});

// ─── prompts (rows 31-36) ────────────────────────────────────────────────────

describe('prompts — protocol surface', () => {
  test('lists commands as prompts by bare name (row 31)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    assert.equal(res.error, undefined, 'prompts/list must not error');
    assert.ok(res.result && Array.isArray(res.result.prompts), 'result.prompts must be an array');
    assert.equal(res.result.prompts.length, 71, 'must list all 71 commands/gsd/*.md as prompts');
    for (const p of res.result.prompts) {
      assert.equal(typeof p.name, 'string');
      assert.equal(p.name.includes('/'), false, 'name must be the bare command, not a path');
      assert.equal(p.name.endsWith('.md'), false, 'name must not carry the .md extension');
    }
  });

  test('gets a prompt in message form (row 32)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'plan-phase' } });
    assert.equal(res.error, undefined, 'prompts/get on a known name must not error');
    assert.equal(typeof res.result.description, 'string');
    assert.ok(Array.isArray(res.result.messages) && res.result.messages.length >= 1);
    const msg = res.result.messages[0];
    assert.equal(msg.role, 'user');
    assert.equal(msg.content.type, 'text');
    assert.equal(typeof msg.content.text, 'string');
  });

  test('unknown prompt name errors (row 33)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'not-a-real-command-xyz' } });
    assert.ok(res.error, 'an unknown prompt name must produce a JSON-RPC error, not a success');
    assert.equal(res.result, undefined);
    assert.notEqual(res.error.code, METHOD_NOT_FOUND, 'must be a semantic unknown-prompt refusal, not merely the current unimplemented-method fallthrough');
  });

  test('arguments are accepted and ignored (row 34)', () => {
    const withoutArgs = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'plan-phase' } });
    const withArgs = handleMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'plan-phase', arguments: { phase: '3' } } });
    assert.equal(withoutArgs.error, undefined, 'prompts/get without arguments must succeed');
    assert.equal(withArgs.error, undefined, 'prompts/get with arguments must be accepted, not rejected');
    assert.deepEqual(withArgs.result, withoutArgs.result, 'no command template takes injected arguments today — content must be unchanged');
  });

  test('prompt name is not a path (row 35)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: '../../../etc/passwd' } });
    assert.ok(res.error, 'a path-shaped prompt name must be refused, not treated as a valid lookup key');
    assert.notEqual(res.error.code, METHOD_NOT_FOUND, 'must be a semantic name-is-not-a-path refusal, not merely the current unimplemented-method fallthrough');
  });

  test('missing prompt name is invalid params (row 36)', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: {} });
    assert.ok(res.error, 'a missing required "name" must error');
    assert.equal(res.error.code, INVALID_PARAMS, 'must be JSON-RPC INVALID_PARAMS (-32602)');
  });
});

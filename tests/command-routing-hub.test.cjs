'use strict';

/**
 * Behavioral contract tests for the CommandRoutingHub (issue #3788, #175).
 *
 * #175: mode/sdkLoader/SdkDispatchFailed dropped. Hub always routes CJS.
 *
 * Testing rules in force (CONTRIBUTING.md § Testing Standards):
 *   1. No readFileSync of source files. All assertions are on return values
 *      from the hub's dispatch() function.
 *   2. Stub cjsRegistry / manifest — the hub is the unit under test.
 *      No real SDK load, no real CJS handler invocation (except one integration
 *      path in the phase-command-router migration tests).
 *   3. ERROR_KINDS is a frozen enum. Tests switch on its values, not string literals.
 *   4. Hub must never throw. Every error surface arrives as { ok: false, ... }.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHub,
  ERROR_KINDS,
  makeUnknownCommand,
  makeInvalidArgs,
  makeHandlerRefusal,
  makeHandlerFailure,
} = require('../gsd-core/bin/lib/command-routing-hub.cjs');

// ─── Frozen taxonomy lock ─────────────────────────────────────────────────────
// #175: SdkDispatchFailed and SdkLoadFailed are removed from the closed enum.
// The set shrinks from 6 to 4 values.
const EXPECTED_ERROR_KINDS = Object.freeze(new Set([
  'UnknownCommand',
  'InvalidArgs',
  'HandlerRefusal',
  'HandlerFailure',
]));

describe('CommandRoutingHub — ERROR_KINDS taxonomy', () => {
  test('exports a frozen ERROR_KINDS object', () => {
    assert.ok(Object.isFrozen(ERROR_KINDS), 'ERROR_KINDS must be frozen');
  });

  test('ERROR_KINDS contains exactly the 4 documented values (SdkDispatchFailed and SdkLoadFailed removed)', () => {
    const actual = new Set(Object.values(ERROR_KINDS));
    assert.deepStrictEqual(actual, EXPECTED_ERROR_KINDS);
  });

  test('ERROR_KINDS does NOT contain SdkDispatchFailed', () => {
    assert.ok(!Object.values(ERROR_KINDS).includes('SdkDispatchFailed'),
      'SdkDispatchFailed must not be in ERROR_KINDS after #175');
  });

  test('ERROR_KINDS does NOT contain SdkLoadFailed', () => {
    assert.ok(!Object.values(ERROR_KINDS).includes('SdkLoadFailed'),
      'SdkLoadFailed must not be in ERROR_KINDS after #175');
  });

  test('ERROR_KINDS keys match their values (self-documenting enum)', () => {
    for (const [key, value] of Object.entries(ERROR_KINDS)) {
      assert.equal(key, value, `ERROR_KINDS.${key} should equal '${key}' but got '${value}'`);
    }
  });
});

// ─── createHub validation ──────────────────────────────────────────────────────
// #175: mode param is removed. Hub is constructed without mode.

describe('CommandRoutingHub — createHub validation', () => {
  test('constructs successfully without any mode parameter', () => {
    // Hub no longer requires mode — no throw when mode is absent
    const hub = createHub({ cjsRegistry: {} });
    assert.ok(typeof hub.dispatch === 'function');
  });

  test('mode parameter is ignored — passing mode: sdk does not route to SDK', () => {
    // Even if a legacy caller passes mode:'sdk', the hub must use CJS dispatch.
    const cjsCalls = [];
    const hub = createHub({
      mode: 'sdk',
      cjsRegistry: {
        phase: {
          add: (_ctx) => { cjsCalls.push(true); return { ok: true, data: 'cjs-dispatched' }; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    // Must route through CJS, not SDK
    assert.ok(result.ok, `Expected ok:true but got: ${JSON.stringify(result)}`);
    assert.equal(result.data, 'cjs-dispatched', 'Hub must dispatch through CJS regardless of mode parameter');
    assert.equal(cjsCalls.length, 1, 'CJS handler must be called exactly once');
  });

  test('mode parameter is ignored — passing mode: cjs also routes through CJS', () => {
    const cjsCalls = [];
    const hub = createHub({
      mode: 'cjs',
      cjsRegistry: {
        state: {
          load: (_ctx) => { cjsCalls.push(true); return { ok: true, data: 'state-loaded' }; },
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, 'state-loaded');
    assert.equal(cjsCalls.length, 1);
  });

  test('sdkLoader parameter is inert — passing sdkLoader does not cause SDK dispatch', () => {
    // sdkLoader is removed; passing it must not cause the Hub to call it
    const sdkCalls = [];
    const hub = createHub({
      sdkLoader: () => { sdkCalls.push(true); return () => ({ ok: true, data: 'sdk-data' }); },
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({ ok: true, data: 'cjs-data' }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.equal(sdkCalls.length, 0, 'sdkLoader must never be called — it is removed in #175');
    assert.ok(result.ok);
    assert.equal(result.data, 'cjs-data');
  });

});

// ─── Happy path — always CJS ──────────────────────────────────────────────────

describe('CommandRoutingHub — happy path, CJS dispatch', () => {
  test('dispatch returns { ok: true, data } from CJS handler result', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          complete: (_ctx) => ({ ok: true, data: { completed: true } }),
        },
      },
      manifest: { phase: ['complete'] },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'complete', args: ['01'], cwd: '/tmp', raw: false });

    assert.ok(result.ok);
    assert.deepEqual(result.data, { completed: true });
  });

  test('dispatch passes full context to CJS handler', () => {
    const received = [];
    const hub = createHub({
      cjsRegistry: {
        roadmap: {
          analyze: (ctx) => { received.push(ctx); return { ok: true, data: null }; },
        },
      },
    });

    hub.dispatch({ family: 'roadmap', subcommand: 'analyze', args: ['--verbose'], cwd: '/myproj', raw: true });

    assert.equal(received.length, 1);
    assert.equal(received[0].family, 'roadmap');
    assert.equal(received[0].subcommand, 'analyze');
    assert.deepEqual(received[0].args, ['--verbose']);
    assert.equal(received[0].cwd, '/myproj');
    assert.equal(received[0].raw, true);
  });

  test('handler returning undefined is treated as ok:true with data:null', () => {
    const hub = createHub({
      cjsRegistry: {
        state: {
          load: (_ctx) => undefined,
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, null);
  });

  test('handler returning a plain value wraps it as data payload', () => {
    const hub = createHub({
      cjsRegistry: {
        verify: {
          check: (_ctx) => 'all-good',
        },
      },
    });

    const result = hub.dispatch({ family: 'verify', subcommand: 'check', args: [], cwd: '/', raw: false });

    assert.ok(result.ok);
    assert.equal(result.data, 'all-good');
  });
});

// ─── kind: UnknownCommand ─────────────────────────────────────────────────────

describe('CommandRoutingHub — kind: UnknownCommand', () => {
  test('unknown family in manifest returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'bogus', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
  });

  test('unknown subcommand in manifest returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'nonexistent', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
  });

  test('missing family in cjsRegistry returns UnknownCommand (no manifest)', () => {
    const hub = createHub({
      cjsRegistry: { state: { load: () => ({ ok: true, data: null }) } },
    });

    const result = hub.dispatch({ family: 'bogus-family', subcommand: 'sub', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
  });

  test('missing subcommand in cjsRegistry returns UnknownCommand', () => {
    const hub = createHub({
      cjsRegistry: { phase: { add: () => ({ ok: true, data: null }) } },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'not-there', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
  });
});

// ─── kind: InvalidArgs ────────────────────────────────────────────────────────

describe('CommandRoutingHub — kind: InvalidArgs', () => {
  test('handler returning InvalidArgs result propagates it', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          insert: (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.InvalidArgs,
            arg: 'phase-number',
            reason: 'phase insert requires a phase number',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'insert', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.InvalidArgs);
    assert.ok(result.reason.includes('phase number'));
  });
});

// ─── kind: HandlerRefusal ─────────────────────────────────────────────────────

describe('CommandRoutingHub — kind: HandlerRefusal', () => {
  test('handler returning HandlerRefusal result propagates it', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          'list-plans': (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.HandlerRefusal,
            reason: 'phase list-plans is not supported in this router.',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'list-plans', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerRefusal);
  });
});

// ─── kind: HandlerFailure ─────────────────────────────────────────────────────

describe('CommandRoutingHub — kind: HandlerFailure', () => {
  test('hub does not throw when CJS handler throws — returns HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw new Error('handler blew up'); },
        },
      },
    });

    let result;
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'phase', subcommand: 'add', args: ['desc'], cwd: '/', raw: false });
    });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.message.includes('handler blew up'));
  });

  test('HandlerFailure cause carries the thrown error', () => {
    const originalError = new Error('boom');
    const hub = createHub({
      cjsRegistry: {
        state: {
          load: (_ctx) => { throw originalError; },
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.strictEqual(result.cause, originalError);
  });
});

// ─── hub never throws ─────────────────────────────────────────────────────────

describe('CommandRoutingHub — hub never throws', () => {
  test('hub does not throw even when cjsRegistry is completely absent', () => {
    const hub = createHub({});

    let result;
    assert.doesNotThrow(() => {
      result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
  });

  test('hub does not throw when dispatch receives malformed request', () => {
    const hub = createHub({ cjsRegistry: {} });

    let result;
    assert.doesNotThrow(() => {
      // Missing family — would normally throw on string ops
      result = hub.dispatch({ family: undefined, subcommand: 'add', args: [], cwd: '/', raw: false });
    });

    // Result is an error, not a thrown exception
    assert.ok(!result.ok);
  });
});

// ─── P1.2: Typed-payload discriminated union (#176) ──────────────────────────
// Each error variant carries ONLY its own typed payload.
// `errorKind` field renamed to `kind`; generic `message`/`details` removed
// from variants that have dedicated fields.

describe('CommandRoutingHub — P1.2 typed-payload discriminated union (#176)', () => {
  // ── UnknownCommand: { ok, kind, command } — no message, no details ──────────
  test('UnknownCommand has exactly { ok, kind, command } — nothing else', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'bogus', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
    assert.equal(typeof result.command, 'string');
    assert.ok(result.command.length > 0, 'command field must be non-empty');
    // Strict field set — no errorKind, no message, no details
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['command', 'kind', 'ok']);
  });

  test('UnknownCommand for unknown subcommand carries the command string', () => {
    const hub = createHub({
      cjsRegistry: {},
      manifest: { phase: ['add'] },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'nonexistent', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
    assert.ok(result.command.includes('nonexistent'), `Expected command to include 'nonexistent', got: ${result.command}`);
  });

  test('UnknownCommand from missing cjsRegistry family carries the command string', () => {
    const hub = createHub({
      cjsRegistry: { state: { load: () => ({ ok: true, data: null }) } },
    });

    const result = hub.dispatch({ family: 'bogus-family', subcommand: 'sub', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.UnknownCommand);
    assert.ok(result.command.includes('bogus-family'), `Expected command to include 'bogus-family', got: ${result.command}`);
  });

  // ── InvalidArgs: { ok, kind, arg, reason } — no message, no details ─────────
  test('InvalidArgs result from handler is propagated with kind/arg/reason fields', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          insert: (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.InvalidArgs,
            arg: '--dry-run',
            reason: 'phase insert does not support --dry-run',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'insert', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.InvalidArgs);
    assert.equal(result.arg, '--dry-run');
    assert.ok(result.reason.includes('--dry-run'));
    // Strict field set
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['arg', 'kind', 'ok', 'reason']);
  });

  // ── HandlerRefusal: { ok, kind, reason } — no message, no details ────────────
  test('HandlerRefusal result from handler is propagated with kind/reason fields', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          'list-plans': (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.HandlerRefusal,
            reason: 'phase list-plans is not supported in this router.',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'list-plans', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerRefusal);
    assert.ok(result.reason.includes('not supported'));
    // Strict field set
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['kind', 'ok', 'reason']);
  });

  // ── HandlerFailure: { ok, kind, message, cause? } — cause carries the Error ──
  test('HandlerFailure from throw has { ok, kind, message, cause } — no details', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw new Error('handler blew up'); },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: ['desc'], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.message.includes('handler blew up'));
    assert.ok(result.cause instanceof Error);
    // Strict field set (cause present when Error thrown)
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['cause', 'kind', 'message', 'ok']);
  });

  test('HandlerFailure cause carries the original thrown Error object', () => {
    const originalError = new Error('boom');
    const hub = createHub({
      cjsRegistry: {
        state: {
          load: (_ctx) => { throw originalError; },
        },
      },
    });

    const result = hub.dispatch({ family: 'state', subcommand: 'load', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.strictEqual(result.cause, originalError);
  });

  // ── ERROR_KINDS values used as `kind` discriminator — still work ─────────────
  test('ERROR_KINDS values are stable string constants matching their key names', () => {
    assert.equal(ERROR_KINDS.UnknownCommand, 'UnknownCommand');
    assert.equal(ERROR_KINDS.InvalidArgs, 'InvalidArgs');
    assert.equal(ERROR_KINDS.HandlerRefusal, 'HandlerRefusal');
    assert.equal(ERROR_KINDS.HandlerFailure, 'HandlerFailure');
  });
});

// ─── No SDK path — single-dispatch invariant ──────────────────────────────────
// #175: Hub is always CJS. There is no SDK path to fall through to.

describe('CommandRoutingHub — single CJS dispatch invariant (#175)', () => {
  test('two dispatches through the same hub produce consistent CJS results', () => {
    const calls = [];
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { calls.push('add'); return { ok: true, data: 'added' }; },
          complete: (_ctx) => { calls.push('complete'); return { ok: true, data: 'done' }; },
        },
      },
    });

    const r1 = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    const r2 = hub.dispatch({ family: 'phase', subcommand: 'complete', args: [], cwd: '/', raw: false });

    assert.ok(r1.ok);
    assert.equal(r1.data, 'added');
    assert.ok(r2.ok);
    assert.equal(r2.data, 'done');
    assert.deepEqual(calls, ['add', 'complete']);
  });

  test('manifest check still applies in CJS-only hub', () => {
    const hub = createHub({
      cjsRegistry: { phase: { add: () => ({ ok: true, data: null }) } },
      manifest: { phase: ['add'] },
    });

    const known = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });
    const unknown = hub.dispatch({ family: 'phase', subcommand: 'nonexistent', args: [], cwd: '/', raw: false });

    assert.ok(known.ok);
    assert.ok(!unknown.ok);
    assert.equal(unknown.kind, ERROR_KINDS.UnknownCommand);
  });
});

// ─── P1.2 Review Finding 1: Hub runtime-validates ok:false handler returns ────
// A handler that returns { ok: false, kind: 'InvalidArgs', message: 'oops' }
// (missing `reason`, has stray `message`) must NOT pass through unchanged.
// Hub must coerce it to a HandlerFailure with a contract-violation message.

describe('CommandRoutingHub — Finding 1: runtime-validation of handler ok:false returns', () => {
  test('malformed InvalidArgs return (missing reason, has stray message) is coerced to HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({
            ok: false,
            kind: 'InvalidArgs',
            message: 'oops',  // wrong: should be reason, not message
            // missing: arg, reason
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok, 'result must be an error');
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure,
      `Expected HandlerFailure but got kind: ${result.kind}`);
    assert.ok(
      result.message.includes('malformed') || result.message.includes('contract') ||
      result.message.includes('InvalidArgs') || result.message.includes('reason'),
      `Expected contract-violation message, got: ${result.message}`
    );
  });

  test('malformed HandlerRefusal return (missing reason) is coerced to HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({
            ok: false,
            kind: 'HandlerRefusal',
            message: 'refuse',  // wrong: should be reason
            // missing: reason
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
  });

  test('malformed HandlerFailure return (missing message) is coerced to HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({
            ok: false,
            kind: 'HandlerFailure',
            // missing: message
            details: 'something',  // extraneous
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
  });

  test('well-formed InvalidArgs return is NOT coerced — passes through unchanged', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({
            ok: false,
            kind: 'InvalidArgs',
            arg: '--dry-run',
            reason: 'not supported',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.InvalidArgs);
    assert.equal(result.arg, '--dry-run');
    assert.equal(result.reason, 'not supported');
  });

  test('unknown kind in ok:false return is coerced to HandlerFailure', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => ({
            ok: false,
            kind: 'SomeLegacyKind',
            errorKind: 'SomeLegacyKind',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
  });
});

// ─── P1.2 Review Finding 2: Non-Error throws preserve the original throwable ──
// When a handler throws a non-Error (plain object, string, number), the Hub must
// wrap it in an Error and attach .thrown = originalValue.

describe('CommandRoutingHub — Finding 2: non-Error throws preserve original throwable', () => {
  test('handler throwing a plain object → HandlerFailure with cause.thrown === original', () => {
    const thrown = { custom: 'payload', code: 42 };
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw thrown; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.cause instanceof Error,
      `result.cause must be an Error, got: ${typeof result.cause}`);
    assert.strictEqual(result.cause.thrown, thrown,
      'cause.thrown must be the original thrown object');
  });

  test('handler throwing a string → HandlerFailure with cause.thrown === original string', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw 'just a string'; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.cause instanceof Error,
      `result.cause must be an Error, got: ${typeof result.cause}`);
    assert.strictEqual(result.cause.thrown, 'just a string',
      'cause.thrown must be the original thrown string');
  });

  test('handler throwing a number → HandlerFailure with cause.thrown === original number', () => {
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw 404; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.ok(result.cause instanceof Error);
    assert.strictEqual(result.cause.thrown, 404);
  });

  test('handler throwing a real Error still works — cause is the Error itself (no .thrown wrapping)', () => {
    const original = new Error('real error');
    const hub = createHub({
      cjsRegistry: {
        phase: {
          add: (_ctx) => { throw original; },
        },
      },
    });

    const result = hub.dispatch({ family: 'phase', subcommand: 'add', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.HandlerFailure);
    assert.strictEqual(result.cause, original, 'Error throws must have cause === original Error');
    // No .thrown on real Error cause
    assert.equal(result.cause.thrown, undefined);
  });
});

// ─── P1.2 Review Finding 3: Factory returns are Object.frozen ─────────────────
// Each makeXxx factory must return a frozen object so callers cannot mutate
// the variant invariant.

describe('CommandRoutingHub — Finding 3: factory returns are Object.frozen', () => {
  test('makeUnknownCommand returns a frozen object', () => {
    const result = makeUnknownCommand('phase bogus');
    assert.ok(Object.isFrozen(result),
      'makeUnknownCommand must return a frozen object');
  });

  test('makeInvalidArgs returns a frozen object', () => {
    const result = makeInvalidArgs('--dry-run', 'not supported');
    assert.ok(Object.isFrozen(result),
      'makeInvalidArgs must return a frozen object');
  });

  test('makeHandlerRefusal returns a frozen object', () => {
    const result = makeHandlerRefusal('not supported');
    assert.ok(Object.isFrozen(result),
      'makeHandlerRefusal must return a frozen object');
  });

  test('makeHandlerFailure returns a frozen object', () => {
    const result = makeHandlerFailure('something broke', new Error('orig'));
    assert.ok(Object.isFrozen(result),
      'makeHandlerFailure must return a frozen object');
  });

  test('frozen factory results cannot be mutated', () => {
    const result = makeUnknownCommand('phase bogus');
    // In strict mode, mutation of a frozen object throws TypeError
    assert.throws(
      () => { result.command = 'tampered'; },
      TypeError,
      'Mutating a frozen factory result must throw TypeError'
    );
  });
});

// ─── P1.2 Review Finding 4: makeHandlerFailure wraps non-Error causes ─────────
// If cause is provided but is not an Error, wrap it so .cause instanceof Error.
// Attach .thrown = originalCause so it is not silently dropped.

describe('CommandRoutingHub — Finding 4: makeHandlerFailure wraps non-Error causes', () => {
  test('makeHandlerFailure("msg", "string-cause") → cause instanceof Error', () => {
    const result = makeHandlerFailure('msg', 'string-cause');
    assert.ok(result.cause instanceof Error,
      `cause must be an Error, got: ${typeof result.cause}`);
  });

  test('makeHandlerFailure("msg", "string-cause") → cause.thrown === "string-cause"', () => {
    const result = makeHandlerFailure('msg', 'string-cause');
    assert.strictEqual(result.cause.thrown, 'string-cause',
      'cause.thrown must be the original non-Error cause');
  });

  test('makeHandlerFailure with a plain object cause → cause instanceof Error with .thrown', () => {
    const obj = { code: 42, detail: 'bad' };
    const result = makeHandlerFailure('msg', obj);
    assert.ok(result.cause instanceof Error);
    assert.strictEqual(result.cause.thrown, obj);
  });

  test('makeHandlerFailure with a real Error cause → cause is the original Error (no wrapping)', () => {
    const original = new Error('real');
    const result = makeHandlerFailure('msg', original);
    assert.strictEqual(result.cause, original,
      'Real Error causes must not be wrapped');
  });

  test('makeHandlerFailure without cause → result.cause is undefined', () => {
    const result = makeHandlerFailure('msg');
    assert.equal(result.cause, undefined);
  });

  test('makeHandlerFailure with null cause → behaves as no cause (undefined)', () => {
    // null is not an Error, but "not provided" — treat as absent
    const result = makeHandlerFailure('msg', null);
    // null should not be wrapped into an Error — it's equivalent to "no cause"
    assert.equal(result.cause, undefined);
  });
});

// ─── Amendment #1642: exitReason? field on InvalidArgs (Phase 1, #1644) ───────
// The optional exitReason? field carries an ERROR_REASON enum value separately
// from the existing `reason` explanation text. The factory conditionally adds
// the field only when a truthy third arg is provided, preserving the strict-keys
// invariant tested above (L444).

describe('CommandRoutingHub — exitReason? field on InvalidArgs (#1644 / amendment #1642)', () => {
  test('makeInvalidArgs(arg, reason) 2-arg form omits exitReason key (strict-keys invariant preserved)', () => {
    const result = makeInvalidArgs('--phase', '--phase must be an integer');
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['arg', 'kind', 'ok', 'reason'],
      `2-arg form must NOT include exitReason key; got: ${JSON.stringify(keys)}`);
    assert.equal(result.exitReason, undefined);
  });

  test('makeInvalidArgs(arg, reason, exitReason) 3-arg form includes exitReason key with the value', () => {
    const result = makeInvalidArgs('--phase', '--phase must be an integer', 'USAGE');
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['arg', 'exitReason', 'kind', 'ok', 'reason'],
      `3-arg form must include exitReason key; got: ${JSON.stringify(keys)}`);
    assert.equal(result.exitReason, 'USAGE');
  });

  test('makeInvalidArgs(arg, reason, undefined) treats undefined as absent (omits key)', () => {
    const result = makeInvalidArgs('--phase', '--phase must be an integer', undefined);
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['arg', 'kind', 'ok', 'reason'],
      `undefined exitReason must be omitted; got: ${JSON.stringify(keys)}`);
  });

  test('makeInvalidArgs(arg, reason, "") treats empty string as absent (omits key)', () => {
    const result = makeInvalidArgs('--phase', '--phase must be an integer', '');
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['arg', 'kind', 'ok', 'reason'],
      `empty-string exitReason must be omitted; got: ${JSON.stringify(keys)}`);
  });

  test('3-arg factory result is still frozen', () => {
    const result = makeInvalidArgs('--phase', 'required', 'USAGE');
    assert.ok(Object.isFrozen(result), '3-arg factory result must be frozen');
  });

  test('hub.dispatch propagates handler-returned InvalidArgs with exitReason unchanged', () => {
    const hub = createHub({
      cjsRegistry: {
        unit: {
          check: (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.InvalidArgs,
            arg: '--flag',
            reason: 'not supported',
            exitReason: 'USAGE',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'unit', subcommand: 'check', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.InvalidArgs);
    assert.equal(result.arg, '--flag');
    assert.equal(result.reason, 'not supported');
    assert.equal(result.exitReason, 'USAGE',
      `Hub must propagate exitReason from handler-returned InvalidArgs; got: ${JSON.stringify(result)}`);
  });

  test('hub.dispatch still accepts InvalidArgs WITHOUT exitReason (no contract regression)', () => {
    const hub = createHub({
      cjsRegistry: {
        unit: {
          check: (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.InvalidArgs,
            arg: '--flag',
            reason: 'not supported',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'unit', subcommand: 'check', args: [], cwd: '/', raw: false });

    assert.ok(!result.ok);
    assert.equal(result.kind, ERROR_KINDS.InvalidArgs);
    assert.equal(result.exitReason, undefined,
      `Hub must not synthesize exitReason when handler omits it; got: ${JSON.stringify(result)}`);
  });

  test('hub validator does NOT reject InvalidArgs with exitReason (well-formed extension)', () => {
    // The runtime validator (_validateErrResult) coerces MALFORMED returns to HandlerFailure.
    // A well-formed InvalidArgs with the new exitReason field must NOT be coerced.
    const hub = createHub({
      cjsRegistry: {
        unit: {
          check: (_ctx) => ({
            ok: false,
            kind: ERROR_KINDS.InvalidArgs,
            arg: '--flag',
            reason: 'required',
            exitReason: 'USAGE',
          }),
        },
      },
    });

    const result = hub.dispatch({ family: 'unit', subcommand: 'check', args: [], cwd: '/', raw: false });

    assert.equal(result.kind, ERROR_KINDS.InvalidArgs,
      `Extended InvalidArgs must not be coerced to HandlerFailure; got kind: ${result.kind}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-167-query-meta-command.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-167-query-meta-command (consolidation epic #1969 B2 #1971)", () => {
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// #4342: this ran gsd-tools with runGsdTools's default cwd — the checkout's own
// working directory — and an inherited HOME, so the child read the developer's
// real .planning/config.json and ~/.gsd/defaults.json. On a machine whose real
// project enables workstream mode with no active workstream, `init.progress`
// exits non-zero and the FIRST assertion fails, so the routing comparison this
// test exists for was never reached. testEnvBase() blanks the config-LOCATION
// env keys but sandboxes neither cwd nor HOME.
//
// The routing invariant is about `query <cmd>` and `<cmd>` agreeing, which is
// independent of project state — so the fixture only has to be a project whose
// state is known and unaffected by the developer's.
test('bug #167: query meta-command prefixes direct gsd-tools calls', (t) => {
  const fixture = createTempProject('gsd-4342-routing-');
  t.after(() => cleanup(fixture));
  // HOME/USERPROFILE point at the fixture so ~/.gsd/defaults.json resolves
  // inside it (absent) rather than in the developer's home — the idiom
  // runGsdTools's own doc comment prescribes for exactly this.
  const sandbox = { HOME: fixture, USERPROFILE: fixture };

  const direct = runGsdTools(['init.progress'], fixture, sandbox);
  assert.equal(direct.success, true, `init.progress failed: ${direct.error || direct.output}`);

  const meta = runGsdTools(['query', 'init.progress'], fixture, sandbox);
  assert.equal(meta.success, true, `query init.progress failed: ${meta.error || meta.output}`);

  const directPayload = JSON.parse(direct.output);
  assert.deepEqual(
    JSON.parse(meta.output),
    directPayload,
    'query-prefixed and direct invocations should return identical init.progress payloads'
  );

  // Pin the sandbox itself, deterministically rather than conditionally: the
  // fixture HAS a .planning/ and the repo checkout does NOT, so if the cwd
  // override is ever dropped this fails on every lane — including CI, where the
  // ambient state that exposed the bug is absent.
  assert.equal(directPayload.planning_exists, true,
    'the child must run in the fixture project, not in the checkout');
  assert.equal(directPayload.phase_count, 0,
    'the fixture has no phases — a non-zero count means a real project was read');
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1818-unknown-flags.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1818-unknown-flags (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression test for bug #1818, updated for #3019.
 *
 * Original #1818 invariant: gsd-tools must NOT silently ignore --help/-h
 * and proceed with a destructive command — that turned AI-agent
 * hallucinations into accidental data loss (e.g. `phases clear --help`
 * deleting phase dirs because the flag was dropped).
 *
 * #3019 update: the same destructive-protection invariant still holds,
 * but the response shape changed. Previously --help → non-zero error
 * exit. Now --help → render top-level usage and exit 0 WITHOUT running
 * the command. Both shapes satisfy the original invariant ("the
 * destructive command did not execute"); the new shape also restores
 * subcommand discoverability for `gsd-sdk query <subcommand> --help`.
 *
 * The tests therefore assert two things:
 *   1. The destructive command did NOT run (anti-hallucination invariant).
 *   2. The output contains the top-level usage (#3019 discoverability).
 *
 * --version remains rejected — it's never a valid gsd-tools flag and has
 * no discovery use-case.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup, isUsageOutput } = require('./helpers.cjs');

describe('unknown flag guard (bug #1818, updated for #3019)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── --help renders usage and does NOT run the destructive command ────────

  test('phases clear --help renders usage and does NOT clear phase dirs', () => {
    // Create a sentinel phase dir so we can assert it survives.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'phase-99');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), 'sentinel');

    const result = runGsdTools(['phases', 'clear', '--help'], tmpDir);
    assert.strictEqual(result.success, true, 'help renders, no error exit');
    assert.ok(isUsageOutput(result.output), `expected top-level usage, got: ${result.output}`);
    // Anti-hallucination invariant: the destructive command did NOT run.
    assert.ok(fs.existsSync(phaseDir), 'phase dir must survive — clear must not have executed');
    assert.ok(fs.existsSync(path.join(phaseDir, 'PLAN.md')));
  });

  test('generate-slug hello --help renders usage and does NOT emit a slug', () => {
    const ok = runGsdTools(['generate-slug', 'hello'], tmpDir);
    assert.strictEqual(ok.success, true, 'control: generate-slug works without --help');
    // The control output is just the slug; the help output is the usage.
    const slugOut = ok.output;
    assert.ok(slugOut && !isUsageOutput(slugOut), `control should not be usage: ${slugOut}`);

    const result = runGsdTools(['generate-slug', 'hello', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output), 'help renders top-level usage');
    assert.notEqual(result.output, slugOut, 'help output must differ from the slug — generate-slug must not have run');
  });

  test('phase complete --help renders usage and does NOT mark a phase complete', () => {
    const result = runGsdTools(['phase', 'complete', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
    // success:true + isUsageOutput is sufficient: if the destructive path
    // had executed it would have emitted a phase-resolution error to stderr
    // (success:false), not the usage to stdout (success:true).
  });

  test('state load --help renders usage', () => {
    const result = runGsdTools(['state', 'load', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  // ── -h shorthand: same shape ─────────────────────────────────────────────

  test('phases clear -h renders usage and does NOT clear phase dirs', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'phase-42');
    fs.mkdirSync(phaseDir, { recursive: true });
    const result = runGsdTools(['phases', 'clear', '-h'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
    assert.ok(fs.existsSync(phaseDir), 'phase dir must survive');
  });

  test('generate-slug hello -h renders usage', () => {
    const result = runGsdTools(['generate-slug', 'hello', '-h'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });

  // ── --version is still rejected — no discovery use-case ──────────────────

  test('generate-slug hello --version is rejected', () => {
    const result = runGsdTools(['generate-slug', 'hello', '--version'], tmpDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /--version/);
  });

  // ── current-timestamp --help: same as the others ─────────────────────────

  test('current-timestamp --help renders usage', () => {
    const result = runGsdTools(['current-timestamp', '--help'], tmpDir);
    assert.strictEqual(result.success, true);
    assert.ok(isUsageOutput(result.output));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3255-json-errors-mode.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3255-json-errors-mode (consolidation epic #1969 B2 #1971)", () => {
/**
 * Tests for the --json-errors mode added in #3255.
 *
 * When gsd-tools is invoked with --json-errors, all error() calls emit a
 * structured JSON object to stderr:
 *
 *   { ok: false, reason: "<error_code>", message: "<human text>" }
 *
 * This lets tests assert on typed reason codes instead of grepping free-form
 * stderr text.  All assertions below parse the captured stderr via JSON.parse
 * and inspect typed fields — never result.error.includes() (#2974 / k001).
 *
 * Covered error paths (representative set, each exercises a different branch):
 *   1. Unknown top-level command   → reason: "sdk_unknown_command"
 *   2. Unknown dotted command      → reason: "sdk_unknown_command"
 *   3. Missing required argument   → reason: "usage"  (--pick without value)
 *   4. Config key not found        → reason: "config_key_not_found"
 *   5. Unknown subcommand          → reason: "sdk_unknown_command"
 *   6. GSD_JSON_ERRORS=1 env var   → same structured output without --flag
 *   7. Successful command unaffected
 *   8. Error object shape is stable ({ok, reason, message})
 *   9. Single error line per invocation
 *  10. Unknown flag                → reason: "usage"
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// Helper: run gsd-tools with --json-errors and parse the structured stderr.
// Returns the parsed object, or throws if stderr is not valid JSON.
function runJsonErrors(args, tmpDir, env = {}) {
  const allArgs = ['--json-errors', ...args];
  const result = runGsdTools(allArgs, tmpDir, env);
  // Must have failed
  assert.strictEqual(result.success, false,
    `Expected failure with --json-errors for args: ${args.join(' ')}\nstdout: ${result.output}\nstderr: ${result.error}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(
      `--json-errors must emit valid JSON on stderr.\n` +
      `Args: ${args.join(' ')}\n` +
      `stderr: ${result.error}\n` +
      `parse error: ${e.message}`
    );
  }
  return parsed;
}

describe('feat #3255: --json-errors mode emits structured error objects', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── 1. Unknown top-level command ─────────────────────────────────────────

  test('unknown top-level command emits { ok: false, reason: "sdk_unknown_command" }', () => {
    const parsed = runJsonErrors(['totally-unknown-command-xyzzy'], tmpDir);

    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'sdk_unknown_command',
      `reason must be "sdk_unknown_command", got: ${parsed.reason}`);
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
      'message must be a non-empty string');
  });

  // ── 2. Unknown dotted command ────────────────────────────────────────────

  test('unknown dotted command (foo.bar) emits { ok: false, reason: "sdk_unknown_command" }', () => {
    const parsed = runJsonErrors(['foo.bar'], tmpDir);

    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'sdk_unknown_command',
      `dotted unknown command reason must be "sdk_unknown_command", got: ${parsed.reason}`);
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
      'message must be a non-empty string');
  });

  // ── 3. Missing --pick value ───────────────────────────────────────────────

  test('--pick without value emits { ok: false, reason: "usage" }', () => {
    const parsed = runJsonErrors(['generate-slug', 'test-text', '--pick'], tmpDir);

    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'usage',
      `missing --pick value reason must be "usage", got: ${parsed.reason}`);
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
      'message must be a non-empty string');
  });

  // ── 4. Config key not found ───────────────────────────────────────────────

  test('config-get for absent key emits { ok: false, reason: "config_key_not_found" }', () => {
    // Initialise config.json first so we reach the "key not found" branch
    // rather than the "no config.json" branch.
    runGsdTools(['config-ensure-section'], tmpDir);

    const parsed = runJsonErrors(['config-get', 'nonexistent_config_key_xyzzy'], tmpDir);

    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'config_key_not_found',
      `reason must be "config_key_not_found", got: ${parsed.reason}`);
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
      'message must be a non-empty string');
  });

  // ── 5. Unknown subcommand within a domain ────────────────────────────────

  test('unknown intel subcommand emits { ok: false, reason: "sdk_unknown_command" }', () => {
    const parsed = runJsonErrors(['intel', 'bogus-subcommand-xyzzy'], tmpDir);

    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'sdk_unknown_command',
      `unknown subcommand reason must be "sdk_unknown_command", got: ${parsed.reason}`);
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
      'message must be a non-empty string');
  });

  // ── 6. GSD_JSON_ERRORS=1 env var activates structured mode ───────────────

  test('GSD_JSON_ERRORS=1 env var produces same structured error as --json-errors flag', () => {
    // Run with env var instead of --json-errors flag
    const result = runGsdTools(
      ['totally-unknown-command-xyzzy'],
      tmpDir,
      { GSD_JSON_ERRORS: '1' }
    );
    assert.strictEqual(result.success, false,
      'command must fail');
    let parsed;
    try {
      parsed = JSON.parse(result.error);
    } catch (e) {
      throw new Error(
        `GSD_JSON_ERRORS=1 must emit valid JSON on stderr.\n` +
        `stderr: ${result.error}\n` +
        `parse error: ${e.message}`
      );
    }
    assert.strictEqual(parsed.ok, false,
      'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'sdk_unknown_command',
      `reason must be "sdk_unknown_command", got: ${parsed.reason}`);
  });

  // ── 7. Successful commands are unaffected by --json-errors ───────────────

  test('successful command with --json-errors flag still succeeds normally', () => {
    const result = runGsdTools(
      ['--json-errors', 'generate-slug', 'hello-world'],
      tmpDir
    );
    assert.strictEqual(result.success, true,
      `Successful command must not be broken by --json-errors flag.\nstderr: ${result.error}`);
    assert.ok(result.output.length > 0,
      'stdout must be non-empty for successful generate-slug');
  });

  // ── 8. Error object shape is stable (no extra top-level keys) ────────────

  test('error object contains exactly {ok, reason, message} — no extra keys', () => {
    const parsed = runJsonErrors(['totally-unknown-command-xyzzy'], tmpDir);

    const keys = Object.keys(parsed).sort();
    assert.deepStrictEqual(keys, ['message', 'ok', 'reason'],
      `error object must have exactly {ok, reason, message}. Got keys: ${keys.join(', ')}`);
  });

  // ── 9. Multiple errors in one session: only the first error is emitted ───

  test('only one error JSON line is emitted per invocation (process exits on first error)', () => {
    const result = runGsdTools(
      ['--json-errors', 'totally-unknown-command-xyzzy'],
      tmpDir
    );
    assert.strictEqual(result.success, false, 'must fail');
    const lines = result.error.trim().split('\n').filter(l => l.length > 0);
    assert.strictEqual(lines.length, 1,
      `stderr must contain exactly one JSON line, got ${lines.length}:\n${result.error}`);
    // Also verify the single line is valid JSON
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.ok, false);
  });

  // ── 10. Unknown flag emits { ok: false, reason: "usage" } ────────────────

  test('unknown version flag emits { ok: false, reason: "usage" }', () => {
    const parsed = runJsonErrors(['--version', 'generate-slug', 'x'], tmpDir);

    assert.strictEqual(parsed.ok, false, 'error object must have ok: false');
    assert.strictEqual(parsed.reason, 'usage',
      `--version flag reason must be "usage", got: ${parsed.reason}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3310-followup-typed-codes.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3310-followup-typed-codes (consolidation epic #1969 B2 #1971)", () => {
/**
 * Follow-up tests for #3310: every remaining `error()` call at a subcommand
 * boundary or usage check in `gsd-tools.cjs` carries a typed `ERROR_REASON`.
 *
 * #3304 wired four representative paths (unknown top-level command, unknown
 * intel subcommand, missing --pick value, --version flag). The rest fell
 * through to `ERROR_REASON.UNKNOWN`. This file locks the post-#3310 contract:
 *
 *   - Every "Unknown <subsystem> subcommand" emits reason: "sdk_unknown_command".
 *   - Every "Usage: ..." / missing-required-arg path emits reason: "usage".
 *
 * All assertions parse stderr via JSON.parse — never `.includes()` — per the
 * #2974 / CONTRIBUTING.md "Prohibited: Raw Text Matching" rule.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// Run gsd-tools with GSD_JSON_ERRORS=1 (env-var activation, exercises the
// path #3304 added alongside the --json-errors flag) and parse the
// structured stderr. Returns the parsed object; throws if stderr is not JSON.
function runJsonErrors(args, tmpDir, env = {}) {
  const result = runGsdTools(args, tmpDir, { ...env, GSD_JSON_ERRORS: '1' });
  assert.strictEqual(result.success, false,
    `Expected failure with GSD_JSON_ERRORS=1 for args: ${args.join(' ')}\n` +
    `stdout: ${result.output}\nstderr: ${result.error}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(
      `GSD_JSON_ERRORS=1 must emit valid JSON on stderr.\n` +
      `Args: ${args.join(' ')}\nstderr: ${result.error}\nparse error: ${e.message}`
    );
  }
  return parsed;
}

// Assert the typed-IR contract: object shape + reason. Keeps the per-test
// boilerplate minimal so each error-path test reads as a single fact.
function assertTypedError(parsed, expectedReason, label) {
  assert.strictEqual(parsed.ok, false,
    `${label}: error object must have ok: false`);
  assert.strictEqual(parsed.reason, expectedReason,
    `${label}: reason must be "${expectedReason}", got: ${parsed.reason}`);
  assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
    `${label}: message must be a non-empty string`);
}

describe('feat #3310: typed ERROR_REASON codes on remaining error paths', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Unknown <subsystem> subcommand → SDK_UNKNOWN_COMMAND ────────────────
  // Each of these used to fall through to reason: "unknown" before #3310.

  test('unknown template subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['template', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'template');
  });

  test('unknown frontmatter subcommand → sdk_unknown_command', () => {
    // frontmatter expects subcommand at args[1] and file at args[2]; pass a
    // bogus subcommand with a placeholder file so we definitely reach the
    // unknown-subcommand branch, not an earlier validation.
    const parsed = runJsonErrors(
      ['frontmatter', 'bogus-subcommand-xyzzy', 'placeholder.md'],
      tmpDir
    );
    assertTypedError(parsed, 'sdk_unknown_command', 'frontmatter');
  });

  test('unknown requirements subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['requirements', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'requirements');
  });

  test('unknown milestone subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['milestone', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'milestone');
  });

  test('unknown uat subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['uat', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'uat');
  });

  test('unknown todo subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['todo', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'todo');
  });

  test('unknown workstream subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['workstream', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'workstream');
  });

  test('unknown graphify subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['graphify', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'graphify');
  });

  test('unknown learnings subcommand → sdk_unknown_command', () => {
    const parsed = runJsonErrors(['learnings', 'bogus-subcommand-xyzzy'], tmpDir);
    assertTypedError(parsed, 'sdk_unknown_command', 'learnings');
  });

  // ── Missing required positional/flag values → USAGE ─────────────────────
  // These previously emitted reason: "unknown" because the second argument
  // to error() was absent.

  test('missing --cwd value → usage', () => {
    // The --cwd flag is consumed before the command dispatcher; passing it
    // bare with no following value triggers the usage error at L253/L258.
    const parsed = runJsonErrors(['--cwd'], tmpDir);
    assertTypedError(parsed, 'usage', '--cwd missing value');
  });

  test('invalid --cwd directory → usage', () => {
    // --cwd <nonexistent-path> hits the existsSync / isDirectory check at L264.
    const parsed = runJsonErrors(
      ['--cwd', '/this/path/should/not/exist/anywhere/xyzzy', 'state', 'load'],
      tmpDir
    );
    assertTypedError(parsed, 'usage', 'invalid --cwd directory');
  });

  test('intel query missing term → usage', () => {
    const parsed = runJsonErrors(['intel', 'query'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel query missing term');
  });

  test('intel patch-meta missing file path → usage', () => {
    const parsed = runJsonErrors(['intel', 'patch-meta'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel patch-meta missing file');
  });

  test('intel extract-exports missing file path → usage', () => {
    const parsed = runJsonErrors(['intel', 'extract-exports'], tmpDir);
    assertTypedError(parsed, 'usage', 'intel extract-exports missing file');
  });

  test('graphify query missing term → usage', () => {
    const parsed = runJsonErrors(['graphify', 'query'], tmpDir);
    assertTypedError(parsed, 'usage', 'graphify query missing term');
  });

  test('learnings query missing --tag → usage', () => {
    const parsed = runJsonErrors(['learnings', 'query'], tmpDir);
    assertTypedError(parsed, 'usage', 'learnings query missing --tag');
  });

  test('learnings prune missing --older-than → usage', () => {
    const parsed = runJsonErrors(['learnings', 'prune'], tmpDir);
    assertTypedError(parsed, 'usage', 'learnings prune missing --older-than');
  });

  test('learnings delete missing id → usage', () => {
    const parsed = runJsonErrors(['learnings', 'delete'], tmpDir);
    assertTypedError(parsed, 'usage', 'learnings delete missing id');
  });

  test('extract-messages missing project arg → usage', () => {
    // L877 — args[1] is undefined or starts with '--'.
    const parsed = runJsonErrors(['extract-messages'], tmpDir);
    assertTypedError(parsed, 'usage', 'extract-messages missing project');
  });

  test('write-profile missing --input → usage', () => {
    const parsed = runJsonErrors(['write-profile'], tmpDir);
    assertTypedError(parsed, 'usage', 'write-profile missing --input');
  });

  test('detect-custom-files missing --config-dir → usage', () => {
    const parsed = runJsonErrors(['detect-custom-files'], tmpDir);
    assertTypedError(parsed, 'usage', 'detect-custom-files missing --config-dir');
  });

  test('detect-custom-files invalid --config-dir → usage', () => {
    const parsed = runJsonErrors(
      ['detect-custom-files', '--config-dir', '/nonexistent/path/xyzzy'],
      tmpDir
    );
    assertTypedError(parsed, 'usage', 'detect-custom-files invalid --config-dir');
  });

  // ── Shape regression guard: every newly-typed path emits the canonical
  //    {ok, reason, message} object — no leakage of reason: "unknown". ────

  test('every remaining typed path emits the canonical {ok, reason, message} shape', () => {
    const probes = [
      ['template', 'bogus'],
      ['frontmatter', 'bogus', 'placeholder.md'],
      ['requirements', 'bogus'],
      ['milestone', 'bogus'],
      ['uat', 'bogus'],
      ['todo', 'bogus'],
      ['workstream', 'bogus'],
      ['graphify', 'bogus'],
      ['learnings', 'bogus'],
      ['intel', 'query'],
      ['extract-messages'],
      ['write-profile'],
      ['detect-custom-files'],
    ];
    for (const args of probes) {
      const parsed = runJsonErrors(args, tmpDir);
      const keys = Object.keys(parsed).sort();
      assert.deepStrictEqual(keys, ['message', 'ok', 'reason'],
        `args ${args.join(' ')}: keys must be exactly {ok,reason,message}, got ${keys.join(',')}`);
      assert.notStrictEqual(parsed.reason, 'unknown',
        `args ${args.join(' ')}: reason must be a typed code, not the fallback "unknown"`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-853-bg-dispatch-runtime-gating.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-853-bg-dispatch-runtime-gating (consolidation epic #1969 B2 #1971)", () => {
'use strict';
/**
 * Regression guard — bug(#853): /gsd-manager and /gsd-autonomous --interactive
 * silently skipped worktree isolation + independent verification because they
 * dispatched Plan/Execute via Agent(run_in_background=true). On Claude Code a
 * backgrounded agent has no Agent/Task tool, so it cannot spawn the nested
 * subagents (worktree executors, plan-checker, verifier). The workflows must
 * now resolve dispatch capability from the registry (#1708) and run inline
 * everywhere except runtimes where dispatch.background && dispatch.backgroundDispatch
 * are both true (currently: codex, cursor).
 *
 * Phase B (#1708): the prose `RUNTIME === 'codex'` rule is graduated to a typed
 * `gsd_run query dispatch-should-flatten` query backed by shouldFlattenDispatch()
 * from host-integration.cjs and the documentation-sourced capability registry.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup: cleanupDir, runGsdTools } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
// allow-test-rule: source-text-is-the-product (see #1708)
const MANAGER = fs.readFileSync(path.join(WORKFLOWS_DIR, 'manager.md'), 'utf8');
// allow-test-rule: source-text-is-the-product (see #1708)
const AUTONOMOUS = fs.readFileSync(path.join(WORKFLOWS_DIR, 'autonomous.md'), 'utf8');

describe('bug-853 — manager/autonomous gate background dispatch by runtime', () => {
  test('manager.md resolves dispatch-should-flatten before dispatching plan/execute', () => {
    // Two dispatch sites (plan + execute), each must use dispatch-should-flatten.
    // allow-test-rule: source-text-is-the-product (see #1708)
    const matches = MANAGER.match(/dispatch-should-flatten/g) || [];
    assert.ok(matches.length >= 2, 'manager.md must use dispatch-should-flatten for both plan and execute dispatch');
  });

  test('manager.md documents why most runtimes cannot background-dispatch', () => {
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(MANAGER, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('manager.md gates background dispatch on FLATTEN=false and runs plan/execute inline otherwise', () => {
    // Background path uses FLATTEN is false
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(MANAGER, /If `FLATTEN` is `false`[\s\S]{0,400}?run_in_background=true/);
    // Inline is the default/else branch for plan — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      MANAGER,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the default/else branch for execute — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      MANAGER,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });

  test('manager.md compound action preamble uses FLATTEN language (not hardcoded runtime names)', () => {
    // allow-test-rule: source-text-is-the-product (see #1708)
    const compoundActionSection = MANAGER.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own manager.md content, fixed-size author-controlled content
      /### Compound Action \(background \+ inline\)[\s\S]*?Inline verification:/,
    );
    assert.ok(compoundActionSection, 'manager.md must document compound action runtime dispatch');

    // Must gate on FLATTEN being false (not runtime name)
    assert.match(
      compoundActionSection[0],
      /If `FLATTEN` is `false`[\s\S]{0,400}?Spawn all background agents first[\s\S]{0,300}?plan\/execute/,
    );
    // Otherwise / inline branch must reference FLATTEN being true
    assert.match(
      compoundActionSection[0],
      /Otherwise[\s\S]{0,260}?`FLATTEN`[\s\S]{0,260}?`true`[\s\S]{0,260}?inline/,
    );
    // Must NOT still hardcode "On Codex:" in this section
    assert.doesNotMatch(
      compoundActionSection[0],
      /\*\*On Codex:\*\*/,
    );
    // Must NOT still hardcode "On Claude Code or any other non-Codex runtime:"
    assert.doesNotMatch(
      compoundActionSection[0],
      /On Claude Code or any other non-Codex runtime:/,
    );
  });

  test('autonomous.md gates interactive background dispatch using dispatch-should-flatten', () => {
    // Two dispatch sites (3b plan + 3c execute), each must use dispatch-should-flatten.
    // allow-test-rule: source-text-is-the-product (see #1708)
    const autoFlattenMatches = AUTONOMOUS.match(/dispatch-should-flatten/g) || [];
    assert.ok(autoFlattenMatches.length >= 2, 'autonomous.md must use dispatch-should-flatten in both 3b (plan) and 3c (execute) interactive branches');
    // Accept both old singular form (backgrounded agent has no) and new plural form (backgrounded agents have no)
    assert.match(AUTONOMOUS, /backgrounded agents? ha(?:s|ve) no `Agent`\/`Task` tool/);
  });

  test('autonomous.md gates interactive background dispatch on FLATTEN=false; runs plan/execute inline otherwise', () => {
    // Background block: run_in_background=true appears within the FLATTEN=false branch and gsd-plan-phase is nearby
    // allow-test-rule: source-text-is-the-product (see #1708)
    assert.match(AUTONOMOUS, /If `FLATTEN` is `false`[\s\S]{0,1200}?run_in_background=true[\s\S]{0,600}?gsd-plan-phase/);
    // Background block: run_in_background=true appears within the FLATTEN=false branch and gsd-execute-phase is nearby
    assert.match(AUTONOMOUS, /If `FLATTEN` is `false`[\s\S]{0,3000}?run_in_background=true[\s\S]{0,200}?gsd-execute-phase/);
    // Inline is the otherwise/else branch for plan — anchored on FLATTEN=true language (not runtime name).
    // #2994: the window between `FLATTEN` and the inline Skill() call widened
    // past manager.md's 400 because this branch now carries a
    // state:plan-strategy-converge conditional-read stub (converge-dispatch-inline,
    // gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md) ahead of
    // the local-planning fallback — the stub's full step-file path is more
    // verbose than the terse `Skill()` call it replaced.
    assert.match(
      AUTONOMOUS,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,700}?Skill\(skill="gsd-plan-phase"/,
    );
    // Inline is the otherwise/else branch for execute — anchored on FLATTEN=true language (not runtime name)
    assert.match(
      AUTONOMOUS,
      /Otherwise[\s\S]{0,100}?`FLATTEN`[\s\S]{0,400}?Skill\(skill="gsd-execute-phase"/,
    );
  });
});

describe('dispatch-should-flatten query — behavioral', () => {
  // #853 / #1708: The typed query replaces prose-level RUNTIME===codex checks.
  // #2939: shouldFlattenDispatch is now DEPTH-AWARE — a host may background only if it can
  // background AND host a nesting orchestrator with a depth budget > 1 (nested:true +
  // subagentToolkit:"full" + maxDepth > 1 or unbounded). The two-field background rule is the
  // first gate, not the whole decision.
  //
  // Registry values (from host-integration-capability-matrix.md):
  //   codex:   background=true, backgroundDispatch=true, BUT maxDepth:1  → shouldFlatten=true  (must inline — #2939: depth budget insufficient for a bg orchestrator + leaf)
  //   claude:  background=true, backgroundDispatch=false                 → shouldFlatten=true  (must inline)
  //   cursor:  background=true, backgroundDispatch=true, maxDepth:2      → shouldFlatten=false (may background — the one shipped host with a sufficient depth budget)
  //   unknown: no entry → fail-closed                                   → shouldFlatten=true  (must inline)

  test('runtime=codex → shouldFlatten=true (#2939: maxDepth:1 cannot host a bg orchestrator + leaf)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'codex',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `#2939: codex maxDepth:1 should return true (must inline), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('runtime=claude → shouldFlatten=true (must inline)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'claude',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `claude should return true (must inline), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('runtime=cursor → shouldFlatten=false (background dispatch safe)', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'cursor',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'false', `cursor should return false (may background), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('unknown runtime → shouldFlatten=true (fail-closed → must inline)', () => {
    // An unknown runtime has no registry entry → dispatch is null → fail-closed to true.
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: 'unknown-runtime-xyz',
      });
      // The query must succeed (exit 0) even for unknown runtimes — fail-closed not crash-closed.
      assert.ok(result.success, `Expected success (fail-closed), got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `unknown runtime should return true (fail-closed), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('--json flag returns structured { runtime, shouldFlatten, dispatch }', () => {
    const tmpDir = createTempProject();
    try {
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--json'], tmpDir, {
        GSD_RUNTIME: 'codex',
      });
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      let parsed;
      try {
        parsed = JSON.parse(result.output);
      } catch {
        assert.fail(`Expected valid JSON output, got: ${result.output}`);
      }
      assert.strictEqual(parsed.runtime, 'codex');
      // #2939: codex maxDepth:1 → shouldFlatten:true (depth budget insufficient). backgroundDispatch
      // stays true on the descriptor (codex CAN background a single agent); only the flatten
      // consequence changes.
      assert.strictEqual(parsed.shouldFlatten, true);
      assert.ok(parsed.dispatch !== null && typeof parsed.dispatch === 'object', 'dispatch should be an object');
      assert.strictEqual(parsed.dispatch.backgroundDispatch, true);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('config.runtime takes precedence when GSD_RUNTIME not set', () => {
    // GSD_RUNTIME > config.runtime > 'claude'
    // Write config.json with runtime=codex; no GSD_RUNTIME override.
    const tmpDir = createTempProject();
    try {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ runtime: 'codex' }),
        'utf-8',
      );
      // Override GSD_RUNTIME to '' (empty string) so any ambient value is cleared.
      // resolveRuntimeNameFromCandidates treats empty string as absent (normalizes
      // to '' which is falsy → skipped → falls through to config.runtime=codex).
      // This is the only way to suppress an ambient GSD_RUNTIME since runGsdTools
      // merges { ...process.env, ...TEST_ENV_BASE, ...env } — passing '' as the
      // override overwrites the ambient value at the correct merge position.
      const result = runGsdTools(['query', 'dispatch-should-flatten', '--raw'], tmpDir, {
        GSD_RUNTIME: '',
      });
      // #2939: config.runtime=codex with GSD_RUNTIME cleared → codex maxDepth:1 → shouldFlatten=true (must inline)
      assert.ok(result.success, `Expected success, got error: ${result.error}`);
      assert.strictEqual(result.output, 'true', `#2939: config.runtime=codex (GSD_RUNTIME cleared) should return true (must inline, maxDepth:1), got: ${result.output}`);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3683-command-cross-reference-invariant.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3683-command-cross-reference-invariant (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3683)
// commands/gsd/*.md bodies are the deployed contract — cross-references between
// them must stay coherent. This test inspects .md source to enforce the invariant.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.resolve(__dirname, '..', 'commands', 'gsd');

function readKnownTargets() {
  const commandNames = fs.readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
  return { commandNames, knownTargets: new Set(commandNames) };
}

function stripFrontmatter(src) {
  return src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

// Word-boundary lookbehind matching fix-slash-commands.cjs buildColonPattern / buildPattern
// Excludes path-y characters (~, ., /) so `~/gsd-workspaces`, `./gsd-foo`, `path/gsd-bar` don't match.
// Trailing `(?![\w-]*\/)` rejects filesystem path segments like `${VAR}/gsd-core/bin` (the
// runtime-launcher shim) where a non-path char (e.g. `}`) precedes `/gsd-core/` — those are
// directory paths to the gsd-core/ runtime, not slash-command references (#604 rename).
const REF_PATTERN = /(?<![a-zA-Z0-9_~./-])\/gsd[:-]([a-zA-Z0-9_-]+)(?![\w-]*\/)/g;

describe('bug-3683 command cross-reference invariant', () => {
  test('all /gsd:<X> and /gsd-<X> body refs resolve to known command base-names', () => {
    const { commandNames, knownTargets: knownSet } = readKnownTargets();
    const mdFiles = commandNames.sort().map(n => path.join(COMMANDS_DIR, `${n}.md`));

    const failures = [];

    for (const filePath of mdFiles) {
      const src = fs.readFileSync(filePath, 'utf-8');
      const body = stripFrontmatter(src);
      const lines = body.split('\n');
      const relFile = path.relative(path.resolve(__dirname, '..'), filePath);

      lines.forEach((line, idx) => {
        REF_PATTERN.lastIndex = 0;
        let m;
        while ((m = REF_PATTERN.exec(line)) !== null) {
          const ref = m[1];
          if (!knownSet.has(ref)) {
            const sep = m[0].includes(':') ? ':' : '-';
            failures.push({
              file: relFile,
              line: idx + 1,
              ref: `/gsd${sep}${ref}`,
              excerpt: line.trim(),
            });
          }
        }
      });
    }

    if (failures.length > 0) {
      const msg = failures
        .map(f => `  ${f.file}:${f.line} — dangling ref "${f.ref}" — ${f.excerpt}`)
        .join('\n');
      assert.fail(`Dangling command cross-references found:\n${msg}`);
    }
  });
});
  });
}

'use strict';

/**
 * ADR-1239 Phase A: Parity guard — validator VALID_* sets MUST exactly match
 * HOST_INTEGRATION_AXES arrays from host-integration.cjs.
 *
 * If either side drifts, this test fails immediately (not silently).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  HOST_INTEGRATION_AXES,
} = require(path.join(__dirname, '../gsd-core/bin/lib/host-integration.cjs'));

const {
  _HOST_INTEGRATION_VOCAB,
  validateCapability,
} = require(path.join(__dirname, '../gsd-core/bin/lib/capability-validator.cjs'));

// Sort for deterministic comparison
function sorted(arr) {
  return [...arr].sort();
}

// Minimal valid runtime capability descriptor (all documented values)
function makeMinimalRuntimeCap(overrides = {}) {
  return {
    id: 'test-runtime',
    role: 'runtime',
    title: 'Test Runtime',
    description: 'Test runtime capability for parity tests',
    tier: 'core',
    requires: [],
    version: '1.0.0',
    runtime: {
      configHome: {
        kind: 'dot-home',
        name: '.test-runtime',
        env: [],
      },
      configFormat: 'markdown',
      artifactLayout: {
        global: [],
        local: [],
      },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'none',
      sandboxTier: 'none',
      supportTier: 1,
      installSurface: 'profile-marker-only',
      localConfigDir: '.test-runtime',
      writesSharedSettings: false,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
        dispatch: {
          namedDispatch: true,
          nested: false,
          maxDepth: 1,
          background: false,
          subagentToolkit: 'full',
          backgroundDispatch: false,
        },
      },
      ...overrides,
    },
  };
}

describe('ADR-1239 Phase A: host-integration validator parity', () => {
  test('_HOST_INTEGRATION_VOCAB is exported from capability-validator.cjs', () => {
    assert.ok(
      _HOST_INTEGRATION_VOCAB !== undefined && _HOST_INTEGRATION_VOCAB !== null,
      '_HOST_INTEGRATION_VOCAB must be exported from capability-validator.cjs',
    );
    assert.strictEqual(typeof _HOST_INTEGRATION_VOCAB, 'object');
  });

  test('embeddingMode: validator set === HOST_INTEGRATION_AXES.embeddingMode', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.embeddingMode),
      sorted(HOST_INTEGRATION_AXES.embeddingMode),
      'validator VALID_EMBEDDING_MODES must exactly match HOST_INTEGRATION_AXES.embeddingMode',
    );
  });

  test('commandSurface: validator set === HOST_INTEGRATION_AXES.commandSurface', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.commandSurface),
      sorted(HOST_INTEGRATION_AXES.commandSurface),
      'validator VALID_COMMAND_SURFACES must exactly match HOST_INTEGRATION_AXES.commandSurface',
    );
  });

  test('modelMode: validator set === HOST_INTEGRATION_AXES.modelMode', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.modelMode),
      sorted(HOST_INTEGRATION_AXES.modelMode),
      'validator VALID_MODEL_MODES must exactly match HOST_INTEGRATION_AXES.modelMode',
    );
  });

  test('hookBus: validator set === HOST_INTEGRATION_AXES.hookBus', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.hookBus),
      sorted(HOST_INTEGRATION_AXES.hookBus),
      'validator VALID_HOOK_BUSES must exactly match HOST_INTEGRATION_AXES.hookBus',
    );
  });

  test('stateIO: validator set === HOST_INTEGRATION_AXES.stateIO', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.stateIO),
      sorted(HOST_INTEGRATION_AXES.stateIO),
      'validator VALID_STATE_IO must exactly match HOST_INTEGRATION_AXES.stateIO',
    );
  });

  test('transport: validator set === HOST_INTEGRATION_AXES.transport', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.transport),
      sorted(HOST_INTEGRATION_AXES.transport),
      'validator VALID_TRANSPORTS must exactly match HOST_INTEGRATION_AXES.transport',
    );
  });

  test('runtime (axis): validator set === HOST_INTEGRATION_AXES.runtime (8 documented values)', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.runtime),
      sorted(HOST_INTEGRATION_AXES.runtime),
      'validator VALID_HOST_RUNTIMES must exactly match HOST_INTEGRATION_AXES.runtime',
    );
  });

  test('subagentToolkit: validator set === HOST_INTEGRATION_AXES.subagentToolkit', () => {
    assert.deepEqual(
      sorted(_HOST_INTEGRATION_VOCAB.subagentToolkit),
      sorted(HOST_INTEGRATION_AXES.subagentToolkit),
      'validator VALID_SUBAGENT_TOOLKITS must exactly match HOST_INTEGRATION_AXES.subagentToolkit',
    );
  });

  test('all axis keys in HOST_INTEGRATION_AXES are covered by _HOST_INTEGRATION_VOCAB', () => {
    const axisKeys = Object.keys(HOST_INTEGRATION_AXES).sort();
    const vocabKeys = Object.keys(_HOST_INTEGRATION_VOCAB).sort();
    assert.deepEqual(
      vocabKeys,
      axisKeys,
      '_HOST_INTEGRATION_VOCAB must cover exactly the same axis keys as HOST_INTEGRATION_AXES',
    );
  });

  test('_HOST_INTEGRATION_VOCAB does NOT include "undocumented" (documented vocab only)', () => {
    for (const [axis, values] of Object.entries(_HOST_INTEGRATION_VOCAB)) {
      assert.ok(
        !values.includes('undocumented'),
        `_HOST_INTEGRATION_VOCAB.${axis} must not include "undocumented" (sentinel is NOT documented vocab)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral: "undocumented" passes validator; bogus values still fail
// ---------------------------------------------------------------------------

describe('ADR-1239 validator behavioral: undocumented sentinel passes, bogus fails', () => {
  const SCALAR_AXES = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];

  for (const axis of SCALAR_AXES) {
    test(`hostIntegration.${axis}:"undocumented" → ZERO validator errors`, () => {
      const cap = makeMinimalRuntimeCap({
        hostIntegration: {
          ...makeMinimalRuntimeCap().runtime.hostIntegration,
          [axis]: 'undocumented',
        },
      });
      const errors = validateCapability(cap, 'test-runtime');
      const hiErrors = errors.filter((e) => e.includes('hostIntegration.' + axis));
      assert.strictEqual(hiErrors.length, 0,
        `"undocumented" for axis "${axis}" must produce no validator errors; got: ${hiErrors.join(', ')}`);
    });

    test(`hostIntegration.${axis}:"zzz" → produces a validator error`, () => {
      const cap = makeMinimalRuntimeCap({
        hostIntegration: {
          ...makeMinimalRuntimeCap().runtime.hostIntegration,
          [axis]: 'zzz',
        },
      });
      const errors = validateCapability(cap, 'test-runtime');
      const hiErrors = errors.filter((e) => e.includes('hostIntegration.' + axis));
      assert.ok(hiErrors.length > 0,
        `bogus value "zzz" for axis "${axis}" must produce a validator error`);
    });
  }

  test('dispatch.namedDispatch:"undocumented" → ZERO validator errors for that field', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: {
          namedDispatch: 'undocumented',
          nested: 'undocumented',
          maxDepth: 'undocumented',
          background: 'undocumented',
          subagentToolkit: 'undocumented',
          backgroundDispatch: 'undocumented',
        },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const dispatchErrors = errors.filter((e) => e.includes('hostIntegration.dispatch'));
    assert.strictEqual(dispatchErrors.length, 0,
      `"undocumented" for all dispatch fields must produce no validator errors; got: ${dispatchErrors.join(', ')}`);
  });

  test('dispatch boolean fields: true/false still accepted', () => {
    const cap = makeMinimalRuntimeCap();
    const errors = validateCapability(cap, 'test-runtime');
    const dispatchErrors = errors.filter((e) => e.includes('hostIntegration.dispatch'));
    assert.strictEqual(dispatchErrors.length, 0,
      `Valid boolean dispatch fields must produce no errors; got: ${dispatchErrors.join(', ')}`);
  });

  // Phase B: backgroundDispatch field validation
  test('dispatch.backgroundDispatch:true → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: true },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:true must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:false → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: false },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:false must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:"undocumented" → ZERO validator errors', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: 'undocumented' },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.strictEqual(bdErrors.length, 0,
      `backgroundDispatch:"undocumented" must produce no errors; got: ${bdErrors.join(', ')}`);
  });

  test('dispatch.backgroundDispatch:"zzz" → produces a validator error', () => {
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch, backgroundDispatch: 'zzz' },
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.ok(bdErrors.length > 0,
      `bogus value "zzz" for backgroundDispatch must produce a validator error`);
  });

  test('dispatch without backgroundDispatch key → validator error (required field — all 15 descriptors carry it)', () => {
    // backgroundDispatch is now REQUIRED (matches sibling fields namedDispatch/nested/background/subagentToolkit/maxDepth).
    const cap = makeMinimalRuntimeCap({
      hostIntegration: {
        ...makeMinimalRuntimeCap().runtime.hostIntegration,
        dispatch: (() => {
          const d = { ...makeMinimalRuntimeCap().runtime.hostIntegration.dispatch };
          delete d.backgroundDispatch;
          return d;
        })(),
      },
    });
    const errors = validateCapability(cap, 'test-runtime');
    const bdErrors = errors.filter((e) => e.includes('backgroundDispatch'));
    assert.ok(bdErrors.length > 0,
      `Missing backgroundDispatch (required field) must produce a validator error`);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: validator must reject reserved keys on hostIntegration and dispatch
// ---------------------------------------------------------------------------

describe('Fix 3: reserved-key guard on hostIntegration and hostIntegration.dispatch', () => {
  // Base valid runtime body (all documented values, claude layout)
  // We build it via JSON.parse to produce an own "__proto__" key that would
  // normally be swallowed by a spread (JSON.parse always produces own props).
  const BASE_RUNTIME_JSON = JSON.stringify({
    id: 'test-runtime',
    role: 'runtime',
    title: 'Test',
    description: 'Test runtime',
    tier: 'core',
    requires: [],
    version: '1.6.0',
    engines: { gsd: '>=1.6.0' },
    runtime: {
      configHome: { kind: 'dot-home', name: '.test', env: [] },
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'settings-json',
      hookEvents: 'claude',
      sandboxTier: 'none',
      supportTier: 1,
      installSurface: 'settings-json',
      localConfigDir: '.test-runtime',
      writesSharedSettings: true,
      permissionWriter: null,
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: {
          namedDispatch: true,
          nested: true,
          maxDepth: 5,
          background: true,
          subagentToolkit: 'full',
          backgroundDispatch: true,
        },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
  });

  test('baseline (no reserved keys) → ZERO errors', () => {
    const cap = JSON.parse(BASE_RUNTIME_JSON);
    const errors = validateCapability(cap, 'test-runtime');
    assert.strictEqual(errors.length, 0,
      'Baseline with no reserved keys must produce zero errors; got: ' + errors.join(', '));
  });

  test('hostIntegration with own __proto__ key → error mentioning "reserved key" and "__proto__"', () => {
    // Inject a raw __proto__ key via JSON string manipulation — JSON.parse gives it
    // as an OWN property (unlike { ..., __proto__: ... } which sets prototype chain).
    const json = BASE_RUNTIME_JSON.replace(
      '"hostIntegration":{',
      '"hostIntegration":{"__proto__":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    // Verify the own-key is actually present (our assumption about JSON.parse)
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration, '__proto__'),
      'JSON.parse must produce an own __proto__ key on hostIntegration',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('__proto__'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error mentioning "reserved key" and "__proto__" for hostIntegration; got: ' + errors.join(', '));
  });

  test('hostIntegration with own "constructor" key → error mentioning "reserved key" and "constructor"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"hostIntegration":{',
      '"hostIntegration":{"constructor":"polluted",',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration, 'constructor'),
      'JSON.parse must produce an own constructor key on hostIntegration',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('constructor'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "constructor" reserved key on hostIntegration; got: ' + errors.join(', '));
  });

  test('hostIntegration.dispatch with own __proto__ key → error mentioning "reserved key" and "__proto__"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"dispatch":{',
      '"dispatch":{"__proto__":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration.dispatch, '__proto__'),
      'JSON.parse must produce an own __proto__ key on dispatch',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('__proto__'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "__proto__" reserved key on dispatch; got: ' + errors.join(', '));
  });

  test('hostIntegration.dispatch with own "prototype" key → error mentioning "reserved key" and "prototype"', () => {
    const json = BASE_RUNTIME_JSON.replace(
      '"dispatch":{',
      '"dispatch":{"prototype":{"polluted":true},',
    );
    const cap = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cap.runtime.hostIntegration.dispatch, 'prototype'),
      'JSON.parse must produce an own prototype key on dispatch',
    );
    const errors = validateCapability(cap, 'test-runtime');
    const reservedErrors = errors.filter((e) => e.includes('reserved key') && e.includes('prototype'));
    assert.ok(reservedErrors.length > 0,
      'Must produce an error for "prototype" reserved key on dispatch; got: ' + errors.join(', '));
  });
});

// ---------------------------------------------------------------------------
// #3673 — ADR-1239 Phase 1: all 19 shipped descriptors carry
// dispatch.maxConcurrency (a real sourced integer or the "undocumented"
// sentinel — never silently absent), and every one validates clean.
// ---------------------------------------------------------------------------

describe('#3673 dispatch.maxConcurrency — all 19 shipped descriptors', () => {
  const registry = require(path.join(__dirname, '../gsd-core/bin/lib/capability-registry.cjs'));

  test('registry carries exactly 19 runtime descriptors', () => {
    assert.strictEqual(Object.keys(registry.runtimes).length, 19,
      `expected exactly 19 shipped runtimes; got: ${Object.keys(registry.runtimes).sort().join(', ')}`);
  });

  test('every shipped descriptor declares dispatch.maxConcurrency as a number or "undocumented" — never absent', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const mc = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch
        && cap.runtime.hostIntegration.dispatch.maxConcurrency;
      assert.ok(mc !== undefined,
        `${id}: runtime.hostIntegration.dispatch.maxConcurrency must be present (number or "undocumented")`);
      assert.ok(typeof mc === 'number' || mc === 'undocumented',
        `${id}: runtime.hostIntegration.dispatch.maxConcurrency must be a number or "undocumented"; got: ${JSON.stringify(mc)}`);
    }
  });

  test('claude declares the one real sourced value (20)', () => {
    assert.strictEqual(registry.runtimes.claude.runtime.hostIntegration.dispatch.maxConcurrency, 20);
  });

  test('every other shipped descriptor declares "undocumented" (not researched for this axis)', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      if (id === 'claude') continue;
      assert.strictEqual(cap.runtime.hostIntegration.dispatch.maxConcurrency, 'undocumented',
        `${id}: expected "undocumented" (only claude has a cited value)`);
    }
  });

  test('validateCapability accepts all 19 shipped descriptors\' dispatch.maxConcurrency with zero errors', () => {
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const errors = validateCapability(cap, id);
      const mcErrors = errors.filter((e) => e.includes('maxConcurrency'));
      assert.strictEqual(mcErrors.length, 0,
        `${id}: shipped dispatch.maxConcurrency must validate clean; got: ${JSON.stringify(mcErrors)}`);
    }
  });
});

'use strict';

/**
 * Unit tests for host-integration.cjs (ADR-1239 Phase A).
 * Pure, additive, no-I/O module — no temp dirs needed.
 * Uses node:test + node:assert/strict.
 * Requires the COMPILED artifact: ../gsd-core/bin/lib/host-integration.cjs
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const hi = require('../gsd-core/bin/lib/host-integration.cjs');
const {
  PROTOCOL_VERSION,
  HOST_INTEGRATION_AXES,
  INTERFACE_POINTS,
  PROFILE_BASELINES,
  DEFAULT_ENGINE,
  UNDOCUMENTED,
  degradationFor,
  profileOf,
  negotiateHostCapabilities,
  hookEventSurfaceFor,
  HOOK_EVENT_SURFACES,
  extensionEventSurfaceFor,
  EXTENSION_EVENT_SURFACES,
} = hi;

const {
  _HOST_INTEGRATION_VOCAB,
  validateCapability,
} = require('../gsd-core/bin/lib/capability-validator.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * A real shipped runtime descriptor with its `dispatch.isolation` value
 * stripped, so validator behavioral tests exercise the actual dispatch shape
 * shipped for a host rather than a hand-modeled fixture (fixture-provenance,
 * #2371 — mirrors `shippedDescriptorWithout` in tests/effort-surface-axis.test.cjs).
 */
function shippedClaudeCapabilityWithoutIsolation() {
  const cap = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'claude', 'capability.json'), 'utf8'),
  );
  delete cap.runtime.hostIntegration.dispatch.isolation;
  return cap;
}

describe('hookEventSurfaceFor (MANAGED-hook dialect consumer — claude/gemini only)', () => {
  test('returns the full Claude managed-hook surface for "claude"', () => {
    const s = hookEventSurfaceFor('claude');
    assert.ok(s && s.includes('PreToolUse') && s.includes('PostToolUse') && s.includes('Stop'));
  });
  test('returns the Gemini BeforeTool/AfterTool managed-hook surface for "gemini"', () => {
    const s = hookEventSurfaceFor('gemini');
    assert.ok(s && s.includes('BeforeTool') && s.includes('AfterTool'));
  });
  test('hookEvents is the MANAGED-hook dialect only — opencode-subset is NOT here (#1943)', () => {
    assert.equal(hookEventSurfaceFor('opencode-subset'), null,
      'opencode-subset is not a hookEvents value — it moved to the extensionEvents vocabulary');
  });
  test('returns null for unknown / missing / non-string dialect (fail-closed)', () => {
    assert.equal(hookEventSurfaceFor('nope'), null);
    assert.equal(hookEventSurfaceFor(undefined), null);
    assert.equal(hookEventSurfaceFor(123), null);
  });
  test('HOOK_EVENT_SURFACES is frozen + covers exactly the 2 managed-hook dialects', () => {
    assert.equal(Object.isFrozen(HOOK_EVENT_SURFACES), true);
    assert.deepEqual(Object.keys(HOOK_EVENT_SURFACES).sort(), ['claude', 'gemini']);
  });
});

describe('extensionEventSurfaceFor (extension-system event dialect — #1943)', () => {
  test('opencode = OpenCode plugin event subset with NO workflow-phase events', () => {
    const s = extensionEventSurfaceFor('opencode');
    assert.ok(s, 'opencode must resolve (non-null) — it is a consumed extensionEvents value');
    assert.ok(s.includes('experimental.session.compacting'));
    assert.ok(s.includes('session.idle'));
    assert.ok(s.includes('tool.execute.before') && s.includes('tool.execute.after'));
    assert.ok(!s.some((e) => /plan:|verify:|ship:/.test(e)),
      'opencode extension events include no workflow-phase events (engine owns phase sequencing)');
  });
  test('pi resolves (extension-system dialect)', () => {
    const s = extensionEventSurfaceFor('pi');
    assert.ok(Array.isArray(s), 'pi is a consumed extensionEvents value');
  });
  test('none = empty surface (host exposes no extension events; engine owns the bus)', () => {
    assert.deepEqual(extensionEventSurfaceFor('none'), []);
  });
  test('returns null for unknown / missing / non-string dialect (fail-closed)', () => {
    assert.equal(extensionEventSurfaceFor('opencode-subset'), null,
      'the old opencode-subset name is gone — use extensionEventSurfaceFor("opencode")');
    assert.equal(extensionEventSurfaceFor('nope'), null);
    assert.equal(extensionEventSurfaceFor(undefined), null);
  });
  test('EXTENSION_EVENT_SURFACES is frozen + covers opencode/pi/hermes/kilo/none', () => {
    assert.equal(Object.isFrozen(EXTENSION_EVENT_SURFACES), true);
    assert.deepEqual(Object.keys(EXTENSION_EVENT_SURFACES).sort(), ['hermes', 'kilo', 'none', 'opencode', 'pi']);
  });
  test('kilo reuses the IDENTICAL event array as opencode (Kilo is an OpenCode fork, same bus — #2093)', () => {
    const kiloSurface = extensionEventSurfaceFor('kilo');
    const opencodeSurface = extensionEventSurfaceFor('opencode');
    assert.ok(kiloSurface, 'kilo must resolve (non-null) — it is a consumed extensionEvents value');
    assert.deepEqual(kiloSurface, opencodeSurface);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT-PIN: constants and vocabulary
// ---------------------------------------------------------------------------

describe('CONTRACT-PIN', () => {
  test('PROTOCOL_VERSION === 1', () => {
    assert.strictEqual(PROTOCOL_VERSION, 1);
  });

  test('HOST_INTEGRATION_AXES is frozen', () => {
    assert.ok(Object.isFrozen(HOST_INTEGRATION_AXES), 'HOST_INTEGRATION_AXES must be frozen');
  });

  test('each axis sub-array is frozen', () => {
    for (const [axis, arr] of Object.entries(HOST_INTEGRATION_AXES)) {
      assert.ok(Object.isFrozen(arr), `HOST_INTEGRATION_AXES.${axis} must be frozen`);
    }
  });

  test('embeddingMode values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.embeddingMode].sort(),
      ['declarative', 'imperative'],
    );
  });

  test('commandSurface values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.commandSurface].sort(),
      ['palette', 'prose-only', 'slash-file', 'slash-programmatic', 'slash-toml'],
    );
  });

  test('modelMode values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.modelMode].sort(),
      ['active', 'passive'],
    );
  });

  test('hookBus values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.hookBus].sort(),
      ['engine', 'host', 'none'],
    );
  });

  test('stateIO values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.stateIO].sort(),
      ['filesystem', 'sandboxed-storage', 'session-log-append'],
    );
  });

  test('transport values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.transport].sort(),
      ['mcp', 'native-extension'],
    );
  });

  test('runtime values (sorted) — 8 documented values', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.runtime].sort(),
      ['bun', 'electron', 'go', 'node', 'other', 'python', 'rust', 'sandboxed-web'],
    );
  });

  test('UNDOCUMENTED === "undocumented"', () => {
    assert.equal(UNDOCUMENTED, 'undocumented');
  });

  test('subagentToolkit values (sorted)', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.subagentToolkit].sort(),
      ['built-in-only', 'full', 'read-only'],
    );
  });

  test('isolation values (sorted) — #2584 ADR-1239 Codex-binding amendment', () => {
    assert.deepStrictEqual(
      [...HOST_INTEGRATION_AXES.isolation].sort(),
      ['harness-worktree', 'none', 'orchestrator-worktree'],
    );
  });

  test('isolation: "undocumented" is NOT a vocabulary member — it is the corpus sentinel', () => {
    assert.ok(!HOST_INTEGRATION_AXES.isolation.includes('undocumented'));
  });

  test('INTERFACE_POINTS frozen and contains expected values', () => {
    assert.ok(Object.isFrozen(INTERFACE_POINTS), 'INTERFACE_POINTS must be frozen');
    const expected = ['command', 'dispatch', 'model', 'hooks', 'state', 'artifact'].sort();
    assert.deepStrictEqual([...INTERFACE_POINTS].sort(), expected);
  });
});

// ---------------------------------------------------------------------------
// degradationFor — happy path per enum value
// ---------------------------------------------------------------------------

describe('degradationFor — happy path', () => {
  test('command: slash-file → full', () => {
    const r = degradationFor('command', { commandSurface: 'slash-file' });
    assert.strictEqual(r.level, 'full');
    assert.strictEqual(typeof r.fallback, 'string');
  });

  test('command: slash-programmatic → full', () => {
    const r = degradationFor('command', { commandSurface: 'slash-programmatic' });
    assert.strictEqual(r.level, 'full');
  });

  test('command: slash-toml → degraded', () => {
    const r = degradationFor('command', { commandSurface: 'slash-toml' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('command: palette → degraded', () => {
    const r = degradationFor('command', { commandSurface: 'palette' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('command: prose-only → absent', () => {
    const r = degradationFor('command', { commandSurface: 'prose-only' });
    assert.strictEqual(r.level, 'absent');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty for prose-only');
  });

  test('model: active → full', () => {
    const r = degradationFor('model', { modelMode: 'active' });
    assert.strictEqual(r.level, 'full');
  });

  test('model: passive → degraded', () => {
    const r = degradationFor('model', { modelMode: 'passive' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('hooks: host → full', () => {
    const r = degradationFor('hooks', { hookBus: 'host' });
    assert.strictEqual(r.level, 'full');
  });

  test('hooks: engine → degraded', () => {
    const r = degradationFor('hooks', { hookBus: 'engine' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('hooks: none → absent', () => {
    const r = degradationFor('hooks', { hookBus: 'none' });
    assert.strictEqual(r.level, 'absent');
  });

  test('state: filesystem → full', () => {
    const r = degradationFor('state', { stateIO: 'filesystem' });
    assert.strictEqual(r.level, 'full');
  });

  test('state: sandboxed-storage → degraded', () => {
    const r = degradationFor('state', { stateIO: 'sandboxed-storage' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('state: session-log-append → degraded', () => {
    const r = degradationFor('state', { stateIO: 'session-log-append' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: slash-file → full', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-file' });
    assert.strictEqual(r.level, 'full');
  });

  test('artifact: slash-programmatic → full', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-programmatic' });
    assert.strictEqual(r.level, 'full');
  });

  test('artifact: slash-toml → degraded', () => {
    const r = degradationFor('artifact', { commandSurface: 'slash-toml' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: prose-only → degraded', () => {
    const r = degradationFor('artifact', { commandSurface: 'prose-only' });
    assert.strictEqual(r.level, 'degraded');
  });

  test('artifact: palette → absent', () => {
    const r = degradationFor('artifact', { commandSurface: 'palette' });
    assert.strictEqual(r.level, 'absent');
  });

  // dispatch variants
  test('dispatch: no namedDispatch → absent', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: false, nested: false, maxDepth: 0, background: false, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'absent');
  });

  test('dispatch: maxDepth===0 → absent', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: 0, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'absent');
  });

  test('dispatch: unbounded (-1) nested → full', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full');
  });

  test('dispatch: nested maxDepth>=2 → full', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: 2, background: true, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full');
  });

  test('dispatch: full but subagentToolkit read-only → degraded', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'read-only' } });
    assert.strictEqual(r.level, 'degraded');
  });

  test('dispatch: flat (maxDepth===1) → degraded', () => {
    const r = degradationFor('dispatch', { dispatch: { namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'degraded');
  });
});

// ---------------------------------------------------------------------------
// degradationFor — EVERY enum value returns a defined result with valid level
// ---------------------------------------------------------------------------

describe('degradationFor — all enum values return valid level', () => {
  const VALID_LEVELS = new Set(['full', 'degraded', 'absent']);

  test('command — all commandSurface values', () => {
    for (const v of HOST_INTEGRATION_AXES.commandSurface) {
      const r = degradationFor('command', { commandSurface: v });
      assert.ok(VALID_LEVELS.has(r.level), `command/${v}: level '${r.level}' invalid`);
      assert.strictEqual(typeof r.fallback, 'string');
    }
  });

  test('model — all modelMode values', () => {
    for (const v of HOST_INTEGRATION_AXES.modelMode) {
      const r = degradationFor('model', { modelMode: v });
      assert.ok(VALID_LEVELS.has(r.level), `model/${v}: level '${r.level}' invalid`);
    }
  });

  test('hooks — all hookBus values', () => {
    for (const v of HOST_INTEGRATION_AXES.hookBus) {
      const r = degradationFor('hooks', { hookBus: v });
      assert.ok(VALID_LEVELS.has(r.level), `hooks/${v}: level '${r.level}' invalid`);
    }
  });

  test('state — all stateIO values', () => {
    for (const v of HOST_INTEGRATION_AXES.stateIO) {
      const r = degradationFor('state', { stateIO: v });
      assert.ok(VALID_LEVELS.has(r.level), `state/${v}: level '${r.level}' invalid`);
    }
  });

  test('artifact — all commandSurface values', () => {
    for (const v of HOST_INTEGRATION_AXES.commandSurface) {
      const r = degradationFor('artifact', { commandSurface: v });
      assert.ok(VALID_LEVELS.has(r.level), `artifact/${v}: level '${r.level}' invalid`);
    }
  });
});

// ---------------------------------------------------------------------------
// degradationFor — unknown / missing axis → absent + unknown:true, never throws
// ---------------------------------------------------------------------------

describe('degradationFor — unknown / missing axis', () => {
  test('unknown commandSurface value for command → absent + unknown:true', () => {
    const r = degradationFor('command', { commandSurface: 'zzz' });
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('missing commandSurface for command → absent + unknown:true', () => {
    const r = degradationFor('command', {});
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('unknown modelMode → absent + unknown:true', () => {
    const r = degradationFor('model', { modelMode: 'zzz' });
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('missing hookBus for hooks → absent + unknown:true', () => {
    const r = degradationFor('hooks', {});
    assert.strictEqual(r.level, 'absent');
    assert.strictEqual(r.unknown, true);
  });

  test('no throw on unknown axis value', () => {
    assert.doesNotThrow(() => degradationFor('dispatch', { dispatch: 'not-an-object' }));
  });

  test('no throw on completely empty axes', () => {
    for (const point of INTERFACE_POINTS) {
      assert.doesNotThrow(() => degradationFor(point, {}));
    }
  });
});

// ---------------------------------------------------------------------------
// profileOf
// ---------------------------------------------------------------------------

describe('profileOf', () => {
  test('profileOf(PROFILE_BASELINES["programmatic-cli"]) === "programmatic-cli"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['programmatic-cli']), 'programmatic-cli');
  });

  test('profileOf(PROFILE_BASELINES["declarative-cli"]) === "declarative-cli"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['declarative-cli']), 'declarative-cli');
  });

  test('profileOf(PROFILE_BASELINES["ide"]) === "ide"', () => {
    assert.strictEqual(profileOf(PROFILE_BASELINES['ide']), 'ide');
  });

  test('imperative + sandboxed-web → ide', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'imperative', runtime: 'sandboxed-web' }),
      'ide',
    );
  });

  test('imperative + node → programmatic-cli', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'imperative', runtime: 'node' }),
      'programmatic-cli',
    );
  });

  test('declarative → declarative-cli', () => {
    assert.strictEqual(
      profileOf({ embeddingMode: 'declarative' }),
      'declarative-cli',
    );
  });

  test('empty axes → null', () => {
    assert.strictEqual(profileOf({}), null);
  });

  test('PROFILE_BASELINES are frozen', () => {
    assert.ok(Object.isFrozen(PROFILE_BASELINES), 'PROFILE_BASELINES must be frozen');
  });
});

// ---------------------------------------------------------------------------
// negotiateHostCapabilities — HAPPY PATH
// ---------------------------------------------------------------------------

describe('negotiateHostCapabilities — happy path', () => {
  test('declarative-cli baseline → effective matches, no warnings, points.command.effectiveLevel===full', () => {
    const baseline = PROFILE_BASELINES['declarative-cli'];
    const result = negotiateHostCapabilities(baseline);

    // No warnings
    assert.deepStrictEqual(result.warnings, [], 'Expected no warnings for full declarative-cli baseline');

    // Key points
    assert.strictEqual(result.points.command.effectiveLevel, 'full');
    assert.strictEqual(result.points.hooks.effectiveLevel, 'full');
    assert.strictEqual(result.points.state.effectiveLevel, 'full');

    // protocolVersion
    assert.strictEqual(result.protocolVersion, PROTOCOL_VERSION);

    // effective axes match baseline (scalar)
    assert.strictEqual(result.effective.embeddingMode, baseline.embeddingMode);
    assert.strictEqual(result.effective.commandSurface, baseline.commandSurface);
    assert.strictEqual(result.effective.modelMode, baseline.modelMode);
    assert.strictEqual(result.effective.hookBus, baseline.hookBus);
    assert.strictEqual(result.effective.stateIO, baseline.stateIO);

    // effective dispatch has maxDepth resolved (declarative has maxDepth:1)
    assert.strictEqual(result.effective.dispatch.maxDepth, 1);
    assert.strictEqual(result.effective.dispatch.namedDispatch, true);
  });

  test('all INTERFACE_POINTS are present in result.points', () => {
    const result = negotiateHostCapabilities(PROFILE_BASELINES['programmatic-cli']);
    for (const point of INTERFACE_POINTS) {
      assert.ok(point in result.points, `Missing point: ${point}`);
      assert.ok(['full', 'degraded', 'absent'].includes(result.points[point].effectiveLevel),
        `Invalid effectiveLevel for ${point}`);
    }
  });
});

// ---------------------------------------------------------------------------
// negotiateHostCapabilities — SECURITY / HOSTILE
// ---------------------------------------------------------------------------

describe('negotiateHostCapabilities — security / hostile', () => {
  test('(1) host declares future commandSurface at protocolVersion 99 → effective is KNOWN value, NOT the unknown one', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      commandSurface: 'future-surface',
      protocolVersion: 99,
    });
    // effective.commandSurface must be a KNOWN value
    assert.ok(
      HOST_INTEGRATION_AXES.commandSurface.includes(result.effective.commandSurface),
      `effective.commandSurface '${result.effective.commandSurface}' is not in known vocabulary`,
    );
    assert.notStrictEqual(result.effective.commandSurface, 'future-surface',
      'future-surface must NOT appear in effective');
    // A warning mentioning protocolVersion
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('protocolVersion') || warnText.includes('unknown'),
      `Expected a warning about protocolVersion or unknown value; got: ${warnText}`);
  });

  test('(2) host modelMode active but engine passive → effective.modelMode === passive', () => {
    const restrictedEngine = {
      ...DEFAULT_ENGINE,
      axes: { ...DEFAULT_ENGINE.axes, modelMode: 'passive' },
    };
    const result = negotiateHostCapabilities(
      { ...PROFILE_BASELINES['programmatic-cli'], modelMode: 'active' },
      restrictedEngine,
    );
    assert.strictEqual(result.effective.modelMode, 'passive');
  });

  test('(3) host dispatch maxDepth:5 nested:true but engine dispatch maxDepth:1 → effective.dispatch.maxDepth===1', () => {
    const restrictedEngine = {
      ...DEFAULT_ENGINE,
      axes: {
        ...DEFAULT_ENGINE.axes,
        dispatch: { ...DEFAULT_ENGINE.axes.dispatch, maxDepth: 1, nested: false },
      },
    };
    const result = negotiateHostCapabilities(
      {
        ...PROFILE_BASELINES['programmatic-cli'],
        dispatch: { namedDispatch: true, nested: true, maxDepth: 5, background: true, subagentToolkit: 'full' },
      },
      restrictedEngine,
    );
    assert.strictEqual(result.effective.dispatch.maxDepth, 1);
  });

  test('(4) host omits hookBus → effective.hookBus is safe default + warning present', () => {
    const hostWithoutHookBus = { ...PROFILE_BASELINES['declarative-cli'] };
    delete hostWithoutHookBus.hookBus;

    const result = negotiateHostCapabilities(hostWithoutHookBus);
    // effective hookBus must be a known value
    assert.ok(
      HOST_INTEGRATION_AXES.hookBus.includes(result.effective.hookBus),
      `effective.hookBus '${result.effective.hookBus}' is not known`,
    );
    // points.hooks must be present
    assert.ok('hooks' in result.points, 'points.hooks must be present');
    // a warning mentioning hookBus
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('hookBus'), `Expected warning about hookBus; got: ${warnText}`);
  });

  test('(5) INVARIANT: every effective scalar ∈ engine.known[axis] for hostile hosts', () => {
    const hostileHosts = [
      // All unknown values
      {
        embeddingMode: 'future-mode',
        commandSurface: 'future-surface',
        modelMode: 'quantum',
        hookBus: 'blockchain',
        stateIO: 'cloud-magic',
        transport: 'telepathy',
        runtime: 'wasm',
        protocolVersion: 999,
      },
      // Mix of known and unknown
      {
        embeddingMode: 'imperative',
        commandSurface: 'palette',
        modelMode: 'active',
        hookBus: 'none',
        stateIO: 'unknown-future',
        transport: 'mcp',
        runtime: 'sandboxed-web',
      },
      // Empty host
      {},
      // Only dispatch with extreme values
      {
        dispatch: { namedDispatch: true, nested: true, maxDepth: 9999, background: true, subagentToolkit: 'full' },
      },
    ];

    const scalarAxes = ['embeddingMode', 'commandSurface', 'modelMode', 'hookBus', 'stateIO', 'transport', 'runtime'];

    for (const host of hostileHosts) {
      const result = negotiateHostCapabilities(host);
      for (const axis of scalarAxes) {
        const effectiveVal = result.effective[axis];
        assert.ok(
          HOST_INTEGRATION_AXES[axis].includes(effectiveVal),
          `INVARIANT VIOLATION: effective.${axis}='${effectiveVal}' is NOT in known vocabulary for host=${JSON.stringify(host)}`,
        );
      }
    }
  });

  test('host protocolVersion > engine → warning mentioning protocolVersion', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['declarative-cli'],
      protocolVersion: 99,
    });
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('protocolVersion'), `Expected protocolVersion warning; got: ${warnText}`);
    assert.strictEqual(result.protocolVersion, PROTOCOL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENCE: mutation safety
// ---------------------------------------------------------------------------

describe('independence / mutation safety', () => {
  test('mutating returned result does not affect second call', () => {
    const host = PROFILE_BASELINES['declarative-cli'];
    const r1 = negotiateHostCapabilities(host);
    // Mutate r1
    r1.warnings.push('injected');
    r1.effective.modelMode = 'active';
    r1.points.command.effectiveLevel = 'absent';

    const r2 = negotiateHostCapabilities(host);
    // r2 must not be affected
    assert.deepStrictEqual(r2.warnings, [], 'r2.warnings must not include injected warning');
    assert.strictEqual(r2.effective.modelMode, host.modelMode, 'r2.effective.modelMode must be original value');
    assert.strictEqual(r2.points.command.effectiveLevel, 'full', 'r2.points.command.effectiveLevel must be full');
  });

  test('all exports are present on the module', () => {
    const expectedExports = [
      'PROTOCOL_VERSION', 'HOST_INTEGRATION_AXES', 'INTERFACE_POINTS',
      'PROFILE_BASELINES', 'DEFAULT_ENGINE', 'UNDOCUMENTED',
      'degradationFor', 'profileOf', 'negotiateHostCapabilities',
    ];
    for (const exp of expectedExports) {
      assert.ok(exp in hi, `Missing export: ${exp}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Decision 1: undocumented sentinel — fail-closed in negotiation
// ---------------------------------------------------------------------------

describe('Decision 1: UNDOCUMENTED sentinel — fail-closed negotiation', () => {
  test('negotiate with embeddingMode:"undocumented" → effective is safe default (documented value), NOT "undocumented"', () => {
    const host = {
      ...PROFILE_BASELINES['declarative-cli'],
      embeddingMode: 'undocumented',
    };
    const result = negotiateHostCapabilities(host);
    // effective.embeddingMode must be a documented value, NOT 'undocumented'
    assert.ok(
      HOST_INTEGRATION_AXES.embeddingMode.includes(result.effective.embeddingMode),
      `effective.embeddingMode must be a documented value; got '${result.effective.embeddingMode}'`,
    );
    assert.notStrictEqual(result.effective.embeddingMode, 'undocumented',
      'effective.embeddingMode must not be "undocumented"');
    // A warning mentioning "undocumented"
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('undocumented'),
      `Expected a warning mentioning "undocumented"; got: ${warnText}`);
  });

  test('negotiate with dispatch fields all "undocumented" → fail-closed dispatch', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: {
        namedDispatch: 'undocumented',
        nested: 'undocumented',
        maxDepth: 'undocumented',
        background: 'undocumented',
        subagentToolkit: 'undocumented',
      },
    };
    const result = negotiateHostCapabilities(host);
    const d = result.effective.dispatch;
    assert.strictEqual(d.namedDispatch, false, 'namedDispatch must be false when "undocumented"');
    assert.strictEqual(d.nested, false, 'nested must be false when "undocumented"');
    assert.strictEqual(d.background, false, 'background must be false when "undocumented"');
    assert.strictEqual(d.subagentToolkit, 'read-only', 'subagentToolkit must be "read-only" when "undocumented"');
    assert.strictEqual(d.maxDepth, 0, 'maxDepth must be 0 when "undocumented"');
    // points.dispatch must be absent
    assert.strictEqual(result.points.dispatch.effectiveLevel, 'absent',
      'points.dispatch.effectiveLevel must be "absent" when dispatch is all undocumented');
  });

  test('degradationFor dispatch with namedDispatch:"undocumented" → level "absent"', () => {
    const r = degradationFor('dispatch', {
      dispatch: {
        namedDispatch: 'undocumented',
        nested: false,
        maxDepth: 0,
        background: false,
        subagentToolkit: 'full',
      },
    });
    assert.strictEqual(r.level, 'absent',
      `degradationFor with namedDispatch:"undocumented" must return absent; got "${r.level}"`);
  });

  test('subagentToolkit "undocumented" (truthy string) fails closed to read-only', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: {
        namedDispatch: true,
        nested: true,
        maxDepth: -1,
        background: true,
        subagentToolkit: 'undocumented',
      },
    };
    const result = negotiateHostCapabilities(host);
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'subagentToolkit "undocumented" must degrade to "read-only"');
  });
});

// ---------------------------------------------------------------------------
// Decision 2: expanded runtime vocabulary (8 documented values)
// ---------------------------------------------------------------------------

describe('Decision 2: expanded runtime vocabulary', () => {
  const newRuntimes = ['python', 'go', 'rust', 'electron', 'other'];

  for (const rt of newRuntimes) {
    test(`negotiate with runtime:"${rt}" → effective.runtime === "${rt}" (no warn about unknown)`, () => {
      const host = {
        ...PROFILE_BASELINES['programmatic-cli'],
        runtime: rt,
      };
      const result = negotiateHostCapabilities(host);
      assert.strictEqual(result.effective.runtime, rt,
        `effective.runtime must be "${rt}"; got "${result.effective.runtime}"`);
      // Must NOT have an unknown-value warning for this runtime
      const runtimeWarnings = result.warnings.filter((w) => w.includes('runtime') && w.includes('not trusted'));
      assert.strictEqual(runtimeWarnings.length, 0,
        `Must not warn about unknown runtime "${rt}"; warnings: ${result.warnings.join(', ')}`);
    });
  }

  test('runtime "undocumented" (sentinel) → fail-closed to safe default', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      runtime: 'undocumented',
    };
    const result = negotiateHostCapabilities(host);
    // Must be a documented value, not "undocumented"
    assert.ok(
      HOST_INTEGRATION_AXES.runtime.includes(result.effective.runtime),
      `effective.runtime must be documented; got "${result.effective.runtime}"`,
    );
    assert.notStrictEqual(result.effective.runtime, 'undocumented');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('undocumented'), `Expected undocumented warning; got: ${warnText}`);
  });

  test('"wasm" (genuinely unknown, not sentinel) → still fails closed with "not trusted" warning', () => {
    const host = {
      ...PROFILE_BASELINES['programmatic-cli'],
      runtime: 'wasm',
    };
    const result = negotiateHostCapabilities(host);
    assert.ok(HOST_INTEGRATION_AXES.runtime.includes(result.effective.runtime),
      `effective.runtime must be documented; got "${result.effective.runtime}"`);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('not trusted') || warnText.includes('unknown'),
      `Expected not-trusted/unknown warning; got: ${warnText}`);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: degradationFor('dispatch') fail-closed on non-'full' subagentToolkit
// ---------------------------------------------------------------------------

describe('Fix 1: degradationFor dispatch fails closed on non-full subagentToolkit', () => {
  const FULL_DEPTH_DISPATCH = { namedDispatch: true, nested: true, maxDepth: -1, background: true };

  test('subagentToolkit:"full" + full depth → level "full"', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'full' } });
    assert.strictEqual(r.level, 'full',
      'subagentToolkit:"full" with full depth must return level "full"');
  });

  test('subagentToolkit:"read-only" + full depth → level "degraded"', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'read-only' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"read-only" must return level "degraded"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"undocumented" + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'undocumented' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"undocumented" must fail closed to level "degraded"; got "' + r.level + '"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"future-xyz" + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: 'future-xyz' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"future-xyz" (unknown) must fail closed to level "degraded"; got "' + r.level + '"');
    assert.ok(r.fallback.length > 0, 'fallback must be non-empty');
  });

  test('subagentToolkit:"" (empty string) + full depth → level "degraded" (fail-closed)', () => {
    const r = degradationFor('dispatch', { dispatch: { ...FULL_DEPTH_DISPATCH, subagentToolkit: '' } });
    assert.strictEqual(r.level, 'degraded',
      'subagentToolkit:"" must fail closed to level "degraded"; got "' + r.level + '"');
  });
});

// ---------------------------------------------------------------------------
// New fixes: M1 maxDepth NaN, M2 struct consistency, L1 SAFE_DEFAULTS,
// L2 protocolVersion warn, N1 undocumented dispatch warnings
// ---------------------------------------------------------------------------

describe('Fix M1: maxDepth NaN bypasses number guard', () => {
  test('negotiate with dispatch.maxDepth NaN → effective.dispatch.maxDepth === 0 AND warning about maxDepth AND Number.isFinite', () => {
    const result = negotiateHostCapabilities({
      dispatch: { namedDispatch: true, nested: false, maxDepth: NaN, background: false, subagentToolkit: 'full' },
    });
    const d = result.effective.dispatch;
    assert.strictEqual(d.maxDepth, 0, 'NaN maxDepth must be normalized to 0');
    assert.ok(Number.isFinite(d.maxDepth), 'effective.dispatch.maxDepth must be finite (Number.isFinite)');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('maxDepth'), `Expected a warning about maxDepth; got: ${warnText}`);
  });

  test('degradationFor dispatch with maxDepth NaN → level "degraded" (not NaN-dependent, not "full")', () => {
    const r = degradationFor('dispatch', {
      dispatch: { namedDispatch: true, nested: true, maxDepth: NaN, subagentToolkit: 'full' },
    });
    // After fix: depth=(NaN not finite)→0; NaN===0 is false so initial check doesn't fire;
    // isUnbounded=false; isFullDepth = false || (nested:true && 0>=2) = false → 'degraded' (flat)
    assert.strictEqual(r.level, 'degraded',
      `NaN maxDepth with nested:true must yield 'degraded' (depth=0, not full-depth); got: ${r.level}`);
    assert.notStrictEqual(r.level, 'full', 'NaN maxDepth must NOT yield "full"');
  });
});

describe('Fix M2: cap nested/background when namedDispatch is false', () => {
  test('negotiate with namedDispatch:"undocumented" → namedDispatch false, nested false, background false, maxDepth 0; warnings include namedDispatch undocumented note', () => {
    const result = negotiateHostCapabilities({
      dispatch: { namedDispatch: 'undocumented', nested: true, background: true, maxDepth: 5, subagentToolkit: 'full' },
    });
    const d = result.effective.dispatch;
    assert.strictEqual(d.namedDispatch, false, 'namedDispatch must be false');
    assert.strictEqual(d.nested, false, 'nested must be false when namedDispatch is false');
    assert.strictEqual(d.background, false, 'background must be false when namedDispatch is false');
    assert.strictEqual(d.maxDepth, 0, 'maxDepth must be 0 when namedDispatch is false');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('namedDispatch') || warnText.includes('dispatch.namedDispatch'),
      `Expected a warning about namedDispatch being undocumented; got: ${warnText}`);
  });
});

describe('Fix L1: SAFE_DEFAULTS.dispatch.subagentToolkit is read-only', () => {
  // CONTRACT: negotiate({}) uses SAFE_DEFAULTS for each axis; dispatch uses its floor
  test('negotiate({}) → effective axes match documented SAFE_DEFAULTS (CONTRACT)', () => {
    const result = negotiateHostCapabilities({});
    const eff = result.effective;
    assert.strictEqual(eff.embeddingMode, 'declarative');
    assert.strictEqual(eff.commandSurface, 'prose-only');
    assert.strictEqual(eff.modelMode, 'passive');
    assert.strictEqual(eff.hookBus, 'none');
    assert.strictEqual(eff.stateIO, 'session-log-append');
    assert.strictEqual(eff.transport, 'mcp');
    assert.strictEqual(eff.runtime, 'node');
    assert.strictEqual(eff.dispatch.subagentToolkit, 'read-only',
      'SAFE_DEFAULTS dispatch floor must be read-only');
  });
});

describe('Fix L2: warn on present-but-non-number protocolVersion', () => {
  test('negotiate with protocolVersion:"beta" → warnings include protocolVersion note; result.protocolVersion === engine default (1)', () => {
    const result = negotiateHostCapabilities({
      embeddingMode: 'declarative',
      commandSurface: 'slash-file',
      modelMode: 'passive',
      hookBus: 'host',
      stateIO: 'filesystem',
      transport: 'mcp',
      runtime: 'node',
      dispatch: { namedDispatch: true, nested: false, maxDepth: 1, background: false, subagentToolkit: 'full' },
      protocolVersion: 'beta',
    });
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('protocolVersion'),
      `Expected a warning about protocolVersion being non-finite/non-number; got: ${warnText}`);
    assert.strictEqual(result.protocolVersion, 1,
      'result.protocolVersion must fall back to engine default (1)');
  });
});

describe('Fix N1: symmetric observability warnings for undocumented dispatch fields', () => {
  test('dispatch.subagentToolkit:"undocumented" → warning includes "dispatch.subagentToolkit is undocumented"', () => {
    const result = negotiateHostCapabilities({
      dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'undocumented' },
    });
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('subagentToolkit') && warnText.includes('undocumented'),
      `Expected warning about dispatch.subagentToolkit undocumented; got: ${warnText}`);
  });
});

describe('Fix: degradationFor unknown point → {level:"absent", unknown:true}', () => {
  test('degradationFor("totally-unknown-point", {}) → {level:"absent", unknown:true}', () => {
    const r = degradationFor('totally-unknown-point', {});
    assert.strictEqual(r.level, 'absent', 'unknown point must return absent');
    assert.strictEqual(r.unknown, true, 'unknown point must have unknown:true');
  });
});

// ---------------------------------------------------------------------------
// Phase B: shouldFlattenDispatch — ADR-1239 Phase B / #1708
// ---------------------------------------------------------------------------

describe('Phase B: shouldFlattenDispatch — contract pin', () => {
  const { shouldFlattenDispatch } = hi;

  test('shouldFlattenDispatch is exported as a function', () => {
    assert.strictEqual(typeof shouldFlattenDispatch, 'function',
      'shouldFlattenDispatch must be exported from host-integration module');
  });

  test('{background:true, backgroundDispatch:true} → false (background OK)', () => {
    assert.strictEqual(shouldFlattenDispatch({ background: true, backgroundDispatch: true }), false,
      'canBackground=true when both background===true AND backgroundDispatch===true → flatten=false');
  });

  test('{background:true, backgroundDispatch:false} → true (must flatten)', () => {
    assert.strictEqual(shouldFlattenDispatch({ background: true, backgroundDispatch: false }), true,
      'backgroundDispatch===false → canBackground=false → flatten=true');
  });

  test('{background:true, backgroundDispatch:"undocumented"} → true (undocumented is not === true)', () => {
    assert.strictEqual(shouldFlattenDispatch({ background: true, backgroundDispatch: 'undocumented' }), true,
      '"undocumented" is not === true → canBackground=false → flatten=true');
  });

  test('{background:false, backgroundDispatch:true} → true (background is false)', () => {
    assert.strictEqual(shouldFlattenDispatch({ background: false, backgroundDispatch: true }), true,
      'background===false → canBackground=false → flatten=true');
  });

  test('{} (empty) → true (missing fields → fail-closed)', () => {
    assert.strictEqual(shouldFlattenDispatch({}), true,
      'empty dispatch → canBackground=false → flatten=true');
  });

  test('missing fields individually', () => {
    assert.strictEqual(shouldFlattenDispatch({ background: true }), true,
      'backgroundDispatch missing → not === true → flatten=true');
    assert.strictEqual(shouldFlattenDispatch({ backgroundDispatch: true }), true,
      'background missing → not === true → flatten=true');
  });

  // M1: null-safety — null/undefined/non-object dispatch must fail-closed (not throw)
  test('null dispatch → true (fail-closed, no throw)', () => {
    assert.strictEqual(shouldFlattenDispatch(null), true,
      'null dispatch must fail-closed to true');
  });

  test('undefined dispatch → true (fail-closed, no throw)', () => {
    assert.strictEqual(shouldFlattenDispatch(undefined), true,
      'undefined dispatch must fail-closed to true');
  });

  test('string dispatch → true (fail-closed, no throw)', () => {
    assert.strictEqual(shouldFlattenDispatch('x'), true,
      'non-object dispatch (string) must fail-closed to true');
  });

  // #853 codex-like profile: full dispatch including backgroundDispatch:true → background OK
  test('#853 codex-like: {namedDispatch:true,nested:true,maxDepth:1,background:true,subagentToolkit:"full",backgroundDispatch:true} → false (background OK)', () => {
    assert.strictEqual(
      shouldFlattenDispatch({ namedDispatch: true, nested: true, maxDepth: 1, background: true, subagentToolkit: 'full', backgroundDispatch: true }),
      false,
      'codex-like dispatch with backgroundDispatch:true must be background-OK (flatten=false)',
    );
  });

  // #853 claude-like profile: backgroundDispatch:false → must flatten
  test('#853 claude-like: {...,background:true,backgroundDispatch:false} → true (inline)', () => {
    assert.strictEqual(
      shouldFlattenDispatch({ namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false }),
      true,
      'claude-like dispatch with backgroundDispatch:false must flatten inline',
    );
  });
});

// ---------------------------------------------------------------------------
// Phase B: negotiateHostCapabilities — backgroundDispatch field
// ---------------------------------------------------------------------------

describe('Phase B: negotiateHostCapabilities — backgroundDispatch', () => {
  test('host dispatch.backgroundDispatch:true against DEFAULT_ENGINE → effective.dispatch.backgroundDispatch===true', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: true },
    });
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, true,
      'backgroundDispatch:true on host AND engine must yield effective backgroundDispatch===true');
  });

  test('host dispatch.backgroundDispatch:"undocumented" → effective.dispatch.backgroundDispatch===false + warning', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: 'undocumented' },
    });
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, false,
      '"undocumented" must fail-closed to false');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('backgroundDispatch') && warnText.includes('undocumented'),
      `Expected warning about backgroundDispatch being undocumented; got: ${warnText}`);
  });

  test('host dispatch.backgroundDispatch:false → effective.dispatch.backgroundDispatch===false', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false },
    });
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, false);
  });

  test('host dispatch without backgroundDispatch key → effective.dispatch.backgroundDispatch===false (fail-closed)', () => {
    const result = negotiateHostCapabilities({
      ...PROFILE_BASELINES['programmatic-cli'],
      dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full' },
    });
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, false,
      'Missing backgroundDispatch key must fail-closed to false');
  });

  test('negotiateHostCapabilities({}) → effective.dispatch.backgroundDispatch===false', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, false,
      'Empty host must produce backgroundDispatch===false (SAFE_DEFAULTS)');
  });

  test('SAFE_DEFAULTS.dispatch.backgroundDispatch is false', () => {
    // Verified via negotiation with empty host
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.backgroundDispatch, false);
  });

  test('DEFAULT_ENGINE.axes.dispatch.backgroundDispatch is true', () => {
    assert.strictEqual(DEFAULT_ENGINE.axes.dispatch.backgroundDispatch, true,
      'DEFAULT_ENGINE (full engine) must declare backgroundDispatch:true');
  });

  test('existing dispatch tests still pass — effective.dispatch.namedDispatch present alongside backgroundDispatch', () => {
    const result = negotiateHostCapabilities(PROFILE_BASELINES['programmatic-cli']);
    const d = result.effective.dispatch;
    assert.ok('namedDispatch' in d, 'namedDispatch must still be present');
    assert.ok('backgroundDispatch' in d, 'backgroundDispatch must be present');
    assert.ok('nested' in d && 'maxDepth' in d && 'background' in d && 'subagentToolkit' in d,
      'all original dispatch fields must still be present');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: negotiateHostCapabilities — host omitting 'dispatch' → subagentToolkit 'read-only'
// ---------------------------------------------------------------------------

describe('Fix 2: negotiate — host omits dispatch → subagentToolkit read-only (fail-closed)', () => {
  test('negotiateHostCapabilities({}) → effective.dispatch.subagentToolkit === "read-only"', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'When host omits dispatch, subagentToolkit must fail-closed to "read-only"; got "' + result.effective.dispatch.subagentToolkit + '"');
  });

  test('negotiateHostCapabilities({}) → effective.dispatch.namedDispatch===false, maxDepth===0, nested===false, background===false', () => {
    const result = negotiateHostCapabilities({});
    const d = result.effective.dispatch;
    assert.strictEqual(d.namedDispatch, false);
    assert.strictEqual(d.maxDepth, 0);
    assert.strictEqual(d.nested, false);
    assert.strictEqual(d.background, false);
  });

  test('negotiateHostCapabilities({}) → points.dispatch.effectiveLevel === "absent"', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.points.dispatch.effectiveLevel, 'absent',
      'dispatch absent when host omits it');
  });

  test('host with all axes but no dispatch → subagentToolkit "read-only"', () => {
    const hostWithoutDispatch = {
      embeddingMode: 'imperative',
      commandSurface: 'slash-file',
      modelMode: 'passive',
      hookBus: 'host',
      stateIO: 'filesystem',
      transport: 'mcp',
      runtime: 'node',
      // no dispatch key
    };
    const result = negotiateHostCapabilities(hostWithoutDispatch);
    assert.strictEqual(result.effective.dispatch.subagentToolkit, 'read-only',
      'Host missing dispatch must produce subagentToolkit "read-only"; got "' + result.effective.dispatch.subagentToolkit + '"');
  });
});

// ---------------------------------------------------------------------------
// #2584 — ADR-1239 Codex-binding amendment: dispatch.isolation sub-field
// (Phase 1 — declared and negotiated, but NOT consumed by any scheduler yet).
// ---------------------------------------------------------------------------

describe('#2584 dispatch.isolation — negotiation', () => {
  const BASE_DISPATCH = {
    namedDispatch: true, nested: false, maxDepth: 1, background: false,
    subagentToolkit: 'full', backgroundDispatch: false,
  };

  for (const value of HOST_INTEGRATION_AXES.isolation) {
    test(`host declares isolation:"${value}" → effective.dispatch.isolation === "${value}"`, () => {
      const result = negotiateHostCapabilities({
        dispatch: { ...BASE_DISPATCH, isolation: value },
      });
      assert.strictEqual(result.effective.dispatch.isolation, value);
    });
  }

  test('isolation:"undocumented" → effective "none" + a warning naming dispatch.isolation', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, isolation: 'undocumented' },
    });
    assert.strictEqual(result.effective.dispatch.isolation, 'none');
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('dispatch.isolation') && warnText.includes('undocumented'),
      `Expected a warning naming dispatch.isolation as undocumented; got: ${warnText}`);
  });

  test('isolation: unknown/garbage value (not the sentinel) → effective "none", no throw', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, isolation: 'quantum-worktree' },
    });
    assert.strictEqual(result.effective.dispatch.isolation, 'none');
  });

  test('isolation: non-string value (number/object/array/null) → effective "none", no throw', () => {
    for (const bogus of [42, {}, [], null, true]) {
      const result = negotiateHostCapabilities({
        dispatch: { ...BASE_DISPATCH, isolation: bogus },
      });
      assert.strictEqual(result.effective.dispatch.isolation, 'none',
        `isolation=${JSON.stringify(bogus)} must degrade to "none"`);
    }
  });

  test('host declares dispatch but omits isolation entirely → effective "none"', () => {
    const result = negotiateHostCapabilities({ dispatch: { ...BASE_DISPATCH } });
    assert.strictEqual(result.effective.dispatch.isolation, 'none');
  });

  test('host omits dispatch entirely → effective.dispatch.isolation === "none"', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.isolation, 'none');
  });

  test('negotiateHostCapabilities({}) → SAFE_DEFAULTS floor carries isolation "none"', () => {
    // FAIL_CLOSED_FLOOR.dispatch.isolation (src/host-integration.cts SAFE_DEFAULTS)
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.isolation, 'none');
  });

  test('isolation is NOT gated by namedDispatch:false — unlike nested/background/backgroundDispatch, it is not capped', () => {
    // orchestrator-worktree fan-out is OS-level (process-spawn), independent of
    // the host's native named-subagent dispatch (ADR-1239 §2584: "does not use
    // the host's native subagent tool"). A host may plausibly declare
    // namedDispatch:false yet still have isolation info; either way it must not
    // silently flip to a DIFFERENT valid value or throw.
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, namedDispatch: false, isolation: 'orchestrator-worktree' },
    });
    assert.strictEqual(result.effective.dispatch.isolation, 'orchestrator-worktree');
  });

  // ─── Boundary: exact valid-set membership ──────────────────────────────────

  describe('boundary — a value one character off a valid member fails closed to "none"', () => {
    const NEAR_MISSES = [
      'harness-worktre',       // missing trailing 'e' (limit-1)
      'harness-worktreee',     // extra trailing 'e' (limit+1)
      'Harness-Worktree',      // case mismatch
      'orchestrator-worktre',  // missing trailing 'e'
      'orchestrator-worktrees', // extra trailing 's'
      'non',                   // missing trailing 'e' of "none"
      'nonee',                 // extra trailing 'e'
      ' none',                 // leading space
      'none ',                 // trailing space
    ];
    for (const nearMiss of NEAR_MISSES) {
      test(`isolation:${JSON.stringify(nearMiss)} → "none"`, () => {
        const result = negotiateHostCapabilities({
          dispatch: { ...BASE_DISPATCH, isolation: nearMiss },
        });
        assert.strictEqual(result.effective.dispatch.isolation, 'none');
      });
    }
  });

  // ─── Property: valid-set-passthrough-else-none contract ─────────────────────

  test('property: effective.dispatch.isolation equals the declared value iff it is a known vocabulary member, else "none"', () => {
    const declaredArb = fc.oneof(
      fc.constantFrom(...HOST_INTEGRATION_AXES.isolation, 'undocumented'),
      fc.string(),
    );
    fc.assert(
      fc.property(declaredArb, (declared) => {
        const result = negotiateHostCapabilities({
          dispatch: { ...BASE_DISPATCH, isolation: declared },
        });
        const eff = result.effective.dispatch.isolation;
        assert.ok(HOST_INTEGRATION_AXES.isolation.includes(eff),
          `effective.dispatch.isolation '${eff}' must always be a known vocabulary member`);
        if (HOST_INTEGRATION_AXES.isolation.includes(declared)) {
          assert.strictEqual(eff, declared, `a valid declared value ('${declared}') must pass through unchanged`);
        } else {
          assert.strictEqual(eff, 'none', `an invalid/sentinel declared value ('${declared}') must degrade to "none"`);
        }
      }),
      { numRuns: 200, seed: 2584 },
    );
  });
});

describe('#2584 dispatch.isolation — validator', () => {
  test('_HOST_INTEGRATION_VOCAB.isolation matches HOST_INTEGRATION_AXES.isolation (parity guard)', () => {
    assert.deepEqual(
      [..._HOST_INTEGRATION_VOCAB.isolation].sort(),
      [...HOST_INTEGRATION_AXES.isolation].sort(),
    );
  });

  test('a descriptor that omits dispatch.isolation entirely still validates clean (added after existing descriptors)', () => {
    const cap = shippedClaudeCapabilityWithoutIsolation();
    const errors = validateCapability(cap, 'claude');
    assert.deepEqual(errors, [], `omitted isolation must validate clean, got: ${JSON.stringify(errors)}`);
  });

  for (const value of ['harness-worktree', 'orchestrator-worktree', 'none', 'undocumented']) {
    test(`dispatch.isolation:"${value}" → ZERO validator errors`, () => {
      const cap = shippedClaudeCapabilityWithoutIsolation();
      cap.runtime.hostIntegration.dispatch.isolation = value;
      const errors = validateCapability(cap, 'claude');
      const isoErrors = errors.filter((e) => e.includes('dispatch.isolation'));
      assert.strictEqual(isoErrors.length, 0,
        `"${value}" must produce no validator errors; got: ${JSON.stringify(isoErrors)}`);
    });
  }

  test('a present invalid dispatch.isolation value is rejected', () => {
    const cap = shippedClaudeCapabilityWithoutIsolation();
    cap.runtime.hostIntegration.dispatch.isolation = 'quantum-worktree';
    const errors = validateCapability(cap, 'claude');
    assert.ok(
      errors.some((e) => e.includes('dispatch.isolation')),
      `an invalid dispatch.isolation must produce a validator error; got: ${JSON.stringify(errors)}`,
    );
  });

  test('a reserved-name dispatch.isolation value ("__proto__") is rejected', () => {
    const cap = shippedClaudeCapabilityWithoutIsolation();
    cap.runtime.hostIntegration.dispatch.isolation = '__proto__';
    const errors = validateCapability(cap, 'claude');
    assert.ok(
      errors.some((e) => e.includes('dispatch.isolation') && e.includes('reserved name')),
      `"__proto__" must produce a reserved-name validator error; got: ${JSON.stringify(errors)}`,
    );
  });

  test('every shipped runtime descriptor with an isolation value passes validateCapability', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const iso = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch
        && cap.runtime.hostIntegration.dispatch.isolation;
      if (iso === undefined) continue;
      const errors = validateCapability(cap, id);
      const isoErrors = errors.filter((e) => e.includes('dispatch.isolation'));
      assert.strictEqual(isoErrors.length, 0,
        `${id}: shipped dispatch.isolation:"${iso}" must validate clean; got: ${JSON.stringify(isoErrors)}`);
    }
  });
});

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
  resolveOrchestratorExec,
} = hi;

const {
  _HOST_INTEGRATION_VOCAB,
  validateCapability,
} = require('../gsd-core/bin/lib/capability-validator.cjs');
const { cleanup, readFileNormalized } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

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

  test('{background:true, backgroundDispatch:true} → true (no depth budget declared → fail-closed/flatten)', () => {
    // #2939: can background AT ALL, but declares no nested/toolkit/maxDepth, so the depth
    // budget is unknown → fail-closed to inline (flatten). A real background-eligible host
    // also carries nested:true + subagentToolkit:"full" + a sufficient maxDepth.
    assert.strictEqual(shouldFlattenDispatch({ background: true, backgroundDispatch: true }), true,
      'canBackground=true but no depth budget declared → fail-closed/flatten=true');
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

  // #2939: the codex-like profile with maxDepth:1 now FLATTENS. A depth budget of 1 is consumed
  // by the backgrounded orchestrator itself (depth 1) and leaves no room for the delegated leaf
  // (depth 2) its own contract requires. This corrects the prior pin, which asserted the buggy
  // shouldFlatten:false output that permitted a depth-2 tree the descriptor cannot support.
  test('#2939 codex-like: {namedDispatch:true,nested:true,maxDepth:1,background:true,subagentToolkit:"full",backgroundDispatch:true} → true (flatten — depth budget insufficient)', () => {
    assert.strictEqual(
      shouldFlattenDispatch({ namedDispatch: true, nested: true, maxDepth: 1, background: true, subagentToolkit: 'full', backgroundDispatch: true }),
      true,
      'maxDepth:1 is insufficient for a backgrounded orchestrator plus a delegated leaf → flatten=true',
    );
  });

  // #2939 negative-space: the same codex-like profile with a SUFFICIENT depth budget backgrounds.
  test('#2939 codex-like maxDepth:2 → false (background OK — depth budget sufficient)', () => {
    assert.strictEqual(
      shouldFlattenDispatch({ namedDispatch: true, nested: true, maxDepth: 2, background: true, subagentToolkit: 'full', backgroundDispatch: true }),
      false,
      'maxDepth:2 leaves room for a backgrounded orchestrator plus a leaf → background OK',
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

// ---------------------------------------------------------------------------
// #3673 — ADR-1239 Phase 1: dispatch.maxConcurrency (numeric sibling of
// dispatch.isolation). NOT an enum member of HOST_INTEGRATION_AXES (same
// "numeric dispatch sub-field" precedent as maxDepth). No engine-side
// reduction (design doc's explicit rejection of a min(host,engine) rule) —
// the resolved value passes through verbatim when it is a positive safe
// integer; every other shape degrades to the fail-closed floor of 1.
// ---------------------------------------------------------------------------

describe('#3673 dispatch.maxConcurrency — negotiation', () => {
  const BASE_DISPATCH = {
    namedDispatch: true, nested: false, maxDepth: 1, background: false,
    subagentToolkit: 'full', backgroundDispatch: false, isolation: 'none',
  };

  test('descriptor maxConcurrency:8 (valid positive integer) is honored', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 8 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 8);
  });

  test('missing dispatch.maxConcurrency degrades to 1', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('maxConcurrency'), `Expected a warning naming maxConcurrency; got: ${warnText}`);
  });

  test('undocumented maxConcurrency degrades to 1 with sentinel-specific warning', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 'undocumented' },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('dispatch.maxConcurrency') && warnText.includes('undocumented'),
      `Expected a sentinel-specific warning naming dispatch.maxConcurrency as undocumented; got: ${warnText}`);
  });

  test('zero maxConcurrency degrades to 1 (non-positive)', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 0 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('non-positive'), `Expected a non-positive warning; got: ${warnText}`);
  });

  test('maxConcurrency of exactly 1 is honored as valid, not degraded', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 1 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(!warnText.includes('maxConcurrency'), `A valid maxConcurrency:1 must not produce a maxConcurrency warning; got: ${warnText}`);
  });

  test('maxConcurrency of 2 is honored', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 2 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 2);
  });

  test('negative maxConcurrency degrades to 1', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: -3 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('non-positive'), `Expected a non-positive warning; got: ${warnText}`);
  });

  test('fractional maxConcurrency degrades to 1 (non-integer)', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: 4.5 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('not an integer'), `Expected a non-integer warning; got: ${warnText}`);
  });

  test('NaN maxConcurrency degrades to 1 (fails Number.isSafeInteger)', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: NaN },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('not an integer'), `Expected a non-integer warning for NaN; got: ${warnText}`);
  });

  test('unsafe-integer maxConcurrency (MAX_SAFE_INTEGER + 1) degrades to 1', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: Number.MAX_SAFE_INTEGER + 1 },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('unsafe integer'), `Expected an unsafe-integer warning; got: ${warnText}`);
  });

  test('MAX_SAFE_INTEGER maxConcurrency is honored (largest valid value)', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: Number.MAX_SAFE_INTEGER },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, Number.MAX_SAFE_INTEGER);
  });

  test('string-typed maxConcurrency ("8") degrades to 1 (non-numeric)', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: '8' },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
    const warnText = result.warnings.join(' ');
    assert.ok(warnText.includes('not a number'), `Expected a non-numeric warning; got: ${warnText}`);
  });

  test('null maxConcurrency degrades to 1', () => {
    const result = negotiateHostCapabilities({
      dispatch: { ...BASE_DISPATCH, maxConcurrency: null },
    });
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
  });

  test('object/array-typed maxConcurrency degrades to 1', () => {
    for (const bogus of [[8], {}]) {
      const result = negotiateHostCapabilities({
        dispatch: { ...BASE_DISPATCH, maxConcurrency: bogus },
      });
      assert.strictEqual(result.effective.dispatch.maxConcurrency, 1,
        `maxConcurrency=${JSON.stringify(bogus)} must degrade to 1`);
    }
  });

  test('adding maxConcurrency does not change isolation/effortSurface/modelMode negotiation results', () => {
    const result = negotiateHostCapabilities({
      embeddingMode: 'imperative',
      commandSurface: 'slash-file',
      modelMode: 'active',
      hookBus: 'host',
      stateIO: 'filesystem',
      transport: 'mcp',
      runtime: 'node',
      effortSurface: 'argv',
      dispatch: { ...BASE_DISPATCH, isolation: 'harness-worktree', maxConcurrency: 8 },
    });
    assert.strictEqual(result.effective.dispatch.isolation, 'harness-worktree');
    assert.strictEqual(result.effective.effortSurface, 'argv');
    assert.strictEqual(result.effective.modelMode, 'active');
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 8);
  });

  test('host omits dispatch entirely → effective.dispatch.maxConcurrency === 1', () => {
    const result = negotiateHostCapabilities({});
    assert.strictEqual(result.effective.dispatch.maxConcurrency, 1);
  });

  test('property: effective.dispatch.maxConcurrency equals the declared value iff it is a positive safe integer, else 1', () => {
    const declaredArb = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.constant('undocumented'),
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.array(fc.integer()),
      fc.object(),
    );
    fc.assert(
      fc.property(declaredArb, (declared) => {
        const result = negotiateHostCapabilities({
          dispatch: { ...BASE_DISPATCH, maxConcurrency: declared },
        });
        const eff = result.effective.dispatch.maxConcurrency;
        const isValid = typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0;
        if (isValid) {
          assert.strictEqual(eff, declared, `a valid declared value (${declared}) must pass through unchanged`);
        } else {
          assert.strictEqual(eff, 1, `an invalid declared value (${JSON.stringify(declared)}) must degrade to 1`);
        }
      }),
      { numRuns: 200, seed: 3673 },
    );
  });
});

describe('#3673 dispatch.maxConcurrency — validator', () => {
  test('a descriptor that omits dispatch.maxConcurrency entirely still validates clean (added after existing descriptors)', () => {
    const cap = shippedClaudeCapabilityWithoutIsolation();
    delete cap.runtime.hostIntegration.dispatch.maxConcurrency;
    const errors = validateCapability(cap, 'claude');
    const mcErrors = errors.filter((e) => e.includes('maxConcurrency'));
    assert.deepEqual(mcErrors, [], `omitted maxConcurrency must validate clean, got: ${JSON.stringify(mcErrors)}`);
  });

  for (const value of [1, 2, 20, Number.MAX_SAFE_INTEGER, 'undocumented']) {
    test(`dispatch.maxConcurrency:${JSON.stringify(value)} → ZERO validator errors`, () => {
      const cap = shippedClaudeCapabilityWithoutIsolation();
      cap.runtime.hostIntegration.dispatch.maxConcurrency = value;
      const errors = validateCapability(cap, 'claude');
      const mcErrors = errors.filter((e) => e.includes('maxConcurrency'));
      assert.strictEqual(mcErrors.length, 0,
        `${JSON.stringify(value)} must produce no validator errors; got: ${JSON.stringify(mcErrors)}`);
    });
  }

  // Hostile: an out-of-vocabulary shape (boolean) — same treatment the
  // validator already gives a malformed isolation/maxDepth value.
  for (const bogus of [true, false, 0, -1, 4.5, '8', null, [], {}]) {
    test(`dispatch.maxConcurrency:${JSON.stringify(bogus)} is rejected`, () => {
      const cap = shippedClaudeCapabilityWithoutIsolation();
      cap.runtime.hostIntegration.dispatch.maxConcurrency = bogus;
      const errors = validateCapability(cap, 'claude');
      assert.ok(
        errors.some((e) => e.includes('maxConcurrency')),
        `${JSON.stringify(bogus)} must produce a validator error; got: ${JSON.stringify(errors)}`,
      );
    });
  }

  test('every shipped runtime descriptor with a maxConcurrency value passes validateCapability', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    for (const [id, cap] of Object.entries(registry.runtimes)) {
      const mc = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch
        && cap.runtime.hostIntegration.dispatch.maxConcurrency;
      if (mc === undefined) continue;
      const errors = validateCapability(cap, id);
      const mcErrors = errors.filter((e) => e.includes('maxConcurrency'));
      assert.strictEqual(mcErrors.length, 0,
        `${id}: shipped dispatch.maxConcurrency:${JSON.stringify(mc)} must validate clean; got: ${JSON.stringify(mcErrors)}`);
    }
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

// ---------------------------------------------------------------------------
// #2584 — ADR-1239 Codex-binding amendment, Phase 2: resolveOrchestratorExec
// + the `runtime.orchestratorExec` descriptor field (sibling of hostBehaviors).
// UNCONSUMED in Phase 2 — no scheduler calls this yet (Phase 3 wires it).
// ---------------------------------------------------------------------------

describe('resolveOrchestratorExec — the 4 shipped orchestrator-worktree descriptors', () => {
  const CWD = '/repo/.claude/worktrees/agent-a1';

  test('codex: exec --cd <cwd>', () => {
    const result = resolveOrchestratorExec({ command: 'codex', args: ['exec'], cwdFlag: '--cd' }, CWD);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'codex');
    assert.deepEqual(result.args, ['exec', '--cd', CWD]);
    assert.equal(result.cwd, CWD);
  });

  test('opencode: run --dir <cwd>', () => {
    const result = resolveOrchestratorExec({ command: 'opencode', args: ['run'], cwdFlag: '--dir' }, CWD);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'opencode');
    assert.deepEqual(result.args, ['run', '--dir', CWD]);
    assert.equal(result.cwd, CWD);
  });

  // #2627: `args` carries --print because kimi's working mode is otherwise the
  // interactive TUI — an orchestrator spawning a TUI hangs forever rather than
  // returning a completed plan.
  test('kimi: --print --work-dir <cwd> (headless flag leads)', () => {
    const result = resolveOrchestratorExec({ command: 'kimi', args: ['--print'], cwdFlag: '--work-dir' }, CWD);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'kimi');
    assert.deepEqual(result.args, ['--print', '--work-dir', CWD]);
    assert.equal(result.cwd, CWD);
  });

  // #2627: the binary is `kimi`, NOT `kimi-code` — Moonshot's TypeScript Kimi
  // Code installs its binary as `kimi`; `kimi-code` is only the npm package and
  // config-home name, so spawning it is an immediate ENOENT.
  test('kimi-code: command is "kimi"; cwdFlag:null appends NO flag, cwd still returned (process-cwd case)', () => {
    const result = resolveOrchestratorExec({ command: 'kimi', args: [], cwdFlag: null }, CWD);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'kimi');
    assert.deepEqual(result.args, []);
    assert.equal(result.cwd, CWD);
  });
});

describe('resolveOrchestratorExec — prompt passing (#2627, Phase 3)', () => {
  const CWD = '/repo/.claude/worktrees/agent-a1';
  const PROMPT = 'Execute plan 2 of phase 3.';

  test('promptFlag:null → prompt appended POSITIONALLY, last (codex shape)', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], cwdFlag: '--cd', promptFlag: null }, CWD, PROMPT,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['exec', '--cd', CWD, PROMPT]);
  });

  test('promptFlag absent → prompt appended POSITIONALLY (opencode shape)', () => {
    const result = resolveOrchestratorExec(
      { command: 'opencode', args: ['run'], cwdFlag: '--dir' }, CWD, PROMPT,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['run', '--dir', CWD, PROMPT]);
  });

  test('promptFlag string → [flag, prompt] appended (kimi shape)', () => {
    const result = resolveOrchestratorExec(
      { command: 'kimi', args: ['--print'], cwdFlag: '--work-dir', promptFlag: '--prompt' }, CWD, PROMPT,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['--print', '--work-dir', CWD, '--prompt', PROMPT]);
  });

  test('promptFlag string + cwdFlag null → prompt flag only, cwd via process cwd (kimi-code shape)', () => {
    const result = resolveOrchestratorExec(
      { command: 'kimi', args: [], cwdFlag: null, promptFlag: '--prompt' }, CWD, PROMPT,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['--prompt', PROMPT]);
    assert.equal(result.cwd, CWD, 'cwd is returned even with no cwd flag — caller binds it on the subprocess');
  });

  test('omitting prompt is byte-identical to the Phase-2 two-arg resolution', () => {
    const descriptor = { command: 'codex', args: ['exec'], cwdFlag: '--cd', promptFlag: null };
    assert.deepEqual(
      resolveOrchestratorExec(descriptor, CWD),
      resolveOrchestratorExec(descriptor, CWD, undefined),
    );
    assert.deepEqual(resolveOrchestratorExec(descriptor, CWD).args, ['exec', '--cd', CWD]);
  });

  test('empty prompt → invalid_prompt (a prompt-less executor hangs, not degrades)', () => {
    const result = resolveOrchestratorExec({ command: 'codex', args: ['exec'] }, CWD, '');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_prompt');
  });

  test('non-string promptFlag → invalid_prompt_flag', () => {
    for (const bogus of [42, {}, []]) {
      const result = resolveOrchestratorExec(
        { command: 'codex', args: ['exec'], promptFlag: bogus }, CWD, PROMPT,
      );
      assert.equal(result.ok, false, `promptFlag=${JSON.stringify(bogus)} must fail`);
      assert.equal(result.reason, 'invalid_prompt_flag');
    }
  });

  // Parity with worktree-safety.cts's `unsafe_leading_dash` guard on git args:
  // a dash-leading positional is parsed by the spawned CLI as a flag, not a
  // value. Same hazard, same rejection — these two surfaces must not diverge.
  test('a dash-leading prompt is rejected (would be parsed as a flag, not a prompt)', () => {
    for (const hostile of ['--dangerously-skip-permissions', '-p', '--help']) {
      const result = resolveOrchestratorExec(
        { command: 'codex', args: ['exec'], cwdFlag: '--cd' }, CWD, hostile,
      );
      assert.equal(result.ok, false, `prompt=${hostile} must be rejected`);
      assert.equal(result.reason, 'unsafe_leading_dash_prompt');
    }
  });

  test('a dash-leading cwd is rejected', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], cwdFlag: '--cd' }, '-oProxyCommand=x', 'ok prompt',
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsafe_leading_dash_cwd');
  });

  test('a prompt merely CONTAINING a dash is fine — only a leading dash is a flag', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], cwdFlag: '--cd' }, CWD, 'Execute plan 2 --verbose style',
    );
    assert.equal(result.ok, true);
    assert.ok(result.args.includes('Execute plan 2 --verbose style'));
  });

  test('empty-string promptFlag falls back to positional rather than emitting a bare ""', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], promptFlag: '' }, CWD, PROMPT,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, ['exec', PROMPT]);
  });
});

describe('resolveOrchestratorExec — fail-closed', () => {
  test('undefined descriptor → missing_command', () => {
    const result = resolveOrchestratorExec(undefined, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_command');
  });

  test('{} (no command) → missing_command', () => {
    const result = resolveOrchestratorExec({}, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_command');
  });

  test('command: "" (empty string) → missing_command', () => {
    const result = resolveOrchestratorExec({ command: '' }, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_command');
  });

  test('command: non-string → missing_command', () => {
    for (const bogus of [42, null, {}, []]) {
      const result = resolveOrchestratorExec({ command: bogus }, '/repo/wt');
      assert.equal(result.ok, false, `command=${JSON.stringify(bogus)} must fail`);
      assert.equal(result.reason, 'missing_command');
    }
  });

  test('empty cwd → invalid_cwd', () => {
    const result = resolveOrchestratorExec({ command: 'codex' }, '');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_cwd');
  });

  test('non-string cwd → invalid_cwd', () => {
    for (const bogus of [undefined, null, 42, {}]) {
      const result = resolveOrchestratorExec({ command: 'codex' }, bogus);
      assert.equal(result.ok, false, `cwd=${JSON.stringify(bogus)} must fail`);
      assert.equal(result.reason, 'invalid_cwd');
    }
  });

  test('args not an array → invalid_args', () => {
    const result = resolveOrchestratorExec({ command: 'codex', args: 'exec' }, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_args');
  });

  test('args array with a non-string element → invalid_args', () => {
    const result = resolveOrchestratorExec({ command: 'codex', args: ['exec', 42] }, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_args');
  });

  test('cwdFlag a number → invalid_cwd_flag', () => {
    const result = resolveOrchestratorExec({ command: 'codex', cwdFlag: 42 }, '/repo/wt');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_cwd_flag');
  });

  test('cwdFlag an object/array → invalid_cwd_flag', () => {
    for (const bogus of [{}, []]) {
      const result = resolveOrchestratorExec({ command: 'codex', cwdFlag: bogus }, '/repo/wt');
      assert.equal(result.ok, false, `cwdFlag=${JSON.stringify(bogus)} must fail`);
      assert.equal(result.reason, 'invalid_cwd_flag');
    }
  });

  test('a reserved-name command string ("__proto__") still resolves at the resolver layer', () => {
    // The resolver only checks "is it a non-empty string" — it never does a
    // property lookup keyed by `command`, so there is no prototype-pollution
    // surface here. The VALIDATOR (capability-validator.cjs) is what rejects
    // "__proto__" at descriptor-load time — see the validator describe block below.
    const result = resolveOrchestratorExec({ command: '__proto__' }, '/repo/wt');
    assert.equal(result.ok, true);
    assert.equal(result.command, '__proto__');
  });
});

describe('resolveOrchestratorExec — fast-check property test', () => {
  const commandArb = fc.string({ minLength: 1 }).filter((s) => s.length > 0);
  const argsArb = fc.array(fc.string());
  const cwdFlagArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.string({ minLength: 1 }).filter((s) => s.length > 0),
  );
  // #2627: a dash-leading cwd is now REJECTED (unsafe_leading_dash_cwd) —
  // the spawned CLI would parse it as a flag, the same hazard worktree-safety's
  // git-argument guard rejects. That is intentional new fail-closed behavior,
  // so the ok:true property below is stated over the domain it actually holds
  // on: real working directories. The rejected half is asserted explicitly in
  // its own property immediately after, so narrowing here loses no coverage.
  const cwdArb = fc.string({ minLength: 1 }).filter((s) => s.length > 0 && !s.startsWith('-'));

  test('property: ok:true, command preserved, cwdFlag appended exactly once (or never for null/absent)', () => {
    fc.assert(
      fc.property(commandArb, argsArb, cwdFlagArb, cwdArb, (command, args, cwdFlag, cwd) => {
        // Guard against the astronomically-rare but non-zero case where the
        // arbitrary `args` already happens to contain the exact `cwd` string —
        // that would make "cwd appears exactly once, at the tail" a false
        // assertion about pre-existing data rather than the resolver's own
        // behavior. Deterministic given the seed; not a flakiness workaround.
        fc.pre(!args.includes(cwd));
        const descriptor = cwdFlag === undefined ? { command, args } : { command, args, cwdFlag };
        const result = resolveOrchestratorExec(descriptor, cwd);
        assert.equal(result.ok, true);
        assert.equal(result.command, command);
        assert.equal(result.cwd, cwd);
        if (typeof cwdFlag === 'string' && cwdFlag.length > 0) {
          assert.deepEqual(result.args.slice(-2), [cwdFlag, cwd]);
          // exactly once: cwdFlag/cwd do not appear anywhere earlier in args
          const earlier = result.args.slice(0, -2);
          assert.ok(!earlier.includes(cwd), 'cwd must not appear before the trailing pair');
        } else {
          assert.ok(!result.args.includes(cwd), 'cwd must not appear in args when cwdFlag is null/absent');
        }
      }),
      { numRuns: 200, seed: 2584 },
    );
  });

  // The complementary half of the narrowed domain above (#2627): every
  // dash-leading cwd fails closed, for ANY descriptor shape.
  test('property: a dash-leading cwd is always rejected, never silently passed through', () => {
    fc.assert(
      fc.property(
        commandArb,
        argsArb,
        cwdFlagArb,
        fc.string().map((s) => `-${s}`),
        (command, args, cwdFlag, cwd) => {
          const descriptor = cwdFlag === undefined ? { command, args } : { command, args, cwdFlag };
          const result = resolveOrchestratorExec(descriptor, cwd);
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'unsafe_leading_dash_cwd');
        },
      ),
      { numRuns: 200, seed: 2627 },
    );
  });

  // Same shape for the prompt argument, which the resolver appends to argv.
  test('property: a dash-leading prompt is always rejected', () => {
    fc.assert(
      fc.property(
        commandArb,
        argsArb,
        fc.string().map((s) => `-${s}`),
        (command, args, prompt) => {
          const result = resolveOrchestratorExec({ command, args }, '/repo/wt', prompt);
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'unsafe_leading_dash_prompt');
        },
      ),
      { numRuns: 200, seed: 2627 },
    );
  });
});

describe('#2584 orchestratorExec — parity / divergence guard', () => {
  const CAPABILITIES_DIR = path.join(REPO_ROOT, 'capabilities');

  function loadCapability(id) {
    return JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, id, 'capability.json'), 'utf8'));
  }

  test('every capability whose dispatch.isolation is "orchestrator-worktree" declares a resolvable orchestratorExec', () => {
    const capIds = fs.readdirSync(CAPABILITIES_DIR).filter((entry) => {
      const capPath = path.join(CAPABILITIES_DIR, entry, 'capability.json');
      return fs.existsSync(capPath);
    });
    const orchestratorWorktreeHosts = [];
    for (const id of capIds) {
      const cap = loadCapability(id);
      const iso = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch
        && cap.runtime.hostIntegration.dispatch.isolation;
      if (iso !== 'orchestrator-worktree') continue;
      orchestratorWorktreeHosts.push(id);

      const orchestratorExec = cap.runtime.orchestratorExec;
      assert.ok(
        orchestratorExec,
        `${id}: dispatch.isolation:"orchestrator-worktree" but no runtime.orchestratorExec declared — ` +
        `a future orchestrator-worktree host MUST declare orchestratorExec (Phase 3 has nothing to spawn otherwise)`,
      );
      const result = resolveOrchestratorExec(orchestratorExec, '/tmp/wt');
      assert.equal(result.ok, true,
        `${id}: runtime.orchestratorExec must resolve cleanly; got reason="${result.ok ? '' : result.reason}"`);
    }
    // Sanity: the sweep actually found the 4 known hosts (guards a broken sweep
    // silently matching zero capabilities and passing vacuously).
    assert.deepEqual(orchestratorWorktreeHosts.sort(), ['codex', 'kimi', 'kimi-code', 'opencode']);
  });

  // #2627: the two guards below encode the per-host research that found two
  // shipped descriptors which would have failed at spawn time — kimi resolving
  // to an interactive TUI (orchestrator hangs) and kimi-code naming a binary
  // that does not exist (ENOENT).
  test('every orchestrator-worktree descriptor resolves to a HEADLESS invocation, never an interactive TUI', () => {
    // A host that binds cwd by flag alone, with no leading subcommand or
    // headless flag, launches its interactive UI. Each host must contribute at
    // least one non-cwd token (a subcommand like `exec`/`run`, or an explicit
    // headless flag like `--print`) BEFORE the cwd flag — or bind by process
    // cwd only, which implies a prompt flag carries the instruction.
    const expected = {
      codex: ['exec'],
      opencode: ['run'],
      kimi: ['--print'],
      'kimi-code': [],
    };
    for (const [id, leadingArgs] of Object.entries(expected)) {
      const cap = loadCapability(id);
      const oe = cap.runtime.orchestratorExec;
      assert.deepEqual(oe.args, leadingArgs,
        `${id}: orchestratorExec.args must be ${JSON.stringify(leadingArgs)} — an empty/verb-less argv for a ` +
        `flag-bound host launches the interactive TUI and the orchestrator waits on it forever`);
      const resolved = resolveOrchestratorExec(oe, '/tmp/wt', 'do the thing');
      assert.equal(resolved.ok, true, `${id}: must resolve with a prompt`);
      assert.ok(resolved.args.includes('do the thing'),
        `${id}: the executor prompt must reach the argv, else the spawned process has no instruction`);
    }
  });

  test('kimi and kimi-code both spawn the "kimi" binary — kimi-code is a package name, not a binary', () => {
    // Moonshot ships both agents as a binary named `kimi`; `kimi-code` is the
    // npm package / config-home name only. Declaring command:"kimi-code" is an
    // immediate ENOENT at spawn.
    for (const id of ['kimi', 'kimi-code']) {
      assert.equal(loadCapability(id).runtime.orchestratorExec.command, 'kimi',
        `${id}: orchestratorExec.command must be the real binary name "kimi"`);
    }
  });

  test('every capability whose dispatch.isolation is "harness-worktree" declares a non-empty harnessIsolationFlag', () => {
    const capIds = fs.readdirSync(CAPABILITIES_DIR).filter((entry) => (
      fs.existsSync(path.join(CAPABILITIES_DIR, entry, 'capability.json'))
    ));
    const harnessHosts = [];
    for (const id of capIds) {
      const cap = loadCapability(id);
      const iso = cap?.runtime?.hostIntegration?.dispatch?.isolation;
      if (iso !== 'harness-worktree') continue;
      harnessHosts.push(id);
      const flag = cap.runtime.harnessIsolationFlag;
      assert.ok(
        typeof flag === 'string' && flag.length > 0,
        `${id}: dispatch.isolation:"harness-worktree" but no runtime.harnessIsolationFlag — the scheduler ` +
        `would have nothing to pass and would dispatch UNISOLATED executors believing they are isolated`,
      );
    }
    assert.deepEqual(harnessHosts.sort(), ['claude', 'cursor']);
  });

  test('no capability declares BOTH isolation mechanisms (they are mutually exclusive models)', () => {
    const capIds = fs.readdirSync(CAPABILITIES_DIR).filter((entry) => (
      fs.existsSync(path.join(CAPABILITIES_DIR, entry, 'capability.json'))
    ));
    for (const id of capIds) {
      const cap = loadCapability(id);
      const hasHarness = typeof cap?.runtime?.harnessIsolationFlag === 'string';
      const hasOrchestrator = cap?.runtime?.orchestratorExec !== undefined;
      assert.ok(!(hasHarness && hasOrchestrator),
        `${id}: declares both harnessIsolationFlag and orchestratorExec — a host has exactly one fan-out model`);
    }
  });
});

describe('#2584 orchestratorExec — validator', () => {
  function shippedCodexCapabilityWithoutOrchestratorExec() {
    const cap = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'codex', 'capability.json'), 'utf8'),
    );
    delete cap.runtime.orchestratorExec;
    return cap;
  }

  test('a descriptor that omits orchestratorExec entirely still validates clean (optional field)', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    const errors = validateCapability(cap, 'codex');
    assert.deepEqual(errors, [], `omitted orchestratorExec must validate clean, got: ${JSON.stringify(errors)}`);
  });

  test('a well-formed orchestratorExec passes with zero orchestratorExec errors', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: 'codex', args: ['exec'], cwdFlag: '--cd' };
    const errors = validateCapability(cap, 'codex');
    const oeErrors = errors.filter((e) => e.includes('orchestratorExec'));
    assert.deepEqual(oeErrors, []);
  });

  test('orchestratorExec: not an object (array/null/string) → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    for (const bogus of [[], null, 'codex', 42]) {
      cap.runtime.orchestratorExec = bogus;
      const errors = validateCapability(cap, 'codex');
      assert.ok(
        errors.some((e) => e.includes('runtime.orchestratorExec must be an object')),
        `orchestratorExec=${JSON.stringify(bogus)} must be rejected; got: ${JSON.stringify(errors)}`,
      );
    }
  });

  test('command missing → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { args: [], cwdFlag: null };
    const errors = validateCapability(cap, 'codex');
    assert.ok(errors.some((e) => e.includes('runtime.orchestratorExec.command')));
  });

  test('command: "" (empty string) → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: '' };
    const errors = validateCapability(cap, 'codex');
    assert.ok(errors.some((e) => e.includes('runtime.orchestratorExec.command')));
  });

  test('command: "__proto__" (reserved name) → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: '__proto__' };
    const errors = validateCapability(cap, 'codex');
    assert.ok(
      errors.some((e) => e.includes('runtime.orchestratorExec.command') && e.includes('reserved name')),
      `"__proto__" must produce a reserved-name validator error; got: ${JSON.stringify(errors)}`,
    );
  });

  test('args: non-array → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: 'codex', args: 'exec' };
    const errors = validateCapability(cap, 'codex');
    assert.ok(errors.some((e) => e.includes('runtime.orchestratorExec.args')));
  });

  test('args: array with a non-string element → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: 'codex', args: ['exec', 42] };
    const errors = validateCapability(cap, 'codex');
    assert.ok(errors.some((e) => e.includes('runtime.orchestratorExec.args')));
  });

  test('cwdFlag: a number → rejected', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: 'codex', cwdFlag: 42 };
    const errors = validateCapability(cap, 'codex');
    assert.ok(errors.some((e) => e.includes('runtime.orchestratorExec.cwdFlag')));
  });

  test('cwdFlag: null is valid (no error)', () => {
    const cap = shippedCodexCapabilityWithoutOrchestratorExec();
    cap.runtime.orchestratorExec = { command: 'kimi-code', args: [], cwdFlag: null };
    const errors = validateCapability(cap, 'codex');
    const oeErrors = errors.filter((e) => e.includes('orchestratorExec'));
    assert.deepEqual(oeErrors, []);
  });

  test('full descriptor sweep: every shipped capability.json still validates clean after the orchestratorExec addition', () => {
    const CAPABILITIES_DIR = path.join(REPO_ROOT, 'capabilities');
    const capIds = fs.readdirSync(CAPABILITIES_DIR).filter((entry) => {
      const capPath = path.join(CAPABILITIES_DIR, entry, 'capability.json');
      return fs.existsSync(capPath);
    });
    for (const id of capIds) {
      const cap = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, id, 'capability.json'), 'utf8'));
      if (cap.role !== 'runtime') continue;
      const errors = validateCapability(cap, id);
      assert.deepEqual(errors, [], `${id}: capability.json must still validate clean; got: ${JSON.stringify(errors)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// #3714 — codex-worktree model pin.
//
// `resolveOrchestratorExec` currently takes NO `model` argument at all, so
// codex's argv never carries `--model` regardless of any configured
// model_overrides. THESE TESTS ARE FAILING-FIRST against today's code — do
// not "fix" resolveOrchestratorExec or gsd-tools.cjs to make them pass here;
// that is a separate change. See issue #3714.
//
// THE FIX THIS PINS (not yet implemented):
//   1. Descriptor gains an optional `modelFlag` (string|null). codex ->
//      "--model"; every other shipped runtime leaves it absent/null.
//   2. resolveOrchestratorExec(orchestratorExec, cwd, prompt, model) gains an
//      optional 4th positional `model`, appending [modelFlag, model] ONLY
//      when modelFlag is a non-empty string AND model is a non-empty string.
//      Argv order: baseArgs -> modelFlag,model -> cwdFlag,cwd -> prompt. The
//      prompt remains the final positional token. Fails closed with
//      'unsafe_leading_dash_model' exactly like the existing
//      unsafe_leading_dash_prompt / unsafe_leading_dash_cwd guards.
//   3. Policy (which model, if any, to pass) lives at the CALLER
//      (bin/gsd-tools.cjs), via:
//        resolveAgentModelOverride('gsd-executor', readGsdEffectiveModelOverrides(cwd), null)
//      then dropping the 'inherit' sentinel. Passing null as the runtime
//      resolver is what makes "no tier routing" structural (ADR-2313) — the
//      seam itself decides no policy.
// ---------------------------------------------------------------------------

describe('#3714 resolveOrchestratorExec — modelFlag/model seam (mechanical, RED pre-fix)', () => {
  const CWD = '/repo/.claude/worktrees/agent-a1';
  const PROMPT = 'Execute plan 2 of phase 3.';
  const CODEX_MODEL_DESCRIPTOR = { command: 'codex', args: ['exec'], cwdFlag: '--cd', modelFlag: '--model' };
  const EXPECTED_ARGS_WITH_MODEL = ['exec', '--model', 'gpt-5.6-terra', '--cd', CWD, PROMPT];
  const EXPECTED_ARGS_NO_MODEL = ['exec', '--cd', CWD, PROMPT];

  // MATRIX row 1 [FAIL]: explicit pin -> full argv identity, not includes().
  // Today's resolver ignores the 4th `model` argument entirely, so this
  // produces ["exec","--cd",CWD,PROMPT] — no "--model" anywhere — and the
  // deepEqual below is RED.
  test('row 1: explicit model pin -> full argv is [baseArgs..., --model, <model>, cwdFlag, cwd, prompt]', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, 'gpt-5.6-terra');
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_WITH_MODEL,
      'today\'s resolver has no model parameter — it silently drops "gpt-5.6-terra" and emits no --model at all');
  });

  // MATRIX row 6 [FAIL]: prompt is still the LAST element of args once a
  // model is emitted. Pinned via the same full-array identity check as row 1
  // (a narrower args[len-1]===prompt check alone would pass today by
  // coincidence, since nothing is ever inserted after the prompt either way).
  test('row 6: when a model IS emitted, the prompt remains the LAST element of args', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, 'gpt-5.6-terra');
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_WITH_MODEL);
    assert.equal(result.args[result.args.length - 1], PROMPT);
  });

  // Boundary: modelFlag absent / null / "" -> no --model ever appears,
  // regardless of a valid model value. All three CONTROL (pass today, by
  // coincidence of today's total absence of model support — but this is also
  // the documented post-fix contract, so these stay green after the fix).
  test('modelFlag absent, model provided -> no --model on the wire', () => {
    const result = resolveOrchestratorExec({ command: 'codex', args: ['exec'], cwdFlag: '--cd' }, CWD, PROMPT, 'gpt-5.6-terra');
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  test('modelFlag null, model provided -> no --model on the wire', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], cwdFlag: '--cd', modelFlag: null }, CWD, PROMPT, 'gpt-5.6-terra',
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  test('modelFlag "" (empty string), model provided -> no --model on the wire', () => {
    const result = resolveOrchestratorExec(
      { command: 'codex', args: ['exec'], cwdFlag: '--cd', modelFlag: '' }, CWD, PROMPT, 'gpt-5.6-terra',
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  // Boundary: model absent / null / "" -> no --model ever appears, regardless
  // of a valid modelFlag. All three CONTROL.
  test('modelFlag present, model absent -> no --model on the wire', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  test('modelFlag present, model null -> no --model on the wire', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, null);
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  test('modelFlag present, model "" (empty string) -> no --model on the wire', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, '');
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, EXPECTED_ARGS_NO_MODEL);
  });

  // New fail-closed guard, mirroring unsafe_leading_dash_prompt/_cwd. RED
  // today: the resolver has no model-validation branch at all, so a
  // dash-leading model is simply ignored (ok:true) rather than rejected.
  test('a dash-leading model is rejected: unsafe_leading_dash_model', () => {
    for (const hostile of ['--dangerously-skip-permissions', '-p', '--help']) {
      const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, hostile);
      assert.equal(result.ok, false, `model=${hostile} must be rejected`);
      assert.equal(result.reason, 'unsafe_leading_dash_model');
    }
  });

  test('a model merely CONTAINING a dash is fine — only a leading dash is a flag', () => {
    const result = resolveOrchestratorExec(CODEX_MODEL_DESCRIPTOR, CWD, PROMPT, 'gpt-5.6-terra');
    assert.equal(result.ok, true);
    assert.ok(result.args.includes('gpt-5.6-terra'));
  });

  // Every existing fail-closed guard must still fire, unaffected by a valid
  // model argument riding alongside. CONTROL — these guards run before any
  // model logic regardless of whether the model param exists yet.
  test('existing fail-closed guards still fire with a model present', () => {
    assert.equal(resolveOrchestratorExec(undefined, CWD, PROMPT, 'm').reason, 'missing_command');
    assert.equal(resolveOrchestratorExec({}, CWD, PROMPT, 'm').reason, 'missing_command');
    assert.equal(resolveOrchestratorExec({ command: 'codex' }, '', PROMPT, 'm').reason, 'invalid_cwd');
    assert.equal(resolveOrchestratorExec({ command: 'codex', args: 'exec' }, CWD, PROMPT, 'm').reason, 'invalid_args');
    assert.equal(resolveOrchestratorExec({ command: 'codex' }, CWD, '', 'm').reason, 'invalid_prompt');
    assert.equal(
      resolveOrchestratorExec({ command: 'codex', cwdFlag: '--cd' }, '-oProxyCommand=x', PROMPT, 'm').reason,
      'unsafe_leading_dash_cwd',
    );
    assert.equal(
      resolveOrchestratorExec({ command: 'codex', cwdFlag: '--cd' }, CWD, '-p', 'm').reason,
      'unsafe_leading_dash_prompt',
    );
  });

  // ITEM 3: `invalid_model` is live for any non-string, non-null, non-undefined
  // `model` argument — a caller error (number/bool/array/object), distinct
  // from the benign "use the host default" degradation that null/undefined/''
  // already exercise. Previously zero test references (Stryker-visible gap).
  test('ITEM 3: a non-string model (number, boolean, array, object) -> {ok:false, reason:"invalid_model"}', () => {
    for (const bogus of [7, true, [], {}]) {
      const result = resolveOrchestratorExec({ command: 'codex', modelFlag: '--model' }, CWD, PROMPT, bogus);
      assert.deepEqual(result, { ok: false, reason: 'invalid_model' },
        `model=${JSON.stringify(bogus)} must take the invalid_model branch`);
    }
  });

  // ITEM 3 CONTROL: null/undefined/'' must NOT take the invalid_model branch —
  // they degrade to "omit the flag" and the resolution still succeeds.
  test('ITEM 3 CONTROL: null/undefined/\'\' do NOT take invalid_model — they omit the flag and succeed', () => {
    for (const benign of [null, undefined, '']) {
      const result = resolveOrchestratorExec({ command: 'codex', modelFlag: '--model' }, CWD, PROMPT, benign);
      assert.equal(result.ok, true, `model=${JSON.stringify(benign)} must resolve ok:true`);
      assert.ok(!result.args.includes('--model'), `model=${JSON.stringify(benign)} must omit the --model flag`);
    }
  });

  // MATRIX row 7 [CONTROL]: a host with no modelFlag is byte-identical to
  // today whether or not a model is passed — kimi-code/opencode never get a
  // 5th positional token nor a flag pair injected.
  test('row 7 CONTROL: a host descriptor with NO modelFlag key resolves identically whether or not a model is passed', () => {
    const descriptor = { command: 'kimi', args: ['--print'], cwdFlag: '--work-dir', promptFlag: '--prompt' };
    const withoutModelArg = resolveOrchestratorExec(descriptor, CWD, PROMPT);
    const withModelArg = resolveOrchestratorExec(descriptor, CWD, PROMPT, 'some-model');
    assert.deepEqual(withModelArg, withoutModelArg,
      'a descriptor with no modelFlag must resolve identically whether or not a model is passed');
    assert.deepEqual(withoutModelArg.args, ['--print', '--work-dir', CWD, '--prompt', PROMPT]);
  });

  test('property: for any descriptor and any model input, when a prompt is supplied it is always args[args.length-1] (seed=3714)', () => {
    const commandArb = fc.string({ minLength: 1 }).filter((s) => s.length > 0);
    const argsArb = fc.array(fc.string());
    const cwdArb = fc.string({ minLength: 1 }).filter((s) => s.length > 0 && !s.startsWith('-'));
    const flagArb = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.constant(''),
      fc.string({ minLength: 1 }).filter((s) => s.length > 0 && !s.startsWith('-')),
    );
    const modelArb = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.constant(''),
      fc.string({ minLength: 1 }).filter((s) => s.length > 0 && !s.startsWith('-')),
    );
    const promptArb = fc.string({ minLength: 1 }).filter((s) => s.length > 0 && !s.startsWith('-'));

    fc.assert(
      fc.property(commandArb, argsArb, cwdArb, flagArb, modelArb, promptArb,
        (command, args, cwd, modelFlag, model, prompt) => {
          fc.pre(!args.includes(cwd) && !args.includes(prompt));
          const descriptor = modelFlag === undefined ? { command, args } : { command, args, modelFlag };
          const result = resolveOrchestratorExec(descriptor, cwd, prompt, model);
          assert.equal(result.ok, true);
          assert.equal(result.args[result.args.length - 1], prompt);
        }),
      { numRuns: 200, seed: 3714 },
    );
  });
});

// ---------------------------------------------------------------------------
// #3714 — end-to-end policy: the caller (bin/gsd-tools.cjs) decides WHETHER
// to pass a model at all, via
//   resolveAgentModelOverride('gsd-executor', readGsdEffectiveModelOverrides(cwd), null)
// then dropping the 'inherit' sentinel. Every row below is a MEASURED FACT
// (verified by direct execution against this repo's current code) about what
// that function returns for a given .planning/config.json shape — these
// describe the POLICY the fix must implement, not a currently-wired
// behavior: `query dispatch-isolation` never emits --model today for ANY
// config shape, so only the "explicit pin" rows are RED; the rest coincide
// with today's (absent) behavior and are CONTROLS.
// ---------------------------------------------------------------------------
describe('#3714 dispatch-isolation CLI — model policy end-to-end (RED pre-fix on explicit-pin rows)', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { throwIfFailed } = require('./helpers/git-fixture.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { createTempProject, cleanup, TEST_HOME_SANDBOX_MARKER } = require('./helpers.cjs');
  const os = require('node:os');
  const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

  function writeConfig(projectDir, config) {
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config),
    );
  }

  // Hermeticity: `queryCodexJson` used to inherit the DEVELOPER's real
  // HOME/USERPROFILE with no override, so any row that writes no
  // `model_overrides` key at all was silently reading (and could red
  // against) the operator's own ~/.gsd/defaults.json — exactly the surface
  // the BLOCKER regression test below needs to control precisely. Every
  // call now gets a fresh, per-call temp HOME (removed synchronously after
  // the CLI returns, since the call is a blocking spawn). USERPROFILE is
  // set alongside HOME because os.homedir() reads USERPROFILE on Windows;
  // omitting it would make the isolation vacuous there. The sandbox marker
  // satisfies the same passwd-less-host fallback installSpawnEnv documents.
  // `beforeSpawn`, when provided, is called with the sandbox HOME dir path
  // BEFORE the CLI spawns — the seam a caller needs to seed a GLOBAL
  // ~/.gsd/defaults.json (see writeGlobalDefaults below) for a
  // global-only-pin row.
  function queryCodexJson(projectDir, extraEnv = {}, beforeSpawn = null) {
    const sandboxHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3714-home-'));
    try {
      if (typeof beforeSpawn === 'function') beforeSpawn(sandboxHomeDir);
      const r = runNode(
        [GSD_TOOLS, 'query', 'dispatch-isolation', '--json', '--cwd-target', '/tmp/wt', '--prompt', 'do the thing'],
        {
          cwd: projectDir,
          env: {
            ...process.env,
            GSD_RUNTIME: 'codex',
            HOME: sandboxHomeDir,
            USERPROFILE: sandboxHomeDir,
            [TEST_HOME_SANDBOX_MARKER]: sandboxHomeDir,
            ...extraEnv,
          },
          timeoutMs: PROBE_TIMEOUT_MS,
        },
      );
      throwIfFailed(r, 'gsd-tools query dispatch-isolation --json (codex, model policy)');
      return { json: JSON.parse(r.stdout), stderr: r.stderr };
    } finally {
      cleanup(sandboxHomeDir);
    }
  }

  // Writes ~/.gsd/defaults.json (the GLOBAL model_overrides store) into the
  // per-call sandbox HOME so a test can exercise "global-only pin, no
  // per-project override" — the exact shape the BLOCKER describes.
  function writeGlobalDefaults(homeDir, defaults) {
    const gsdDir = path.join(homeDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify(defaults));
  }

  function hasModelFlag(execArgs) {
    return execArgs.includes('--model');
  }

  // MATRIX row 1: an explicit real-Codex gsd-executor override reaches argv
  // as --model.
  test('row 1: explicit model_overrides["gsd-executor"] -> exec.args contains ["--model","gpt-5.6-terra"] at the correct position', () => {
    const dir = createTempProject('gsd-3714-row1-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': 'gpt-5.6-terra' } });
      const { json: result } = queryCodexJson(dir);
      assert.equal(result.isolation, 'orchestrator-worktree');
      assert.deepEqual(result.exec.args, ['exec', '--model', 'gpt-5.6-terra', '--cd', '/tmp/wt', 'do the thing']);
    } finally {
      cleanup(dir);
    }
  });

  // MATRIX row 2 [CONTROL]: no override configured -> no --model, and in
  // particular the resolve-model tier value ("sonnet") must NEVER leak onto
  // codex's argv (that is the #2310/#2311 400 ADR-2313 exists to prevent).
  test('row 2 CONTROL: no override -> exec.args contains NO --model and no "sonnet" anywhere', () => {
    const dir = createTempProject('gsd-3714-row2-');
    try {
      writeConfig(dir, {});
      const { json: result } = queryCodexJson(dir);
      assert.equal(result.isolation, 'orchestrator-worktree');
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.ok(!result.exec.args.join(' ').includes('sonnet'));
    } finally {
      cleanup(dir);
    }
  });

  // MATRIX row 3 [CONTROL]: the 'inherit' sentinel must never reach argv.
  test('row 3 CONTROL: model_overrides["gsd-executor"] === "inherit" -> no --model (sentinel never on the wire)', () => {
    const dir = createTempProject('gsd-3714-row3-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': 'inherit' } });
      const { json: result } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.ok(!result.exec.args.join(' ').includes('inherit'));
    } finally {
      cleanup(dir);
    }
  });

  // MATRIX row 4 [CONTROL]: an empty-string override resolves to null, same as no override.
  test('row 4 CONTROL: model_overrides["gsd-executor"] === "" -> no --model', () => {
    const dir = createTempProject('gsd-3714-row4-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': '' } });
      const { json: result } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
    } finally {
      cleanup(dir);
    }
  });

  // MATRIX row 5 [CONTROL]: a model_profile alone (no per-agent override) must
  // NOT route through the tier table onto codex's argv — ADR-2313 forbids
  // tier routing to codex entirely; passing `null` as the runtimeResolver
  // (per the fix design) is what makes this structural rather than incidental.
  test('row 5 CONTROL: model_profile:"balanced" only (no per-agent override) -> no --model (tier routing forbidden, ADR-2313)', () => {
    const dir = createTempProject('gsd-3714-row5-');
    try {
      writeConfig(dir, { runtime: 'codex', model_profile: 'balanced' });
      const { json: result } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.ok(!result.exec.args.join(' ').includes('sonnet'));
    } finally {
      cleanup(dir);
    }
  });

  // BLOCKER regression test: a GLOBAL (~/.gsd/defaults.json) Anthropic-flavored
  // pin must NOT reach codex's argv, and must produce a stderr warning. Before
  // this fix, presence-only gating let this straight through to
  // `codex exec --model sonnet` — the documented #2310/#2311 400.
  test('BLOCKER: global-only model_overrides["gsd-executor"]="sonnet" -> NO --model, and a stderr warning', () => {
    const dir = createTempProject('gsd-3714-blocker-global-anthropic-');
    try {
      writeConfig(dir, {});
      const { json: result, stderr } = queryCodexJson(dir, {}, (homeDir) => {
        writeGlobalDefaults(homeDir, { model_overrides: { 'gsd-executor': 'sonnet' } });
      });
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.ok(!result.exec.args.join(' ').includes('sonnet'));
      assert.match(stderr, /gsd-executor.*sonnet.*Anthropic/i);
    } finally {
      cleanup(dir);
    }
  });

  test('global-only model_overrides["gsd-executor"]="gpt-5.6-terra" (real Codex pin) -> IS emitted', () => {
    const dir = createTempProject('gsd-3714-global-real-');
    try {
      writeConfig(dir, {});
      const { json: result, stderr } = queryCodexJson(dir, {}, (homeDir) => {
        writeGlobalDefaults(homeDir, { model_overrides: { 'gsd-executor': 'gpt-5.6-terra' } });
      });
      assert.deepEqual(result.exec.args, ['exec', '--model', 'gpt-5.6-terra', '--cd', '/tmp/wt', 'do the thing']);
      assert.equal(stderr, '');
    } finally {
      cleanup(dir);
    }
  });

  test('whitespace-only override "   " -> no --model, no warning', () => {
    const dir = createTempProject('gsd-3714-ws-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': '   ' } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.equal(stderr, '');
    } finally {
      cleanup(dir);
    }
  });

  test('"Inherit" and " inherit " (case/whitespace-insensitive sentinel) -> no --model', () => {
    for (const value of ['Inherit', ' inherit ']) {
      const dir = createTempProject('gsd-3714-inherit-ci-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result, stderr } = queryCodexJson(dir);
        assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing'], `value=${JSON.stringify(value)}`);
        assert.equal(stderr, '');
      } finally {
        cleanup(dir);
      }
    }
  });

  test('injection-shaped override values -> no --model, and a stderr warning', () => {
    const injectionValues = [
      'gpt-5 -c approval_policy=never',
      'gpt-5$(touch /tmp/x)',
      'gpt-5; touch /tmp/x',
      'gpt-5\nHOST_INJECTED',
      'gpt-5 HOST_INJECTED',
    ];
    for (const value of injectionValues) {
      const dir = createTempProject('gsd-3714-injection-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result, stderr } = queryCodexJson(dir);
        assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing'],
          `value=${JSON.stringify(value)} must never reach argv`);
        assert.ok(!hasModelFlag(result.exec.args));
        assert.match(stderr, /gsd-executor/, `value=${JSON.stringify(value)} must warn`);
      } finally {
        cleanup(dir);
      }
    }
  });

  test('legitimate real-Codex ids survive: "gpt-5.6-terra" and "synthetic/hf:zai-org/GLM-5.2"', () => {
    for (const value of ['gpt-5.6-terra', 'synthetic/hf:zai-org/GLM-5.2']) {
      const dir = createTempProject('gsd-3714-legit-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result, stderr } = queryCodexJson(dir);
        assert.deepEqual(result.exec.args, ['exec', '--model', value, '--cd', '/tmp/wt', 'do the thing']);
        assert.equal(stderr, '');
      } finally {
        cleanup(dir);
      }
    }
  });

  // ITEM 1 follow-up: MODEL_ID_CHARSET_RE previously excluded '@', so a real
  // Vertex model-version pin ("text-bison@002") was dropped as if it were an
  // injection-shaped value. '@' is now permitted. The leading-dash row is
  // kept adjacent so the anchor LEADING_DASH_RE still enforces is visibly
  // still live even after widening the charset.
  test('ITEM 1: "text-bison@002" (Vertex model-version pin) survives — "@" is a legitimate model-id character', () => {
    const dir = createTempProject('gsd-3714-vertex-at-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': 'text-bison@002' } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--model', 'text-bison@002', '--cd', '/tmp/wt', 'do the thing']);
      assert.equal(stderr, '');
    } finally {
      cleanup(dir);
    }
  });

  test('ITEM 1 anchor control: a leading dash still drops even though "@" is now permitted ("-@bad" -> no --model, a warning)', () => {
    const dir = createTempProject('gsd-3714-vertex-at-leading-dash-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': '-@bad' } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.match(stderr, /gsd-executor/);
    } finally {
      cleanup(dir);
    }
  });

  // MATRIX row 8: the dispatch predicate (what gsd-tools.cjs's caller decides
  // to pass) must agree, on every config shape below, with what the shared
  // resolveAgentModelOverride('gsd-executor', overrides, null) function
  // returns (dropping only the 'inherit' sentinel). This row is a resolver
  // TAUTOLOGY — it agrees with the presence-only predicate and does not
  // exercise the VALUE policy (Anthropic-flavored / charset) at all. It is
  // kept as a presence-level regression guard; the real divergence guard is
  // the CROSS-SURFACE PARITY test below.
  test('row 8: dispatch predicate agrees with resolveAgentModelOverride(..., null) on every config shape', () => {
    const installModelOverrideResolver = require('../gsd-core/bin/lib/install-model-override-resolver.cjs');
    const shapes = [
      { name: 'explicit pin', config: { model_overrides: { 'gsd-executor': 'gpt-5.6-terra' } } },
      { name: 'no override', config: {} },
      { name: 'override "inherit"', config: { model_overrides: { 'gsd-executor': 'inherit' } } },
      { name: 'override ""', config: { model_overrides: { 'gsd-executor': '' } } },
      { name: 'model_profile only', config: { runtime: 'codex', model_profile: 'balanced' } },
    ];
    for (const shape of shapes) {
      const dir = createTempProject('gsd-3714-row8-');
      try {
        writeConfig(dir, shape.config);
        // The predicate the fix's caller must implement: explicit override,
        // no runtime-tier resolver (null), with 'inherit' dropped.
        const overrides = installModelOverrideResolver.readGsdEffectiveModelOverrides(dir);
        const resolved = installModelOverrideResolver.resolveAgentModelOverride('gsd-executor', overrides, null);
        const expectedModel = (resolved && resolved !== 'inherit') ? resolved : null;
        const expectedHasModel = expectedModel !== null;

        const { json: result } = queryCodexJson(dir);
        const actualHasModel = hasModelFlag(result.exec.args);

        assert.equal(actualHasModel, expectedHasModel,
          `shape="${shape.name}": predicate says emit-model=${expectedHasModel} but actual argv ` +
          `${expectedHasModel ? 'never carries' : 'unexpectedly carries'} --model (args=${JSON.stringify(result.exec.args)})`);
        if (expectedHasModel) {
          assert.deepEqual(result.exec.args, ['exec', '--model', expectedModel, '--cd', '/tmp/wt', 'do the thing']);
        }
      } finally {
        cleanup(dir);
      }
    }
  });

  // DIVERGENCE GUARD — real cross-surface parity test. For each value below,
  // assert that dispatch (this describe's CLI, driven for real end-to-end)
  // and the install-side .toml policy (bin/install.js generateCodexAgentToml,
  // NOT reachable in-process here — it lives in the generated installer
  // module and is exercised only via `npm run build` / the install test
  // suite) would reach the SAME emit-vs-drop decision for the identical
  // model_overrides["gsd-executor"] value.
  //
  // What is asserted DIRECTLY (real code path, in-process): the dispatch
  // side, via the real `gsd-tools query dispatch-isolation` CLI spawn.
  // What is MIRRORED (not independently re-executed): the install-side half
  // is derived from `isAnthropicFlavoredModel` (the single-sourced #3241
  // predicate, imported for real from bin/lib/model-catalog.cjs — so THAT
  // predicate call is real, not re-implemented) plus the documented
  // install-side rules from bin/install.js's generateCodexAgentToml
  // (trim; drop empty/whitespace-only; drop Anthropic-flavored). Install-side
  // does NOT apply a charset check — that is dispatch-only, added because
  // dispatch crosses a shell-argv boundary that a static .toml string never
  // does. A future reader: if bin/install.js's trim/drop rules for this key
  // change without a matching update here, this comment is the thing that
  // goes stale, not a shared executable — that is the acknowledged limit.
  test('DIVERGENCE GUARD: dispatch model-pin decision matches install-side Codex .toml policy for the same value', () => {
    const { isAnthropicFlavoredModel } = require('../gsd-core/bin/lib/model-catalog.cjs');
    function installSideWouldEmit(rawValue) {
      if (typeof rawValue !== 'string') return false;
      const trimmed = rawValue.trim();
      if (trimmed === '') return false;
      if (isAnthropicFlavoredModel(trimmed)) return false;
      return true;
    }
    const table = [
      'gpt-5.6-terra',
      'synthetic/hf:zai-org/GLM-5.2',
      'sonnet',
      'opus',
      'claude-sonnet-4-5',
      '',
      '   ',
      'inherit',
      'Inherit',
      '-p',
      'gpt-5 -c approval_policy=never',
    ];
    for (const value of table) {
      const dir = createTempProject('gsd-3714-parity-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result } = queryCodexJson(dir);
        const dispatchEmitted = hasModelFlag(result.exec.args);
        // Dispatch additionally drops 'inherit' (case/whitespace-insensitive)
        // and non-model-id-charset values — neither is an install-side .toml
        // concern (install never sees the literal string "inherit" as a
        // meaningful sentinel, and a static TOML string is not a shell argv
        // boundary), so those two are excluded from the parity assertion
        // itself and asserted directly instead.
        const trimmedLower = typeof value === 'string' ? value.trim().toLowerCase() : value;
        if (trimmedLower === 'inherit') {
          assert.equal(dispatchEmitted, false, `value=${JSON.stringify(value)}: inherit sentinel must never emit`);
          continue;
        }
        if (value === '-p' || value === 'gpt-5 -c approval_policy=never') {
          assert.equal(dispatchEmitted, false, `value=${JSON.stringify(value)}: unsafe-charset value must never emit`);
          continue;
        }
        assert.equal(dispatchEmitted, installSideWouldEmit(value),
          `value=${JSON.stringify(value)}: dispatch emit=${dispatchEmitted} but install-side policy says emit=${installSideWouldEmit(value)}`);
      } finally {
        cleanup(dir);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Round-2 review regression rows — three real defects reproduced against
  // this repo's actual CLI (see the fix commit for the full repro transcript).
  // ---------------------------------------------------------------------------

  // DEFECT 1: a leading-dash pin ('-c', '--config', '-', '--') previously
  // passed MODEL_ID_CHARSET_RE silently (it permits '-'), reached
  // resolveOrchestratorExec, tripped its `unsafe_leading_dash_model` guard,
  // and turned the WHOLE resolution to exec:null — a wave-fatal abort per
  // executor-isolation-dispatch.md:299-303, with no warning at all. The fix
  // rejects a leading '-' inside resolveDispatchModelPin itself so it
  // degrades like every other rejected shape: no --model, a warning, exec
  // still resolves.
  test('DEFECT 1: leading-dash pins ("-c", "--config", "-", "--") -> no --model, a warning, exec NOT null (argv == no-model argv)', () => {
    const leadingDashValues = ['-c', '--config', '-', '--'];
    for (const value of leadingDashValues) {
      const dir = createTempProject('gsd-3714-leading-dash-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result, stderr } = queryCodexJson(dir);
        assert.notEqual(result.exec, null, `value=${JSON.stringify(value)}: exec must not be null`);
        assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing'],
          `value=${JSON.stringify(value)}: argv must equal the no-model argv exactly`);
        assert.ok(!hasModelFlag(result.exec.args));
        assert.match(stderr, /gsd-executor/, `value=${JSON.stringify(value)} must warn`);
      } finally {
        cleanup(dir);
      }
    }
  });

  // DEFECT 1 REGRESSION ROW: the same '-c' pin under a host with NO
  // modelFlag at all (kimi-code) must resolve byte-identical argv to the
  // no-pin case — before the fix, resolveOrchestratorExec's leading-dash
  // guard fires BEFORE the modelFlag presence check, so this host (which
  // previously ignored the model entirely) was newly broken by the pin
  // policy. The pin policy (and its warning) is gated on the descriptor
  // declaring a non-empty `modelFlag`; kimi-code declares none, so this must
  // now produce NO stderr warning either (item 2 follow-up) — the value
  // policy never runs at all for a host that was never going to emit
  // --model.
  test('DEFECT 1 REGRESSION: "-c" pin under kimi-code (no modelFlag host) -> argv byte-identical to no-pin, exec NOT null, stderr EMPTY', () => {
    const noPinDir = createTempProject('gsd-3714-kimi-nopin-');
    const pinnedDir = createTempProject('gsd-3714-kimi-pinned-');
    try {
      writeConfig(noPinDir, {});
      writeConfig(pinnedDir, { model_overrides: { 'gsd-executor': '-c' } });
      const { json: noPinResult } = queryCodexJson(noPinDir, { GSD_RUNTIME: 'kimi-code' });
      const { json: pinnedResult, stderr } = queryCodexJson(pinnedDir, { GSD_RUNTIME: 'kimi-code' });
      assert.notEqual(noPinResult.exec, null, 'kimi-code no-pin: exec must not be null');
      assert.notEqual(pinnedResult.exec, null, 'kimi-code "-c" pin: exec must not be null (this is the regression)');
      assert.deepEqual(pinnedResult.exec.args, noPinResult.exec.args,
        'kimi-code argv with a "-c" pin must be byte-identical to the no-pin argv');
      assert.equal(stderr, '', 'a host with no modelFlag must never run the pin policy, so no warning');
    } finally {
      cleanup(noPinDir);
      cleanup(pinnedDir);
    }
  });

  // DEFECT 2: isAnthropicFlavoredModel lowercased its substring arm but not
  // its CLAUDE_AGENT_ALIASES.has(...) arm, so a case variant of a bare alias
  // ("Sonnet", "OPUS") or a mixed-case "claude-*" id ("Claude-Sonnet-4-5")
  // slipped through as if it were a real Codex model id. Lowercase 'sonnet'
  // is the control (already correctly dropped pre-fix).
  // NOTE: "opus-4.1" is deliberately excluded from this table. It matches
  // neither arm of isAnthropicFlavoredModel by DESIGN, independent of case:
  // CLAUDE_AGENT_ALIASES holds only the bare tier names ('opus'/'sonnet'/
  // 'haiku'/'fable'), never version-qualified forms, and "opus-4.1" contains
  // no "claude" substring (every real catalog Anthropic id is "claude-*").
  // This is a pre-existing predicate-design gap, not the case-sensitivity
  // defect fixed here — flagged separately rather than asserted as fixed
  // behavior in this test.
  test('DEFECT 2: case variants of Anthropic-flavored pins ("Sonnet", "OPUS", "Claude-Sonnet-4-5") -> no --model + warning', () => {
    const caseVariants = ['Sonnet', 'OPUS', 'Claude-Sonnet-4-5'];
    for (const value of caseVariants) {
      const dir = createTempProject('gsd-3714-case-flavor-');
      try {
        writeConfig(dir, { model_overrides: { 'gsd-executor': value } });
        const { json: result, stderr } = queryCodexJson(dir);
        assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing'],
          `value=${JSON.stringify(value)} must never reach argv`);
        assert.ok(!hasModelFlag(result.exec.args));
        assert.match(stderr, /gsd-executor/, `value=${JSON.stringify(value)} must warn`);
      } finally {
        cleanup(dir);
      }
    }
  });

  test('DEFECT 2 CONTROL: lowercase "sonnet" still drops (unchanged behavior)', () => {
    const dir = createTempProject('gsd-3714-case-flavor-control-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': 'sonnet' } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.match(stderr, /gsd-executor/);
    } finally {
      cleanup(dir);
    }
  });

  // DEFECT 3: _warnDispatchModelPinDropped wrote the rejected raw value to
  // stderr, truncated but never escaped — a guaranteed-reachable raw-to-TTY
  // sink for control/escape bytes, since every value reaching this warning
  // failed the charset test by definition. Built with String.fromCharCode so
  // the test source itself carries no literal control characters.
  test('DEFECT 3: an ESC/BEL-bearing pin is dropped AND the stderr warning contains no raw control character', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const hostileValue = `x${ESC}]0;PWNED${BEL}y`;
    const dir = createTempProject('gsd-3714-defect3-hostile-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': hostileValue } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.match(stderr, /gsd-executor/);
      const stderrBody = stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr;
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw control bytes is the point of this test
      assert.doesNotMatch(stderrBody, /[\x00-\x1f\x7f]/,
        'stderr must contain no raw control character outside the trailing newline');
    } finally {
      cleanup(dir);
    }
  });

  // DEFECT 3 (truncation ordering): a long escape-bearing value must be
  // sanitized BEFORE truncation, so a truncated escape sequence can never
  // survive into the emitted warning (e.g. an SGR sequence cut before its
  // reset, leaving sticky terminal state).
  test('DEFECT 3: a long ESC-bearing pin (> 64 chars) is sanitized before truncation — no raw control survives', () => {
    const ESC = String.fromCharCode(27);
    const hostileValue = `${'x'.repeat(80)}${ESC}[31mHOSTILE`;
    const dir = createTempProject('gsd-3714-defect3-long-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': hostileValue } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      const stderrBody = stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr;
      // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of raw control bytes is the point of this test
      assert.doesNotMatch(stderrBody, /[\x00-\x1f\x7f]/,
        'a truncated escape sequence must never survive into the emitted warning');
    } finally {
      cleanup(dir);
    }
  });

  // ---------------------------------------------------------------------------
  // ITEM 2 follow-up — the pin policy (and its warning) is HOST-NEUTRAL code
  // running at a site shared by every runtime, so it previously ran (and
  // warned) even for hosts whose descriptor declares no `modelFlag` at all
  // (opencode, kimi, kimi-code) — none of which were ever going to emit a
  // --model regardless of the pin's value. The fix gates the whole policy on
  // the resolved runtime's orchestratorExec declaring a non-empty modelFlag.
  // ---------------------------------------------------------------------------
  test('ITEM 2: a "sonnet" pin under kimi-code -> argv byte-identical to no-pin, stderr EMPTY (no modelFlag declared)', () => {
    const noPinDir = createTempProject('gsd-3714-item2-kimicode-nopin-');
    const pinnedDir = createTempProject('gsd-3714-item2-kimicode-pinned-');
    try {
      writeConfig(noPinDir, {});
      writeConfig(pinnedDir, { model_overrides: { 'gsd-executor': 'sonnet' } });
      const { json: noPinResult, stderr: noPinStderr } = queryCodexJson(noPinDir, { GSD_RUNTIME: 'kimi-code' });
      const { json: pinnedResult, stderr: pinnedStderr } = queryCodexJson(pinnedDir, { GSD_RUNTIME: 'kimi-code' });
      assert.deepEqual(pinnedResult.exec.args, noPinResult.exec.args,
        'kimi-code argv with a "sonnet" pin must be byte-identical to the no-pin argv');
      assert.equal(noPinStderr, '');
      assert.equal(pinnedStderr, '', 'kimi-code declares no modelFlag — the pin policy must not run at all, so no warning');
    } finally {
      cleanup(noPinDir);
      cleanup(pinnedDir);
    }
  });

  test('ITEM 2: a "sonnet" pin under opencode -> argv byte-identical to no-pin, stderr EMPTY (no modelFlag declared)', () => {
    const noPinDir = createTempProject('gsd-3714-item2-opencode-nopin-');
    const pinnedDir = createTempProject('gsd-3714-item2-opencode-pinned-');
    try {
      writeConfig(noPinDir, {});
      writeConfig(pinnedDir, { model_overrides: { 'gsd-executor': 'sonnet' } });
      const { json: noPinResult, stderr: noPinStderr } = queryCodexJson(noPinDir, { GSD_RUNTIME: 'opencode' });
      const { json: pinnedResult, stderr: pinnedStderr } = queryCodexJson(pinnedDir, { GSD_RUNTIME: 'opencode' });
      assert.deepEqual(pinnedResult.exec.args, noPinResult.exec.args,
        'opencode argv with a "sonnet" pin must be byte-identical to the no-pin argv');
      assert.equal(noPinStderr, '');
      assert.equal(pinnedStderr, '', 'opencode declares no modelFlag — the pin policy must not run at all, so no warning');
    } finally {
      cleanup(noPinDir);
      cleanup(pinnedDir);
    }
  });

  test('ITEM 2 CONTROL: a "sonnet" pin under codex (declares modelFlag) -> still dropped, WITH the warning', () => {
    const dir = createTempProject('gsd-3714-item2-codex-control-');
    try {
      writeConfig(dir, { model_overrides: { 'gsd-executor': 'sonnet' } });
      const { json: result, stderr } = queryCodexJson(dir);
      assert.deepEqual(result.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
      assert.ok(!hasModelFlag(result.exec.args));
      assert.match(stderr, /gsd-executor.*sonnet.*Anthropic/i);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #2627 Phase 3 — the `dispatch-isolation` CLI route.
//
// Behavioral: each case SPAWNS the real gsd-tools CLI and asserts on its actual
// stdout, rather than inspecting the route's source. This is the scheduler
// consumer's only entry point — execute-phase branches on exactly this output.
// ---------------------------------------------------------------------------
describe('#2627 dispatch-isolation CLI route', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { throwIfFailed } = require('./helpers/git-fixture.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

  function query(runtimeId, extraArgs = []) {
    const r = runNode(
      [GSD_TOOLS, 'query', 'dispatch-isolation', ...extraArgs],
      { cwd: REPO_ROOT, env: { ...process.env, GSD_RUNTIME: runtimeId }, timeoutMs: PROBE_TIMEOUT_MS },
    );
    throwIfFailed(r, `gsd-tools query dispatch-isolation ${extraArgs.join(' ')}`);
    return r.stdout;
  }
  const queryJson = (runtimeId, extraArgs = []) => JSON.parse(query(runtimeId, ['--json', ...extraArgs]));

  test('raw output is the bare negotiated value for each isolation model', () => {
    assert.equal(query('claude').trim(), 'harness-worktree');
    assert.equal(query('codex').trim(), 'orchestrator-worktree');
    assert.equal(query('pi').trim(), 'none');
  });

  test('an undocumented isolation declaration degrades to none (fail-closed)', () => {
    // cline declares isolation:"undocumented" — the corpus-wide sentinel.
    assert.equal(query('cline').trim(), 'none');
  });

  test('an unknown runtime degrades to none rather than erroring', () => {
    assert.equal(query('no-such-runtime-xyz').trim(), 'none');
  });

  test('harness-worktree surfaces the host\'s declared flag, and no exec', () => {
    const claude = queryJson('claude');
    assert.equal(claude.isolation, 'harness-worktree');
    assert.equal(claude.harnessFlag, 'isolation="worktree"');
    assert.equal(claude.exec, null, 'GSD runs no git on the harness path — there is nothing to spawn');

    assert.equal(queryJson('cursor').harnessFlag, '--worktree');
  });

  test('orchestrator-worktree yields exec only when a cwd target is supplied', () => {
    assert.equal(queryJson('codex').exec, null, 'no --cwd-target → nothing to bind');

    const withTarget = queryJson('codex', ['--cwd-target', '/tmp/wt', '--prompt', 'do the thing']);
    assert.equal(withTarget.isolation, 'orchestrator-worktree');
    assert.equal(withTarget.exec.command, 'codex');
    assert.deepEqual(withTarget.exec.args, ['exec', '--cd', '/tmp/wt', 'do the thing']);
    assert.equal(withTarget.exec.cwd, '/tmp/wt');
    assert.equal(withTarget.harnessFlag, null);
  });

  test('each orchestrator-worktree host resolves to its own documented argv shape', () => {
    const args = (id) => queryJson(id, ['--cwd-target', '/tmp/wt', '--prompt', 'P']).exec.args;
    assert.deepEqual(args('opencode'), ['run', '--dir', '/tmp/wt', 'P']);
    // kimi carries the prompt behind --prompt (its --print mode requires it),
    // unlike codex/opencode which take it positionally.
    assert.deepEqual(args('kimi'), ['--print', '--work-dir', '/tmp/wt', '--prompt', 'P']);
    // kimi-code binds by process cwd — no flag in argv, but cwd still returned.
    assert.deepEqual(args('kimi-code'), ['--prompt', 'P']);
    assert.equal(queryJson('kimi-code', ['--cwd-target', '/tmp/wt', '--prompt', 'P']).exec.cwd, '/tmp/wt');
  });

  test('a cwd target with no prompt still resolves (prompt is optional at this seam)', () => {
    const noPrompt = queryJson('codex', ['--cwd-target', '/tmp/wt']);
    assert.equal(noPrompt.isolation, 'orchestrator-worktree');
    assert.deepEqual(noPrompt.exec.args, ['exec', '--cd', '/tmp/wt']);
  });

  test('the route never reports an isolation model it cannot actually service', () => {
    // The invariant the scheduler depends on: if isolation is non-none, the
    // corresponding mechanism is present. Anything else would have the wave
    // create a worktree and then discover it has nothing to spawn into it.
    for (const id of ['claude', 'cursor', 'codex', 'opencode', 'kimi', 'kimi-code', 'pi', 'cline', 'zcode']) {
      const r = queryJson(id, ['--cwd-target', '/tmp/wt', '--prompt', 'P']);
      if (r.isolation === 'harness-worktree') {
        assert.ok(r.harnessFlag && r.harnessFlag.length > 0, `${id}: harness-worktree without a flag`);
      } else if (r.isolation === 'orchestrator-worktree') {
        assert.ok(r.exec && r.exec.command, `${id}: orchestrator-worktree without a spawnable exec`);
      } else {
        assert.equal(r.isolation, 'none', `${id}: unexpected isolation value ${r.isolation}`);
        assert.equal(r.exec, null);
        assert.equal(r.harnessFlag, null);
      }
    }
  });

  test('a none-isolation host never yields an exec even when a target is supplied', () => {
    const pi = queryJson('pi', ['--cwd-target', '/tmp/wt', '--prompt', 'P']);
    assert.equal(pi.isolation, 'none');
    assert.equal(pi.exec, null);
    assert.equal(pi.harnessFlag, null);
  });
});

describe('#3673 dispatch-capacity CLI route', () => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const { throwIfFailed } = require('./helpers/git-fixture.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const GSD_TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

  // `maxConcurrencyEnv === undefined` means "unset" — GSD_DISPATCH_MAX_CONCURRENCY
  // is deliberately deleted from the child's env rather than passed as the
  // literal string "undefined", so the "env absent" test cases are genuinely
  // absent, not present-with-a-bogus-value.
  function query(runtimeId, extraArgs = [], maxConcurrencyEnv) {
    const env = { ...process.env, GSD_RUNTIME: runtimeId };
    delete env.GSD_DISPATCH_MAX_CONCURRENCY;
    if (maxConcurrencyEnv !== undefined) {
      env.GSD_DISPATCH_MAX_CONCURRENCY = maxConcurrencyEnv;
    }
    const r = runNode(
      [GSD_TOOLS, 'query', 'dispatch-capacity', ...extraArgs],
      { cwd: REPO_ROOT, env, timeoutMs: PROBE_TIMEOUT_MS },
    );
    throwIfFailed(r, `gsd-tools query dispatch-capacity ${extraArgs.join(' ')}`);
    return r.stdout;
  }
  const queryJson = (runtimeId, extraArgs = [], maxConcurrencyEnv) =>
    JSON.parse(query(runtimeId, ['--json', ...extraArgs], maxConcurrencyEnv));

  test('live env wins over descriptor', () => {
    // claude's shipped descriptor declares maxConcurrency:20.
    assert.equal(query('claude', [], '4').trim(), '4');
    assert.equal(queryJson('claude', [], '4').source, 'live');
  });

  test('descriptor used when live is absent', () => {
    const result = queryJson('claude');
    assert.equal(result.capacity, 20);
    assert.equal(result.source, 'descriptor');
  });

  test('fallback to 1 when both live and a real descriptor value are absent', () => {
    // codex's shipped descriptor carries the "undocumented" sentinel.
    const result = queryJson('codex');
    assert.equal(result.capacity, 1);
    assert.equal(result.source, 'fallback');
  });

  test('malformed live env falls through to descriptor tier', () => {
    assert.equal(query('claude', [], 'abc').trim(), '20');
    assert.equal(queryJson('claude', [], 'abc').source, 'descriptor');
  });

  test('invalid live env values (0, negative, fractional) fall through to descriptor tier', () => {
    for (const bogus of ['0', '-1', '4.5']) {
      assert.equal(query('claude', [], bogus).trim(), '20', `env=${bogus} must fall through to descriptor`);
    }
  });

  test('JSON output has the documented shape', () => {
    const result = queryJson('claude');
    assert.deepEqual(Object.keys(result).sort(), ['capacity', 'declared', 'reason', 'runtime', 'source'].sort());
    assert.equal(result.runtime, 'claude');
    assert.equal(result.capacity, 20);
    assert.equal(result.declared, 20);
    assert.equal(result.source, 'descriptor');
    assert.equal(result.reason, 'ok');
  });

  test('unknown runtime degrades to 1 without erroring', () => {
    const result = queryJson('no-such-runtime-xyz');
    assert.equal(result.capacity, 1);
    assert.equal(result.source, 'fallback');
    assert.equal(result.reason, 'unknown_runtime');
  });

  test('default output mode matches --raw', () => {
    assert.equal(query('claude').trim(), query('claude', ['--raw']).trim());
  });

  test('claude descriptor value (20) is honored', () => {
    assert.equal(query('claude').trim(), '20');
  });

  test('undocumented descriptor value degrades to fallback', () => {
    // codex declares dispatch.maxConcurrency:"undocumented".
    const result = queryJson('codex');
    assert.equal(result.capacity, 1);
    assert.equal(result.source, 'fallback');
    assert.equal(result.reason, 'undocumented');
  });
});

// ---------------------------------------------------------------------------
// #2652 — dispatch-site parity: isolation is decided by the negotiated
// dispatch.isolation capability, never by a runtime id.
//
// #2584 migrated the phase scheduler off `RUNTIME != "claude"` but left quick.md
// and diagnose-issues.md behind, so Codex — which declares orchestrator-worktree
// — was refused isolation it had negotiated. That is this repo's
// DEFECT.GENERATIVE-FIX-DIVERGENCE shape: parallel surfaces reading one contract,
// one migrated and the others silently stale. This guard fails when any dispatch
// site reintroduces a runtime-name test around its isolation decision.
// ---------------------------------------------------------------------------
// Scan workflows AND the reference fragments they inline: scheduler branches that
// mutate USE_WORKTREES live in gsd-core/references/ too (execute-phase-wave-guard,
// execute-phase-between-wave-reset), and a workflows-only scan misses them.
// Shared by both #2652 and #2728 suites below — a second, hand-listed copy is how
// the degrade scan silently narrowed to three files (round-7 review, Major 6).
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'gsd-core', 'workflows'),
  path.join(REPO_ROOT, 'gsd-core', 'references'),
];

function collectMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('#2652 dispatch-site parity — isolation gates on capability, not runtime id', () => {
  const ISOLATION_TOKEN = /USE_WORKTREES|ISOLATION|isolation="worktree"|harnessFlag/;

  // Any shape that reads RUNTIME as a branch condition. Line-based matching missed
  // multiline `&&`, [[ ]], case, `test`, and JS-template forms, so match the RUNTIME
  // test itself and then look for an isolation token within the following window.
  //
  // Operand ORDER is not fixed either: `[ "claude" != "$RUNTIME" ]` is the same gate
  // written backwards, and hand-written left-only patterns let it through. Each
  // comparison shape is therefore generated in both orders from a single template, so
  // a new shape cannot be added in one order and forgotten in the other.
  const RT = '"?\\$\\{?RUNTIME\\}?"?';   // $RUNTIME / "$RUNTIME" / "${RUNTIME}"
  const JS_RT = 'RUNTIME';                // bare identifier inside a ${…} template
  const QLIT = '["\'][a-z-]+["\']';       // "claude"
  const LIT = '["\']?[a-z-]+["\']?';      // claude / "claude"  ([[ ]] permits bare)

  /** One comparison shape → two regexes, operands in either order. */
  const bothOrders = (tpl, a, b) => [
    new RegExp(tpl.replace('%L', a).replace('%R', b)),
    new RegExp(tpl.replace('%L', b).replace('%R', a)),
  ];

  const RUNTIME_TESTS = [
    ...bothOrders('\\[\\s*%L\\s*(?:!=|==?)\\s*%R\\s*\\]', RT, QLIT),        // [ "$RUNTIME" = "x" ]
    ...bothOrders('\\[\\[\\s*%L\\s*(?:!=|==?)\\s*%R\\s*\\]\\]', RT, LIT),   // [[ "$RUNTIME" == x ]]
    ...bothOrders('\\btest\\s+%L\\s*(?:!=|=)\\s*%R', RT, QLIT),             // test "$RUNTIME" = "x"
    ...bothOrders('\\$\\{\\s*%L\\s*(?:===|!==|==|!=)\\s*%R', JS_RT, QLIT),  // ${RUNTIME === "x" ? ...}
    /\bcase\s+"?\$\{?RUNTIME\}?"?\s+in\b/,                                  // case "$RUNTIME" in (no reversed form)
  ];

  const WINDOW = 400; // chars after the RUNTIME test to look for an isolation decision

  function isolationGateOffenders(text, label) {
    const hits = [];
    for (const re of RUNTIME_TESTS) {
      const global = new RegExp(re.source, 'g');
      let m;
      while ((m = global.exec(text)) !== null) {
        const window = text.slice(m.index, m.index + WINDOW);
        if (ISOLATION_TOKEN.test(window)) {
          const line = text.slice(0, m.index).split('\n').length;
          hits.push(`${label}:${line}: ${m[0].trim()}`);
        }
      }
    }
    return hits;
  }

  const dispatchSites = SCAN_ROOTS.flatMap(collectMarkdown).filter(f =>
    ISOLATION_TOKEN.test(fs.readFileSync(f, 'utf-8')),
  );

  test('the scan covers the known dispatch sites (guards against a vacuous pass)', () => {
    const rel = dispatchSites.map(f => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
    // Assert identities, not just a count: a count survives the scan silently
    // drifting off the files that actually matter.
    for (const required of [
      'gsd-core/workflows/quick.md',
      'gsd-core/workflows/diagnose-issues.md',
      'gsd-core/workflows/execute-plan.md',
      'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
    ]) {
      assert.ok(rel.includes(required), `dispatch-site scan must cover ${required}; found ${rel.length} files`);
    }
  });

  // #2652 review: executor-isolation-dispatch.md declared
  // references/dispatch-isolation-gate.md canonical while keeping the OLDER
  // collapsing resolver inline — `|| echo "none"`, no ISOLATION_RESOLVED — so a
  // transient shim failure aborted /gsd:execute-phase telling a Claude or
  // Cursor user their runtime "declares no executor-isolation primitive". Still
  // fail-closed, so not an unsafe-dispatch hole, but the correction this PR is
  // about was unwired at one of the five sites. Nothing caught it: the emitted
  // coverage in install.test.cjs checks the REFERENCE, not each site's own copy.
  test('every site that inlines the resolver uses the non-collapsing shape', () => {
    // A site "inlines the resolver" only if it ASSIGNS from it. The other
    // dispatch sites @-reference the gate and merely re-record a degrade
    // (`--force-isolation …` with no assignment), which carries no verdict of
    // its own — matching those too would flag files that have nothing to fix.
    const INLINE_RESOLVE = /\w+=\$\(gsd_run query dispatch-isolation --raw/;
    // Dedupe: SCAN_ROOTS already yields the gate reference, so appending it
    // again made `length >= 2` satisfiable by the gate alone — the executor
    // site could drop out of the predicate entirely and this would still pass.
    const candidates = [...new Set(
      [...dispatchSites, path.join(REPO_ROOT, 'gsd-core', 'references', 'dispatch-isolation-gate.md')]
        .filter(f => fs.existsSync(f))
        .map(f => path.resolve(f)),
    )];
    const inliners = candidates
      .map(f => ({ rel: path.relative(REPO_ROOT, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf-8') }))
      .filter(({ text }) => INLINE_RESOLVE.test(text));

    // Pin identities, not a count. A count cannot tell "the executor site was
    // fixed" from "the executor site stopped matching the predicate".
    assert.deepEqual(
      inliners.map(i => i.rel).sort(),
      [
        'gsd-core/references/dispatch-isolation-gate.md',
        'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
      ],
      'the set of files inlining the resolver changed — a new inliner needs the same treatment, and a missing one means the predicate stopped seeing it',
    );

    for (const { rel, text } of inliners) {
      // Any assignment target, not just ISOLATION — `_ISOLATION_RAW=$(… || echo
      // "none")` restores the identical defect while leaving ISOLATION_RESOLVED
      // in the file, so a name-specific pattern passes on a broken block.
      assert.doesNotMatch(
        text,
        /\w+=\$\(gsd_run query dispatch-isolation --raw[^\n]*\|\|[^\n]*echo/,
        `${rel}: collapses a resolver failure straight to none — that reports "declares no primitive" for a host that simply could not be queried`,
      );
      assert.match(
        text,
        /ISOLATION_RESOLVED=false/,
        `${rel}: inlines the resolver but never records that no verdict was learned`,
      );
      assert.match(
        text,
        /could not resolve this runtime's executor-isolation capability/,
        `${rel}: has no distinct message for the unresolved case, so both outcomes read as a capability verdict`,
      );
    }
  });

  test('the detector flags every known runtime-gate shape (discrimination proof)', () => {
    // Each of these slipped past the original same-line, single-bracket detector.
    const mutations = {
      'single bracket, same line':
        'if [ "$RUNTIME" != "claude" ] && [ "$USE_WORKTREES" != "false" ]; then',
      'multiline &&':
        'if [ "$RUNTIME" != "claude" ] && \\\n   [ "$USE_WORKTREES" != "false" ]; then',
      'double bracket':
        'if [[ "$RUNTIME" == claude ]]; then\n  USE_WORKTREES=false\nfi',
      'nested, later assignment':
        'if [ "$RUNTIME" = "codex" ]; then\n  echo hi\n  ISOLATION=none\nfi',
      'case statement':
        'case "$RUNTIME" in\n  claude) USE_WORKTREES=true ;;\nesac',
      'js template':
        '${RUNTIME === "claude" ? \'isolation="worktree",\' : \'\'}',
      'test builtin':
        'if test "$RUNTIME" = "claude"; then\n  ISOLATION=harness-worktree\nfi',
      // Reversed operands — the same gate written backwards. Every one of these
      // evaded the original left-only patterns (#2728 review, Minor).
      'reversed single bracket':
        'if [ "claude" != "$RUNTIME" ] && [ "$USE_WORKTREES" != "false" ]; then',
      'reversed double bracket':
        'if [[ claude == "$RUNTIME" ]]; then\n  USE_WORKTREES=false\nfi',
      'reversed test builtin':
        'if test "claude" = "$RUNTIME"; then\n  ISOLATION=harness-worktree\nfi',
      'reversed js template':
        '${"claude" === RUNTIME ? \'isolation="worktree",\' : \'\'}',
    };
    for (const [name, snippet] of Object.entries(mutations)) {
      assert.equal(
        isolationGateOffenders(snippet, 'mutation').length >= 1,
        true,
        `detector must flag the "${name}" reintroduction — otherwise the guard below proves nothing`,
      );
    }
  });

  test('the detector flags generated shell-comparison permutations (property)', () => {
    // The mutation table above is 11 hand-picked cases; this generates the cross
    // product of the axes an author actually varies — bracket form, operator,
    // operand order, quoting, spacing, runtime id. A permutation the hand-written
    // patterns miss shows up here rather than in production (#2728 review, Nit).
    fc.assert(
      fc.property(
        fc.constantFrom('[', '[[', 'test'),
        fc.constantFrom('=', '==', '!='),
        fc.boolean(),                                    // reversed operands?
        fc.constantFrom('"$RUNTIME"', '$RUNTIME', '"${RUNTIME}"'),
        fc.constantFrom('claude', 'codex', 'kimi-code'),
        fc.boolean(),                                    // quote the literal?
        fc.constantFrom('', ' '),                        // extra padding
        (form, op, reversed, rtTok, id, quoted, pad) => {
          // `test` has no `==` form and never takes brackets; bare literals are
          // only legal inside [[ ]].
          if (form === 'test' && op === '==') return true;
          const lit = quoted || form !== '[[' ? `"${id}"` : id;
          const [l, r] = reversed ? [lit, rtTok] : [rtTok, lit];
          const cond = `${l}${pad} ${op} ${pad}${r}`;
          const snippet = form === 'test'
            ? `if test ${cond}; then\n  ISOLATION=none\nfi`
            : `if ${form} ${cond} ${form === '[[' ? ']]' : ']'}; then\n  ISOLATION=none\nfi`;
          return isolationGateOffenders(snippet, 'prop').length >= 1;
        },
      ),
      { numRuns: 300 },
    );
  });

  test('a RUNTIME read with no isolation decision nearby is NOT flagged (no false positive)', () => {
    const benign = 'RUNTIME=$(gsd_run query config-get runtime --raw)\necho "runtime is $RUNTIME"';
    assert.deepEqual(isolationGateOffenders(benign, 'benign'), []);
  });

  test('no dispatch site gates isolation on a runtime id', () => {
    const offenders = [];
    for (const file of dispatchSites) {
      offenders.push(
        ...isolationGateOffenders(
          fs.readFileSync(file, 'utf-8'),
          path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        ),
      );
    }
    assert.deepEqual(
      offenders,
      [],
      'isolation must be resolved from `gsd_run query dispatch-isolation` (see ' +
        'gsd-core/references/dispatch-isolation-gate.md), never from a RUNTIME comparison:\n' +
        offenders.join('\n'),
    );
  });

  // #2728 review Blocker — the ISOLATION_TOKEN regex above treats
  // `isolation="worktree"` as a legitimate isolation marker, so the runtime-gate
  // detector cannot catch a *conditional* keyed on that literal. But the literal
  // is Claude Code's own rendering of {harnessFlag}; Cursor's rendering is
  // `--worktree`, so any post-dispatch step gated on the literal is a silent
  // no-op for a correctly-isolated Cursor run (quick.md's manifest append and
  // worktree merge-back were exactly this — isolated work never merged, never
  // cleaned up). Post-dispatch bookkeeping must key on the negotiated ISOLATION
  // value instead (dispatch-isolation-gate.md's "never hardcode" rule).
  const LITERAL_CONDITION = /\bIf\b[^.\n]*`isolation="worktree"`/g;

  function literalConditionOffenders(text, label) {
    const hits = [];
    let m;
    const re = new RegExp(LITERAL_CONDITION.source, 'g');
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${label}:${line}: ${m[0].trim()}`);
    }
    return hits;
  }

  test('the literal-condition detector flags the pre-fix quick.md shapes (discrimination proof)', () => {
    const preFix = {
      'manifest append':
        'If the executor ran with `isolation="worktree"`, append its returned metadata to `QUICK_WORKTREE_MANIFEST` before cleanup.',
      'worktree cleanup':
        '1. **Worktree cleanup:** If the executor ran with `isolation="worktree"`, merge the worktree branch back and clean up:',
    };
    for (const [name, snippet] of Object.entries(preFix)) {
      assert.equal(
        literalConditionOffenders(snippet, 'mutation').length,
        1,
        `detector must flag the pre-fix "${name}" conditional — otherwise the guard below proves nothing`,
      );
    }
    // Explanatory prose that merely *names* the literal (no conditional) stays legal.
    assert.deepEqual(
      literalConditionOffenders(
        'Claude Code\'s `isolation="worktree"` forks new worktrees from `origin/HEAD`.',
        'benign',
      ),
      [],
    );
  });

  test('no dispatch site conditions post-dispatch behavior on the Claude-rendered literal', () => {
    const offenders = [];
    for (const file of dispatchSites) {
      offenders.push(
        ...literalConditionOffenders(
          fs.readFileSync(file, 'utf-8'),
          path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        ),
      );
    }
    assert.deepEqual(
      offenders,
      [],
      'post-dispatch steps must key on `ISOLATION = "harness-worktree"`, never on ' +
        'Claude Code\'s rendered `isolation="worktree"` literal (a Cursor dispatch renders ' +
        '`--worktree` and would silently skip these steps):\n' + offenders.join('\n'),
    );
  });

  test('quick.md post-dispatch bookkeeping keys on the negotiated ISOLATION value', () => {
    const quick = fs.readFileSync(
      path.join(REPO_ROOT, 'gsd-core', 'workflows', 'quick.md'), 'utf-8',
    );
    assert.match(
      quick,
      /If the executor ran isolated \(`ISOLATION = "harness-worktree"` at dispatch\), append its returned/,
      'the QUICK_WORKTREE_MANIFEST append must be gated on ISOLATION',
    );
    assert.match(
      quick,
      /\*\*Worktree cleanup:\*\* If the executor ran isolated \(`ISOLATION = "harness-worktree"` at dispatch\)/,
      'the worktree merge-back/cleanup must be gated on ISOLATION',
    );
    assert.match(
      quick,
      /If `ISOLATION` was not `"harness-worktree"` at dispatch[^\n]*skip this step/,
      'the cleanup skip clause must mirror the same ISOLATION gate (USE_WORKTREES stays true on an isolated Cursor run)',
    );
  });
});

// ---------------------------------------------------------------------------
// #2728 review BLOCKER (B1/B2/B3) — a degrade must re-RECORD, not just reassign.
//
// Every isolation degrade in a dispatch site is decided in SHELL, where
// `routeDispatchIsolation` cannot see it. That resolver persists whatever it
// resolved to the run-scoped sentinel as an unconditional side effect (#3045
// CORE REDESIGN, hooks/lib/isolation-sentinel.js), so a degrade that only
// reassigns `$ISOLATION` leaves the sentinel asserting `harness-worktree`
// while the dispatch correctly omits the harness flag. The shipped PreToolUse
// guard reads the sentinel at the instant of the `Agent()` call and denies the
// mismatch with exit 2 — the work does not run unisolated, it does not run.
//
// WHY THIS ASSERTS THE RECORDED VALUE, NOT `$ISOLATION`: asserting the local
// variable is precisely what let this class through. `$ISOLATION` was already
// correct at all three sites — `none` — and the defect was entirely in what
// reached the sentinel. So these tests execute each workflow's own degrade
// block under a `gsd_run` stub that captures every call, and assert on the
// value the workflow PUSHED THROUGH THE WRITE PATH.
// ---------------------------------------------------------------------------
describe('#2728 B1 — isolation degrades re-record through the single write path', () => {
  const { runHook } = require('./helpers/process-seam.cjs');
  // Class-norm timeout, not a local literal (CONTRIBUTING: class-norm
  // timeouts live in tests/helpers/timeouts.cjs). This harness is a short
  // shell probe against a gsd_run stub — exactly the PROBE class.
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const os = require('node:os');

  const WORKFLOWS = path.join(REPO_ROOT, 'gsd-core', 'workflows');

  /**
   * Pull the fenced ```bash block containing `marker` out of a workflow.
   *
   * DEFECT.WINDOWS-CRLF-TEST-PORTABILITY: the captured body is handed to
   * `bash` below, so it must be CRLF-free. A `\r?\n` fence regex is NOT
   * sufficient — it only protects the delimiter match, leaving embedded `\r`
   * on every line of the body, which bash treats as part of the token
   * (helpers.cjs documents exactly this trap). Normalize at the READ
   * boundary so everything downstream is LF-only by construction.
   */
  function bashBlockContaining(file, marker) {
    const text = readFileNormalized(file);
    const lines = text.split('\n');
    for (const block of scanFencedBlocks(lines)) {
      if (block.closeLineIdx === -1) continue;
      if ((block.infoString || '').trim() !== 'bash') continue;
      const body = lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
      if (body.includes(marker)) return body;
    }
    assert.fail(`no \`\`\`bash block containing ${JSON.stringify(marker)} in ${file}`);
  }

  /**
   * Run a degrade block with the base-check forced to fire, under a `gsd_run`
   * stub that logs its argv. Returns every `dispatch-isolation` call the block
   * made, in order — i.e. the writes that would have hit the sentinel.
   */
  function recordedWrites(block) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-degrade-'));
    const log = path.join(dir, 'calls.log');
    // The stub answers the base-check `true` so the degrade path is TAKEN;
    // every other query returns empty. It logs the full argv of each call.
    const harness = [
      'set -u',
      `gsd_run() { printf '%s\\n' "$*" >> ${JSON.stringify(log)};`,
      '  case "$*" in',
      '    *"worktree.base-check"*"shouldDegrade"*) printf true ;;',
      '    *"worktree.base-check"*"message"*) printf "base diverged" ;;',
      '    *) printf "" ;;',
      '  esac; }',
      'ISOLATION=harness-worktree',
      'USE_WORKTREES=true',
      'RUNTIME=claude',
      'PHASE_NUMBER=7',
      block,
      // Prove the local variable was ALSO correct, so a failure below can only
      // mean the recording is missing — not that the degrade itself misfired.
      'printf "FINAL_LOCAL=%s\\n" "$ISOLATION"',
    ].join('\n');

    // Through the process seam, never a hand-rolled spawnSync (CONTRIBUTING
    // "Spawning a subprocess: use the process seam"). `runHook` documents
    // `interpreter: 'bash'` for running a shell script, so the harness is
    // written to a file rather than passed as `-c`. Bounded by construction
    // (DEFECT.UNBOUNDED-SUBPROCESS): pure shell against a `gsd_run` stub — no
    // git, no network, no real CLI — so it completes in milliseconds.
    const scriptPath = path.join(dir, 'degrade-harness.sh');
    fs.writeFileSync(scriptPath, harness);
    const res = runHook(scriptPath, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    if (res.outcome !== 'exited') {
      cleanup(dir);
      assert.fail(`degrade block did not complete: outcome=${res.outcome} ${res.stderr || ''}`);
    }
    assert.equal(res.exitCode, 0, `degrade block exited ${res.exitCode}: ${res.stderr}`);
    assert.match(res.stdout, /FINAL_LOCAL=none/, 'the degrade must set $ISOLATION=none locally');

    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf-8').split(/\r?\n/).filter(Boolean)
      : [];
    cleanup(dir);
    return calls.filter(c => c.includes('dispatch-isolation'));
  }

  /** The isolation mode the last write pushed, or null if nothing was written. */
  function recordedIsolation(block) {
    const writes = recordedWrites(block);
    if (writes.length === 0) return null;
    const last = writes[writes.length - 1];
    const m = last.match(/--force-isolation\s+(\S+)/);
    return m ? m[1] : null;
  }

  const DEGRADE_SITES = [
    {
      label: 'quick.md #1941 base-check degrade',
      file: path.join(WORKFLOWS, 'quick.md'),
      marker: '_QUICK_SHOULD_DEGRADE',
    },
    {
      label: 'diagnose-issues.md #2649 base-check degrade',
      file: path.join(WORKFLOWS, 'diagnose-issues.md'),
      marker: '_DIAG_SHOULD_DEGRADE',
    },
  ];

  for (const site of DEGRADE_SITES) {
    test(`${site.label} records none, not just the local variable`, () => {
      const block = bashBlockContaining(site.file, site.marker);
      assert.equal(
        recordedIsolation(block),
        'none',
        `${site.label}: $ISOLATION degraded to none but the block never pushed that ` +
          'through `query dispatch-isolation --force-isolation`. The sentinel still ' +
          'asserts harness-worktree, so the #3045 PreToolUse guard denies the dispatch ' +
          'with exit 2. Re-record immediately after the degrade.',
      );
    });
  }

  test('the harness detects a degrade that only reassigns (fail-first proof)', () => {
    // Strip the re-record from the shipped block. If the assertion above can
    // still pass against this, it is not testing what it claims to test.
    const block = bashBlockContaining(
      path.join(WORKFLOWS, 'quick.md'), '_QUICK_SHOULD_DEGRADE',
    );
    const preFix = block
      .split('\n')
      .filter(l => !l.includes('--force-isolation'))
      .join('\n');

    assert.notEqual(preFix, block, 'the shipped block must contain a --force-isolation re-record');
    assert.equal(
      recordedIsolation(preFix),
      null,
      'the pre-fix shape must record NOTHING — otherwise these tests prove nothing. ' +
        'Note $ISOLATION is `none` in BOTH shapes: that is exactly why asserting the ' +
        'local variable would have passed on the defect.',
    );
  });

  test('every dispatch-site degrade block re-records before the block ends', () => {
    // Coverage guard: a NEW degrade site added later cannot silently skip the
    // re-record. Scans the shipped shell rather than a hand-listed set.
    const offenders = [];
    // DERIVED, not hand-listed. The previous revision named three files, so a
    // degrade added anywhere else passed a check whose name claims "every"
    // (#2728 round-7 review, Major 6). Scan every workflow and reference.
    const scan = SCAN_ROOTS.flatMap(collectMarkdown);
    assert.ok(
      scan.length > 10,
      `the degrade scan collected only ${scan.length} files — the walk is broken, not the tree`,
    );

    // Wave sites re-record PER PLAN, not inline: `execute-phase-wave-guard.md` and
    // `execute-phase-between-wave-reset.md` degrade `USE_WORKTREES=false` together
    // with `ISOLATION=none`, and `per-plan-worktree-gate.md` seeds
    // `USE_WORKTREES_FOR_PLAN="$USE_WORKTREES"` and pushes `--force-isolation none`
    // before each plan's dispatch. That is a real re-record, just delegated — so
    // these two are exempt. The exemption is ASSERTED below rather than assumed,
    // so deleting the delegate fails this test instead of silently widening a hole.
    const DELEGATED_TO_PER_PLAN_GATE = new Set([
      'gsd-core/references/execute-phase-wave-guard.md',
      'gsd-core/references/execute-phase-between-wave-reset.md',
    ]);
    const perPlanGate = readFileNormalized(
      path.join(WORKFLOWS, 'execute-phase', 'steps', 'per-plan-worktree-gate.md'),
    );
    assert.ok(
      perPlanGate.includes('USE_WORKTREES_FOR_PLAN="$USE_WORKTREES"') &&
        perPlanGate.includes('--force-isolation none'),
      'per-plan-worktree-gate.md no longer inherits USE_WORKTREES and re-records `none`, so the ' +
        'wave degrade sites above are no longer covered by delegation — either restore the ' +
        'delegate or make those sites re-record inline',
    );

    // #2486 note: the runtime-neutral diagnostics (health.md, settings.md)
    // resolve isolation for a READ, not a dispatch, and deliberately name their
    // state `INSPECTED_ISOLATION` rather than `ISOLATION`. That keeps them out
    // of this scan by construction. An earlier revision exempted those two
    // files instead; the exemption was file-wide, so any real dispatch block
    // added to either one would have inherited it and escaped a guard whose
    // name promises "every dispatch site" (#2486 review). Renaming the variable
    // removes the carve-out entirely — a diagnostic that ever writes a literal
    // `ISOLATION=none` is caught here like any other site.
    for (const file of scan) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (DELEGATED_TO_PER_PLAN_GATE.has(rel)) continue;
      const text = readFileNormalized(file);
      const lines = text.split('\n');
      for (const fenced of scanFencedBlocks(lines)) {
        if (fenced.closeLineIdx === -1) continue;
        if ((fenced.infoString || '').trim() !== 'bash') continue;
        const block = lines.slice(fenced.openLineIdx + 1, fenced.closeLineIdx).join('\n');
        if (!/^\s*ISOLATION=none\s*$/m.test(block)) continue;
        if (!block.includes('--force-isolation')) {
          offenders.push(`${rel}:${fenced.openLineIdx + 1}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'these shell blocks degrade $ISOLATION to none without re-recording it through ' +
        '`query dispatch-isolation --force-isolation` — the #3045 guard will deny the ' +
        'resulting dispatch:\n' + offenders.join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Folded from tests/issue-2939-dispatch-flatten-maxdepth.test.cjs (H3 Wave 7,
// issue #3339). Two of the original nine cases (maxDepth:1 → true and
// maxDepth:2 → false, both with the full codex-like descriptor) were exact
// duplicates of the "Phase B: shouldFlattenDispatch — contract pin" describe
// above (lines ~1014-1029) and were dropped; the remaining seven exercise
// input shapes (maxDepth:-1 unbounded, nested:false, non-full toolkit,
// background:false/backgroundDispatch:false with maxDepth:5, maxDepth:0,
// and maxDepth missing/non-number) not covered elsewhere in this file.
// ---------------------------------------------------------------------------
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2939-dispatch-flatten-maxdepth', () => {
    /** The live Codex-shaped descriptor (the #2939 bug input), with per-test depth overrides. */
    function codexLike(overrides = {}) {
      return {
        namedDispatch: true,
        nested: true,
        maxDepth: 1,
        background: true,
        subagentToolkit: 'full',
        backgroundDispatch: true,
        ...overrides,
      };
    }

    test('maxDepthUnboundedBackgroundsUnchanged', () => {
      // Row 3: maxDepth:-1 (unbounded) → background permitted, unchanged.
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ maxDepth: -1 })),
        false,
        'maxDepth:-1 (unbounded) → background permitted (unchanged)',
      );
    });

    test('nestedFalseFlattensRegardlessOfDepth', () => {
      // Row 4 / acceptance #4: nested:false cannot host a nesting orchestrator →
      // flatten regardless of maxDepth.
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ nested: false, maxDepth: 5 })),
        true,
        'nested:false → flatten regardless of maxDepth',
      );
    });

    test('nonFullToolkitFlattens', () => {
      // Row 5 / acceptance #4: a non-full toolkit cannot delegate → flatten
      // regardless of maxDepth.
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ subagentToolkit: 'read-only', maxDepth: 5 })),
        true,
        'subagentToolkit!=="full" → flatten regardless of maxDepth',
      );
    });

    test('backgroundFalseStillFlattens', () => {
      // Row 6 / negative-space: background:false → flatten (the existing
      // background-boolean fail-closed path is unchanged).
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ background: false, maxDepth: 5 })),
        true,
        'background:false → flatten (unchanged)',
      );
    });

    test('backgroundDispatchFalseStillFlattens', () => {
      // Row 7 / negative-space: backgroundDispatch:false → flatten (unchanged).
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ backgroundDispatch: false, maxDepth: 5 })),
        true,
        'backgroundDispatch:false → flatten (unchanged)',
      );
    });

    test('maxDepth0Flattens', () => {
      // Row 9: maxDepth:0 (zero depth budget) → flatten.
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ maxDepth: 0 })),
        true,
        'maxDepth:0 → flatten (zero depth budget)',
      );
    });

    test('maxDepthMissingFlattens', () => {
      // Row 10: maxDepth missing/non-number → flatten (fail-closed on absent
      // budget, mirrors degradationFor treating non-finite as 0).
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ maxDepth: undefined })),
        true,
        'maxDepth missing → flatten (fail-closed)',
      );
      assert.strictEqual(
        hi.shouldFlattenDispatch(codexLike({ maxDepth: 'deep' })),
        true,
        'maxDepth non-number → flatten (fail-closed)',
      );
    });
  });
}

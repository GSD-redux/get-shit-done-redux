'use strict';

/**
 * loop-render-hooks.test.cjs — behavioral tests for loop-resolver.cjs.
 *
 * ADR-857 phase 3c.
 * Uses node:test + node:assert/strict.
 * Pure-function tests (resolveLoopHooks, renderLoopHooks) pass registry+config
 * directly — no I/O. End-to-end tests use cmdLoopRenderHooks + a temp project.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  resolveLoopHooks,
  renderLoopHooks,
  _getNestedConfigValue,
  _resolveActivationValue,
  _readRawConfigKey,
  CANONICAL_POINTS_FALLBACK,
  CANONICAL_POINTS,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

// The real registry for integration tests
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Synthetic registry fixtures ─────────────────────────────────────────────

/**
 * Build a minimal synthetic registry with a single step hook at a given point.
 * Optionally include a configSchema for testing default-based activation.
 */
function makeRegistry({ point = 'plan:pre', steps = [], contributions = [], gates = {}, configSchema = {} } = {}) {
  const byLoopPoint = {};
  for (const p of CANONICAL_POINTS_FALLBACK) {
    byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  }
  if (steps.length) byLoopPoint[point].steps = steps;
  if (contributions.length) byLoopPoint[point].contributions = contributions;
  if (gates[point]) byLoopPoint[point].gates = gates[point];
  return { byLoopPoint, configSchema };
}

// ─── Temp project helpers ─────────────────────────────────────────────────────

let tmpProjectDir;
// A project with NO .planning/config.json — relies on schema defaults
let tmpEmptyProjectDir;
// A project where ui_phase is explicitly false in root config
let tmpFalseConfigProjectDir;
// Runtime config dir whose surface disables the UI capability
let tmpUiDisabledConfigDir;

before(() => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-test-'));
  const planningDir = path.join(tmpProjectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Write minimal config.json with all UI flags enabled
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } }),
    'utf8',
  );

  // Empty project — no config.json: schema defaults drive activation
  tmpEmptyProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-empty-'));
  fs.mkdirSync(path.join(tmpEmptyProjectDir, '.planning'), { recursive: true });

  // False config project — ui_phase explicitly false in root config
  tmpFalseConfigProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-false-'));
  const falseConfigPlanningDir = path.join(tmpFalseConfigProjectDir, '.planning');
  fs.mkdirSync(falseConfigPlanningDir, { recursive: true });
  fs.writeFileSync(
    path.join(falseConfigPlanningDir, 'config.json'),
    JSON.stringify({ workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } }),
    'utf8',
  );

  tmpUiDisabledConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-ui-disabled-'));
  fs.writeFileSync(
    path.join(tmpUiDisabledConfigDir, '.gsd-surface.json'),
    JSON.stringify({
      baseProfile: 'full',
      disabledClusters: ['ui'],
      explicitAdds: [],
      explicitRemoves: [],
    }, null, 2),
    'utf8',
  );
});

after(() => {
  if (tmpProjectDir) cleanup(tmpProjectDir);
  if (tmpEmptyProjectDir) cleanup(tmpEmptyProjectDir);
  if (tmpFalseConfigProjectDir) cleanup(tmpFalseConfigProjectDir);
  if (tmpUiDisabledConfigDir) cleanup(tmpUiDisabledConfigDir);
});

// ─── 1. Canonical-point validation ───────────────────────────────────────────

describe('canonical point validation', () => {
  test('all 12 canonical points are accepted by resolveLoopHooks with empty registry', () => {
    const emptyRegistry = makeRegistry();
    const config = {};
    for (const p of CANONICAL_POINTS_FALLBACK) {
      const result = resolveLoopHooks({ point: p, registry: emptyRegistry, config });
      assert.strictEqual(result.point, p);
      assert.deepEqual(result.activeHooks, []);
    }
  });

  test('12 canonical points total', () => {
    assert.strictEqual(CANONICAL_POINTS_FALLBACK.length, 12);
  });

  test('invalid point throws with a clear message', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'plan:mid', registry: emptyRegistry, config: {} }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid loop point/);
        assert.match(err.message, /plan:mid/);
        return true;
      },
    );
  });

  test('empty string point throws', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: '', registry: emptyRegistry, config: {} }),
      /Invalid loop point/,
    );
  });

  test('close typo throws', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'plan:pre ', registry: emptyRegistry, config: {} }),
      /Invalid loop point/,
    );
  });

  // FIX 2: non-canonical point rejected even if the registry has it as a byLoopPoint key
  test('non-canonical point in registry byLoopPoint is still rejected', () => {
    // Craft a registry that has a synthetic non-canonical key in byLoopPoint
    const registry = {
      byLoopPoint: {
        // All canonical points (needed so the registry is well-formed)
        ...Object.fromEntries(CANONICAL_POINTS_FALLBACK.map(p => [p, { steps: [], contributions: [], gates: [] }])),
        // A non-canonical key that a malformed registry might inject
        'inject:arbitrary': { steps: [{ capId: 'evil', ref: { skill: 'bad' } }], contributions: [], gates: [] },
      },
    };
    assert.throws(
      () => resolveLoopHooks({ point: 'inject:arbitrary', registry, config: {} }),
      /Invalid loop point/,
    );
  });

  // FIX 2: all 12 canonical points are listed in the error message
  test('invalid point error lists the canonical 12', () => {
    const emptyRegistry = makeRegistry();
    assert.throws(
      () => resolveLoopHooks({ point: 'not:real', registry: emptyRegistry, config: {} }),
      (err) => {
        assert.ok(err instanceof Error);
        for (const p of CANONICAL_POINTS_FALLBACK) {
          assert.ok(err.message.includes(p), `Expected "${p}" in error message: ${err.message}`);
        }
        return true;
      },
    );
  });

  // CANONICAL_POINTS is derived from LOOP_HOST_CONTRACT, not from registry keys
  test('CANONICAL_POINTS and CANONICAL_POINTS_FALLBACK are the same 12 points', () => {
    assert.deepEqual(CANONICAL_POINTS, CANONICAL_POINTS_FALLBACK);
    assert.strictEqual(CANONICAL_POINTS.length, 12);
  });
});

// ─── 2. Activation tests ─────────────────────────────────────────────────────

describe('activation filter', () => {
  test('hook with no "when" is always active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' } }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });

  test('hook with when="mytool.on", config{mytool:{on:true}} → active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].kind, 'step');
  });

  test('hook with when="mytool.on", config{mytool:{on:false}} → filtered', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('hook with when="mytool.on", config{} (absent key) → filtered', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('hook with when="mytool.on", config{mytool:{}} → filtered (key absent)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
    });
    const config = { mytool: {} };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  // FIX 3: non-string `when` → INACTIVE (not always-active)
  test('hook with when=true (boolean) → inactive (FIX 3: malformed non-string when)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: true }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when=true must be treated as inactive');
  });

  test('hook with when=42 (number) → inactive (FIX 3)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 42 }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when=42 must be inactive');
  });

  test('hook with when={} (object) → inactive (FIX 3)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: {} }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'non-string when={} must be inactive');
  });

  // FIX 4: configSchema default=true → active with absent config (no cwd → level 4 applies)
  test('configSchema default=true + absent config → active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: true, description: 'Enable mytool.' },
      },
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1, 'schema default=true should activate the hook');
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });

  // FIX 4: configSchema default=false → inactive with absent config
  test('configSchema default=false + absent config → inactive', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: false, description: 'Disabled by default.' },
      },
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0, 'schema default=false should keep hook inactive');
  });

  // FIX 4: configSchema default=true but explicit config override=false → inactive (config wins)
  test('configSchema default=true but config override false → inactive (config wins)', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'test-cap', point: 'plan:pre', ref: { skill: 'my-skill' }, when: 'mytool.on' }],
      configSchema: {
        'mytool.on': { type: 'boolean', default: true, description: 'Enabled by default.' },
      },
    });
    const config = { mytool: { on: false } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0, 'explicit config=false overrides schema default=true');
  });
});

// ─── 3. UI pilot integration tests ───────────────────────────────────────────

describe('UI pilot integration', () => {
  test('plan:pre with workflow.ui_phase=true → ui-phase step active', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'Expected ui step at plan:pre');
    assert.deepEqual(uiStep.ref, { skill: 'ui-phase' });
    assert.ok(Array.isArray(uiStep.produces));
    assert.ok(uiStep.produces.includes('UI-SPEC.md'));
  });

  test('plan:pre with workflow.ui_phase=false → ui-phase step filtered', () => {
    const config = { workflow: { ui_phase: false, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(uiStep, undefined, 'Expected ui step to be filtered');
  });

  // FIX 4 INVERSION: empty config + real registry → ui-phase IS active (schema default=true)
  test('plan:pre with empty config + real registry → ui-phase step active by default (FIX 4)', () => {
    // realRegistry has configSchema['workflow.ui_phase'].default === true
    // So with no config and no cwd, the schema default kicks in → active
    const result = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config: {} });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(
      uiStep,
      'Expected ui step to be active by default (configSchema.default=true). Got: ' +
        JSON.stringify(result.activeHooks),
    );
    assert.strictEqual(uiStep.when, 'workflow.ui_phase');
  });

  test('execute:wave:post with workflow.ui_safety_gate=true → ui gate active', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.ok(uiGate, 'Expected ui gate at execute:wave:post');
    assert.strictEqual(uiGate.blocking, true);
    assert.strictEqual(uiGate.onError, 'halt');
  });

  test('execute:wave:post with workflow.ui_safety_gate=false → ui gate filtered', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } };
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.strictEqual(uiGate, undefined, 'Expected ui gate to be filtered');
  });

  // FIX 4: execute:wave:post with empty config → ui gate active by schema default
  test('execute:wave:post with empty config → ui gate active by schema default', () => {
    const result = resolveLoopHooks({ point: 'execute:wave:post', registry: realRegistry, config: {} });
    const uiGate = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'gate');
    assert.ok(uiGate, 'Expected ui gate active by default (configSchema.default=true)');
    assert.strictEqual(uiGate.blocking, true);
  });
});

// ─── 4. Ordering tests ────────────────────────────────────────────────────────

describe('hook ordering', () => {
  test('steps appear before contributions before gates', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'c1', point: 'plan:pre', ref: { skill: 'sk1' } }],
      contributions: [{ capId: 'c2', point: 'plan:pre', into: 'planner' }],
      gates: { 'plan:pre': [{ capId: 'c3', point: 'plan:pre', check: { query: 'some-gate' }, blocking: false }] },
    });
    const config = {};
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 3);
    assert.strictEqual(result.activeHooks[0].kind, 'step');
    assert.strictEqual(result.activeHooks[1].kind, 'contribution');
    assert.strictEqual(result.activeHooks[2].kind, 'gate');
  });

  test('within steps, registry order is preserved', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [
        { capId: 'cap-a', point: 'plan:pre', ref: { skill: 'a' } },
        { capId: 'cap-b', point: 'plan:pre', ref: { skill: 'b' } },
        { capId: 'cap-c', point: 'plan:pre', ref: { skill: 'c' } },
      ],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.deepEqual(result.activeHooks.map(h => h.capId), ['cap-a', 'cap-b', 'cap-c']);
  });
});

// ─── 5. Envelope shape ────────────────────────────────────────────────────────

describe('envelope shape', () => {
  test('envelope has point, activeHooks, rendered from renderLoopHooks', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'cap-a', point: 'plan:pre', ref: { skill: 'my-skill' }, produces: ['A.md'], consumes: ['B.md'] }],
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    const rendered = renderLoopHooks(resolved);
    assert.strictEqual(resolved.point, 'plan:pre');
    assert.ok(Array.isArray(resolved.activeHooks));
    assert.strictEqual(typeof rendered, 'string');
  });

  test('empty activeHooks → rendered is non-empty placeholder string', () => {
    const registry = makeRegistry(); // all empty
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    const rendered = renderLoopHooks(resolved);
    assert.strictEqual(resolved.activeHooks.length, 0);
    assert.ok(rendered.length > 0, 'rendered should be a non-empty placeholder');
    assert.match(rendered, /plan:pre/);
  });

  test('rendered contains hook content when hooks are active', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'ui', point: 'plan:pre', ref: { skill: 'ui-phase' }, produces: ['UI-SPEC.md'], consumes: ['CONTEXT.md'], when: 'workflow.ui_phase', onError: 'skip' }],
    });
    const config = { workflow: { ui_phase: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config });
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /ui-phase/);
    assert.match(rendered, /ui/);
    assert.match(rendered, /UI-SPEC\.md/);
  });

  test('rendered for UI pilot at plan:pre with all flags on', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /ui-phase/);
    assert.match(rendered, /UI-SPEC\.md/);
  });
});

// ─── 6. Malformed registry resilience ────────────────────────────────────────

describe('malformed registry resilience', () => {
  test('missing byLoopPoint → no throw, empty activeHooks', () => {
    const badRegistry = {}; // no byLoopPoint
    // No throw — but point validation falls back to CANONICAL_POINTS_FALLBACK
    const result = resolveLoopHooks({ point: 'plan:pre', registry: badRegistry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('null hook in steps array → skipped', () => {
    const registry = makeRegistry({
      steps: [null, { capId: 'ok', point: 'plan:pre', ref: { skill: 'ok-skill' } }, undefined],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 1);
    assert.strictEqual(result.activeHooks[0].capId, 'ok');
  });

  test('byLoopPoint[point] missing arrays → no throw, empty result', () => {
    const registry = { byLoopPoint: { 'plan:pre': {} } }; // no steps/contributions/gates keys
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('byLoopPoint[point] has non-array steps → treated as empty', () => {
    const registry = { byLoopPoint: { 'plan:pre': { steps: 'bad', contributions: [], gates: [] } } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('byLoopPoint[point] is null → no throw, empty result', () => {
    const registry = { byLoopPoint: { 'plan:pre': null } };
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });
});

// ─── 7. Prototype-pollution guard ────────────────────────────────────────────

describe('prototype-pollution guard', () => {
  test('when="__proto__.x" does not pollute Object.prototype', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: '__proto__.x' }],
    });
    const config = { x: 'injected' };
    // Should not throw and should not activate (guard returns found:false)
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config });
    assert.strictEqual(result.activeHooks.length, 0);
    // Object.prototype must not be polluted
    assert.strictEqual(({}).x, undefined);
  });

  test('when="constructor.x" does not pollute', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: 'constructor.x' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('when="prototype.x" does not pollute', () => {
    const registry = makeRegistry({
      steps: [{ capId: 'attacker', point: 'plan:pre', ref: { skill: 'evil' }, when: 'prototype.x' }],
    });
    const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(result.activeHooks.length, 0);
  });

  test('_getNestedConfigValue: __proto__ segment returns found:false', () => {
    const r = _getNestedConfigValue({}, '__proto__.x');
    assert.strictEqual(r.found, false);
  });

  test('_getNestedConfigValue: constructor segment returns found:false', () => {
    const r = _getNestedConfigValue({}, 'constructor.toString');
    assert.strictEqual(r.found, false);
  });

  test('_getNestedConfigValue: normal dotted key traversal works', () => {
    const config = { workflow: { ui_phase: true } };
    const r = _getNestedConfigValue(config, 'workflow.ui_phase');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.value, true);
  });

  // FIX 4: raw config.json with __proto__ key does not pollute via _readRawConfigKey
  test('raw config.json with "__proto__" key does not pollute Object.prototype', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-proto-'));
    try {
      // Write a raw config.json containing __proto__ at top level and nested
      // (JSON.parse of {"__proto__":{"x":"polluted"}} does NOT set prototype in modern Node,
      // but we verify our guarded traversal returns found:false for such keys)
      const maliciousConfig = '{"__proto__":{"x":"polluted"},"workflow":{"ui_phase":true}}';
      fs.writeFileSync(path.join(tmpDir, 'config.json'), maliciousConfig, 'utf8');
      // _readRawConfigKey with '__proto__.x' should return found:false (guard)
      const r1 = _readRawConfigKey(path.join(tmpDir, 'config.json'), '__proto__.x');
      assert.strictEqual(r1.found, false, '__proto__ lookup must be guarded');
      // Normal key should work
      const r2 = _readRawConfigKey(path.join(tmpDir, 'config.json'), 'workflow.ui_phase');
      assert.strictEqual(r2.found, true);
      assert.strictEqual(r2.value, true);
      // Object.prototype must not be polluted
      assert.strictEqual(({}).x, undefined);
    } finally {
      cleanup(tmpDir);
    }
  });

  // FIX 4: _resolveActivationValue with cwd pointing to project with __proto__ config key
  test('_resolveActivationValue: raw config with __proto__ key does not pollute', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-proto2-'));
    try {
      const planningDir = path.join(tmpDir, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        '{"__proto__":{"y":"polluted2"}}',
        'utf8',
      );
      const registry = makeRegistry({
        steps: [{ capId: 'test', point: 'plan:pre', ref: { skill: 'sk' }, when: '__proto__.y' }],
      });
      const result = resolveLoopHooks({ point: 'plan:pre', registry, config: {}, cwd: tmpDir });
      assert.strictEqual(result.activeHooks.length, 0, '__proto__ when must be inactive');
      assert.strictEqual(({}).y, undefined, 'Object.prototype.y must not be polluted');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 7b. Raw config.json override paths (FIX 4) ──────────────────────────────

describe('raw config.json override paths (FIX 4)', () => {
  // FIX 4: user sets workflow.ui_phase=false in root config.json → hook filtered
  test('root config.json with ui_phase=false overrides schema default=true → inactive', () => {
    // tmpFalseConfigProjectDir has .planning/config.json { workflow: { ui_phase: false } }
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result (simulating pre-cutover)
      cwd: tmpFalseConfigProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(
      uiStep,
      undefined,
      'root config.json override false must beat schema default=true',
    );
  });

  // FIX 4: root config.json with ui_phase=true (explicit) → hook active
  test('root config.json with ui_phase=true → active (raw config read path)', () => {
    // tmpProjectDir has .planning/config.json { workflow: { ui_phase: true } }
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result (simulating pre-cutover)
      cwd: tmpProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'root config.json ui_phase=true should activate hook');
  });

  // FIX 4: no config.json at all → falls through to schema default=true → active
  test('no config.json → schema default=true → hook active', () => {
    // tmpEmptyProjectDir has .planning/ directory but no config.json
    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {}, // empty loadConfig result
      cwd: tmpEmptyProjectDir,
    });
    const uiStep = result.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'no config.json → schema default=true → hook should be active');
  });

  // FIX 4: _readRawConfigKey returns found:false for missing file (ENOENT — silent)
  test('_readRawConfigKey: missing file → found:false, no throw', () => {
    const result = _readRawConfigKey('/nonexistent/path/config.json', 'workflow.ui_phase');
    assert.strictEqual(result.found, false);
  });

  // FIX 4: _readRawConfigKey returns found:false for malformed JSON, warns once
  test('_readRawConfigKey: malformed JSON → found:false, no throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-resolver-malformed-'));
    try {
      const malformedPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(malformedPath, '{ invalid json }', 'utf8');
      const result = _readRawConfigKey(malformedPath, 'workflow.ui_phase');
      assert.strictEqual(result.found, false, 'malformed JSON should return found:false');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── 8. Renderer tests ────────────────────────────────────────────────────────

describe('renderLoopHooks', () => {
  test('step hook renders skill ref, capId, produces, consumes', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [{
        capId: 'ui',
        kind: 'step',
        ref: { skill: 'ui-phase' },
        when: 'workflow.ui_phase',
        produces: ['UI-SPEC.md'],
        consumes: ['CONTEXT.md'],
        onError: 'skip',
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Step 1/);
    assert.match(rendered, /skill:ui-phase/);
    assert.match(rendered, /\(ui\)/);
    assert.match(rendered, /UI-SPEC\.md/);
    assert.match(rendered, /CONTEXT\.md/);
    assert.match(rendered, /workflow\.ui_phase/);
    assert.match(rendered, /skip/);
  });

  test('step hook renders agent ref and inline prompt fragment', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{
        capId: 'research',
        point: 'plan:pre',
        ref: { agent: 'gsd-phase-researcher' },
        fragment: { inline: 'Research the phase before planning.' },
        produces: ['RESEARCH.md'],
        consumes: ['CONTEXT.md'],
        onError: 'skip',
      }],
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.deepEqual(resolved.activeHooks[0].fragment, { inline: 'Research the phase before planning.' });

    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /agent:gsd-phase-researcher/);
    assert.match(rendered, /Research the phase before planning\./);
  });

  test('contribution hook renders into role', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [{
        capId: 'contrib-cap',
        kind: 'contribution',
        into: 'planner',
        fragment: { inline: 'Apply the project-specific planning guardrails.' },
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /contribution/);
    assert.match(rendered, /contrib-cap/);
    assert.match(rendered, /planner/);
    assert.match(rendered, /Apply the project-specific planning guardrails\./);
    assert.match(rendered, /<contribution from="contrib-cap" into="planner">/);
    assert.match(rendered, /<\/contribution>/);
    assert.doesNotMatch(rendered, /<contribution[^>]+\/>/);
  });

  test('resolveLoopHooks preserves contribution fragment data', () => {
    const registry = makeRegistry({
      point: 'plan:pre',
      contributions: [{
        capId: 'contrib-cap',
        point: 'plan:pre',
        into: 'planner',
        fragment: { inline: 'Use artifact-backed evidence.' },
        produces: ['PLAN-NOTES.md'],
        consumes: ['CONTEXT.md'],
        when: 'workflow.contrib',
        onError: 'halt',
      }],
      configSchema: {
        'workflow.contrib': { type: 'boolean', default: true, description: 'Enable test contribution.' },
      },
    });
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 1);
    assert.deepEqual(resolved.activeHooks[0].fragment, { inline: 'Use artifact-backed evidence.' });
    assert.deepEqual(resolved.activeHooks[0].produces, ['PLAN-NOTES.md']);
    assert.deepEqual(resolved.activeHooks[0].consumes, ['CONTEXT.md']);
    assert.strictEqual(resolved.activeHooks[0].onError, 'halt');
  });

  test('gate hook renders check, blocking, onError', () => {
    const resolved = {
      point: 'execute:wave:post',
      activeHooks: [{
        capId: 'ui',
        kind: 'gate',
        check: { query: 'ui.safety-gate' },
        blocking: true,
        onError: 'halt',
      }],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Gate/);
    assert.match(rendered, /ui/);
    assert.match(rendered, /blocking=true/);
    assert.match(rendered, /halt/);
  });

  test('multiple hooks in order render with correct ordinals', () => {
    const resolved = {
      point: 'plan:pre',
      activeHooks: [
        { capId: 'cap-a', kind: 'step', ref: { skill: 'a' }, produces: ['A.md'], consumes: [] },
        { capId: 'cap-b', kind: 'step', ref: { skill: 'b' }, produces: ['B.md'], consumes: ['A.md'] },
      ],
    };
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /Step 1/);
    assert.match(rendered, /Step 2/);
    const idx1 = rendered.indexOf('Step 1');
    const idx2 = rendered.indexOf('Step 2');
    assert.ok(idx1 < idx2, 'Step 1 should appear before Step 2');
  });

  test('empty hooks returns placeholder containing the point name', () => {
    const rendered = renderLoopHooks({ point: 'ship:post', activeHooks: [] });
    assert.match(rendered, /ship:post/);
    assert.ok(rendered.length > 0);
  });

  test('rendered is deterministic (same input → same output)', () => {
    const config = { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } };
    const resolved = resolveLoopHooks({ point: 'plan:pre', registry: realRegistry, config });
    const r1 = renderLoopHooks(resolved);
    const r2 = renderLoopHooks(resolved);
    assert.strictEqual(r1, r2);
  });
});

// ─── 9. End-to-end cmdLoopRenderHooks (via gsd-tools subprocess) ─────────────

const { runNode } = require('./helpers/process-seam.cjs');
const ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('cmdLoopRenderHooks end-to-end (via gsd-tools)', () => {
  test('loop render-hooks plan:pre returns JSON envelope with ui-phase step active', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpProjectDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'plan:pre');
    assert.ok(Array.isArray(envelope.activeHooks));
    assert.strictEqual(typeof envelope.rendered, 'string');
    // With ui_phase=true in tmpProjectDir config, ui-phase step should be active
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(uiStep, 'Expected ui step in activeHooks. Got: ' + JSON.stringify(envelope.activeHooks));
    assert.match(envelope.rendered, /ui-phase/);
  });

  // FIX 4: schema-default activation — no config.json in project → ui-phase step active by default
  test('loop render-hooks plan:pre with no config.json → ui-phase step active by schema default', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpEmptyProjectDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.ok(
      uiStep,
      'Expected ui step active by default. Got: ' + JSON.stringify(envelope.activeHooks),
    );
    assert.match(envelope.rendered, /ui-phase/);
  });

  test('loop render-hooks plan:pre with ui capability disabled in surface → ui hooks absent', () => {
    const result = runNode(
      [
        GSD_TOOLS,
        'loop',
        'render-hooks',
        'plan:pre',
        '--cwd',
        tmpEmptyProjectDir,
        '--config-dir',
        tmpUiDisabledConfigDir,
      ],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiHooks = envelope.activeHooks.filter(h => h.capId === 'ui');
    assert.deepStrictEqual(
      uiHooks,
      [],
      'UI hooks must be absent when the UI capability is disabled at the runtime surface',
    );
  });

  // FIX 4: explicit false in config.json overrides schema default
  test('loop render-hooks plan:pre with ui_phase=false in config.json → ui-phase step absent', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:pre', '--cwd', tmpFalseConfigProjectDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    const envelope = JSON.parse(result.stdout.trim());
    const uiStep = envelope.activeHooks.find(h => h.capId === 'ui' && h.kind === 'step');
    assert.strictEqual(
      uiStep,
      undefined,
      'ui-phase step should be absent when config.json sets ui_phase=false',
    );
  });

  test('loop render-hooks invalid-point exits non-zero', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'plan:mid', '--cwd', tmpProjectDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.notStrictEqual(result.exitCode, 0, 'Expected non-zero exit for invalid point');
    assert.match(result.stderr, /plan:mid|Invalid loop point/);
  });
});

// ─── 10. --active-cap flag (scanner-safe boolean derivation) ──────────────────

describe('--active-cap flag (loop render-hooks)', () => {
  // Temp project with tdd_mode=true in config
  let tddOnDir;
  // Temp project with tdd_mode=false in config
  let tddOffDir;

  before(() => {
    tddOnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-active-cap-tdd-on-'));
    const planOn = path.join(tddOnDir, '.planning');
    fs.mkdirSync(planOn, { recursive: true });
    fs.writeFileSync(
      path.join(planOn, 'config.json'),
      JSON.stringify({ workflow: { tdd_mode: true } }),
      'utf8',
    );

    tddOffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-active-cap-tdd-off-'));
    const planOff = path.join(tddOffDir, '.planning');
    fs.mkdirSync(planOff, { recursive: true });
    fs.writeFileSync(
      path.join(planOff, 'config.json'),
      JSON.stringify({ workflow: { tdd_mode: false } }),
      'utf8',
    );
  });

  after(() => {
    if (tddOnDir) cleanup(tddOnDir);
    if (tddOffDir) cleanup(tddOffDir);
  });

  test('--active-cap tdd with tdd_mode=true → stdout trimmed === "true", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOnDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'true', 'Expected stdout "true" when tdd_mode=true');
  });

  test('--active-cap tdd with tdd_mode=false → stdout trimmed === "false", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'false', 'Expected stdout "false" when tdd_mode=false');
  });

  test('--active-cap <nonexistent-cap> → stdout trimmed === "false", exit 0', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'no-such-capability-xyz', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0 for unknown capId. stderr: ' + (result.stderr || ''));
    assert.strictEqual(result.stdout.trim(), 'false', 'Expected stdout "false" for unknown capId');
  });

  test('--active-cap with no value → non-zero exit and error message', () => {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', '--cwd', tddOffDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.notStrictEqual(result.exitCode, 0, 'Expected non-zero exit when --active-cap has no value');
    assert.match(result.stderr, /active-cap/i, 'Expected error message referencing --active-cap');
  });

  test('--active-cap output is exactly "true" or "false" (no JSON envelope, clean for shell capture)', () => {
    // The entire stdout must be just "true" or "false" + newline — no envelope object
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', 'execute:post', '--active-cap', 'tdd', '--cwd', tddOnDir],
      { cwd: ROOT, timeoutMs: 15000 },
    );
    assert.strictEqual(result.exitCode, 0, 'Expected exit 0. stderr: ' + (result.stderr || ''));
    // Must be exactly "true" or "false" — not a JSON object/envelope
    const trimmed = result.stdout.trim();
    assert.ok(
      trimmed === 'true' || trimmed === 'false',
      `stdout must be "true" or "false", got: ${JSON.stringify(result.stdout)}`,
    );
    // Must not be a JSON object (no envelope with point/activeHooks/rendered keys)
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    assert.ok(
      typeof parsed !== 'object' || parsed === null,
      'stdout must not be a JSON object/envelope when --active-cap is used',
    );
  });
});

// ─── Phase 4 regression: loop-resolver gates on state.active (not state.enabled) ─────
//
// FAIL-FIRST PROOF (what would fail against the OLD state.enabled check):
//   Scenario: capability has activationKey set; it is installed + surfaced (enabled=true)
//   but the activationKey resolves to false (active=false). The capability has a hook
//   WITHOUT a `when` guard (unconditional). With old state.enabled check:
//     state.enabled=true → state.enabled !== false → true → hook IS rendered (BUG).
//   With new state.active check:
//     state.active=false → state.active === true → false → hook NOT rendered (CORRECT).
//
// This test uses resolveLoopHooks directly with a synthetic registry and a
// capabilityStatesById map that models the above scenario: enabled=true, active=false.
// It would FAIL against the OLD `state.enabled !== false` code and PASS against the
// NEW `state.active === true` code.

describe('Phase 4 regression: capabilityStatesById gates on active (not enabled) for config-disabled capability', () => {
  test('[regression] enabled=true active=false + no `when` guard → hook NOT rendered (state.active gate)', () => {
    // Fail-first: with OLD `state.enabled !== false`, enabled=true → hook IS rendered (BUG).
    // With NEW `state.active === true`, active=false → hook NOT rendered (CORRECT).
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'test-cap', ref: { skill: 'gsd-test-skill' } }],
      // No `when` → unconditional hook (no per-hook config gate to fall back on)
    });

    const capabilityStatesById = new Map([
      // enabled=true (installed+surfaced), active=false (activationKey resolved to false)
      // This models a capability like intel/graphify that is surfaced but config-disabled.
      ['test-cap', { enabled: true, active: false }],
    ]);

    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config: {},  // config doesn't matter — capability already resolved active=false
      capabilityStatesById,
    });

    assert.strictEqual(
      result.activeHooks.length,
      0,
      'Hook must NOT be rendered when state.active=false, even if enabled=true and no `when` guard — ' +
      'OLD state.enabled check would include this hook (BUG: enabled=true passes enabled!==false); ' +
      'NEW state.active check correctly suppresses it (active=false fails active===true)',
    );
  });

  test('[positive control] enabled=true active=true + no `when` guard → hook IS rendered', () => {
    // Confirms the fixture is sound: same hook, same registry, but active=true → rendered.
    // This test must PASS against BOTH old and new code (it's the unbroken branch).
    const registry = makeRegistry({
      point: 'plan:pre',
      steps: [{ capId: 'test-cap', ref: { skill: 'gsd-test-skill' } }],
    });

    const capabilityStatesById = new Map([
      ['test-cap', { enabled: true, active: true }],
    ]);

    const result = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config: {},
      capabilityStatesById,
    });

    assert.strictEqual(
      result.activeHooks.length,
      1,
      'Hook MUST be rendered when state.active=true and no `when` guard (positive control)',
    );
    assert.strictEqual(result.activeHooks[0].capId, 'test-cap');
  });
});

// ─── ADR-1244 D2: load-failed capability gates FAIL OPEN with a loud warning (#2009) ──

describe('ADR-1244 D2: load-failed capability gates fail OPEN with a loud warning (#2009)', () => {
  // Decision (#2009): a capability that fails to LOAD must not block the loop.
  // cmdLoopRenderHooks injects NO gate (the loop proceeds — fail open) and emits a
  // loud warning naming the load reason and the exact `gsd capability remove <id>`
  // remediation, both to STDERR (the channel host workflows actually surface) and
  // in the envelope's `warnings` array. Previously it injected a blocking=true,
  // onError=halt gate that halted every declared point project-wide.

  // Helper: write an overlay cap with an incompatible engines.gsd (→ skipped at load)
  // that declares gate(s) at the given point(s). `capId` may be an invalid id to
  // exercise the sanitization path.
  function writeSkippedGateCap(overlayHome, capId, gatePoints) {
    const capDir = path.join(overlayHome, '.gsd', 'capabilities', capId);
    fs.mkdirSync(capDir, { recursive: true });
    const capManifest = {
      id: capId,
      role: 'feature',
      version: '1.0.0',
      title: 'Load-Failed Gate Cap',
      description: 'ADR-1244 D2 fail-open wiring test',
      tier: 'standard',
      requires: [],
      engines: { gsd: '>=99.0.0' },  // intentionally incompatible → always skipped at load
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [],
      gates: gatePoints.map((point) => ({ point, check: { query: 'always-pass' }, blocking: true, onError: 'halt' })),
    };
    fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(capManifest), 'utf8');
  }

  function renderHooks(overlayHome, point, extraArgs = []) {
    const result = runNode(
      [GSD_TOOLS, 'loop', 'render-hooks', point, '--cwd', overlayHome, ...extraArgs],
      { cwd: ROOT, timeoutMs: 15000, env: { ...process.env, GSD_HOME: overlayHome } },
    );
    assert.strictEqual(result.exitCode, 0, `Expected exit 0 at ${point}. stderr: ` + (result.stderr || ''));
    return result;
  }

  function parseEnvelope(result) {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      assert.fail('loop render-hooks output must be valid JSON; got: ' + result.stdout.slice(0, 300));
    }
  }

  test('load-failed gate-kind overlay cap → NO gate injected (fail open) + loud warning on stderr and in envelope', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-'));
    t.after(() => cleanup(overlayHome));

    const capId = 'load-failed-gate-cap';
    writeSkippedGateCap(overlayHome, capId, ['execute:wave:post']);

    const result = renderHooks(overlayHome, 'execute:wave:post');
    const envelope = parseEnvelope(result);

    // AC2 / AC-a: fail OPEN — NO gate (blocking or otherwise) is injected for the
    // load-failed cap, so the loop proceeds.
    const anyGate = Array.isArray(envelope.activeHooks)
      ? envelope.activeHooks.find((h) => h.capId === capId)
      : undefined;
    assert.strictEqual(
      anyGate, undefined,
      'no hook must be injected for a load-failed cap (fail open). Got: ' + JSON.stringify(envelope.activeHooks),
    );

    // AC-b: a loud warning is surfaced in the envelope `warnings` channel...
    const warnEnv = (envelope.warnings || []).find((w) => w.includes(capId));
    assert.ok(warnEnv, 'envelope.warnings must name the load-failed cap. Got: ' + JSON.stringify(envelope.warnings));
    // AC1: ...carrying the exact remediation, and making clear the gate is not enforced.
    assert.ok(
      warnEnv.includes(`gsd capability remove ${capId}`),
      'warning must include the `gsd capability remove <id>` remediation. Got: ' + warnEnv,
    );
    assert.match(warnEnv, /skipped|not enforced|failing open/i, 'warning must say the gate is not enforced. Got: ' + warnEnv);

    // ...and ALSO to stderr (the channel host workflows actually see).
    assert.ok(
      result.stderr.includes(`gsd capability remove ${capId}`),
      'stderr must carry the loud fail-open warning with remediation. Got: ' + result.stderr,
    );
  });

  test('load-failed cap declaring gates at ship:pre AND verify:post → neither point blocks (project can ship & verify)', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-2pt-'));
    t.after(() => cleanup(overlayHome));

    const capId = 'load-failed-two-point-cap';
    writeSkippedGateCap(overlayHome, capId, ['ship:pre', 'verify:post']);

    for (const point of ['ship:pre', 'verify:post']) {
      const result = renderHooks(overlayHome, point);
      const envelope = parseEnvelope(result);
      const injected = envelope.activeHooks.find((h) => h.capId === capId);
      assert.strictEqual(
        injected, undefined,
        `${point} must NOT inject any hook for a load-failed cap (fail open). Got: ` + JSON.stringify(envelope.activeHooks),
      );
      const warn = (envelope.warnings || []).find((w) => w.includes(`gsd capability remove ${capId}`));
      assert.ok(warn, `${point} must surface a fail-open warning with remediation. Got: ` + JSON.stringify(envelope.warnings));
    }
  });

  test('security: an invalid (non-kebab) capability id is withheld — no runnable remove command is rendered (#2009 review)', (t) => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fail-open-evil-'));
    t.after(() => cleanup(overlayHome));

    // A directory name that is a valid POSIX filename but NOT a valid capability
    // id, and contains a shell metacharacter. It must never appear inside a
    // runnable `gsd capability remove <id>` command in the surfaced warning.
    const evilId = 'Bad;Cap';
    writeSkippedGateCap(overlayHome, evilId, ['ship:pre']);

    const result = renderHooks(overlayHome, 'ship:pre');
    const envelope = parseEnvelope(result);

    const combined = (envelope.warnings || []).join('\n') + '\n' + result.stderr;
    // The raw metacharacter id must not be embedded in a runnable remove command.
    assert.ok(
      !combined.includes(`gsd capability remove ${evilId}`),
      'invalid capability id must NOT be placed in a runnable remove command. Got: ' + combined,
    );
    // A warning is still surfaced (fail-open is loud), using the withheld-id form.
    assert.match(
      combined, /invalid id \(withheld\)/,
      'an invalid id must be reported via the withheld-id placeholder. Got: ' + combined,
    );
  });
});


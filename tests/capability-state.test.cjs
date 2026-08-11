'use strict';

/**
 * capability-state.test.cjs — behavioral tests for capability-state.cjs.
 *
 * ADR-857 phase 4b.
 * Uses node:test + node:assert/strict.
 * Pure-function tests (resolveCapabilityState) pass registry+Sets+config
 * directly — no I/O. End-to-end tests use cmdCapabilityState + temp dirs.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup, runGsdTools } = require('./helpers.cjs');

const {
  resolveCapabilityState,
  resolveCapabilityRuntimeState,
  isCapabilityActive,
  _isSafePropKey,
  _loadInstalledSkillsManifest,
  _loadFlatCommandsGsdManifest,
  _resolveManifest,
} = require('../gsd-core/bin/lib/capability-state.cjs');

// The real capability registry
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── Synthetic registry fixture ───────────────────────────────────────────────

/**
 * Build a minimal synthetic registry for a single capability with the given
 * skills, steps, gates, contributions, configSchema, and optional activationKey.
 */
function makeRegistry({
  id = 'test-cap',
  tier = 'standard',
  skills = [],
  steps = [],
  gates = [],
  contributions = [],
  configSchema = {},
  activationKey = undefined,
} = {}) {
  const capEntry = {
    id,
    tier,
    skills,
    steps,
    gates,
    contributions,
    config: {},
  };
  if (activationKey !== undefined) {
    capEntry.activationKey = activationKey;
  }
  return {
    capabilities: {
      [id]: capEntry,
    },
    configSchema,
  };
}

// ─── Temp project helpers ─────────────────────────────────────────────────────

let tmpProjectDir;
let tmpProjectDirFalse;

before(() => {
  // Project with UI flags enabled
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-test-'));
  const planningDir = path.join(tmpProjectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({
      workflow: {
        ui_phase: true,
        ui_review: true,
        ui_safety_gate: true,
      },
    }),
    'utf8',
  );

  // Project with all UI flags disabled
  tmpProjectDirFalse = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-false-'));
  fs.mkdirSync(path.join(tmpProjectDirFalse, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(path.join(tmpProjectDirFalse, '.planning'), 'config.json'),
    JSON.stringify({
      workflow: {
        ui_phase: false,
        ui_review: false,
        ui_safety_gate: false,
      },
    }),
    'utf8',
  );
});

after(() => {
  cleanup(tmpProjectDir);
  cleanup(tmpProjectDirFalse);
});

// ─── _isSafePropKey helper ────────────────────────────────────────────────────

describe('_isSafePropKey', () => {
  test('allows normal keys', () => {
    assert.strictEqual(_isSafePropKey('ui'), true);
    assert.strictEqual(_isSafePropKey('my-cap'), true);
    assert.strictEqual(_isSafePropKey('cap123'), true);
  });

  test('blocks __proto__', () => {
    assert.strictEqual(_isSafePropKey('__proto__'), false);
  });

  test('blocks constructor', () => {
    assert.strictEqual(_isSafePropKey('constructor'), false);
  });

  test('blocks prototype', () => {
    assert.strictEqual(_isSafePropKey('prototype'), false);
  });

  test('blocks non-string', () => {
    assert.strictEqual(_isSafePropKey(null), false);
    assert.strictEqual(_isSafePropKey(42), false);
    assert.strictEqual(_isSafePropKey(undefined), false);
  });
});

// ─── resolveCapabilityState — basic shapes ────────────────────────────────────

describe('resolveCapabilityState — basic shapes', () => {
  test('empty registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: { capabilities: {} },
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('missing capabilities key → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: {},
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('null registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: null,
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('array registry → {capabilities:[]}', () => {
    const result = resolveCapabilityState({
      registry: [],
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });

  test('malformed capabilities entry is skipped gracefully', () => {
    const result = resolveCapabilityState({
      registry: { capabilities: { 'bad-cap': 'not-an-object' } },
      installedSkills: new Set(),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.deepStrictEqual(result, { capabilities: [] });
  });
});

// ─── resolveCapabilityState — installed dimension ────────────────────────────

describe('resolveCapabilityState — installed dimension', () => {
  test('installedSkills="*" → installed=true for all caps', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities.length, 1);
    assert.strictEqual(result.capabilities[0].installed, true);
  });

  test('all skills in installedSkills → installed=true', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, true);
  });

  test('one skill missing from installedSkills → installed=false', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['ui-phase']), // missing ui-review
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, false);
  });

  test('empty skills array → installed=true vacuously', () => {
    // A capability with zero skills has no skills to be absent, so it is
    // vacuously installed and surfaced regardless of the installed/surfaced sets.
    // This is intentional: capabilities that gate purely on config (no skills
    // required) should report installed=true/surfaced=true when no skills are
    // needed. Activation state is still governed by hook `when` keys.
    const registry = makeRegistry({ skills: [] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(), // nothing installed — vacuous true still applies
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].installed, true);
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });
});

// ─── resolveCapabilityState — surfaced dimension ──────────────────────────────

describe('resolveCapabilityState — surfaced dimension', () => {
  test('all skills in surfacedSkills → surfaced=true', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });

  test('one skill missing from surfacedSkills → surfaced=false', () => {
    const registry = makeRegistry({ skills: ['ui-phase', 'ui-review'] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase']), // missing ui-review
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, false);
  });

  test('empty skills array → surfaced=true vacuously', () => {
    const registry = makeRegistry({ skills: [] });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(), // nothing surfaced
      config: {},
    });
    assert.strictEqual(result.capabilities[0].surfaced, true);
  });
});

// ─── resolveCapabilityState — UI capability (real registry) ──────────────────

describe('resolveCapabilityState — UI capability with real registry', () => {
  test('UI cap: installed=true when ui-phase + ui-review in installedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present');
    assert.strictEqual(uiCap.installed, true);
    assert.strictEqual(uiCap.surfaced, true);
    assert.strictEqual(uiCap.enabled, true);
  });

  test('UI cap: installed=false when ui-review missing from installedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase']), // missing ui-review
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    assert.strictEqual(uiCap.installed, false);
    assert.strictEqual(uiCap.enabled, false);
  });

  test('UI cap: surfaced=false when ui-review missing from surfacedSkills', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']), // missing ui-review
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    assert.strictEqual(uiCap.surfaced, false);
    assert.strictEqual(uiCap.enabled, false);
  });

  test('UI cap step hook: workflow.ui_phase true → active=true', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    // Find the plan:pre step (ui-phase step)
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'should have plan:pre step with when=workflow.ui_phase');
    assert.strictEqual(planPreStep.configured, true);
    assert.strictEqual(planPreStep.active, true);
  });

  test('UI cap step hook: surfaced=false and workflow.ui_phase true → configured=true but active=false', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    assert.strictEqual(uiCap.enabled, false);
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'should have plan:pre step with when=workflow.ui_phase');
    assert.strictEqual(planPreStep.configured, true);
    assert.strictEqual(planPreStep.active, false);
  });

  test('UI cap step hook: workflow.ui_phase false → active=false', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } },
      cwd: tmpProjectDirFalse,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'should have plan:pre step with when=workflow.ui_phase');
    assert.strictEqual(planPreStep.configured, false);
    assert.strictEqual(planPreStep.active, false);
  });

  test('UI cap gate hook: workflow.ui_safety_gate true → active=true', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const safetyGate = uiCap.hooks.find(
      (h) => h.kind === 'gate' && h.when === 'workflow.ui_safety_gate',
    );
    assert.ok(safetyGate, 'should have gate with when=workflow.ui_safety_gate');
    assert.strictEqual(safetyGate.configured, true);
    assert.strictEqual(safetyGate.active, true);
  });

  test('UI cap gate hook: workflow.ui_safety_gate false → active=false', () => {
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { ui_phase: false, ui_review: false, ui_safety_gate: false } },
      cwd: tmpProjectDirFalse,
    });
    const uiCap = result.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap);
    const safetyGate = uiCap.hooks.find(
      (h) => h.kind === 'gate' && h.when === 'workflow.ui_safety_gate',
    );
    assert.ok(safetyGate, 'should have gate with when=workflow.ui_safety_gate');
    assert.strictEqual(safetyGate.configured, false);
    assert.strictEqual(safetyGate.active, false);
  });
});

// ─── resolveCapabilityState — hook activation ─────────────────────────────────

describe('resolveCapabilityState — hook activation details', () => {
  test('hook with no `when` → active=true (unconditional)', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', ref: { skill: 'test-skill' } }], // no `when`
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    assert.strictEqual(result.capabilities.length, 1);
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, undefined);
    assert.strictEqual(hook.active, true);
  });

  test('hook with `when` resolving truthy → active=true', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 'workflow.my_feature' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { my_feature: true } },
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook);
    assert.strictEqual(hook.active, true);
  });

  test('hook with `when` resolving falsy → active=false', () => {
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 'workflow.my_feature' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { my_feature: false } },
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook);
    assert.strictEqual(hook.active, false);
  });

  test('mixed hooks: some active, some not', () => {
    const registry = makeRegistry({
      steps: [
        { point: 'plan:pre', when: 'workflow.feat_a' },
        { point: 'plan:post' }, // no when → unconditional
      ],
      gates: [{ point: 'execute:wave:post', when: 'workflow.feat_b' }],
      // contributions must be a real array (not an object) so hook enumeration works
      contributions: [
        { point: 'plan:pre', into: 'context', when: 'workflow.feat_c' },
      ],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: { workflow: { feat_a: false, feat_b: true, feat_c: true } },
    });
    const cap = result.capabilities[0];
    // feat_a step: inactive
    const featAStep = cap.hooks.find((h) => h.when === 'workflow.feat_a');
    assert.ok(featAStep);
    assert.strictEqual(featAStep.active, false);
    // unconditional step: active
    const unconditional = cap.hooks.find((h) => h.kind === 'step' && !h.when);
    assert.ok(unconditional);
    assert.strictEqual(unconditional.active, true);
    // feat_b gate: active
    const featBGate = cap.hooks.find((h) => h.when === 'workflow.feat_b');
    assert.ok(featBGate);
    assert.strictEqual(featBGate.active, true);
    // feat_c contribution: active, enumerated correctly
    const featCContrib = cap.hooks.find((h) => h.kind === 'contribution' && h.when === 'workflow.feat_c');
    assert.ok(featCContrib, 'contribution hook should be enumerated from array');
    assert.strictEqual(featCContrib.active, true);
  });

  test('empty-string `when` → active=false (aligned with loop-resolver)', () => {
    // loop-resolver.isActive: `when.length === 0` → false
    // capability-state must behave identically
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: '' }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, '', 'original when value must be preserved');
    assert.strictEqual(hook.active, false, 'empty-string when → inactive');
  });

  test('non-string `when` → active=false (aligned with loop-resolver)', () => {
    // loop-resolver.isActive: `typeof when !== 'string'` → false
    const registry = makeRegistry({
      steps: [{ point: 'plan:pre', when: 42 }],
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const hook = result.capabilities[0].hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'step hook should be present');
    assert.strictEqual(hook.when, 42, 'original non-string when value must be preserved');
    assert.strictEqual(hook.active, false, 'non-string when → inactive');
  });

  // ── configActivation cascade to hooks ────────────────────────────────────────
  // Bug: a config-disabled capability (active=false) with an unconditional hook
  // (no `when`, configured=true) was wrongly yielding hook.active=true because
  // the hook loop used `enabled && configured` instead of `active && configured`.
  // Fix: hook.active = active(capability) && configured.

  test('config-disabled capability with unconditional hook → hook.active=false, configured=true', () => {
    // The capability activationKey resolves false → capability active=false.
    // The hook has no `when` → configured=true (unconditional).
    // Before the fix: hook.active = enabled(true) && configured(true) = true  ← BUG
    // After the fix:  hook.active = active(false) && configured(true)  = false ← correct
    const registry = makeRegistry({
      id: 'test-cap',
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      steps: [{ point: 'plan:pre', ref: { skill: 'my-skill' } }], // no `when` → unconditional
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: false } }, // capability's configActivation = false
    });
    const cap = result.capabilities[0];
    assert.ok(cap, 'capability must be present');
    assert.strictEqual(cap.enabled, true, 'enabled stays true: installed && surfaced');
    assert.strictEqual(cap.active, false, 'capability active=false: configActivation off');
    const hook = cap.hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'unconditional step hook must be present');
    assert.strictEqual(hook.when, undefined, 'hook has no when field (unconditional)');
    assert.strictEqual(hook.configured, true, 'hook configured=true: hook own gate is open');
    assert.strictEqual(hook.active, false, 'hook active=false: capability configActivation cascades to hook');
  });

  test('config-ENABLED capability with unconditional hook → hook.active=true (control)', () => {
    // Same setup as above but activationKey resolves true → capability active=true.
    // hook.active should follow configured as before.
    const registry = makeRegistry({
      id: 'test-cap',
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      steps: [{ point: 'plan:pre', ref: { skill: 'my-skill' } }], // no `when`
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: true } }, // capability's configActivation = true
    });
    const cap = result.capabilities[0];
    assert.ok(cap, 'capability must be present');
    assert.strictEqual(cap.active, true, 'capability active=true: configActivation on');
    const hook = cap.hooks.find((h) => h.kind === 'step');
    assert.ok(hook, 'unconditional step hook must be present');
    assert.strictEqual(hook.configured, true, 'hook configured=true');
    assert.strictEqual(hook.active, true, 'hook active=true: both capability and hook gate open');
  });
});

// ─── resolveCapabilityState — determinism ─────────────────────────────────────

describe('resolveCapabilityState — determinism', () => {
  test('sorted by id — two caps returned in lexicographic order', () => {
    // contributions must be an array (not an object) for the hook enumeration to work
    const registry = {
      capabilities: {
        'zzz-cap': { id: 'zzz-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
        'aaa-cap': { id: 'aaa-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
        'mmm-cap': { id: 'mmm-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      },
    };
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const ids = result.capabilities.map((c) => c.id);
    assert.deepStrictEqual(ids, ['aaa-cap', 'mmm-cap', 'zzz-cap']);
  });

  test('two calls with same inputs produce identical output', () => {
    const result1 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']),
      config: { workflow: { ui_phase: true, ui_review: false, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    const result2 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase']),
      config: { workflow: { ui_phase: true, ui_review: false, ui_safety_gate: true } },
      cwd: tmpProjectDir,
    });
    assert.deepStrictEqual(result1, result2);
  });

  test('pure config-only resolution (cwd: undefined) — no I/O, deterministic', () => {
    // When cwd is omitted, resolveCapabilityState does no filesystem I/O.
    // Two calls with identical args must produce identical output regardless
    // of any .planning/config.json files that may exist on disk.
    const result1 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } },
      // no cwd
    });
    const result2 = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(['ui-phase', 'ui-review']),
      surfacedSkills: new Set(['ui-phase', 'ui-review']),
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: false } },
      // no cwd
    });
    assert.deepStrictEqual(result1, result2);
    // Activation should come from the `config` arg only, not from disk
    const uiCap = result1.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present');
    const uiPhaseStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    if (uiPhaseStep) {
      assert.strictEqual(uiPhaseStep.active, true, 'should use config arg, not disk');
    }
  });
});

// ─── resolveCapabilityState — prototype pollution guard ──────────────────────

describe('resolveCapabilityState — prototype pollution guard', () => {
  test('prototype-pollution capId is skipped; Object.prototype unpolluted', () => {
    // Use Object.create(null) + Object.defineProperty to create a capabilities
    // map with a real OWN '__proto__' key (not the prototype chain).
    // The `{ __proto__: ... }` object literal syntax sets the prototype, not
    // an own property — so it cannot exercise the guard. Using defineProperty
    // ensures the key is an enumerable own property that Object.keys() returns.
    const capabilitiesMap = Object.create(null);
    Object.defineProperty(capabilitiesMap, '__proto__', {
      value: { id: '__proto__', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(capabilitiesMap, 'safe-cap', {
      value: { id: 'safe-cap', tier: 'standard', skills: [], steps: [], gates: [], contributions: [] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const registry = { capabilities: capabilitiesMap };
    const before = Object.prototype.toString.call({});
    const result = resolveCapabilityState({
      registry,
      installedSkills: '*',
      surfacedSkills: new Set(),
      config: {},
    });
    const after = Object.prototype.toString.call({});
    // Object.prototype must be unpolluted
    assert.strictEqual(before, after);
    // Verify no pollution occurred — a new plain object must not have a `polluted` property
    assert.strictEqual(({}).polluted, undefined);
    // Only the safe cap should appear
    assert.strictEqual(result.capabilities.length, 1);
    assert.strictEqual(result.capabilities[0].id, 'safe-cap');
  });
});

// ─── cmdCapabilityState — end-to-end via gsd-tools CLI ──────────────────────
//
// Because cmdCapabilityState destructures `output` at module load time, patching
// core.cjs after the fact is ineffective. We instead invoke gsd-tools via
// spawnSync so each test gets a fresh process with stdout captured.

const { spawnSync } = require('node:child_process');

const gsdToolsPath = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function runCapabilityState(cwd, configDir) {
  const result = spawnSync(
    process.execPath,
    [gsdToolsPath, 'capability', 'state', '--config-dir', configDir, '--raw', '--cwd', cwd],
    { encoding: 'utf8', timeout: 15000 },
  );
  return result;
}

describe('cmdCapabilityState — end-to-end via gsd-tools CLI', () => {
  let tmpConfigDir;
  let tmpConfigDirCore;
  let tmpConfigDirUiDisabled;

  before(() => {
    // Tmp runtime config dir without .gsd-profile (defaults to 'full')
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-cfg-'));

    // Tmp runtime config dir with core profile marker
    tmpConfigDirCore = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-cfg-core-'));
    fs.writeFileSync(path.join(tmpConfigDirCore, '.gsd-profile'), 'core\n', 'utf8');

    tmpConfigDirUiDisabled = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-cfg-ui-disabled-'));
    fs.writeFileSync(
      path.join(tmpConfigDirUiDisabled, '.gsd-surface.json'),
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
    cleanup(tmpConfigDir);
    cleanup(tmpConfigDirCore);
    cleanup(tmpConfigDirUiDisabled);
  });

  test('emits envelope with runtimeConfigDir and capabilities array', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDir);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(typeof envelope === 'object' && envelope !== null, 'envelope must be an object');
    assert.ok('runtimeConfigDir' in envelope, 'envelope must have runtimeConfigDir');
    assert.ok(Array.isArray(envelope.capabilities), 'envelope.capabilities must be an array');
    assert.ok(envelope.capabilities.length > 0, 'should have at least one capability');
  });

  test('with core profile marker: capabilities present (profile resolution does not throw)', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDirCore);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(Array.isArray(envelope.capabilities));
    // ui capability should appear; installed=false because core profile doesn't include ui-phase/ui-review
    const uiCap = envelope.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present in output');
    assert.strictEqual(uiCap.installed, false, 'ui-phase/ui-review not in core profile');
  });

  test('runtimeConfigDir is echoed in the envelope', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDir);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.runtimeConfigDir, tmpConfigDir);
  });

  test('surface-disabled UI capability reports enabled=false and inactive hooks', () => {
    const result = runCapabilityState(tmpProjectDir, tmpConfigDirUiDisabled);
    assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    const uiCap = envelope.capabilities.find((c) => c.id === 'ui');
    assert.ok(uiCap, 'ui capability should be present in output');
    assert.strictEqual(uiCap.installed, true, 'full base profile still installs UI');
    assert.strictEqual(uiCap.surfaced, false, 'surface disables UI capability skills');
    assert.strictEqual(uiCap.enabled, false, 'disabled surface must disable the capability');
    const planPreStep = uiCap.hooks.find(
      (h) => h.kind === 'step' && h.when === 'workflow.ui_phase',
    );
    assert.ok(planPreStep, 'ui plan step should be present in diagnostic state');
    assert.strictEqual(planPreStep.configured, true, 'project config/schema still configures UI on');
    assert.strictEqual(planPreStep.active, false, 'effective hook activity must match workflow dispatch');
  });
});

// ─── regressions: installed-runtime capability surface (#1160) ────────────────
//
// In an installed runtime (e.g. Codex) the commands/gsd source tree is absent.
// Only <configDir>/skills/gsd-*/SKILL.md files exist. Prior to this fix,
// loadSkillsManifest returned an empty map → resolveSurface materialized '*'
// to an empty Set → security.enabled=false / nyquist.enabled=false even when
// the project config had security_enforcement=true / nyquist_validation=true.
//
// These tests directly exercise the new _loadInstalledSkillsManifest and
// _resolveManifest functions with a non-existent commandsGsdDir path so they
// FAIL before the fix and PASS after, regardless of whether commands/gsd
// happens to exist in the current checkout.

describe('regressions: flat commands/gsd-<stem>.md layout (#1858)', () => {
  // Flat command layout (Claude local project install shape): skills live at
  // <repo>/commands/gsd-<stem>.md — the gsd- prefix is baked into the filename
  // and there is NO commands/gsd/ subdir. _resolveManifest must detect this
  // layout, strip the gsd- prefix, and produce the same stems the nested
  // loader (commands/gsd/<stem>.md) would, or every skill-bearing capability
  // is silently reported surfaced:false / enabled:false / active:false.
  function makeFlatCommandMd(stem, requires) {
    const req = requires ? `requires: [${requires.join(', ')}]` : 'requires: [phase]';
    return [
      '---',
      `name: gsd:${stem}`,
      `description: ${stem} skill`,
      'argument-hint: "[phase number]"',
      'allowed-tools:',
      '  - Read',
      req,
      '---',
      'Execute end-to-end.',
    ].join('\n') + '\n';
  }

  // ── Unit tests for _loadFlatCommandsGsdManifest ─────────────────────────────

  test('_loadFlatCommandsGsdManifest: returns empty map when parent dir absent', () => {
    const missing = path.join(os.tmpdir(), 'cap-flat-missing-' + Date.now());
    const manifest = _loadFlatCommandsGsdManifest(missing);
    assert.ok(manifest instanceof Map, 'should return a Map');
    assert.strictEqual(manifest.size, 0, 'should be empty when parent dir absent');
  });

  test('_loadFlatCommandsGsdManifest: scans gsd-<stem>.md and strips the gsd- prefix', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-flat-scan-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'gsd-validate-phase.md'), makeFlatCommandMd('validate-phase'), 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'gsd-secure-phase.md'), makeFlatCommandMd('secure-phase'), 'utf8');
      // Non-gsd file must be ignored
      fs.writeFileSync(path.join(tmpDir, 'random-doc.md'), '# not a skill\n', 'utf8');
      // Non-markdown gsd file must be ignored
      fs.writeFileSync(path.join(tmpDir, 'gsd-notskill.txt'), 'nope\n', 'utf8');

      const manifest = _loadFlatCommandsGsdManifest(tmpDir);
      assert.ok(manifest.has('validate-phase'), 'flat gsd-validate-phase.md -> stem validate-phase');
      assert.ok(manifest.has('secure-phase'), 'flat gsd-secure-phase.md -> stem secure-phase');
      assert.ok(!manifest.has('gsd-validate-phase'), 'must NOT keep the gsd- prefix on the stem');
      assert.ok(!manifest.has('random-doc'), 'non-gsd file must be ignored');
      assert.ok(!manifest.has('notskill'), 'non-.md gsd file must be ignored');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_loadFlatCommandsGsdManifest: parses requires via shared parseRequires (no drift)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-flat-req-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'gsd-my-skill.md'),
        makeFlatCommandMd('my-skill', ['dep-a', 'dep-b']),
        'utf8',
      );
      const manifest = _loadFlatCommandsGsdManifest(tmpDir);
      assert.deepStrictEqual(manifest.get('my-skill'), ['dep-a', 'dep-b']);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_loadFlatCommandsGsdManifest: companion _calls_agents_<stem> key present (parity with nested loader)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-flat-agents-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'gsd-validate-phase.md'), makeFlatCommandMd('validate-phase'), 'utf8');
      const manifest = _loadFlatCommandsGsdManifest(tmpDir);
      assert.ok(manifest.has('_calls_agents_validate-phase'),
        'flat loader must emit the companion _calls_agents_ key (same Map shape as loadSkillsManifest)');
    } finally {
      cleanup(tmpDir);
    }
  });

  // Low-1 (review): boundary — empty stem (gsd-.md) skipped, single-char stem kept.
  test('_loadFlatCommandsGsdManifest: skips gsd-.md (empty stem) and keeps single-char stem (slice boundary)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-flat-edge-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'gsd-.md'), makeFlatCommandMd(''), 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'gsd-x.md'), makeFlatCommandMd('x'), 'utf8');
      const manifest = _loadFlatCommandsGsdManifest(tmpDir);
      assert.ok(!manifest.has(''), 'gsd-.md must NOT register an empty-string stem');
      assert.ok(!manifest.has('_calls_agents_'), 'no companion key for an empty stem');
      assert.ok(manifest.has('x'), 'gsd-x.md -> single-char stem "x" (slice(4,-3) boundary)');
    } finally {
      cleanup(tmpDir);
    }
  });

  // Low-2 (review): unreadable file degrades both keys to [] (parity with nested
  // loader's catch). POSIX-only AND must not run as root — root bypasses POSIX
  // read permission bits, so chmod 0o000 would NOT make the file unreadable and
  // the test would assert [] against the real parsed deps (false failure).
  // Skip on win32 (DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT) and when getuid()==0.
  const _skipUnreadable = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
  test('_loadFlatCommandsGsdManifest: unreadable file degrades to empty deps + agents (parity)', { skip: _skipUnreadable }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-flat-unread-'));
    let madeUnreadable = false;
    try {
      const skillPath = path.join(tmpDir, 'gsd-secure.md');
      fs.writeFileSync(skillPath, '---\nname: gsd:secure\nrequires: [phase]\n---\nbody\n', { mode: 0o644 });
      fs.chmodSync(skillPath, 0o000);
      madeUnreadable = true;
      const manifest = _loadFlatCommandsGsdManifest(tmpDir);
      assert.deepStrictEqual(manifest.get('secure'), [], 'unreadable file -> empty requires (parity with nested catch)');
      assert.deepStrictEqual(manifest.get('_calls_agents_secure'), [], 'unreadable file -> empty agents (parity with nested catch)');
    } finally {
      // Restore writability so cleanup() can rm the tmp tree.
      if (madeUnreadable) {
        try { fs.chmodSync(path.join(tmpDir, 'gsd-secure.md'), 0o644); } catch { /* best effort */ }
      }
      cleanup(tmpDir);
    }
  });

  // ── _resolveManifest picks the flat branch when nested is absent ────────────

  test('_resolveManifest: detects flat commands/gsd-<stem>.md layout when nested commands/gsd/ is absent (#1858)', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-flat-repo-'));
    try {
      // Flat source layout: <repo>/commands/gsd-<stem>.md
      // NO commands/gsd/ subdir, NO skills/ dir.
      const commandsDir = path.join(tmpRepo, 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, 'gsd-validate-phase.md'), makeFlatCommandMd('validate-phase'), 'utf8');
      fs.writeFileSync(path.join(commandsDir, 'gsd-secure-phase.md'), makeFlatCommandMd('secure-phase'), 'utf8');

      // commandsGsdDir = <repo>/commands/gsd (nested — does NOT exist).
      // dirname(commandsGsdDir) = <repo>/commands (where the flat files live).
      const commandsGsdDir = path.join(commandsDir, 'gsd');
      // configDir = a separate empty tmp dir (no skills/ → installed fallback empty).
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-flat-cfg-'));
      try {
        const manifest = _resolveManifest(commandsGsdDir, configDir);
        assert.ok(manifest.has('validate-phase'),
          'flat layout must populate validate-phase stem (was empty pre-fix → all skill caps unsurfaced)');
        assert.ok(manifest.has('secure-phase'), 'flat layout must populate secure-phase stem');
        assert.ok(!manifest.has('gsd-validate-phase'), 'stem must have gsd- prefix stripped');
      } finally {
        cleanup(configDir);
      }
    } finally {
      cleanup(tmpRepo);
    }
  });

  test('_resolveManifest: flat branch does NOT shadow a populated installed skills dir when no flat files exist', () => {
    // Precedence: nested > flat-source > installed. If the flat parent dir has
    // NO gsd-*.md files, the flat loader returns an empty Map and _resolveManifest
    // must fall through to the installed-skills branch (not return empty).
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-precedence-'));
    try {
      const commandsDir = path.join(tmpRepo, 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      // No gsd-*.md files in commands/ — flat loader yields empty.
      // Installed skills present under configDir:
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-precedence-cfg-'));
      try {
        const secureDir = path.join(configDir, 'skills', 'gsd-secure-phase');
        fs.mkdirSync(secureDir, { recursive: true });
        fs.writeFileSync(path.join(secureDir, 'SKILL.md'),
          '---\nname: gsd:secure-phase\nrequires: [phase]\n---\nbody\n', 'utf8');

        const commandsGsdDir = path.join(commandsDir, 'gsd'); // nested absent
        const manifest = _resolveManifest(commandsGsdDir, configDir);
        assert.ok(manifest.has('secure-phase'),
          'when flat dir is empty, installed-skills fallback must still work (precedence flat > installed only when flat non-empty)');
      } finally {
        cleanup(configDir);
      }
    } finally {
      cleanup(tmpRepo);
    }
  });

  // ── Parity: flat loader produces the same stems as the nested loader ────────
  // (DEFECT.GENERATIVE-FIX — guards against silent divergence between the two
  // parallel manifest-builders.)

  test('flat loader and nested loader produce identical stems for the same command set (parity)', () => {
    const realCommandsGsdDir = path.resolve(__dirname, '..', 'commands', 'gsd');
    if (!fs.existsSync(realCommandsGsdDir)) return; // skip outside a repo checkout
    // Build a flat mirror of the real nested commands/gsd/<stem>.md as
    // commands/gsd-<stem>.md in a temp dir, then compare stem sets.
    const tmpFlat = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-parity-flat-'));
    try {
      const nested = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(realCommandsGsdDir);
      for (const [stem] of nested) {
        if (stem.startsWith('_calls_agents_')) continue;
        const src = path.join(realCommandsGsdDir, stem + '.md');
        if (!fs.existsSync(src)) continue;
        fs.writeFileSync(path.join(tmpFlat, 'gsd-' + stem + '.md'), fs.readFileSync(src, 'utf8'), 'utf8');
      }
      const flat = _loadFlatCommandsGsdManifest(tmpFlat);
      const nestedStems = [...nested.keys()].filter((k) => !k.startsWith('_calls_agents_')).sort();
      const flatStems = [...flat.keys()].filter((k) => !k.startsWith('_calls_agents_')).sort();
      assert.deepStrictEqual(flatStems, nestedStems,
        'flat loader stem set must match nested loader stem set for the real command tree');
      // Nit-2 (review): also compare _calls_agents_<stem> VALUES, not just the
      // stem set — proves the shared parseCallsAgents output is identical.
      for (const stem of flatStems) {
        assert.deepStrictEqual(flat.get(`_calls_agents_${stem}`), nested.get(`_calls_agents_${stem}`),
          `agent refs for stem "${stem}" must match between flat and nested loaders`);
        assert.deepStrictEqual(flat.get(stem), nested.get(stem),
          `requires for stem "${stem}" must match between flat and nested loaders`);
      }
    } finally {
      cleanup(tmpFlat);
    }
  });
});

describe('regressions: installed-runtime capability surface (#1160)', () => {
  // Minimal valid SKILL.md content (frontmatter only — matches what install emits)
  function makeSkillMd(stem) {
    return [
      '---',
      `name: gsd:${stem}`,
      `description: ${stem} skill`,
      'argument-hint: "[phase number]"',
      'allowed-tools:',
      '  - Read',
      'requires: [phase]',
      '---',
      'Execute end-to-end.',
    ].join('\n') + '\n';
  }

  // ── Unit tests for _loadInstalledSkillsManifest ──────────────────────────────

  test('_loadInstalledSkillsManifest: returns empty map when skills dir absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ism-empty-'));
    try {
      const manifest = _loadInstalledSkillsManifest(tmpDir);
      assert.ok(manifest instanceof Map, 'should return a Map');
      assert.strictEqual(manifest.size, 0, 'should be empty when no skills/ dir');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_loadInstalledSkillsManifest: scans gsd-<stem>/SKILL.md dirs and produces stems', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ism-scan-'));
    try {
      // Create installed skill dirs
      const secureDir = path.join(tmpDir, 'skills', 'gsd-secure-phase');
      const validateDir = path.join(tmpDir, 'skills', 'gsd-validate-phase');
      fs.mkdirSync(secureDir, { recursive: true });
      fs.mkdirSync(validateDir, { recursive: true });
      fs.writeFileSync(path.join(secureDir, 'SKILL.md'), makeSkillMd('secure-phase'), 'utf8');
      fs.writeFileSync(path.join(validateDir, 'SKILL.md'), makeSkillMd('validate-phase'), 'utf8');
      // Add a non-gsd- dir that should be ignored
      fs.mkdirSync(path.join(tmpDir, 'skills', 'user-custom'), { recursive: true });

      const manifest = _loadInstalledSkillsManifest(tmpDir);
      assert.ok(manifest instanceof Map);
      assert.ok(manifest.has('secure-phase'), 'should have secure-phase stem');
      assert.ok(manifest.has('validate-phase'), 'should have validate-phase stem');
      assert.ok(!manifest.has('user-custom'), 'non-gsd- dir must not appear');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_loadInstalledSkillsManifest: parses requires from SKILL.md frontmatter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ism-req-'));
    try {
      const skillDir = path.join(tmpDir, 'skills', 'gsd-my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: gsd:my-skill\nrequires: [dep-a, dep-b]\n---\nbody\n',
        'utf8',
      );
      const manifest = _loadInstalledSkillsManifest(tmpDir);
      assert.deepStrictEqual(manifest.get('my-skill'), ['dep-a', 'dep-b']);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_loadInstalledSkillsManifest: directory with no SKILL.md is NOT registered (parity with loadSkillsManifest)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ism-nodoc-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'skills', 'gsd-nodoc'), { recursive: true });
      // No SKILL.md written — a stale/empty skill dir must not invent a stem,
      // mirroring loadSkillsManifest which only registers stems for files that exist.
      const manifest = _loadInstalledSkillsManifest(tmpDir);
      assert.ok(!manifest.has('nodoc'), 'stem must NOT be registered when SKILL.md is absent');
      assert.ok(!manifest.has('_calls_agents_nodoc'), 'companion agents key must also be absent');
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── Unit tests for _resolveManifest ─────────────────────────────────────────

  test('_resolveManifest: uses commandsGsdDir when it exists', () => {
    const realCommandsGsdDir = path.resolve(__dirname, '..', 'commands', 'gsd');
    if (!fs.existsSync(realCommandsGsdDir)) {
      // Skip if not in a repo checkout
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-src-'));
    try {
      // No skills/ dir — if _resolveManifest uses source, it returns real skills
      const manifest = _resolveManifest(realCommandsGsdDir, tmpDir);
      assert.ok(manifest instanceof Map);
      // The real commands/gsd has many skills; manifest should be non-empty
      assert.ok(manifest.size > 0, 'should load skills from real source dir');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('_resolveManifest: falls back to installed skills when commandsGsdDir absent', () => {
    const nonExistentDir = path.join(os.tmpdir(), 'cap-rm-nonexistent-' + Date.now());
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rm-installed-'));
    try {
      // Create installed skill layout under tmpDir
      const secureDir = path.join(tmpDir, 'skills', 'gsd-secure-phase');
      const validateDir = path.join(tmpDir, 'skills', 'gsd-validate-phase');
      fs.mkdirSync(secureDir, { recursive: true });
      fs.mkdirSync(validateDir, { recursive: true });
      fs.writeFileSync(path.join(secureDir, 'SKILL.md'), makeSkillMd('secure-phase'), 'utf8');
      fs.writeFileSync(path.join(validateDir, 'SKILL.md'), makeSkillMd('validate-phase'), 'utf8');

      const manifest = _resolveManifest(nonExistentDir, tmpDir);
      assert.ok(manifest instanceof Map);
      assert.ok(manifest.has('secure-phase'), 'must have secure-phase from installed skills');
      assert.ok(manifest.has('validate-phase'), 'must have validate-phase from installed skills');
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── Integration tests: capability state with installed-layout config dir ────
  // These tests use a config dir that has NO .gsd-source and where _resolveCommandsGsdDir
  // would return the real repo path. To force the installed-path, we call
  // resolveCapabilityState directly with manifests derived from _resolveManifest
  // using a non-existent commandsGsdDir.

  test('resolveCapabilityState: security enabled when secure-phase in installedSkills+surfacedSkills', () => {
    const securitySkills = ['secure-phase'];
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: new Set(securitySkills),
      surfacedSkills: new Set(securitySkills),
      config: { workflow: { security_enforcement: true } },
    });
    const secCap = result.capabilities.find((c) => c.id === 'security');
    assert.ok(secCap, 'security capability must be present');
    assert.strictEqual(secCap.installed, true, 'secure-phase in installedSkills → installed');
    assert.strictEqual(secCap.surfaced, true, 'secure-phase in surfacedSkills → surfaced');
    assert.strictEqual(secCap.enabled, true, 'installed+surfaced → enabled');
  });

  test('resolveCapabilityState: security NOT enabled when surfacedSkills empty (pre-fix scenario)', () => {
    // Simulates the pre-fix behavior: manifest empty → surface materializes to empty Set
    const result = resolveCapabilityState({
      registry: realRegistry,
      installedSkills: '*', // full profile → installed=true
      surfacedSkills: new Set(), // empty set (what empty manifest causes)
      config: { workflow: { security_enforcement: true } },
    });
    const secCap = result.capabilities.find((c) => c.id === 'security');
    assert.ok(secCap, 'security capability must be present');
    assert.strictEqual(secCap.installed, true);
    assert.strictEqual(secCap.surfaced, false, 'empty surfacedSkills → surfaced=false (pre-fix bug)');
    assert.strictEqual(secCap.enabled, false, 'surfaced=false → enabled=false (pre-fix bug)');
  });

  // ── End-to-end CLI tests: capability state + loop render-hooks ───────────────

  describe('end-to-end CLI with installed skill layout', () => {
    let tmpInstalledConfigDir;
    let tmpInstalledProjectDir;

    before(() => {
      tmpInstalledConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-installed-'));
      fs.writeFileSync(path.join(tmpInstalledConfigDir, '.gsd-profile'), 'full\n', 'utf8');
      const secureDir = path.join(tmpInstalledConfigDir, 'skills', 'gsd-secure-phase');
      const validateDir = path.join(tmpInstalledConfigDir, 'skills', 'gsd-validate-phase');
      fs.mkdirSync(secureDir, { recursive: true });
      fs.mkdirSync(validateDir, { recursive: true });
      fs.writeFileSync(path.join(secureDir, 'SKILL.md'), makeSkillMd('secure-phase'), 'utf8');
      fs.writeFileSync(path.join(validateDir, 'SKILL.md'), makeSkillMd('validate-phase'), 'utf8');

      tmpInstalledProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-installed-proj-'));
      fs.mkdirSync(path.join(tmpInstalledProjectDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpInstalledProjectDir, '.planning', 'config.json'),
        JSON.stringify({ workflow: { security_enforcement: true, nyquist_validation: true } }),
        'utf8',
      );
    });

    after(() => {
      cleanup(tmpInstalledConfigDir);
      cleanup(tmpInstalledProjectDir);
    });

    test('security capability: enabled=true in installed runtime with security_enforcement=true', () => {
      const result = runCapabilityState(tmpInstalledProjectDir, tmpInstalledConfigDir);
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout);
      const secCap = envelope.capabilities.find((c) => c.id === 'security');
      assert.ok(secCap, 'security capability must be present in output');
      assert.strictEqual(secCap.installed, true, 'security skill secure-phase is installed');
      assert.strictEqual(secCap.surfaced, true, 'security skill secure-phase is surfaced (full profile)');
      assert.strictEqual(secCap.enabled, true, 'security capability must be enabled');
    });

    test('nyquist capability: enabled=true in installed runtime with nyquist_validation=true', () => {
      const result = runCapabilityState(tmpInstalledProjectDir, tmpInstalledConfigDir);
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout);
      const nyqCap = envelope.capabilities.find((c) => c.id === 'nyquist');
      assert.ok(nyqCap, 'nyquist capability must be present in output');
      assert.strictEqual(nyqCap.installed, true, 'nyquist skill validate-phase is installed');
      assert.strictEqual(nyqCap.surfaced, true, 'nyquist skill validate-phase is surfaced (full profile)');
      assert.strictEqual(nyqCap.enabled, true, 'nyquist capability must be enabled');
    });

    test('security hook at verify:post is active in installed runtime', () => {
      const result = spawnSync(
        process.execPath,
        [
          gsdToolsPath,
          'loop', 'render-hooks', 'verify:post',
          '--config-dir', tmpInstalledConfigDir,
          '--cwd', tmpInstalledProjectDir,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.point, 'verify:post');
      assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
      const securityHook = envelope.activeHooks.find(
        (h) => h.capId === 'security' && h.kind === 'step',
      );
      assert.ok(
        securityHook,
        'verify:post must include security step hook when security_enforcement=true. Got: ' +
          JSON.stringify(envelope.activeHooks),
      );
      assert.ok(
        securityHook.ref && securityHook.ref.skill === 'secure-phase',
        'security hook ref.skill must be secure-phase',
      );
    });

    test('nyquist hook at verify:post is active in installed runtime', () => {
      const result = spawnSync(
        process.execPath,
        [
          gsdToolsPath,
          'loop', 'render-hooks', 'verify:post',
          '--config-dir', tmpInstalledConfigDir,
          '--cwd', tmpInstalledProjectDir,
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      const nyquistHook = envelope.activeHooks.find(
        (h) => h.capId === 'nyquist' && h.kind === 'step',
      );
      assert.ok(
        nyquistHook,
        'verify:post must include nyquist step hook when nyquist_validation=true. Got: ' +
          JSON.stringify(envelope.activeHooks),
      );
      assert.ok(
        nyquistHook.ref && nyquistHook.ref.skill === 'validate-phase',
        'nyquist hook ref.skill must be validate-phase',
      );
    });
  });

  // ── TRUE installed-runtime layout: gsd-tools runs where commands/gsd is unreachable ──
  // The block above runs the repo's gsd-tools.cjs, where commands/gsd source IS
  // reachable by walk-up, so it cannot exercise the bug. This block copies the
  // runtime executable tree (gsd-core/bin + scripts + package.json) into a temp
  // install root that has NO commands/ sibling — faithfully reproducing a global
  // skills-runtime install (e.g. Codex at ~/.codex). There, the source manifest
  // is genuinely empty, so pre-fix the '*' profile materialized to an empty
  // surfaced set → enabled=false → verify:post activeHooks: []. This test FAILS
  // before the fix and PASSES after.
  describe('true installed layout (commands/gsd unreachable)', () => {
    let installRoot;
    let installedConfigDir;
    let installedProjectDir;
    let installedGsdTools;

    before(() => {
      const repoRoot = path.resolve(__dirname, '..');
      // 1. Faithful install root: copy the executable runtime WITHOUT commands/.
      installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-installroot-'));
      fs.mkdirSync(path.join(installRoot, 'gsd-core'), { recursive: true });
      fs.cpSync(
        path.join(repoRoot, 'gsd-core', 'bin'),
        path.join(installRoot, 'gsd-core', 'bin'),
        { recursive: true },
      );
      fs.cpSync(
        path.join(repoRoot, 'scripts'),
        path.join(installRoot, 'scripts'),
        { recursive: true },
      );
      fs.copyFileSync(
        path.join(repoRoot, 'package.json'),
        path.join(installRoot, 'package.json'),
      );
      installedGsdTools = path.join(installRoot, 'gsd-core', 'bin', 'gsd-tools.cjs');

      // 2. Installed runtime config dir: full profile + skills/gsd-*/SKILL.md only.
      installedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-instcfg-'));
      fs.writeFileSync(path.join(installedConfigDir, '.gsd-profile'), 'full\n', 'utf8');
      for (const stem of ['secure-phase', 'validate-phase']) {
        const skillDir = path.join(installedConfigDir, 'skills', `gsd-${stem}`);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), makeSkillMd(stem), 'utf8');
      }

      // 3. Project enabling both gates.
      installedProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-instproj-'));
      fs.mkdirSync(path.join(installedProjectDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(installedProjectDir, '.planning', 'config.json'),
        JSON.stringify({ workflow: { security_enforcement: true, nyquist_validation: true } }),
        'utf8',
      );
    });

    after(() => {
      cleanup(installRoot);
      cleanup(installedConfigDir);
      cleanup(installedProjectDir);
    });

    test('commands/gsd is genuinely unreachable from the installed gsd-tools', () => {
      // Sanity: no commands/gsd anywhere under the install root.
      const probe = path.join(installRoot, 'commands', 'gsd');
      assert.strictEqual(fs.existsSync(probe), false, 'install root must have no commands/gsd');
    });

    test('capability state: security & nyquist enabled in true installed runtime', () => {
      const result = spawnSync(
        process.execPath,
        [
          installedGsdTools,
          'capability', 'state',
          '--config-dir', installedConfigDir,
          '--cwd', installedProjectDir,
          '--raw',
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout);
      const secCap = envelope.capabilities.find((c) => c.id === 'security');
      const nyqCap = envelope.capabilities.find((c) => c.id === 'nyquist');
      assert.ok(secCap && nyqCap, 'security and nyquist capabilities must be present');
      assert.strictEqual(secCap.surfaced, true, 'security surfaced from installed skills (pre-fix: false)');
      assert.strictEqual(secCap.enabled, true, 'security enabled in installed runtime (pre-fix: false)');
      assert.strictEqual(nyqCap.surfaced, true, 'nyquist surfaced from installed skills (pre-fix: false)');
      assert.strictEqual(nyqCap.enabled, true, 'nyquist enabled in installed runtime (pre-fix: false)');
    });

    test('loop render-hooks verify:post: includes security & nyquist in true installed runtime', () => {
      const result = spawnSync(
        process.execPath,
        [
          installedGsdTools,
          'loop', 'render-hooks', 'verify:post',
          '--config-dir', installedConfigDir,
          '--cwd', installedProjectDir,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.point, 'verify:post');
      assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
      const sec = envelope.activeHooks.find((h) => h.capId === 'security' && h.kind === 'step');
      const nyq = envelope.activeHooks.find((h) => h.capId === 'nyquist' && h.kind === 'step');
      assert.ok(
        sec && sec.ref && sec.ref.skill === 'secure-phase',
        'verify:post must include security -> secure-phase (pre-fix: activeHooks was []). Got: ' + JSON.stringify(envelope.activeHooks),
      );
      assert.ok(
        nyq && nyq.ref && nyq.ref.skill === 'validate-phase',
        'verify:post must include nyquist -> validate-phase (pre-fix: activeHooks was []). Got: ' + JSON.stringify(envelope.activeHooks),
      );
    });

    test('negative: when both gates disabled, hooks stay inactive (no over-activation)', () => {
      const disabledProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-instproj-off-'));
      try {
        fs.mkdirSync(path.join(disabledProj, '.planning'), { recursive: true });
        fs.writeFileSync(
          path.join(disabledProj, '.planning', 'config.json'),
          JSON.stringify({ workflow: { security_enforcement: false, nyquist_validation: false } }),
          'utf8',
        );
        const result = spawnSync(
          process.execPath,
          [
            installedGsdTools,
            'loop', 'render-hooks', 'verify:post',
            '--config-dir', installedConfigDir,
            '--cwd', disabledProj,
          ],
          { encoding: 'utf8', timeout: 20000 },
        );
        assert.strictEqual(result.status, 0, `gsd-tools exited ${result.status}:\nstderr: ${result.stderr}`);
        const envelope = JSON.parse(result.stdout.trim());
        const sec = (envelope.activeHooks || []).find((h) => h.capId === 'security' && h.kind === 'step');
        const nyq = (envelope.activeHooks || []).find((h) => h.capId === 'nyquist' && h.kind === 'step');
        assert.ok(!sec, 'security step must NOT be active when security_enforcement=false');
        assert.ok(!nyq, 'nyquist step must NOT be active when nyquist_validation=false');
      } finally {
        cleanup(disabledProj);
      }
    });
  });

});

// ─── resolveCapabilityState — per-capability active field ────────────────────

describe('resolveCapabilityState — per-capability active (Phase 2)', () => {
  // Boundary: installed && surfaced && config-enabled → active=true
  test('active=true when installed && surfaced && activationKey resolves true', () => {
    const registry = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      configSchema: { 'myfeature.enabled': { default: false } },
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: true } },
    });
    const cap = result.capabilities[0];
    assert.ok(cap, 'capability must be present');
    assert.strictEqual(cap.installed, true);
    assert.strictEqual(cap.surfaced, true);
    assert.strictEqual(cap.enabled, true, 'enabled = installed && surfaced (unchanged)');
    assert.strictEqual(cap.active, true, 'active = enabled && config-enabled');
  });

  // Boundary: installed && surfaced && config-DISABLED → active=false (the key case)
  test('active=false when installed && surfaced but activationKey resolves false', () => {
    const registry = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      configSchema: { 'myfeature.enabled': { default: false } },
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: false } },
    });
    const cap = result.capabilities[0];
    assert.ok(cap);
    assert.strictEqual(cap.enabled, true, 'enabled still true: installed && surfaced unchanged');
    assert.strictEqual(cap.active, false, 'active=false: config gate is off');
  });

  // Boundary: config-enabled but NOT surfaced → active=false
  test('active=false when config-enabled but not surfaced (enabled=false)', () => {
    const registry = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(), // NOT surfaced
      config: { myfeature: { enabled: true } },
    });
    const cap = result.capabilities[0];
    assert.ok(cap);
    assert.strictEqual(cap.surfaced, false);
    assert.strictEqual(cap.enabled, false, 'enabled=false: not surfaced');
    assert.strictEqual(cap.active, false, 'active=false: enabled is false');
  });

  // Boundary: NOT installed → active=false regardless of config
  test('active=false when not installed (installed=false)', () => {
    const registry = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
    });
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(), // NOT installed
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: true } },
    });
    const cap = result.capabilities[0];
    assert.ok(cap);
    assert.strictEqual(cap.installed, false);
    assert.strictEqual(cap.enabled, false);
    assert.strictEqual(cap.active, false, 'active=false: not installed');
  });

  // Boundary: no activationKey → active === enabled (no config gate)
  test('active=enabled when capability has no activationKey', () => {
    // No activationKey: configActivation defaults to true so active = enabled
    const registry = makeRegistry({
      skills: ['my-skill'],
      // No activationKey
    });
    // installed && surfaced → enabled=true → active=true
    const resultEnabled = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: {},
    });
    const capEnabled = resultEnabled.capabilities[0];
    assert.ok(capEnabled);
    assert.strictEqual(capEnabled.enabled, true);
    assert.strictEqual(capEnabled.active, true, 'active=true when no activationKey and enabled');

    // NOT surfaced → enabled=false → active=false
    const resultDisabled = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(), // not surfaced
      config: {},
    });
    const capDisabled = resultDisabled.capabilities[0];
    assert.ok(capDisabled);
    assert.strictEqual(capDisabled.enabled, false);
    assert.strictEqual(capDisabled.active, false, 'active=false when no activationKey and not enabled');
  });

  // enabled field semantics unchanged: still installed && surfaced only
  test('enabled stays installed && surfaced regardless of activationKey', () => {
    const registry = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
    });
    // installed && surfaced but config disables it
    const result = resolveCapabilityState({
      registry,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: { myfeature: { enabled: false } },
    });
    const cap = result.capabilities[0];
    assert.ok(cap);
    // enabled must still be true (installed && surfaced — config doesn't affect it)
    assert.strictEqual(cap.enabled, true, 'enabled = installed && surfaced (config does not affect enabled)');
    assert.strictEqual(cap.active, false, 'active reflects config gate');
  });

  // activationKey defaults to schema default when key absent from config
  test('active uses schema default when activationKey not in config', () => {
    // schema default = true → active=true when enabled
    const registryDefaultTrue = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      configSchema: { 'myfeature.enabled': { default: true } },
    });
    const resultTrue = resolveCapabilityState({
      registry: registryDefaultTrue,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: {}, // no explicit key
    });
    assert.strictEqual(resultTrue.capabilities[0].active, true, 'active=true when schema default=true');

    // schema default = false → active=false when enabled
    const registryDefaultFalse = makeRegistry({
      skills: ['my-skill'],
      activationKey: 'myfeature.enabled',
      configSchema: { 'myfeature.enabled': { default: false } },
    });
    const resultFalse = resolveCapabilityState({
      registry: registryDefaultFalse,
      installedSkills: new Set(['my-skill']),
      surfacedSkills: new Set(['my-skill']),
      config: {}, // no explicit key
    });
    assert.strictEqual(resultFalse.capabilities[0].active, false, 'active=false when schema default=false');
  });
});

// ─── isCapabilityActive convenience predicate ─────────────────────────────────

describe('isCapabilityActive — convenience predicate (Phase 2)', () => {
  // isCapabilityActive delegates to resolveCapabilityRuntimeState which does I/O.
  // We test it via the CLI+tmpDir path used by the existing e2e tests above, and
  // a pure-function boundary test that forces a known-missing capability id.

  test('returns false for unknown capId (not in registry)', () => {
    // We can't easily inject the registry into resolveCapabilityRuntimeState
    // without a cwd that has been set up. Instead, probe a capability id that
    // is guaranteed to never appear in the real registry.
    // We use a non-existent cwd so resolveCapabilityRuntimeState degrades
    // gracefully (installedSkills/surfacedSkills → empty → all disabled) but
    // still returns a capabilities array from the real registry.
    // Any truly-unknown capId must return false regardless.
    const nonExistentCwd = path.join(os.tmpdir(), 'cap-active-nonexistent-' + Date.now());
    const result = isCapabilityActive('__definitely_not_a_capability__', nonExistentCwd);
    assert.strictEqual(result, false, 'unknown capId must return false');
  });

  test('isCapabilityActive returns same value as the entry active field (e2e)', () => {
    // Use a non-existent cwd so resolveCapabilityRuntimeState degrades gracefully.
    // resolveCapabilityRuntimeState and isCapabilityActive both resolve against
    // the SAME runtime environment: we compare isCapabilityActive(capId, cwd)
    // to the matching entry's .active from resolveCapabilityRuntimeState(cwd, undefined)
    // called on the identical cwd. This guarantees a real equality check — not typeof.
    //
    // We need resolveCapabilityRuntimeState for the comparison; require it here
    // since it is exported from the same module.
    const { resolveCapabilityRuntimeState } = require('../gsd-core/bin/lib/capability-state.cjs');

    const nonExistentCwd = path.join(os.tmpdir(), 'cap-active-eq-' + Date.now());

    // Pick a capability that exists in the real registry ('ui' is always present).
    const capId = 'ui';

    // resolveCapabilityRuntimeState resolves state from the real environment.
    const runtimeResult = resolveCapabilityRuntimeState(nonExistentCwd, undefined);
    const entry = runtimeResult.capabilities.find((c) => c.id === capId);
    assert.ok(entry, `'${capId}' must be present in the real registry`);

    // isCapabilityActive must return exactly the same boolean as the resolved entry.
    const actual = isCapabilityActive(capId, nonExistentCwd);
    assert.strictEqual(
      actual,
      entry.active,
      `isCapabilityActive('${capId}') must equal entry.active=${entry.active} from resolveCapabilityRuntimeState`,
    );

    // Also verify the already-covered false case for unknown capId:
    assert.strictEqual(isCapabilityActive('__no_such_cap__', nonExistentCwd), false);
  });
});

// ─── resolveCapabilityRuntimeState configOverride (FIX 1 — single config snapshot) ──────────────

describe('resolveCapabilityRuntimeState configOverride — honors caller snapshot instead of reading disk', () => {
  // These tests exercise the optional third parameter `configOverride`.
  // When provided, the resolver MUST use that config object for capability
  // activation (active = enabled && configActivation) rather than calling
  // loadConfig(cwd) internally. This guarantees that cmdLoopRenderHooks and
  // the resolver use the exact same config snapshot (TOCTOU elimination).
  //
  // Strategy: build a synthetic registry with `activationKey: 'myfeature.enabled'`
  // and use a tmpdir whose on-disk .planning/config.json carries the OPPOSITE
  // value from the configOverride. The test asserts that the returned capability
  // `active` matches the override, not the on-disk file.

  const { resolveCapabilityRuntimeState } = require('../gsd-core/bin/lib/capability-state.cjs');

  let tmpDir;
  let savedEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-override-'));
    // Save env vars that affect planningDir / config resolution
    savedEnv = {
      GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
      GSD_PROJECT: process.env.GSD_PROJECT,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.CLAUDE_CONFIG_DIR;

    // Write on-disk config with myfeature.enabled=false (override will say true)
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ myfeature: { enabled: false } }),
      'utf8',
    );
  });

  after(() => {
    // Restore env vars
    if (savedEnv.GSD_WORKSTREAM !== undefined) process.env.GSD_WORKSTREAM = savedEnv.GSD_WORKSTREAM;
    else delete process.env.GSD_WORKSTREAM;
    if (savedEnv.GSD_PROJECT !== undefined) process.env.GSD_PROJECT = savedEnv.GSD_PROJECT;
    else delete process.env.GSD_PROJECT;
    if (savedEnv.CLAUDE_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
    else delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmpDir);
  });

  test('configOverride=undefined (default) reads on-disk config → active=false', () => {
    // Baseline: without override, loadConfig reads the on-disk file which has
    // myfeature.enabled=false, so the capability is inactive.
    // NOTE: resolveCapabilityRuntimeState does real I/O (profile/surface), which
    // degrades gracefully on a tmpDir that has no surface marker. We only assert
    // on the `active` field which is determined by the config activation leg.
    // Use a simple registry with no skills so installed=surfaced=enabled=true
    // (vacuously) and active depends solely on configActivation.
    //
    // Because resolveCapabilityRuntimeState always uses the real capability-registry.cjs,
    // we cannot inject the synthetic registry into it. Instead we verify the
    // config-override leg by comparing the two code paths (with and without override)
    // against each other on a known config key that the real registry uses.
    //
    // We use the real 'graphify' capability whose activationKey='graphify.enabled'.
    // On-disk: graphify.enabled=false → active=false.
    // Override: { graphify: { enabled: true } } → active=true.
    //
    // Set up a separate tmpdir with graphify.enabled=false on disk.
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-override-baseline-'));
    try {
      fs.mkdirSync(path.join(tmpCwd, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpCwd, '.planning', 'config.json'),
        JSON.stringify({ graphify: { enabled: false } }),
        'utf8',
      );
      // No override → reads on-disk config → graphify active=false
      const result = resolveCapabilityRuntimeState(tmpCwd, undefined);
      const graphifyEntry = result.capabilities.find((c) => c.id === 'graphify');
      assert.ok(graphifyEntry, 'graphify capability must be present in the real registry');
      assert.strictEqual(
        graphifyEntry.active,
        false,
        'Without configOverride, on-disk graphify.enabled=false must produce active=false',
      );
    } finally {
      cleanup(tmpCwd);
    }
  });

  test('configOverride honors caller value — overrides on-disk config (active flips from false to true)', () => {
    // On-disk: graphify.enabled=false (set up in before()).
    // configOverride: { graphify: { enabled: true } }  ← caller wins.
    // Expected: graphify active=true (override, not disk).
    //
    // The tmpDir from before() has graphify.enabled=false on disk. We pass
    // configOverride with graphify.enabled=true. The returned active must be true.
    const override = { graphify: { enabled: true } };
    const result = resolveCapabilityRuntimeState(tmpDir, undefined, override);
    const graphifyEntry = result.capabilities.find((c) => c.id === 'graphify');
    assert.ok(graphifyEntry, 'graphify capability must be present in the real registry');
    assert.strictEqual(
      graphifyEntry.active,
      true,
      'configOverride { graphify: { enabled: true } } must produce active=true even though on-disk config has graphify.enabled=false',
    );
  });

  test('configOverride — non-existent cwd, override with enabled=true → active=true regardless of absent disk file', () => {
    // When cwd points to a non-existent directory, loadConfig(cwd) would return {}
    // (or throw/fallback to {}). With configOverride, the caller's value is used
    // for level-1 directly. Levels 2+3 raw reads on a non-existent cwd produce
    // no-hits. So: override={graphify:{enabled:true}} → level-1 hit → active=true.
    // This is a clean test that avoids any interaction with the on-disk fixture in tmpDir.
    const nonExistentCwd = path.join(os.tmpdir(), 'cap-override-nonexistent-' + Date.now());
    const override = { graphify: { enabled: true } };
    const result = resolveCapabilityRuntimeState(nonExistentCwd, undefined, override);
    const graphifyEntry = result.capabilities.find((c) => c.id === 'graphify');
    assert.ok(graphifyEntry, 'graphify capability must be present in the real registry');
    assert.strictEqual(
      graphifyEntry.active,
      true,
      'configOverride { graphify: { enabled: true } } must produce active=true even with non-existent cwd (level-1 hit from override)',
    );
  });
});

// ─── Cross-runtime runtime detection (HIGH fix — GSD_RUNTIME → config.runtime → 'claude') ──────

describe('isCapabilityActive cross-runtime detection (GSD_RUNTIME → config.runtime → claude)', () => {
  // Verifies the HIGH bug fix: when GSD_RUNTIME='codex', resolveCapabilityRuntimeState
  // must consult the CODEX config dir (via CODEX_HOME), not ~/.claude.
  //
  // Fixture layout:
  //   CODEX_HOME        → tmpCodexDir/   ← .gsd-surface.json: full profile, graphify SURFACED
  //   CLAUDE_CONFIG_DIR → tmpClaudeDir/ ← .gsd-surface.json: full profile, graphify NOT surfaced
  //   GSD_RUNTIME=codex
  //   project cwd       → tmpProjectDir/ ← config.json: graphify.enabled=true
  //                       (config leg must pass; SURFACE leg is what we are isolating)
  //
  // Expected: isCapabilityActive('graphify', cwd) === true
  //   (codex dir has graphify surfaced, so the codex surface should win)
  //
  // Pre-fix (hardcoded 'claude'): would read tmpClaudeDir → graphify NOT surfaced → false (BUG).
  // Post-fix (detects 'codex' via GSD_RUNTIME): reads tmpCodexDir → surfaced → true (CORRECT).

  let tmpCodexDir;
  let tmpClaudeDir;
  let tmpProjectDir;
  let prevGsdRuntime;
  let prevCodexHome;
  let prevClaudeConfigDir;
  let prevGsdWorkstream;
  let prevGsdProject;

  before(() => {
    tmpCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-codex-cfg-'));
    tmpClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-claude-cfg-'));
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-xrt-project-'));

    // Codex config dir: full profile + graphify SURFACED (disabledClusters empty)
    fs.writeFileSync(
      path.join(tmpCodexDir, '.gsd-surface.json'),
      JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
      'utf8',
    );

    // Claude config dir: full profile + graphify NOT surfaced
    fs.writeFileSync(
      path.join(tmpClaudeDir, '.gsd-surface.json'),
      JSON.stringify({ baseProfile: 'full', disabledClusters: ['graphify'], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
      'utf8',
    );

    // Project: config with graphify.enabled=true so the config leg passes.
    // The SURFACE leg (install+surfaced) is what we are testing — it must read
    // the CODEX config dir (via CODEX_HOME), not the CLAUDE config dir.
    fs.mkdirSync(path.join(tmpProjectDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProjectDir, '.planning', 'config.json'),
      JSON.stringify({ graphify: { enabled: true } }),
      'utf8',
    );
  });

  after(() => {
    cleanup(tmpCodexDir);
    cleanup(tmpClaudeDir);
    cleanup(tmpProjectDir);
  });

  test('GSD_RUNTIME=codex → resolver consults CODEX_HOME, not CLAUDE_CONFIG_DIR (HIGH cross-runtime fix)', () => {
    prevGsdRuntime = process.env.GSD_RUNTIME;
    prevCodexHome = process.env.CODEX_HOME;
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    prevGsdWorkstream = process.env.GSD_WORKSTREAM;
    prevGsdProject = process.env.GSD_PROJECT;

    try {
      process.env.GSD_RUNTIME = 'codex';
      process.env.CODEX_HOME = tmpCodexDir;       // codex dir: graphify SURFACED
      process.env.CLAUDE_CONFIG_DIR = tmpClaudeDir; // claude dir: graphify NOT surfaced
      delete process.env.GSD_WORKSTREAM;
      delete process.env.GSD_PROJECT;

      // With GSD_RUNTIME=codex, the resolver must look at CODEX_HOME (graphify surfaced)
      // and return true. Pre-fix it would look at CLAUDE_CONFIG_DIR (not surfaced) → false.
      const active = isCapabilityActive('graphify', tmpProjectDir);
      assert.strictEqual(
        active,
        true,
        'isCapabilityActive must return true when GSD_RUNTIME=codex and graphify is surfaced in CODEX_HOME — ' +
        'the pre-fix code hardcoded getGlobalConfigDir("claude") regardless of GSD_RUNTIME, returning false (BUG)',
      );

      // Also verify: if we swap surfaces (codex NOT surfaced, claude surfaced), still uses codex dir → false
      fs.writeFileSync(
        path.join(tmpCodexDir, '.gsd-surface.json'),
        JSON.stringify({ baseProfile: 'full', disabledClusters: ['graphify'], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpClaudeDir, '.gsd-surface.json'),
        JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
        'utf8',
      );
      const activeSwapped = isCapabilityActive('graphify', tmpProjectDir);
      assert.strictEqual(
        activeSwapped,
        false,
        'isCapabilityActive must return false when GSD_RUNTIME=codex and graphify is NOT surfaced in CODEX_HOME — ' +
        'even though claude dir has graphify surfaced, the codex dir is the authoritative surface',
      );
    } finally {
      // Restore env vars
      if (prevGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = prevGsdRuntime;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      if (prevGsdWorkstream === undefined) delete process.env.GSD_WORKSTREAM;
      else process.env.GSD_WORKSTREAM = prevGsdWorkstream;
      if (prevGsdProject === undefined) delete process.env.GSD_PROJECT;
      else process.env.GSD_PROJECT = prevGsdProject;

      // Restore codex dir surface fixture for cleanup consistency
      fs.writeFileSync(
        path.join(tmpCodexDir, '.gsd-surface.json'),
        JSON.stringify({ baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] }, null, 2) + '\n',
        'utf8',
      );
    }
  });
});

// ─── ADR-1244 D2 overlay wiring — capability-state sees installed overlays ───

describe('ADR-1244 D2: overlay-aware registry wiring in capability-state', () => {
  // Verifies that resolveCapabilityRuntimeState uses loadRegistry({includeInstalled:true})
  // so a valid installed overlay capability appears in the capabilities list.
  // The overlay cap has no activationKey so it activates freely.
  const { resolveCapabilityRuntimeState } = require('../gsd-core/bin/lib/capability-state.cjs');

  test('valid overlay capability appears in runtime state capabilities list', () => {
    const overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-overlay-'));
    const prevGsdHome = process.env.GSD_HOME;
    try {
      // Write a valid overlay capability manifest
      const capDir = path.join(overlayHome, '.gsd', 'capabilities', 'my-overlay-cap');
      fs.mkdirSync(capDir, { recursive: true });
      const capManifest = {
        id: 'my-overlay-cap',
        role: 'feature',
        version: '1.0.0',
        title: 'My Overlay Cap',
        description: 'ADR-1244 D2 wiring test overlay',
        tier: 'standard',
        requires: [],
        engines: { gsd: '>=0.0.0' },
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
      };
      fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify(capManifest), 'utf8');

      // Point GSD_HOME to the overlay home so loadRegistry finds it
      process.env.GSD_HOME = overlayHome;

      // Use a non-existent cwd so no project-scope overlay is scanned — pure global
      const nonExistentCwd = path.join(os.tmpdir(), 'cap-state-overlay-cwd-' + Date.now());
      const result = resolveCapabilityRuntimeState(nonExistentCwd, undefined);

      const overlayEntry = result.capabilities.find((c) => c.id === 'my-overlay-cap');
      assert.ok(
        overlayEntry !== undefined,
        'overlay capability "my-overlay-cap" must appear in resolveCapabilityRuntimeState results ' +
        '(ADR-1244 D2: capability-state must use overlay-aware loadRegistry)',
      );
    } finally {
      if (prevGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = prevGsdHome;
      cleanup(overlayHome);
    }
  });
});

// ─── #1459 IC-04: capability-state threads the consent home (GSD_HOME) to loadRegistry ───

describe('#1459 IC-04: capability-state threads gsdHome to the overlay loader', () => {
  const { mock } = require('node:test');
  const { resolveCapabilityRuntimeState } = require('../gsd-core/bin/lib/capability-state.cjs');
  // The SAME cached loader module instance capability-state requires internally — spy its loadRegistry.
  const loader = require('../gsd-core/bin/lib/capability-loader.cjs');

  test('resolveCapabilityRuntimeState passes gsdHome=process.env.GSD_HOME to EVERY overlay-aware loadRegistry call', () => {
    // revert-fails: if ANY consumer reached on this path (capability-state itself, or the federated
    // config-loader it calls via loadConfig) called loadRegistry({ includeInstalled, cwd }) WITHOUT
    // gsdHome (the pre-IC-04 form), that call's captured options.gsdHome would be undefined while
    // process.env.GSD_HOME is set, so the per-call strictEqual below fails. The loader's behavioral
    // env-fallback would still resolve the right home, masking the regression — only this
    // explicit-threading spy pins the contract that every consumer forwards the home it sees. We assert
    // EVERY includeInstalled call (not just the last) so reverting any single consumer's threading fails.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-ic04-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-state-ic04-cwd-'));
    const prev = process.env.GSD_HOME;
    const calls = [];
    const spy = mock.method(loader, 'loadRegistry', function (opts) {
      calls.push(opts || {});
      return realRegistry; // a valid registry shape; we only assert on the call options.
    });
    try {
      process.env.GSD_HOME = home;
      resolveCapabilityRuntimeState(cwd, null);
      const overlayCalls = calls.filter((o) => o.includeInstalled === true);
      assert.ok(overlayCalls.length > 0, 'at least one overlay-aware loadRegistry call was made on this path');
      for (const o of overlayCalls) {
        assert.strictEqual(o.gsdHome, home, 'every overlay-aware loadRegistry call threads gsdHome = process.env.GSD_HOME (IC-04)');
      }
    } finally {
      spy.mock.restore();
      if (prev === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = prev;
      cleanup(home);
      cleanup(cwd);
    }
  });
});

describe('regressions: --runtime override bypasses persisted runtime (#2003)', () => {
  // #2003: `capability state` and `loop render-hooks` parsed only --config-dir,
  // never --runtime. resolveCapabilityRuntimeState derived the config dir from
  // resolveRuntime(cwd) (GSD_RUNTIME → config.runtime → 'claude'), so a repo
  // with persisted runtime:"codex" resolved the config dir to ~/.codex — where
  // the Claude skill isn't installed → surfaced:false. Fix: thread an explicit
  // --runtime override through both commands into resolveCapabilityRuntimeState
  // so it bypasses the persisted-runtime fallback (mirrors the update-context /
  // effort sync precedent).

  function writePersistedRuntime(tmpDir, runtime) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime }),
      'utf8',
    );
  }

  test('resolveCapabilityRuntimeState: runtimeOverride="claude" bypasses persisted config.runtime:"codex"', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-override-'));
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const runtimeHomes = require('../gsd-core/bin/lib/runtime-homes.cjs');
      const expectedClaudeDir = runtimeHomes.getGlobalConfigDir('claude');
      const expectedCodexDir = runtimeHomes.getGlobalConfigDir('codex');
      // Persisted runtime is codex; explicit override is claude. The override
      // MUST win (resolveRuntime is never consulted when an override is given,
      // so GSD_RUNTIME env cannot interfere either).
      const result = resolveCapabilityRuntimeState(tmpDir, undefined, undefined, 'claude');
      assert.strictEqual(result.runtimeConfigDir, expectedClaudeDir,
        '--runtime claude must override persisted runtime:"codex"');
      assert.notStrictEqual(result.runtimeConfigDir, expectedCodexDir,
        'must NOT resolve to the codex config dir when --runtime claude is explicit');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('resolveCapabilityRuntimeState: no override still honours persisted config.runtime (unchanged, regression guard)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-no-override-'));
    // Control GSD_RUNTIME so resolveRuntime deterministically reads config.runtime.
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const runtimeHomes = require('../gsd-core/bin/lib/runtime-homes.cjs');
      const expectedCodexDir = runtimeHomes.getGlobalConfigDir('codex');
      // No override → persisted codex wins (existing behavior preserved).
      const result = resolveCapabilityRuntimeState(tmpDir, undefined, undefined, undefined);
      assert.strictEqual(result.runtimeConfigDir, expectedCodexDir,
        'without --runtime, persisted config.runtime:"codex" still drives resolution (unchanged)');
    } finally {
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
      cleanup(tmpDir);
    }
  });

  test('resolveCapabilityRuntimeState: runtimeOverride canonicalizes aliases (codex-app -> codex)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-alias-'));
    try {
      writePersistedRuntime(tmpDir, 'claude');
      const runtimeHomes = require('../gsd-core/bin/lib/runtime-homes.cjs');
      const expectedCodexDir = runtimeHomes.getGlobalConfigDir('codex');
      // Alias "codex-app" canonicalizes to "codex" via runtime-name-policy.
      const result = resolveCapabilityRuntimeState(tmpDir, undefined, undefined, 'codex-app');
      assert.strictEqual(result.runtimeConfigDir, expectedCodexDir,
        '--runtime codex-app (alias) must canonicalize to codex');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('CLI: `capability state --runtime claude` reports the Claude config dir despite persisted runtime:"codex"', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-cli-'));
    try {
      writePersistedRuntime(tmpDir, 'codex');
      // #2665: sandbox HOME and let the config-location vars stay BLANK (helpers'
      // TEST_ENV_BASE zeroes them), so the child resolves through the home-derived
      // FALLBACK branch of getGlobalConfigDir. The original test compared the
      // child's answer against the PARENT process's getGlobalConfigDir() -- two
      // different environments, agreeing only because the child inherited the
      // developer's ambient CLAUDE_CONFIG_DIR.
      //
      // Injecting CLAUDE_CONFIG_DIR here instead would fix that leak but move the
      // test onto the env-FIRST branch, silently dropping the only coverage this
      // #2003 regression has of the fallback branch. Sandboxing HOME keeps the
      // expectation test-controlled AND keeps the branch under test unchanged.
      const result = runGsdTools('capability state --runtime claude --raw', tmpDir, {
        HOME: tmpDir,
        USERPROFILE: tmpDir,
      });
      assert.ok(result.success, `capability state --runtime should succeed: ${result.error || ''}`);
      const parsed = JSON.parse(result.output);
      // Home-derived Claude dir. That this is NOT <tmpDir>/.codex is the #2003
      // assertion; a separate notStrictEqual against the codex dir would be dead,
      // since it cannot fail whenever this strictEqual passes.
      assert.strictEqual(parsed.runtimeConfigDir, path.join(tmpDir, '.claude'),
        '`capability state --runtime claude` must resolve to the Claude config dir, not the persisted codex dir');
    } finally {
      cleanup(tmpDir);
    }
  });

  // L-2 (review): end-to-end CLI test for loop render-hooks --runtime — the exact
  // command the bug report calls out as silently no-op'ing. Guards the copy-pasted
  // arg parsing in gsd-tools.cjs from diverging from the capability-state branch.
  test('CLI: `loop render-hooks verify:post --runtime claude` resolves against the Claude config dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-loop-cli-'));
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const result = runGsdTools('loop render-hooks verify:post --runtime claude --raw', tmpDir);
      assert.ok(result.success, `loop render-hooks --runtime should succeed: ${result.error || ''}`);
      const parsed = JSON.parse(result.output);
      // The envelope carries activeHooks/rendered; the key assertion is that it
      // ran without silently no-op'ing against the codex dir. A non-empty
      // point + a rendered string (even "_No active hooks..._") proves the
      // command executed against the resolved (claude) config dir rather than
      // erroring or emitting nothing.
      assert.strictEqual(parsed.point, 'verify:post', 'render-hooks must echo the requested point');
      assert.ok(typeof parsed.rendered === 'string', 'render-hooks must produce a rendered string');
    } finally {
      cleanup(tmpDir);
    }
  });

  // M-1 + NIT-01 (review): unknown / crafted --runtime values are REJECTED by the
  // closed-vocabulary canonicalizer, warn, and fall through to the persisted
  // runtime (never embedded into a path). This is the security-load-bearing
  // contract — pin it so a future refactor can't silently break it.
  test('resolveCapabilityRuntimeState: unknown/crafted --runtime is rejected (closed vocabulary), warns, and falls through to persisted runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-reject-'));
    const savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const runtimeHomes = require('../gsd-core/bin/lib/runtime-homes.cjs');
      const expectedCodexDir = runtimeHomes.getGlobalConfigDir('codex');
      const crafted = ['../../etc/passwd', '__proto__', 'constructor', '--config-dir', 'garbage', 'foo bar', 'cluade'];
      for (const bad of crafted) {
        const result = resolveCapabilityRuntimeState(tmpDir, undefined, undefined, bad);
        assert.strictEqual(result.runtimeConfigDir, expectedCodexDir,
          `crafted --runtime "${bad}" must fall through to persisted codex dir, not be embedded in a path`);
        assert.ok(result.warnings.some((w) => w.includes('--runtime') && w.includes(bad)),
          `crafted --runtime "${bad}" must emit a warning naming the rejected value`);
      }
    } finally {
      if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
      else process.env.GSD_RUNTIME = savedGsdRuntime;
      cleanup(tmpDir);
    }
  });

  // N-1 (review): CLI arg-parsing boundary — --config-dir wins over --runtime
  // (most-explicit input takes precedence), and missing --runtime value errors.
  test('CLI: --config-dir takes precedence over --runtime when both are given', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-precedence-'));
    const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-explicit-cfg-'));
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const result = runGsdTools(
        `capability state --config-dir ${explicitDir} --runtime claude --raw`,
        tmpDir,
      );
      assert.ok(result.success, `capability state with both flags should succeed: ${result.error || ''}`);
      const parsed = JSON.parse(result.output);
      assert.strictEqual(parsed.runtimeConfigDir, explicitDir,
        '--config-dir (explicit path) must win over --runtime when both are present');
    } finally {
      cleanup(explicitDir);
      cleanup(tmpDir);
    }
  });

  test('CLI: `capability state --runtime` with no value errors with USAGE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-rt-missing-'));
    try {
      writePersistedRuntime(tmpDir, 'codex');
      const result = runGsdTools('capability state --runtime', tmpDir);
      assert.ok(!result.success, 'missing --runtime value must produce a non-zero exit');
      assert.ok(/Missing value for --runtime/.test(result.error || ''),
        `error must name the missing --runtime value: ${result.error || ''}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

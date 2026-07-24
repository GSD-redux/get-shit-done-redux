'use strict';

/**
 * capability-registry.test.cjs — behavioral tests for the capability registry generator.
 *
 * ADR-894 phase 3a-impl.
 * Uses node:test + node:assert/strict.
 * Tests use in-memory fixtures (not real files) for adversarial cases.
 * The UI pilot test loads from the real capabilities/ui/ directory.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const {
  validateCapability,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  classifyCrossErrors,
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  computeRequiresClosure,
  topoSortSteps,
  normalizeLineEndings,
  stripGeneratedComment,
  validateConfigSliceEntry,
  VALID_CONFIG_SLICE_TYPES,
  SCHEMA_VERSION,
  // ADR-857 phase 4a
  deriveCapabilityClusters,
  deriveProfileMembership,
  runConsistencyGate,
  PROFILE_RANK,
  // ADR-959
  validateCommandEntry,
  // ADR-857 phase 5e
  VALID_CONVERTER_NAMES,
  validateArtifactKindEntry,
  runConfigFormatParityGate,
  INSTALL_SURFACE_TO_CONFIG_FORMAT,
  // ADR-857 phase 5f: cross-field consistency gates
  INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES,
  VALID_INSTALL_SURFACES,
  VALID_EXTENDED_HOOK_EVENTS,
  VALID_PERMISSION_WRITERS,
  validateRuntimeCompat,
  validateRuntimeBody,
  loadCentralConfigKeys,
  validateHooksWired,
  POINT_ORDER,
} = require('../scripts/gen-capability-registry.cjs');

const {
  STEP_WORKFLOWS,
  HOST_LOOP_FILES,
  scanWiredPoints,
  getWiredLoopPoints,
  CANONICAL_POINTS,
} = require('../scripts/gen-loop-host-contract.cjs');

const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

// ADR-1244 D2: the validator was extracted to a shared runtime-callable module.
// The generator must re-export it verbatim — the parity suite below proves no drift.
const capValidatorModule = require('../gsd-core/bin/lib/capability-validator.cjs');
const generatorModule = require('../scripts/gen-capability-registry.cjs');

const fc = require('fast-check');

const ROOT = path.resolve(__dirname, '..');

// ─── UI pilot fixture (from capabilities/ui/capability.json) ─────────────────

const UI_CAP_PATH = path.join(ROOT, 'capabilities', 'ui', 'capability.json');
const UI_CAP = JSON.parse(fs.readFileSync(UI_CAP_PATH, 'utf8'));

// ─── Helper: write temporary capability dir ───────────────────────────────────

function makeTempCapDir(capabilities) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  for (const [id, cap] of Object.entries(capabilities)) {
    const subDir = path.join(tmpDir, id);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return tmpDir;
}

// ─── 1. Valid UI pilot ────────────────────────────────────────────────────────

describe('UI pilot capability', () => {
  test('UI capability.json passes per-file validation', () => {
    const errors = validateCapability(UI_CAP, 'ui');
    assert.deepEqual(errors, [], 'Expected no validation errors: ' + JSON.stringify(errors));
  });

  test('UI capability passes contract validation', () => {
    const errors = validateAgainstContract(UI_CAP, 'ui');
    assert.deepEqual(errors, [], 'Expected no contract errors: ' + JSON.stringify(errors));
  });

  test('UI pilot generates a registry with correct shape', () => {
    // Pass empty central keys so the pre-migration config keys do not cause collision errors
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'Expected no errors: ' + JSON.stringify(errors));

    const registry = buildRegistry(capMap);

    // capabilities.ui exists
    assert.ok(registry.capabilities.ui, 'registry.capabilities.ui should exist');
    assert.strictEqual(registry.version, SCHEMA_VERSION);
    assert.deepStrictEqual(
      registry.capabilities.ui.runtimeCompat,
      { supported: ['*'], unsupported: [] },
      'feature runtime compatibility contract should be preserved in the registry',
    );

    // bySkill maps ui-phase and ui-review to 'ui'
    assert.strictEqual(registry.bySkill['ui-phase'], 'ui');
    assert.strictEqual(registry.bySkill['ui-review'], 'ui');

    // byAgent maps gsd-ui-checker and gsd-ui-auditor to 'ui'
    assert.strictEqual(registry.byAgent['gsd-ui-checker'], 'ui');
    assert.strictEqual(registry.byAgent['gsd-ui-auditor'], 'ui');

    // byLoopPoint['plan:pre'].steps contains the ui-phase step
    const planPreSteps = registry.byLoopPoint['plan:pre'].steps;
    assert.ok(Array.isArray(planPreSteps), 'plan:pre.steps should be an array');
    const uiPhaseStep = planPreSteps.find((s) => s.ref && s.ref.skill === 'ui-phase');
    assert.ok(uiPhaseStep, 'plan:pre.steps should contain the ui-phase step');
    assert.strictEqual(uiPhaseStep.capId, 'ui');

    // byLoopPoint['plan:pre'].gates contains the new ui.plan-gate (#1026)
    const planPreGates = registry.byLoopPoint['plan:pre'].gates;
    assert.ok(Array.isArray(planPreGates), 'plan:pre.gates should be an array');
    const uiPlanGate = planPreGates.find(
      (g) => g.check && g.check.query === 'ui.plan-gate',
    );
    assert.ok(uiPlanGate, 'plan:pre.gates should contain the ui.plan-gate (#1026)');
    assert.strictEqual(uiPlanGate.capId, 'ui');
    assert.strictEqual(uiPlanGate.blocking, true);
    assert.strictEqual(uiPlanGate.when, 'workflow.ui_safety_gate');
    assert.strictEqual(uiPlanGate.onError, 'halt');

    // byLoopPoint['execute:wave:post'].gates contains the UI safety gate
    const execWavePostGates = registry.byLoopPoint['execute:wave:post'].gates;
    assert.ok(Array.isArray(execWavePostGates), 'execute:wave:post.gates should be an array');
    const uiGate = execWavePostGates.find(
      (g) => g.check && g.check.query === 'ui.safety-gate',
    );
    assert.ok(uiGate, 'execute:wave:post.gates should contain the ui safety gate');
    assert.strictEqual(uiGate.capId, 'ui');
    assert.strictEqual(uiGate.blocking, true);

    // configKeys maps the 3 UI keys to 'ui' (ownership map — preserved)
    assert.strictEqual(registry.configKeys['workflow.ui_phase'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_review'], 'ui');
    assert.strictEqual(registry.configKeys['workflow.ui_safety_gate'], 'ui');

    // configSchema index — new in phase 3b
    assert.ok(registry.configSchema, 'registry.configSchema should exist');

    // workflow.ui_phase
    assert.ok(registry.configSchema['workflow.ui_phase'], 'configSchema should have workflow.ui_phase');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_phase'].default, true);
    assert.strictEqual(typeof registry.configSchema['workflow.ui_phase'].description, 'string');
    assert.ok(registry.configSchema['workflow.ui_phase'].description.length > 0);

    // workflow.ui_review
    assert.ok(registry.configSchema['workflow.ui_review'], 'configSchema should have workflow.ui_review');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_review'].default, true);

    // workflow.ui_safety_gate
    assert.ok(registry.configSchema['workflow.ui_safety_gate'], 'configSchema should have workflow.ui_safety_gate');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].owner, 'ui');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].type, 'boolean');
    assert.strictEqual(registry.configSchema['workflow.ui_safety_gate'].default, true);
  });

  test('requiresClosure("ui") returns empty set (no requires)', () => {
    const capMap = new Map([['ui', UI_CAP]]);
    const closure = computeRequiresClosure('ui', capMap);
    assert.deepEqual([...closure], []);
  });
});

// ─── 2. Adversarial invalid declarations ─────────────────────────────────────

describe('validateCapability adversarial cases', () => {
  test('missing id rejected', () => {
    const cap = { ...UI_CAP };
    delete cap.id;
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for missing id');
    assert.ok(
      errors.some((e) => e.includes('id')),
      'Error should mention id, got: ' + JSON.stringify(errors),
    );
  });

  test('id not equal to folder name rejected', () => {
    const cap = { ...UI_CAP, id: 'not-ui' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('folder')));
  });

  test('bad role rejected', () => {
    const cap = { ...UI_CAP, role: 'plugin' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('role')));
  });

  test('feature capability without runtimeCompat is rejected', () => {
    const cap = { ...UI_CAP };
    delete cap.runtimeCompat;
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.some((e) => e.includes('runtimeCompat')),
      'Expected missing runtimeCompat validation error, got: ' + JSON.stringify(errors),
    );
  });

  test('runtimeCompat.supported must be a non-empty array', () => {
    const errors = validateRuntimeCompat('ui', { supported: [], unsupported: [] });
    assert.ok(
      errors.some((e) => e.includes('runtimeCompat.supported')),
      'Expected supported-array validation error, got: ' + JSON.stringify(errors),
    );
  });

  test('runtimeCompat.supported wildcard cannot be mixed with runtime ids', () => {
    const errors = validateRuntimeCompat('ui', { supported: ['*', 'claude'], unsupported: [] });
    assert.ok(
      errors.some((e) => e.includes('wildcard')),
      'Expected wildcard validation error, got: ' + JSON.stringify(errors),
    );
  });

  test('bad tier enum rejected', () => {
    const cap = { ...UI_CAP, tier: 'premium' };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('tier')));
  });

  test('step with invalid point rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        { ...UI_CAP.steps[0], point: 'notapoint:pre' },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('notapoint:pre')));
  });

  test('gate with agentVerdict and blocking:true rejected', () => {
    const cap = {
      ...UI_CAP,
      gates: [
        {
          point: 'execute:wave:post',
          check: { agentVerdict: { ref: 'gsd-ui-checker', prompt: 'check' } },
          blocking: true,
          onError: 'halt',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e) => e.includes('agentVerdict') && e.includes('blocking')),
      'Expected error about agentVerdict forcing blocking:false, got: ' + JSON.stringify(errors),
    );
  });

  test('#1634: a valid tool-scoping matcher is accepted on a lifecycle hook', () => {
    const cap = {
      ...UI_CAP,
      hooks: [{ event: 'PreToolUse', script: 'hooks/genfile-guard.cjs', matcher: 'Write|Edit' }],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      !errors.some((e) => e.includes('matcher')),
      'A valid matcher must not produce a matcher error, got: ' + JSON.stringify(errors),
    );
  });

  test('#1634: an absent matcher is accepted (match-all)', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PreToolUse', script: 'hooks/g.js' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      !errors.some((e) => e.includes('matcher')),
      'An absent matcher must not error, got: ' + JSON.stringify(errors),
    );
  });

  test('#1634: an empty-string matcher is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PreToolUse', script: 'hooks/g.js', matcher: '' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.some((e) => e.includes('matcher') && e.includes('non-empty')),
      'Expected a non-empty matcher error, got: ' + JSON.stringify(errors),
    );
  });

  test('#1634: a non-string matcher is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PreToolUse', script: 'hooks/g.js', matcher: 42 }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.some((e) => e.includes('matcher')),
      'Expected a matcher type error, got: ' + JSON.stringify(errors),
    );
  });

  test('#1634: a matcher containing control characters is rejected', () => {
    const cap = {
      ...UI_CAP,
      hooks: [{ event: 'PreToolUse', script: 'hooks/g.js', matcher: 'Write\n|Edit' }],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.some((e) => e.includes('matcher') && e.includes('control')),
      'Expected a control-character matcher error, got: ' + JSON.stringify(errors),
    );
  });
});

describe('validateAgainstContract adversarial cases', () => {
  test('contribution.into not in step agentRoles rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'notarole',
          fragment: { inline: 'test' },
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateAgainstContract(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('notarole')));
  });
});

describe('validateCrossCapability adversarial cases', () => {
  test('duplicate skill ownership across two capabilities rejected', () => {
    const cap1 = { ...UI_CAP };
    const cap2 = {
      ...UI_CAP,
      id: 'ui2',
      skills: ['ui-phase'],  // duplicate
      agents: ['gsd-other-agent'],
      config: {},
    };
    const capMap = new Map([['ui', cap1], ['ui2', cap2]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('ui-phase')));
  });

  test('requires referencing nonexistent id rejected', () => {
    const cap = { ...UI_CAP, requires: ['nonexistent-cap'] };
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('nonexistent-cap')));
  });

  test('runtimeCompat explicit runtime ids must exist', () => {
    const cap = {
      ...UI_CAP,
      runtimeCompat: { supported: ['claude', 'future-runtime'], unsupported: [] },
    };
    const runtime = {
      id: 'claude',
      role: 'runtime',
      title: 'Claude',
      description: 'Runtime fixture.',
      tier: 'core',
      requires: [],
      runtime: {
        configHome: { kind: 'dot-home', name: '.claude', env: ['CLAUDE_CONFIG_DIR'] },
        configFormat: 'settings-json',
        artifactLayout: { global: [], local: [] },
        commandStyle: 'slash-hyphen',
        hooksSurface: 'settings-json',
        sandboxTier: 'none',
        supportTier: 1,
        installSurface: 'settings-json',
        writesSharedSettings: true,
        permissionWriter: null,
        extendedHookEvents: [],
      },
    };
    const capMap = new Map([['ui', cap], ['claude', runtime]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(
      errors.some((e) => e.includes('runtimeCompat.supported') && e.includes('future-runtime')),
      'Expected unknown runtimeCompat runtime error, got: ' + JSON.stringify(errors),
    );
  });

  test('requires cycle rejected', () => {
    const capA = { ...UI_CAP, id: 'cap-a', tier: 'standard', requires: ['cap-b'] };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', tier: 'standard', requires: ['cap-a'],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('cycle')));
  });

  test('tier-monotone violation: core requires full rejected', () => {
    const coreCap = {
      id: 'core-cap', role: 'feature', title: 'Core', tier: 'core', requires: ['full-cap'],
      skills: ['core-skill'], agents: ['gsd-core-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const fullCap = {
      id: 'full-cap', role: 'feature', title: 'Full', tier: 'full', requires: [],
      skills: ['full-skill'], agents: ['gsd-full-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['core-cap', coreCap], ['full-cap', fullCap]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('tier-monotone')));
  });

  test('config key colliding with central config-schema rejected', () => {
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase']); // simulate key present in both
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_phase') && e.includes('central config-schema')),
      'Expected central config-schema collision error, got: ' + JSON.stringify(errors),
    );
  });

  test('config key owned by two capabilities rejected', () => {
    const cap1 = { ...UI_CAP };
    const cap2 = {
      id: 'ui2', role: 'feature', title: 'UI2', tier: 'standard', requires: [],
      skills: ['other-skill'], agents: ['gsd-other-agent'], hooks: [],
      config: { 'workflow.ui_phase': { type: 'boolean', default: true, description: 'dup' } },
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['ui', cap1], ['ui2', cap2]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('workflow.ui_phase')));
  });
});

// ─── 3. Materialized ordering ─────────────────────────────────────────────────

describe('topological step ordering', () => {
  test('two steps at one point with produces/consumes dependency order correctly', () => {
    // Step B consumes what step A produces → A must come before B
    const stepA = {
      capId: 'cap-a',
      step: { point: 'plan:pre', ref: { skill: 'a-skill' }, produces: ['A-OUTPUT.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const stepB = {
      capId: 'cap-b',
      step: { point: 'plan:pre', ref: { skill: 'b-skill' }, produces: ['B-OUTPUT.md'], consumes: ['A-OUTPUT.md'], when: undefined, onError: 'skip' },
    };

    // Pass in reverse order to verify sort happens
    const sorted = topoSortSteps([stepB, stepA]);
    assert.strictEqual(sorted[0].capId, 'cap-a', 'cap-a (producer) should come first');
    assert.strictEqual(sorted[1].capId, 'cap-b', 'cap-b (consumer) should come second');
  });

  test('steps with no dependency order by capId tiebreak', () => {
    const stepZ = {
      capId: 'z-cap',
      step: { point: 'plan:pre', ref: { skill: 'z' }, produces: ['Z.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const stepA = {
      capId: 'a-cap',
      step: { point: 'plan:pre', ref: { skill: 'a' }, produces: ['A.md'], consumes: [], when: undefined, onError: 'skip' },
    };
    const sorted = topoSortSteps([stepZ, stepA]);
    assert.strictEqual(sorted[0].capId, 'a-cap', 'a-cap should come first (alphabetical tiebreak)');
    assert.strictEqual(sorted[1].capId, 'z-cap');
  });

  test('contributions at one point use produces/consumes dependency order', () => {
    const capMap = new Map([
      ['a-consumer', {
        id: 'a-consumer',
        role: 'feature',
        title: 'Consumer',
        tier: 'full',
        requires: [],
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [],
        agents: [],
        hooks: [],
        config: {},
        steps: [],
        contributions: [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'Consume produced planning note.' },
          produces: [],
          consumes: ['PLAN-NOTE.md'],
          onError: 'skip',
        }],
        gates: [],
      }],
      ['b-producer', {
        id: 'b-producer',
        role: 'feature',
        title: 'Producer',
        tier: 'full',
        requires: [],
        skills: [],
        agents: [],
        hooks: [],
        config: {},
        steps: [],
        contributions: [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'Produce planning note.' },
          produces: ['PLAN-NOTE.md'],
          consumes: [],
          onError: 'skip',
        }],
        gates: [],
      }],
    ]);

    const registry = buildRegistry(capMap);
    assert.deepEqual(
      registry.byLoopPoint['plan:pre'].contributions.map((c) => c.capId),
      ['b-producer', 'a-consumer'],
    );
  });

  test('contribution produces/consumes cycle throws a clear error', () => {
    const capMap = new Map([
      ['cap-a', {
        id: 'cap-a',
        role: 'feature',
        title: 'A',
        tier: 'full',
        requires: [],
        skills: [],
        agents: [],
        hooks: [],
        config: {},
        steps: [],
        contributions: [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'A.' },
          produces: ['A.md'],
          consumes: ['B.md'],
          onError: 'skip',
        }],
        gates: [],
      }],
      ['cap-b', {
        id: 'cap-b',
        role: 'feature',
        title: 'B',
        tier: 'full',
        requires: [],
        skills: [],
        agents: [],
        hooks: [],
        config: {},
        steps: [],
        contributions: [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'B.' },
          produces: ['B.md'],
          consumes: ['A.md'],
          onError: 'skip',
        }],
        gates: [],
      }],
    ]);

    assert.throws(
      () => buildRegistry(capMap),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /contributions/);
        assert.match(err.message, /cycle/);
        return true;
      },
    );
  });
});

// ─── 4. --check drift detection ──────────────────────────────────────────────
//
// The real --check pipeline (gen-capability-registry.cjs main()) compares
// committed vs live via:
//
//   normalizeLineEndings(stripGeneratedComment(committed))
//     !== normalizeLineEndings(stripGeneratedComment(live))
//
// stripGeneratedComment is private (not exported), so these tests replicate the
// same filter inline and call the exported normalizeLineEndings to exercise the
// ACTUAL comparison semantics rather than doing a bare string-equality tautology.
//
// The subprocess tests additionally prove that the real --check CLI exits 1 on a
// tampered registry and exits 0 when only the auto-generated timestamp comment
// changes (comment immunity).

const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');

/**
 * Mirror of the private stripGeneratedComment() from gen-capability-registry.cjs.
 * Kept here intentionally: the test validates BEHAVIOR, and the implementation is
 * stable (a single-line filter). If the source changes the sentinel string, this
 * test will correctly start failing — that is the desired red signal.
 *
 * NOTE (#1191): The equivalence test below pins the exported stripGeneratedComment
 * to this mirror.  If the export's sentinel ever drifts from the mirror's sentinel,
 * the equivalence test goes RED — making the implicit "sentinel drift = red signal"
 * comment above into an explicit automated check.
 */
function applyStripGeneratedComment(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes('generated by scripts/gen-capability-registry.cjs'))
    .join('\n');
}

/** Apply the full --check comparison pipeline to a single content string. */
function checkPipeline(content) {
  return normalizeLineEndings(applyStripGeneratedComment(content));
}

// ─── Seam-3 equivalence test (#1191) ─────────────────────────────────────────
//
// Verifies that the now-exported stripGeneratedComment from gen-capability-registry.cjs
// matches the local oracle (applyStripGeneratedComment) on a representative sample.
// This turns the oracle's implicit "fails if sentinel drifts" into an explicit guard.

describe('exported stripGeneratedComment matches the test oracle (no sentinel drift)', () => {
  test('exported stripGeneratedComment matches the test oracle (no sentinel drift)', () => {
    const sample = [
      '// generated by scripts/gen-capability-registry.cjs — DO NOT EDIT',
      "'use strict';",
      '// normal comment (not a generated-by line)',
      "module.exports = { version: '1' };",
      '// generated by scripts/gen-capability-registry.cjs (second occurrence)',
    ].join('\n');

    assert.strictEqual(
      stripGeneratedComment(sample),
      applyStripGeneratedComment(sample),
      'exported stripGeneratedComment must produce identical output to the test oracle — ' +
        'a sentinel mismatch means the export and the oracle have drifted'
    );
  });
});

describe('--check drift detection', () => {
  test('stale VERSION survives stripGeneratedComment+normalizeLineEndings and IS detected as drift', () => {
    // Build a fresh registry from the real UI cap — this is the "live" content
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const liveContent = serializeRegistry(registry, capMap);

    // Tamper: replace the schema version field — this simulates a stale committed file
    // (version: '1' → version: '0-stale')
    const staledContent = liveContent.replace(
      "version: '" + SCHEMA_VERSION + "'",
      "version: '0-stale'",
    );
    assert.notStrictEqual(staledContent, liveContent, 'precondition: tampered content differs before pipeline');

    // The tampered version must SURVIVE both pipeline steps and still differ from live.
    // This is what actually matters: a raw string diff is trivial; the test must show
    // the comparison survives stripping + normalization — i.e. it IS real drift.
    assert.notStrictEqual(
      checkPipeline(staledContent),
      checkPipeline(liveContent),
      'stale VERSION must be detected as drift after stripGeneratedComment + normalizeLineEndings',
    );
  });

  test('comment-only timestamp change is NOT flagged as drift after stripping', () => {
    // Build a fresh registry
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const liveContent = serializeRegistry(registry, capMap);

    // Confirm the generated comment is present in the serialized output
    assert.ok(
      liveContent.includes('generated by scripts/gen-capability-registry.cjs'),
      'precondition: generated comment must be present in serialized output',
    );

    // Simulate a Windows git checkout that adds a fake timestamp annotation on the
    // generated-comment line — the kind of comment-only mutation that must NOT trigger drift
    const commentVariant = liveContent.replace(
      ' * capability-registry.cjs — generated by scripts/gen-capability-registry.cjs',
      ' * capability-registry.cjs — generated by scripts/gen-capability-registry.cjs on 2024-01-01T00:00:00Z',
    );
    assert.notStrictEqual(commentVariant, liveContent, 'precondition: variant differs before stripping');

    // After stripping the generated-comment line, both must be identical — NOT flagged as drift
    assert.strictEqual(
      checkPipeline(commentVariant),
      checkPipeline(liveContent),
      'comment-only change must NOT be detected as drift (stripGeneratedComment must neutralize it)',
    );
  });

  test('no drift when registry is freshly generated', () => {
    // Determinism check: two calls to serializeRegistry must produce identical output
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content1 = serializeRegistry(registry, capMap);
    const content2 = serializeRegistry(registry, capMap);
    assert.strictEqual(content1, content2, 'Two calls to serializeRegistry should be identical');
  });

  test('--check comparison pipeline detects a tampered VERSION (in-memory, no file mutation)', () => {
    // Prove that the --check comparison pipeline (the same pipeline used by
    // gen-capability-registry.cjs main()) exits 1 on a stale committed registry.
    //
    // NOTE: We intentionally do NOT write to the committed REGISTRY_PATH here.
    // Writing to a committed file during a test is unsafe: it races with concurrent
    // test runners that require() the same module and leaves the worktree dirty on
    // SIGKILL.  Instead, we exercise the comparison logic using the same exported
    // helpers the CLI uses, applied to in-memory strings — giving identical coverage
    // without touching the filesystem.
    const originalContent = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const tamperedContent = originalContent.replace(
      "version: '" + SCHEMA_VERSION + "'",
      "version: '0-stale'",
    );
    assert.notStrictEqual(tamperedContent, originalContent, 'precondition: tamper must change the file');

    // Build the "live" content the same way --check does.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const liveContent = serializeRegistry(registry, capMap);

    // The tampered committed content must NOT equal the live content after the
    // same stripGeneratedComment + normalizeLineEndings pipeline that --check uses.
    // If this assertion passes, --check would exit 1 (drift detected) and emit "stale".
    assert.notStrictEqual(
      checkPipeline(tamperedContent),
      checkPipeline(liveContent),
      '--check comparison pipeline must flag a tampered VERSION as drift.\n' +
      'If this fails, the pipeline no longer detects stale VERSION strings.',
    );

    // Also verify the tampered content contains the stale marker (so the above
    // assertion is meaningful and not vacuously true due to other diff).
    assert.ok(
      tamperedContent.includes("version: '0-stale'"),
      'precondition: tampered content must contain the stale version marker',
    );
  });
});

// ─── 4b. normalizeLineEndings — Windows CRLF regression guard ────────────────

describe('normalizeLineEndings', () => {
  test('strips \\r so LF and CRLF content compare as equal', () => {
    const lf = 'line1\nline2\nline3\n';
    const crlf = 'line1\r\nline2\r\nline3\r\n';
    assert.strictEqual(
      normalizeLineEndings(lf),
      normalizeLineEndings(crlf),
      'LF and CRLF variants should normalize to the same string',
    );
  });

  test('standalone \\r (old Mac line endings) is also stripped', () => {
    const cr = 'line1\rline2\r';
    const lf = 'line1\nline2\n';
    assert.notStrictEqual(normalizeLineEndings(cr), normalizeLineEndings(lf),
      'standalone CR collapses differently from LF — only \\r is stripped, not newlines added');
    // The key property: \\r is gone
    assert.ok(!normalizeLineEndings(cr).includes('\r'), 'result must not contain \\r');
  });

  test('real registry content: CRLF variant compares equal to LF variant after normalization', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const lfContent = serializeRegistry(registry, capMap);

    // Simulate Windows git checkout by converting LF -> CRLF
    const crlfContent = lfContent.replace(/\n/g, '\r\n');

    assert.notStrictEqual(lfContent, crlfContent, 'CRLF and LF versions are byte-different');
    assert.strictEqual(
      normalizeLineEndings(lfContent),
      normalizeLineEndings(crlfContent),
      '--check must treat CRLF-checked-out registry as up to date (Windows autocrlf regression guard)',
    );
  });
});

// ─── 5. Registry shape from multiple capabilities ────────────────────────────

describe('registry structure', () => {
  test('byLoopPoint contains all 12 valid points', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);

    const expectedPoints = [
      'discuss:pre', 'discuss:post',
      'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post',
      'ship:pre', 'ship:post',
    ];
    for (const point of expectedPoints) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.byLoopPoint, point),
        'byLoopPoint should contain point: ' + point,
      );
    }
  });

  test('requiresClosure works for a cap with transitive requires', () => {
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', tier: 'standard', requires: ['cap-b'],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', tier: 'standard', requires: ['cap-c'],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capC = {
      id: 'cap-c', role: 'feature', title: 'C', tier: 'standard', requires: [],
      skills: ['c-skill'], agents: ['gsd-c-agent'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB], ['cap-c', capC]]);
    const closure = computeRequiresClosure('cap-a', capMap);
    assert.ok(closure.has('cap-b'), 'closure should include cap-b');
    assert.ok(closure.has('cap-c'), 'closure should include cap-c (transitive)');
    assert.strictEqual(closure.size, 2);
  });
});

describe('ADR-857 phase 6 planning feature capabilities', () => {
  const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

  test('real registry declares research, ai-integration, and pattern-mapper capabilities', () => {
    for (const capId of ['research', 'ai-integration', 'pattern-mapper']) {
      assert.ok(realRegistry.capabilities[capId], `${capId} capability must be declared`);
      assert.strictEqual(realRegistry.capabilities[capId].role, 'feature');
    }
  });

  test('planning feature capabilities own their workflow config keys', () => {
    assert.strictEqual(realRegistry.configKeys['workflow.research'], 'research');
    assert.strictEqual(realRegistry.configKeys['workflow.ai_integration_phase'], 'ai-integration');
    assert.strictEqual(realRegistry.configKeys['workflow.pattern_mapper'], 'pattern-mapper');
  });

  test('planning feature capabilities register plan:pre hooks', () => {
    const hooks = [
      ...realRegistry.byLoopPoint['plan:pre'].steps,
      ...realRegistry.byLoopPoint['plan:pre'].contributions,
      ...realRegistry.byLoopPoint['plan:pre'].gates,
    ];
    for (const capId of ['research', 'ai-integration', 'pattern-mapper']) {
      assert.ok(
        hooks.some((hook) => hook.capId === capId),
        `${capId} must participate in plan:pre through the Capability Registry`,
      );
    }
  });
});

// ─── 6. Fix regression guards ────────────────────────────────────────────────

describe('Fix #1: consumes-satisfiability is point-order-aware', () => {
  test('plan:pre step consuming UAT.md (produced only at verify:post) is rejected', () => {
    // UAT.md is produced by the host at verify:post (C1: :post availability rule).
    // A plan:pre step consuming it must fail — the host hasn't produced it yet at that point.
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['UAT.md'],  // UAT.md not available until verify:post
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    // C2: consumes validation is now global
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected a satisfiability error for early consumption of UAT.md');
    assert.ok(
      errors.some((e) => e.includes('UAT.md')),
      'Error should mention UAT.md, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      errors.some((e) => e.includes('plan:pre')),
      'Error should mention plan:pre, got: ' + JSON.stringify(errors),
    );
  });

  test('verify:post step consuming UAT.md (produced at verify:post by host) is accepted', () => {
    // C1: UAT.md becomes available from verify:post onward (produced by the verify host step).
    // verify:post index (9) <= verify:post index (9) → accepted.
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'ui-review' },
          produces: ['UI-REVIEW.md'],
          consumes: ['UAT.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    // C2: consumes validation is now global
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    // Should have zero satisfiability errors for UAT.md at verify:post
    const satErrors = errors.filter((e) => e.includes('UAT.md'));
    assert.deepEqual(satErrors, [], 'Expected no satisfiability errors for UAT.md at verify:post, got: ' + JSON.stringify(satErrors));
  });

  // C1 regression: PLAN.md is produced at plan:post, NOT plan:pre
  test('plan:pre step consuming PLAN.md is rejected (PLAN.md only available from plan:post)', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['PLAN.md'],  // PLAN.md produced at plan:post, not available at plan:pre
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: PLAN.md not available at plan:pre');
    assert.ok(errors.some((e) => e.includes('PLAN.md')), 'Error should mention PLAN.md');
  });

  // C1: execute:pre consuming PLAN.md → PLAN.md available at plan:post (index 3), execute:pre is index 4 → accepted
  test('execute:pre step consuming PLAN.md (produced at plan:post) is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'execute:pre',
          ref: { skill: 'ui-phase' },
          produces: [],
          consumes: ['PLAN.md'],  // PLAN.md available from plan:post onward
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const capMap = new Map([['ui', cap]]);
    const errors = validateConsumesGlobal(capMap);
    const satErrors = errors.filter((e) => e.includes('PLAN.md'));
    assert.deepEqual(satErrors, [], 'Expected PLAN.md to be available at execute:pre, got: ' + JSON.stringify(satErrors));
  });
});

describe('Fix #2: topoSortSteps errors on a produces/consumes cycle', () => {
  test('two-step cycle at the same point throws an error', () => {
    // Step A produces X and consumes Y; step B produces Y and consumes X — mutual dependency
    const stepA = {
      capId: 'cap-a',
      step: {
        point: 'plan:pre',
        ref: { skill: 'a-skill' },
        produces: ['X.md'],
        consumes: ['Y.md'],
        onError: 'skip',
      },
    };
    const stepB = {
      capId: 'cap-b',
      step: {
        point: 'plan:pre',
        ref: { skill: 'b-skill' },
        produces: ['Y.md'],
        consumes: ['X.md'],
        onError: 'skip',
      },
    };
    assert.throws(
      () => topoSortSteps([stepA, stepB]),
      (err) => {
        assert.ok(err instanceof Error, 'Should throw an Error');
        assert.ok(
          err.message.includes('cycle') || err.message.includes('cycle'),
          'Error message should mention cycle, got: ' + err.message,
        );
        return true;
      },
    );
  });
});

describe('Fix #3: config-collision emits pending-migration warning, not hard error', () => {
  test('validateCrossCapability still detects and reports the collision', () => {
    // The underlying collision detection must still fire (regression guard for existing test)
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase']);
    const capMap = new Map([['ui', cap]]);
    const errors = validateCrossCapability(capMap, centralKeys);
    assert.ok(errors.length > 0, 'Expected collision errors from validateCrossCapability');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_phase') && e.includes('central config-schema')),
      'Expected central config-schema collision error, got: ' + JSON.stringify(errors),
    );
  });

  test('classifyCrossErrors separates collision errors into pending-migration warnings', () => {
    const cap = { ...UI_CAP };
    const centralKeys = new Set(['workflow.ui_phase', 'workflow.ui_review', 'workflow.ui_safety_gate']);
    const capMap = new Map([['ui', cap]]);
    const allErrors = validateCrossCapability(capMap, centralKeys);
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(allErrors);
    // All three collision errors should become warnings, not hard errors
    assert.strictEqual(
      hardErrors.length, 0,
      'No hard errors expected for collision-only cross errors, got: ' + JSON.stringify(hardErrors),
    );
    assert.ok(
      pendingMigrationWarnings.length >= 1,
      'Expected at least one pending-migration warning',
    );
    assert.ok(
      pendingMigrationWarnings.some((w) => w.includes('pending-migration') && w.includes('workflow.ui_phase')),
      'Warning should mention pending-migration and workflow.ui_phase, got: ' + JSON.stringify(pendingMigrationWarnings),
    );
  });
});

describe('Fix #4: step.ref must be exclusive skill XOR agent', () => {
  test('step.ref with both skill and agent is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase', agent: 'gsd-ui-checker' },  // BOTH keys — invalid
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for step.ref with both skill and agent');
    assert.ok(
      errors.some((e) => e.includes('exactly one') || e.includes('not both') || e.includes('skill') && e.includes('agent')),
      'Error should mention exclusive skill/agent constraint, got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref with only skill is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const refErrors = validateCapability(cap, 'ui').filter((e) => e.includes('ref'));
    assert.deepEqual(refErrors, [], 'No ref errors expected for skill-only ref, got: ' + JSON.stringify(refErrors));
  });

  test('step.ref with only agent is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-ui-checker' },
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const refErrors = validateCapability(cap, 'ui').filter((e) => e.includes('ref'));
    assert.deepEqual(refErrors, [], 'No ref errors expected for agent-only ref, got: ' + JSON.stringify(refErrors));
  });
});

describe('double-prefix guard: step.ref.skill must not start with "gsd-"', () => {
  // ref.skill is an unprefixed stem (e.g. "ui-review"). Workflow dispatch prepends
  // "gsd-" at runtime. A stem already starting with "gsd-" would produce "gsd-gsd-..."
  // at dispatch time, silently invoking a non-existent skill.

  test('ref.skill starting with "gsd-" is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'gsd-ui-review' },  // wrong: stem must NOT have gsd- prefix
          produces: ['UI-REVIEW.md'],
          consumes: ['UI-SPEC.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected an error for gsd-prefixed ref.skill');
    assert.ok(
      errors.some((e) => e.includes('gsd-') && (e.includes('double') || e.includes('unprefixed') || e.includes('must not start'))),
      'Error should mention the double-prefix problem, got: ' + JSON.stringify(errors),
    );
  });

  test('ref.skill without "gsd-" prefix is accepted (stem only)', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'verify:post',
          ref: { skill: 'ui-review' },  // correct: unprefixed stem
          produces: ['UI-REVIEW.md'],
          consumes: ['UI-SPEC.md'],
          when: 'workflow.ui_review',
          onError: 'skip',
        },
      ],
    };
    const prefixErrors = validateCapability(cap, 'ui').filter((e) => e.includes('gsd-') && e.includes('stem'));
    assert.deepEqual(prefixErrors, [], 'No prefix errors expected for unprefixed stem, got: ' + JSON.stringify(prefixErrors));
  });

  test('real UI capability.json uses unprefixed ref.skill values', () => {
    // Verify the live capability uses unprefixed stems and therefore passes the new guard.
    const errors = validateCapability(UI_CAP, 'ui');
    const prefixErrors = errors.filter((e) => e.includes('must not start with'));
    assert.deepEqual(prefixErrors, [], 'Live UI capability.json should not trigger the double-prefix guard: ' + JSON.stringify(prefixErrors));
  });
});

// ─── Fix: ref.skill/ref.agent membership in declared skills/agents ────────────

describe('ref membership check: step.ref.skill must be in cap.skills', () => {
  // A capability declares skills: ["ui-phase", "ui-review"].
  // A step with ref.skill "typo-skill" (not in skills) must be rejected.

  test('step.ref.skill NOT in cap.skills is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'typo-skill' },  // not in skills: ["ui-phase", "ui-review"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for undeclared ref.skill');
    assert.ok(
      errors.some((e) => e.includes('typo-skill') && e.includes('not declared')),
      'Error should mention "typo-skill" and "not declared", got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref.skill IN cap.skills is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'ui-phase' },  // declared in skills: ["ui-phase", "ui-review"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared') && e.includes('ui-phase'));
    assert.deepEqual(
      membershipErrors, [],
      'No membership errors expected for declared ref.skill, got: ' + JSON.stringify(membershipErrors),
    );
  });

  test('real UI capability passes: ui-phase and ui-review are both in skills', () => {
    // Regression guard: the real UI capability must not trigger the new membership check.
    const errors = validateCapability(UI_CAP, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared'));
    assert.deepEqual(
      membershipErrors, [],
      'Real UI capability should pass membership check for all ref.skill values, got: ' + JSON.stringify(membershipErrors),
    );
  });
});

describe('ref membership check: step.ref.agent must be in cap.agents', () => {
  // A capability declares agents: ["gsd-ui-checker", "gsd-ui-auditor"].
  // A step with ref.agent "gsd-unknown-agent" (not in agents) must be rejected.

  test('step.ref.agent NOT in cap.agents is rejected', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-unknown-agent' },  // not in agents: ["gsd-ui-checker", "gsd-ui-auditor"]
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected errors for undeclared ref.agent');
    assert.ok(
      errors.some((e) => e.includes('gsd-unknown-agent') && e.includes('not declared')),
      'Error should mention "gsd-unknown-agent" and "not declared", got: ' + JSON.stringify(errors),
    );
  });

  test('step.ref.agent IN cap.agents is accepted', () => {
    const cap = {
      ...UI_CAP,
      steps: [
        {
          point: 'plan:pre',
          ref: { agent: 'gsd-ui-checker' },  // declared in agents
          produces: ['UI-SPEC.md'],
          consumes: ['CONTEXT.md'],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const membershipErrors = errors.filter((e) => e.includes('not declared') && e.includes('gsd-ui-checker'));
    assert.deepEqual(
      membershipErrors, [],
      'No membership errors expected for declared ref.agent, got: ' + JSON.stringify(membershipErrors),
    );
  });
});

describe('Fix: 3-node requires cycle (A→B→C→A) is detected', () => {
  test('three-node requires cycle is reported as an error', () => {
    const capA = {
      id: 'cyc-a', role: 'feature', title: 'CycA', tier: 'standard', requires: ['cyc-b'],
      skills: ['cyc-a-skill'], agents: ['gsd-cyc-a'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capB = {
      id: 'cyc-b', role: 'feature', title: 'CycB', tier: 'standard', requires: ['cyc-c'],
      skills: ['cyc-b-skill'], agents: ['gsd-cyc-b'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capC = {
      id: 'cyc-c', role: 'feature', title: 'CycC', tier: 'standard', requires: ['cyc-a'],
      skills: ['cyc-c-skill'], agents: ['gsd-cyc-c'], hooks: [], config: {},
      steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['cyc-a', capA], ['cyc-b', capB], ['cyc-c', capC]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(errors.length > 0, 'Expected cycle errors for A→B→C→A');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('cycle')),
      'Error should mention cycle, got: ' + JSON.stringify(errors),
    );
  });
});

describe('Fix: agentVerdict gate with blocking:false is accepted', () => {
  test('agentVerdict gate with blocking:false generates zero errors', () => {
    // Complement of the existing blocking:true rejection test
    const cap = {
      ...UI_CAP,
      gates: [
        {
          point: 'execute:wave:post',
          check: { agentVerdict: { ref: 'gsd-ui-checker', prompt: 'check ui' } },
          blocking: false,  // advisory — valid
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    const gateErrors = errors.filter((e) => e.includes('agentVerdict'));
    assert.deepEqual(
      gateErrors, [],
      'Expected no agentVerdict errors for blocking:false, got: ' + JSON.stringify(gateErrors),
    );
  });
});

// ─── 7. Security: fragment.path traversal (S1) ───────────────────────────────

describe('S1: fragment.path traversal guard', () => {
  const makeCapWithContribPath = (fragPath) => ({
    ...UI_CAP,
    contributions: [
      {
        point: 'plan:pre',
        into: 'planner',
        fragment: { path: fragPath },
        when: 'workflow.ui_phase',
        onError: 'skip',
      },
    ],
  });

  test('fragment.path with ".." segments is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath('../../etc/passwd'), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for path traversal');
    assert.ok(
      errors.some((e) => e.includes('fragment.path') && e.includes('..')),
      'Error should mention fragment.path traversal, got: ' + JSON.stringify(errors),
    );
  });

  test('absolute fragment.path is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath('/etc/passwd'), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for absolute path');
    assert.ok(
      errors.some((e) => e.includes('fragment.path')),
      'Error should mention fragment.path, got: ' + JSON.stringify(errors),
    );
  });

  test('clean relative fragment.path is accepted', () => {
    const errors = validateCapability(makeCapWithContribPath('loop/threat-model.md'), 'ui');
    const pathErrors = errors.filter((e) => e.includes('fragment.path'));
    assert.deepEqual(pathErrors, [], 'Expected no path errors for clean relative path, got: ' + JSON.stringify(pathErrors));
  });

  test('empty fragment.path string is rejected', () => {
    const errors = validateCapability(makeCapWithContribPath(''), 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for empty path');
    assert.ok(errors.some((e) => e.includes('fragment.path')));
  });

  test('array fragment shape is rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: [],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('fragment') && e.includes('object')));
  });

  test('non-string fragment.inline is rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 42 },
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('fragment.inline') && e.includes('string')));
  });

  test('empty fragment.inline string is rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: '' },
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('fragment.inline') && e.includes('non-empty')));
  });

  test('non-array contribution produces is rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'Plan with UI context.' },
          produces: 'PLAN-NOTE.md',
          consumes: [],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('produces') && e.includes('array')));
  });

  test('non-string contribution consumes entry is rejected', () => {
    const cap = {
      ...UI_CAP,
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { inline: 'Plan with UI context.' },
          produces: [],
          consumes: [42],
          when: 'workflow.ui_phase',
          onError: 'skip',
        },
      ],
    };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('consumes entries') && e.includes('strings')));
  });

  test('fragment.path is materialized into inline registry content', (t) => {
    const capsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-fragment-'));
    t.after(() => cleanup(capsDir));
    const capDir = path.join(capsDir, 'planning-advice');
    fs.mkdirSync(path.join(capDir, 'fragments'), { recursive: true });
    fs.writeFileSync(
      path.join(capDir, 'fragments', 'plan-pre.md'),
      'Use the capability-owned planning fragment.\n',
    );
    fs.writeFileSync(
      path.join(capDir, 'capability.json'),
      JSON.stringify({
        id: 'planning-advice',
        role: 'feature',
        version: '1.0.0',
        title: 'Planning advice',
        description: 'Synthetic fixture for fragment path materialization.',
        tier: 'full',
        requires: [],
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [],
        agents: [],
        hooks: [],
        config: {},
        steps: [],
        contributions: [{
          point: 'plan:pre',
          into: 'planner',
          fragment: { path: 'fragments/plan-pre.md' },
          produces: [],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        }],
        gates: [],
      }),
    );

    const { capMap, errors } = loadAndValidate(new Set(), capsDir);
    assert.deepEqual(errors, []);
    const registry = buildRegistry(capMap);
    assert.strictEqual(
      registry.byLoopPoint['plan:pre'].contributions[0].fragment.inline,
      'Use the capability-owned planning fragment.\n',
    );
  });

  test('step fragment.path is materialized into inline registry content', (t) => {
    const capsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-step-fragment-'));
    t.after(() => cleanup(capsDir));
    const capDir = path.join(capsDir, 'research');
    fs.mkdirSync(path.join(capDir, 'fragments'), { recursive: true });
    fs.writeFileSync(
      path.join(capDir, 'fragments', 'plan-pre.md'),
      'Research prompt owned by the capability.\n',
    );
    fs.writeFileSync(
      path.join(capDir, 'capability.json'),
      JSON.stringify({
        id: 'research',
        role: 'feature',
        version: '1.0.0',
        title: 'Research',
        description: 'Synthetic fixture for step fragment materialization.',
        tier: 'standard',
        requires: [],
        runtimeCompat: { supported: ['*'], unsupported: [] },
        skills: [],
        agents: ['gsd-phase-researcher'],
        hooks: [],
        config: {},
        steps: [{
          point: 'plan:pre',
          ref: { agent: 'gsd-phase-researcher' },
          fragment: { path: 'fragments/plan-pre.md' },
          produces: ['RESEARCH.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        }],
        contributions: [],
        gates: [],
      }),
    );

    const { capMap, errors } = loadAndValidate(new Set(), capsDir);
    assert.deepEqual(errors, []);
    const registry = buildRegistry(capMap);
    assert.strictEqual(
      registry.byLoopPoint['plan:pre'].steps[0].fragment.inline,
      'Research prompt owned by the capability.\n',
    );
  });
});

// ─── 8. Security: prototype pollution (S2) ────────────────────────────────────

describe('S2: prototype pollution guards', () => {
  test('skill named "__proto__" is rejected', () => {
    const cap = { ...UI_CAP, skills: ['__proto__'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for __proto__ skill');
    assert.ok(
      errors.some((e) => e.includes('__proto__') && e.includes('reserved')),
      'Error should mention reserved name, got: ' + JSON.stringify(errors),
    );
  });

  test('skill named "constructor" is rejected', () => {
    const cap = { ...UI_CAP, skills: ['constructor'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('constructor') && e.includes('reserved')));
  });

  test('agent named "__proto__" is rejected', () => {
    const cap = { ...UI_CAP, agents: ['__proto__'] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('__proto__') && e.includes('reserved')));
  });

  test('config key named "prototype" is rejected', () => {
    const configWithReserved = {
      ...UI_CAP.config,
      'prototype': { type: 'boolean', default: false, description: 'bad key' },
    };
    const cap = { ...UI_CAP, config: configWithReserved };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('prototype') && e.includes('reserved')));
  });

  test('building registry with prototype-polluting names does not pollute Object.prototype', () => {
    // Even if somehow a reserved name got through, buildRegistry must not pollute.
    // We test this by checking that Object.prototype is clean after a normal build.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    buildRegistry(capMap);
    // After registry build, Object.prototype must not have been polluted.
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype should not be polluted');
    assert.strictEqual(({}).ui, undefined, 'Object.prototype.ui should not exist');
  });
});

// ─── 9. C2: Cross-capability consumes satisfiability ─────────────────────────

describe('C2: cross-capability consumes satisfiability (global pass)', () => {
  test('cap B step consuming artifact produced by cap A at earlier point is accepted', () => {
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: ['A-OUTPUT.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', description: 'B', tier: 'standard', requires: [],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'execute:pre',  // after plan:pre — A-OUTPUT.md is available
          ref: { skill: 'b-skill' },
          produces: [],
          consumes: ['A-OUTPUT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateConsumesGlobal(capMap);
    const aOutputErrors = errors.filter((e) => e.includes('A-OUTPUT.md'));
    assert.deepEqual(aOutputErrors, [], 'Cap B consuming A-OUTPUT at execute:pre should be accepted, got: ' + JSON.stringify(aOutputErrors));
  });

  test('consuming an artifact that is never produced is rejected', () => {
    const cap = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: [],
          consumes: ['NONEXISTENT-ARTIFACT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: NONEXISTENT-ARTIFACT.md is never produced');
    assert.ok(errors.some((e) => e.includes('NONEXISTENT-ARTIFACT.md')));
    assert.ok(errors.some((e) => e.includes('never produced')));
  });

  test('same-point consumer of cross-cap artifact is accepted (topo handles intra-point order)', () => {
    // Cap B at plan:pre consumes A-OUTPUT.md produced by cap A also at plan:pre.
    // Same-point is OK — topoSortSteps will ensure A runs before B.
    const capA = {
      id: 'cap-a', role: 'feature', title: 'A', description: 'A', tier: 'standard', requires: [],
      skills: ['a-skill'], agents: ['gsd-a-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'a-skill' },
          produces: ['A-PLAN-OUTPUT.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capB = {
      id: 'cap-b', role: 'feature', title: 'B', description: 'B', tier: 'standard', requires: [],
      skills: ['b-skill'], agents: ['gsd-b-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point — OK for global check; topo handles ordering
          ref: { skill: 'b-skill' },
          produces: [],
          consumes: ['A-PLAN-OUTPUT.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateConsumesGlobal(capMap);
    const outputErrors = errors.filter((e) => e.includes('A-PLAN-OUTPUT.md'));
    assert.deepEqual(outputErrors, [], 'Same-point cross-cap consume should be accepted by global check, got: ' + JSON.stringify(outputErrors));
  });
});

// ─── 10. C3: role:runtime validation ─────────────────────────────────────────

describe('C3: role:runtime body validation', () => {
  // ADR-1016 phase 5a: fixture updated to match tightened structured-value shapes.
  // configHome is now an object (Decision 1), artifactLayout is { global, local } (Decision 3),
  // commandStyle is closed enum (Decision 4), hooksSurface is closed enum (Decision 5).
  const VALID_RUNTIME_CAP = {
    id: 'cursor', role: 'runtime', version: '1.0.0', title: 'Cursor', description: 'Cursor IDE runtime',
    tier: 'standard', requires: [],
    runtime: {
      configHome: { kind: 'dot-home', name: '.cursor', env: ['CURSOR_CONFIG_DIR'] },
      localConfigDir: '.cursor',
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'cursor-hooks-json',
      hookEvents: 'claude',
      sandboxTier: 'none',
      supportTier: 2,
      installSurface: 'cursor-hooks-json',
      writesSharedSettings: false,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'declarative',
        commandSurface: 'slash-file',
        dispatch: { namedDispatch: true, nested: true, maxDepth: 2, background: false, subagentToolkit: 'full', backgroundDispatch: false },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
  };

  test('valid runtime descriptor passes validation', () => {
    const errors = validateCapability(VALID_RUNTIME_CAP, 'cursor');
    assert.deepEqual(errors, [], 'Expected no validation errors for valid runtime cap, got: ' + JSON.stringify(errors));
  });

  test('runtime cap with skills present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, skills: ['some-skill'] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('skills') && e.includes('feature-only')));
  });

  test('runtime cap with steps present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, steps: [] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('steps') && e.includes('feature-only')));
  });

  test('runtime cap with contributions present is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, contributions: [] };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('contributions') && e.includes('feature-only')));
  });

  test('runtime cap missing the runtime object is rejected', () => {
    const { runtime: _r, ...capWithoutRuntime } = VALID_RUNTIME_CAP;
    const errors = validateCapability(capWithoutRuntime, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('runtime') && e.includes('object')));
  });

  test('runtime cap with invalid configFormat is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, configFormat: 'xml' } };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('configFormat')));
  });

  test('runtime cap with supportTier 3 is rejected', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, supportTier: 3 } };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('supportTier')));
  });

  test('runtime cap with supportTier 1 is accepted', () => {
    const cap = { ...VALID_RUNTIME_CAP, runtime: { ...VALID_RUNTIME_CAP.runtime, supportTier: 1 } };
    const errors = validateCapability(cap, 'cursor');
    assert.deepEqual(errors, [], 'Expected no errors for supportTier:1, got: ' + JSON.stringify(errors));
  });
});

// ─── 11. C4: description and hooks validation ─────────────────────────────────

describe('C4: description and hooks validation', () => {
  test('missing description is rejected', () => {
    const { description: _d, ...capWithoutDesc } = UI_CAP;
    const errors = validateCapability(capWithoutDesc, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for missing description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('hooks = 42 (non-array) is rejected', () => {
    const cap = { ...UI_CAP, hooks: 42 };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hooks = 42');
    assert.ok(errors.some((e) => e.includes('hooks') && e.includes('array')));
  });

  test('hooks with malformed entry (missing event) is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ script: 'some.sh' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hook missing event');
    assert.ok(errors.some((e) => e.includes('hooks[0].event')));
  });

  test('hooks with malformed entry (missing script) is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'FileChanged' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for hook missing script');
    assert.ok(errors.some((e) => e.includes('hooks[0].script')));
  });

  test('valid hooks array with well-formed entry is accepted', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'FileChanged', script: 'hooks/file-changed.sh' }] };
    const errors = validateCapability(cap, 'ui');
    const hookErrors = errors.filter((e) => e.includes('hooks['));
    assert.deepEqual(hookErrors, [], 'Expected no hook errors for valid hooks entry, got: ' + JSON.stringify(hookErrors));
  });

  // ─── #1460 (R) HIGH: hook script path must be shell-safe ──────────────────
  // The hook `script` is resolved to an absolute path and written verbatim as the hook
  // `command` STRING in settings.json (consumed by a shell). A manifest-controlled script
  // name containing shell metacharacters (`;`, `|`, `$`, backtick, whitespace, …) would
  // inject a second command at hook-exec time. Fail closed at the validator: reject any
  // script path outside the conservative [A-Za-z0-9._/-] allowlist. revert-fails: without
  // the allowlist these all pass the non-empty-string check and validate OK.
  for (const [label, script] of [
    ['command-injection via `;`', 'run.sh; touch /tmp/pwn'],
    ['embedded space', 'my hook.sh'],
    ['command substitution `$( )`', 'run-$(whoami).sh'],
    ['backtick substitution', 'run-`id`.sh'],
    ['pipe metacharacter', 'a.sh|b.sh'],
    ['newline injection', 'a.sh\ntouch /tmp/pwn'],
    ['ampersand background', 'a.sh & evil'],
    ['shell glob', 'hooks/*.sh'],
    ['redirect', 'a.sh > /tmp/pwn'],
    ['leading dash (option injection)', '-rf'],
    ['single quote', "a'.sh"],
    ['double quote', 'a".sh'],
    ['NUL/control char', 'a\u0000.sh'],
  ]) {
    test(`hook script with unsafe chars is rejected (${label})`, () => {
      const cap = { ...UI_CAP, hooks: [{ event: 'PostToolUse', script }] };
      const errors = validateCapability(cap, 'ui');
      const hookErrors = errors.filter((e) => e.includes('hooks[0].script'));
      assert.ok(
        hookErrors.length > 0,
        `Expected a hooks[0].script rejection for ${label} (script=${JSON.stringify(script)}), got: ` + JSON.stringify(errors),
      );
      assert.ok(
        hookErrors.some((e) => /unsafe character/.test(e)),
        'Error should mention unsafe characters, got: ' + JSON.stringify(hookErrors),
      );
    });
  }

  test('hook script with absolute path is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PostToolUse', script: '/etc/evil.sh' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('hooks[0].script')), 'absolute script must be rejected: ' + JSON.stringify(errors));
  });

  test('hook script with .. traversal is rejected', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PostToolUse', script: '../../etc/evil.sh' }] };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.some((e) => e.includes('hooks[0].script')), '.. script must be rejected: ' + JSON.stringify(errors));
  });

  test('hook script with a normal nested relative path is still accepted', () => {
    const cap = { ...UI_CAP, hooks: [{ event: 'PostToolUse', script: 'hooks/sub-dir/format_v2.sh' }] };
    const errors = validateCapability(cap, 'ui');
    const hookErrors = errors.filter((e) => e.includes('hooks[0].script'));
    assert.deepEqual(hookErrors, [], 'Expected a normal nested relative script to be accepted, got: ' + JSON.stringify(hookErrors));
  });

  test('description present in UI_CAP passes validation', () => {
    const errors = validateCapability(UI_CAP, 'ui');
    const descErrors = errors.filter((e) => e.includes('description'));
    assert.deepEqual(descErrors, [], 'UI_CAP should have valid description, got: ' + JSON.stringify(descErrors));
  });
});

// ─── 12. C5: config value shape validation ────────────────────────────────────

describe('C5: config value shape validation', () => {
  test('config value that is null is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_null_test': null };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for null config value');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_null_test') && e.includes('null')),
      'Error should mention the key and null, got: ' + JSON.stringify(errors),
    );
  });

  test('config value that is a string scalar is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_bad': 'just-a-string' };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for scalar string config value');
    assert.ok(errors.some((e) => e.includes('workflow.ui_bad') && e.includes('object')));
  });

  test('config value that is a number is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_num': 42 };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('workflow.ui_num') && e.includes('object')));
  });

  test('config value that is a proper object is accepted', () => {
    // UI_CAP config values are all valid objects — validate it
    const errors = validateCapability(UI_CAP, 'ui');
    const configErrors = errors.filter((e) => e.includes('config['));
    assert.deepEqual(configErrors, [], 'UI_CAP config values should all be valid objects, got: ' + JSON.stringify(configErrors));
  });

  test('config value {} (empty object, missing type) is rejected', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_no_type': {} };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    assert.ok(errors.length > 0, 'Expected rejection for config value with no type field');
    assert.ok(
      errors.some((e) => e.includes('workflow.ui_no_type') && e.includes('type')),
      'Error should mention the key and "type", got: ' + JSON.stringify(errors),
    );
  });

  test('config value { type: "boolean", default: true } is accepted', () => {
    const config = { ...UI_CAP.config, 'workflow.ui_good': { type: 'boolean', default: true } };
    const cap = { ...UI_CAP, config };
    const errors = validateCapability(cap, 'ui');
    const configErrors = errors.filter((e) => e.includes('workflow.ui_good'));
    assert.deepEqual(configErrors, [], 'config value with type:"boolean" and default should be accepted, got: ' + JSON.stringify(configErrors));
  });

  test('UI pilot config values all have type:"boolean" and pass FIX 2 validation', () => {
    // Regression guard: UI_CAP config keys (workflow.ui_phase etc.) all have type:"boolean"
    const errors = validateCapability(UI_CAP, 'ui');
    const configErrors = errors.filter((e) => e.includes('config['));
    assert.deepEqual(
      configErrors, [],
      'UI pilot config values should all pass type-field validation, got: ' + JSON.stringify(configErrors),
    );
    // Directly confirm each key has type:"boolean"
    for (const [key, val] of Object.entries(UI_CAP.config)) {
      assert.strictEqual(typeof val.type, 'string', 'config["' + key + '"].type should be a string');
      assert.strictEqual(val.type, 'boolean', 'config["' + key + '"].type should be "boolean"');
    }
  });
});

// ─── 13. FIX 1: self-consume rejection ───────────────────────────────────────

describe('FIX 1: self-consume rejection in validateConsumesGlobal', () => {
  test('a step produces:["SELF.md"] and consumes:["SELF.md"] with no other producer is rejected', () => {
    const cap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Self consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'self-skill' },
          produces: ['SELF.md'],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['self-cap', cap]]);
    const errors = validateConsumesGlobal(capMap);
    assert.ok(errors.length > 0, 'Expected rejection: step cannot consume its own output');
    assert.ok(
      errors.some((e) => e.includes('SELF.md')),
      'Error should mention SELF.md, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      errors.some((e) => e.includes('self') || e.includes('itself') || e.includes('own output')),
      'Error should indicate self-consume violation, got: ' + JSON.stringify(errors),
    );
  });

  test('a step produces:["SELF.md"] and consumes:["SELF.md"] but another capability produces SELF.md at an earlier point is accepted', () => {
    const producerCap = {
      id: 'producer-cap', role: 'feature', title: 'Producer', description: 'Produces SELF.md',
      tier: 'standard', requires: [],
      skills: ['producer-skill'], agents: ['gsd-producer-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point, but different cap — satisfies self-cap's consume
          ref: { skill: 'producer-skill' },
          produces: ['SELF.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const selfCap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Self consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'execute:pre',  // later point than plan:pre — producer-cap satisfies it
          ref: { skill: 'self-skill' },
          produces: ['SELF.md'],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['producer-cap', producerCap], ['self-cap', selfCap]]);
    const errors = validateConsumesGlobal(capMap);
    const selfErrors = errors.filter((e) => e.includes('SELF.md') && e.includes('self-cap'));
    assert.deepEqual(
      selfErrors, [],
      'Expected self-cap consume of SELF.md to be accepted when producer-cap produces it at an earlier point, got: ' + JSON.stringify(selfErrors),
    );
  });

  // (this test follows the series above)
  // Updated fixture: producer-cap produces SELF.md at plan:pre; self-cap CONSUMES (not produces)
  // SELF.md at plan:pre — a single producer at that point satisfies the consume.
  // The prior fixture had BOTH caps producing SELF.md at plan:pre, which now violates the
  // duplicate-producer invariant added in Issue #1123. The consume-satisfiability logic being
  // tested here is unaffected — the key assertion remains: a step consuming an artifact that
  // a DIFFERENT cap produces at the SAME point is satisfied.
  test('a step consumes:["SELF.md"] and another capability produces SELF.md at the SAME point is accepted (different cap)', () => {
    const producerCap = {
      id: 'producer-cap', role: 'feature', title: 'Producer', description: 'Produces SELF.md',
      tier: 'standard', requires: [],
      skills: ['producer-skill'], agents: ['gsd-producer-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'producer-skill' },
          produces: ['SELF.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const consumerCap = {
      id: 'self-cap', role: 'feature', title: 'Self', description: 'Consume test',
      tier: 'standard', requires: [],
      skills: ['self-skill'], agents: ['gsd-self-agent'], hooks: [], config: {},
      steps: [
        {
          point: 'plan:pre',  // same point — producer-cap (different cap) satisfies the consume
          ref: { skill: 'self-skill' },
          produces: [],
          consumes: ['SELF.md'],
          onError: 'skip',
        },
      ],
      contributions: [], gates: [],
    };
    const capMap = new Map([['producer-cap', producerCap], ['self-cap', consumerCap]]);
    const errors = validateConsumesGlobal(capMap);
    const selfErrors = errors.filter((e) => e.includes('SELF.md') && e.includes('self-cap'));
    assert.deepEqual(
      selfErrors, [],
      'Expected self-cap consume of SELF.md to be accepted when a DIFFERENT cap produces it at the same point, got: ' + JSON.stringify(selfErrors),
    );
  });
});

// ─── 14. configSchema emission (ADR-857 phase 3b) ────────────────────────────

describe('configSchema emission (ADR-857 phase 3b)', () => {
  test('buildRegistry emits configSchema with correct shape for UI pilot', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'No errors expected');

    const registry = buildRegistry(capMap);
    assert.ok(registry.configSchema, 'registry.configSchema must exist');

    const uiPhase = registry.configSchema['workflow.ui_phase'];
    assert.ok(uiPhase, 'configSchema must have workflow.ui_phase');
    assert.strictEqual(uiPhase.owner, 'ui');
    assert.strictEqual(uiPhase.type, 'boolean');
    assert.strictEqual(uiPhase.default, true);
    assert.ok(typeof uiPhase.description === 'string' && uiPhase.description.length > 0);

    const uiReview = registry.configSchema['workflow.ui_review'];
    assert.ok(uiReview, 'configSchema must have workflow.ui_review');
    assert.strictEqual(uiReview.owner, 'ui');
    assert.strictEqual(uiReview.type, 'boolean');

    const uiSafetyGate = registry.configSchema['workflow.ui_safety_gate'];
    assert.ok(uiSafetyGate, 'configSchema must have workflow.ui_safety_gate');
    assert.strictEqual(uiSafetyGate.type, 'boolean');
  });

  test('serializeRegistry emits a configSchema block in the generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);

    assert.ok(content.includes('const configSchema'), 'Generated file must contain "const configSchema"');
    assert.ok(content.includes('"workflow.ui_phase"'), 'Generated file must contain "workflow.ui_phase"');
    assert.ok(content.includes('"owner"'), 'Generated file must contain "owner" field');
    assert.ok(content.includes('"type"'), 'Generated file must contain "type" field');
    assert.ok(content.includes('"default"'), 'Generated file must contain "default" field');
    assert.ok(content.includes('"description"'), 'Generated file must contain "description" field');
    assert.ok(content.includes('configSchema,'), 'Generated module.exports must include configSchema');
  });

  test('committed capability-registry.cjs has configSchema with correct shape', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.configSchema, 'capability-registry.cjs must export configSchema');

    const uiPhase = registry.configSchema['workflow.ui_phase'];
    assert.ok(uiPhase, 'committed registry configSchema must have workflow.ui_phase');
    assert.strictEqual(uiPhase.owner, 'ui', 'owner must be "ui"');
    assert.strictEqual(uiPhase.type, 'boolean', 'type must be "boolean"');
    assert.strictEqual(uiPhase.default, true, 'default must be true');
    assert.ok(typeof uiPhase.description === 'string' && uiPhase.description.length > 0);
  });
});

// ─── 15. validateConfigSliceEntry adversarial tests ───────────────────────────

describe('validateConfigSliceEntry adversarial cases (ADR-857 phase 3b)', () => {
  const CAP_ID = 'test-cap';
  const KEY = 'test.key';

  test('VALID_CONFIG_SLICE_TYPES exports expected types', () => {
    const types = [...VALID_CONFIG_SLICE_TYPES];
    assert.ok(types.includes('boolean'), 'Must include boolean');
    assert.ok(types.includes('string'), 'Must include string');
    assert.ok(types.includes('number'), 'Must include number');
    assert.ok(types.includes('enum'), 'Must include enum');
    assert.strictEqual(types.length, 4, 'Must have exactly 4 types');
  });

  test('valid boolean slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: 'ok' });
    assert.deepEqual(errors, [], 'Valid boolean slice should produce no errors, got: ' + JSON.stringify(errors));
  });

  test('valid string slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'string', default: 'x', description: 'ok' });
    assert.deepEqual(errors, []);
  });

  test('valid number slice passes validation', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: 5, description: 'ok' });
    assert.deepEqual(errors, []);
  });

  test('REJECTED: enum slice without values list → error (FIX 5a: values required)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum without values list, got: ' + JSON.stringify(errors));
    assert.ok(
      errors.some((e) => e.includes('values') || e.includes('enum')),
      'Error should mention values or enum, got: ' + JSON.stringify(errors),
    );
  });

  test('valid enum slice (with values list, default in values) passes', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, {
      type: 'enum', default: 'b', values: ['a', 'b', 'c'], description: 'ok',
    });
    assert.deepEqual(errors, []);
  });

  test('REJECTED: bad type ("xml") → error mentioning type', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'xml', default: '<x/>', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for bad type');
    assert.ok(errors.some((e) => e.includes('type')), 'Error should mention type, got: ' + JSON.stringify(errors));
  });

  test('REJECTED: missing type → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { default: true, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for missing type');
    assert.ok(errors.some((e) => e.includes('type')));
  });

  test('REJECTED: missing default → error mentioning default', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for missing default');
    assert.ok(errors.some((e) => e.includes('default')), 'Error should mention default, got: ' + JSON.stringify(errors));
  });

  test('REJECTED: boolean type with string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: 'true', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for boolean type with string default');
    assert.ok(errors.some((e) => e.includes('boolean') || e.includes('default')));
  });

  test('REJECTED: string type with boolean default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'string', default: false, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for string type with boolean default');
  });

  test('REJECTED: number type with string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: 'five', description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for number type with string default');
  });

  test('REJECTED: enum type with values list, default not in values → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, {
      type: 'enum', default: 'z', values: ['a', 'b', 'c'], description: 'ok',
    });
    assert.ok(errors.length > 0, 'Expected rejection for enum default not in values');
    assert.ok(errors.some((e) => e.includes('enum') || e.includes('values') || e.includes('z')));
  });

  test('REJECTED: enum type with non-string default → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 42, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with non-string default');
  });

  test('REJECTED: empty description string → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: '' });
    assert.ok(errors.length > 0, 'Expected rejection for empty description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: non-string description (number) → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true, description: 42 });
    assert.ok(errors.length > 0, 'Expected rejection for non-string description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: missing description → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'boolean', default: true });
    assert.ok(errors.length > 0, 'Expected rejection for missing description');
    assert.ok(errors.some((e) => e.includes('description')));
  });

  test('REJECTED: null slice → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, null);
    assert.ok(errors.length > 0, 'Expected rejection for null slice');
  });

  test('REJECTED: array slice → error', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, []);
    assert.ok(errors.length > 0, 'Expected rejection for array slice');
  });

  // FIX 5a: enum-without-values and default-not-in-values
  test('REJECTED: enum with empty values array → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', values: [], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with empty values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('values') || e.includes('enum')));
  });

  test('REJECTED: enum with non-string values array entries → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'x', values: ['a', 42], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum with non-string values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('values') || e.includes('string')));
  });

  test('REJECTED: enum default not in values → error (FIX 5a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'enum', default: 'z', values: ['a', 'b'], description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for enum default not in values, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('z') || e.includes('values') || e.includes('default')));
  });

  // FIX 6a: NaN and non-finite number defaults
  test('REJECTED: NaN number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: NaN, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for NaN default, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('finite') || e.includes('NaN') || e.includes('number')));
  });

  test('REJECTED: Infinity number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: Infinity, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for Infinity default, got: ' + JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('finite') || e.includes('number')));
  });

  test('REJECTED: -Infinity number default → error (FIX 6a)', () => {
    const errors = validateConfigSliceEntry(CAP_ID, KEY, { type: 'number', default: -Infinity, description: 'ok' });
    assert.ok(errors.length > 0, 'Expected rejection for -Infinity default, got: ' + JSON.stringify(errors));
  });

  test('buildRegistry throws on malformed config slice in capability', () => {
    // A capability with a config slice that has a missing default — buildRegistry must throw
    const cap = {
      ...UI_CAP,
      config: {
        ...UI_CAP.config,
        'workflow.bad_key': { type: 'boolean', description: 'missing default' },
      },
    };
    const capMap = new Map([['ui', cap]]);
    assert.throws(
      () => buildRegistry(capMap),
      (err) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.ok(
          err.message.includes('configSchema') || err.message.includes('default') || err.message.includes('validation'),
          'Error must mention configSchema validation, got: ' + err.message,
        );
        return true;
      },
    );
  });
});

// ─── 16. ADR-857 phase 4a: capabilityClusters + profileMembership ─────────────

// Minimal valid feature capability for synthetic tests
function makeSyntheticCap(id, tier, skills) {
  return {
    id,
    role: 'feature',
    title: id,
    description: 'Synthetic cap for testing',
    tier,
    requires: [],
    skills: [...skills],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
}

describe('ADR-857 phase 4a: capabilityClusters shape', () => {
  test('ui capabilityClusters → [ui-phase, ui-review]', () => {
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(clusters.ui, 'capabilityClusters.ui should exist');
    // Skills are sorted for determinism
    assert.deepEqual(
      clusters.ui,
      ['ui-phase', 'ui-review'],
      'ui cluster should be [ui-phase, ui-review], got: ' + JSON.stringify(clusters.ui),
    );
  });

  test('capabilityClusters skips runtime capabilities (no skills)', () => {
    const runtimeCap = {
      id: 'cursor', role: 'runtime', title: 'Cursor', description: 'Cursor runtime',
      tier: 'standard', requires: [],
      runtime: {
        configHome: '~/.cursor', configFormat: 'settings-json',
        artifactLayout: [], commandStyle: 'slash', hooksSurface: 'rules',
        sandboxTier: 'none', supportTier: 2,
      },
    };
    const capMap = new Map([['cursor', runtimeCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(!clusters.cursor, 'runtime cap should not appear in capabilityClusters');
  });

  test('capabilityClusters skills are sorted for determinism', () => {
    const cap = makeSyntheticCap('test-cap', 'standard', ['z-skill', 'a-skill', 'm-skill']);
    const capMap = new Map([['test-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.deepEqual(
      clusters['test-cap'],
      ['a-skill', 'm-skill', 'z-skill'],
      'Skills should be sorted alphabetically, got: ' + JSON.stringify(clusters['test-cap']),
    );
  });

  test('buildRegistry includes capabilityClusters with correct ui value', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.capabilityClusters, 'registry.capabilityClusters should exist');
    assert.deepEqual(
      registry.capabilityClusters.ui,
      ['ui-phase', 'ui-review'],
      'registry.capabilityClusters.ui should be [ui-phase, ui-review]',
    );
  });

  test('serializeRegistry emits capabilityClusters block in generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(content.includes('const capabilityClusters'), 'Generated file must contain "const capabilityClusters"');
    assert.ok(content.includes('"ui-phase"'), 'Generated file must contain "ui-phase" in capabilityClusters');
    assert.ok(content.includes('capabilityClusters,'), 'module.exports must include capabilityClusters');
  });

  test('committed capability-registry.cjs has capabilityClusters with ui=[ui-phase,ui-review]', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.capabilityClusters, 'capability-registry.cjs must export capabilityClusters');
    assert.deepEqual(
      registry.capabilityClusters.ui,
      ['ui-phase', 'ui-review'],
      'committed capabilityClusters.ui should be [ui-phase, ui-review]',
    );
  });
});

describe('ADR-857 phase 4a: capabilityClusters HARD consistency gate', () => {
  test('synthetic cap whose capId matches a CLUSTERS name but with different skills throws', () => {
    // The 'ui' name exists in CLUSTERS with ['ui-phase', 'ui-review'].
    // A synthetic 'ui' cap with only ['ui-phase'] (missing 'ui-review') must throw.
    const wrongUiCap = makeSyntheticCap('ui', 'standard', ['ui-phase']); // missing ui-review
    const capMap = new Map([['ui', wrongUiCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.throws(
      () => runConsistencyGate(clusters, profiles, capMap),
      (err) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.ok(
          err.message.includes('ui'),
          'Error must name the capId, got: ' + err.message,
        );
        assert.ok(
          err.message.includes('ui-review') || err.message.includes('derived set') || err.message.includes('hand-authored'),
          'Error must describe the mismatch, got: ' + err.message,
        );
        return true;
      },
    );
  });

  test('cap with capId that has NO matching CLUSTERS entry is accepted (new cluster — fine)', () => {
    // A new capability 'payments' that has no CLUSTERS entry must NOT throw
    const newCap = makeSyntheticCap('payments', 'standard', ['pay-phase', 'pay-review']);
    const capMap = new Map([['payments', newCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    // Must not throw
    assert.doesNotThrow(
      () => runConsistencyGate(clusters, profiles, capMap),
      'A cap with no matching CLUSTERS entry should not throw (new cluster is fine)',
    );
  });

  test('HARD gate: extra skill in derived set (more than hand-authored) also throws', () => {
    // 'ui' cap with an extra skill triggers the mismatch
    const extraUiCap = makeSyntheticCap('ui', 'standard', ['ui-phase', 'ui-review', 'ui-extra']);
    const capMap = new Map([['ui', extraUiCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.throws(
      () => runConsistencyGate(clusters, profiles, capMap),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('ui'), 'Error must name the capId');
        return true;
      },
    );
  });
});

describe('ADR-857 phase 4a: profileMembership derivation', () => {
  test('tier core → profiles [core, standard, full]', () => {
    const cap = makeSyntheticCap('core-cap', 'core', ['core-skill']);
    const capMap = new Map([['core-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['core-cap'], 'profileMembership should have core-cap');
    assert.strictEqual(profiles['core-cap'].tier, 'core');
    assert.deepEqual(
      profiles['core-cap'].profiles,
      ['core', 'standard', 'full'],
      'core tier should produce [core, standard, full], got: ' + JSON.stringify(profiles['core-cap'].profiles),
    );
  });

  test('tier standard → profiles [standard, full]', () => {
    const cap = makeSyntheticCap('std-cap', 'standard', ['std-skill']);
    const capMap = new Map([['std-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['std-cap'], 'profileMembership should have std-cap');
    assert.strictEqual(profiles['std-cap'].tier, 'standard');
    assert.deepEqual(
      profiles['std-cap'].profiles,
      ['standard', 'full'],
      'standard tier should produce [standard, full], got: ' + JSON.stringify(profiles['std-cap'].profiles),
    );
  });

  test('tier full → profiles [full]', () => {
    const cap = makeSyntheticCap('full-cap', 'full', ['full-skill']);
    const capMap = new Map([['full-cap', cap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(profiles['full-cap'], 'profileMembership should have full-cap');
    assert.strictEqual(profiles['full-cap'].tier, 'full');
    assert.deepEqual(
      profiles['full-cap'].profiles,
      ['full'],
      'full tier should produce [full], got: ' + JSON.stringify(profiles['full-cap'].profiles),
    );
  });

  test('PROFILE_RANK is imported (not hardcoded): all three tiers covered', () => {
    // Verify PROFILE_RANK is the canonical ['core', 'standard', 'full'] from install-profiles.cjs
    assert.deepEqual(
      PROFILE_RANK,
      ['core', 'standard', 'full'],
      'PROFILE_RANK must be [core, standard, full] from install-profiles.cjs, got: ' + JSON.stringify(PROFILE_RANK),
    );
  });

  test('ui cap (tier full after reconciliation) profileMembership is [full]', () => {
    // ADR-857 phase 4c: ui tier changed from standard → full
    const capMap = new Map([['ui', UI_CAP]]);
    const profiles = deriveProfileMembership(capMap);
    assert.deepEqual(
      profiles.ui.profiles,
      ['full'],
      'ui (tier full) should have profiles [full] after reconciliation',
    );
  });

  test('buildRegistry includes profileMembership with correct ui value', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.profileMembership, 'registry.profileMembership should exist');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profiles: ['full'] only
    assert.deepEqual(
      registry.profileMembership.ui,
      { tier: 'full', profiles: ['full'] },
      'profileMembership.ui should be { tier: full, profiles: [full] } after reconciliation',
    );
  });

  test('serializeRegistry emits profileMembership block in generated .cjs', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(content.includes('const profileMembership'), 'Generated file must contain "const profileMembership"');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profileMembership contains "full"
    assert.ok(content.includes('"full"'), 'Generated file must contain "full" in profileMembership');
    assert.ok(content.includes('profileMembership,'), 'module.exports must include profileMembership');
  });

  test('committed capability-registry.cjs has profileMembership with correct ui value', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.ok(registry.profileMembership, 'capability-registry.cjs must export profileMembership');
    // After ADR-857 phase 4c reconciliation: ui is tier:full → profiles: ['full'] only
    assert.deepEqual(
      registry.profileMembership.ui,
      { tier: 'full', profiles: ['full'] },
      'committed profileMembership.ui should be { tier: full, profiles: [full] } after reconciliation',
    );
  });
});

describe('ADR-857 phase 4a: pending-reconciliation warnings (SOFT gate)', () => {
  test('ui (tier full) generates ZERO pending-reconciliation warnings (ADR-857 phase 4c reconciliation)', () => {
    // After reconciliation: ui is tier:full. The full profile is '*' (every skill).
    // The consistency gate must NOT fire for full-tier capabilities — their skills are
    // always present in the full profile by definition.
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const uiPhaseWarn = warnings.find((w) => w.includes('ui-phase'));
    const uiReviewWarn = warnings.find((w) => w.includes('ui-review'));
    assert.ok(
      !uiPhaseWarn,
      'No pending-reconciliation warning expected for ui-phase (tier:full), got: ' + JSON.stringify(warnings),
    );
    assert.ok(
      !uiReviewWarn,
      'No pending-reconciliation warning expected for ui-review (tier:full), got: ' + JSON.stringify(warnings),
    );
  });

  test('ui reconciled: profileMembership.ui.profiles is ["full"] after tier:full reconciliation', () => {
    // After reconciliation: ui is tier:full → profileMembership.ui.profiles = ['full'] only.
    // ui-phase/ui-review are correctly absent from core/standard (they're full-only features).
    // No pending-reconciliation warning fires because full='*' always satisfies the gate.
    const capMap = new Map([['ui', UI_CAP]]);
    const profiles = deriveProfileMembership(capMap);
    assert.deepStrictEqual(
      profiles.ui.profiles,
      ['full'],
      'After tier:full reconciliation, ui profileMembership should be ["full"] only',
    );
    assert.strictEqual(
      profiles.ui.tier,
      'full',
      'ui tier should be "full" after reconciliation',
    );

    // Confirm ui-phase is NOT in standard profile — that's expected and correct for full-tier skills.
    const { resolveProfile: rp } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const resolved = rp({ modes: ['standard'], manifest: new Map() });
    assert.ok(
      resolved.skills !== '*',
      'standard profile should not be full',
    );
    assert.ok(
      !resolved.skills.has('ui-phase'),
      'ui-phase should NOT be in hand-authored standard profile (correctly full-only after reconciliation)',
    );
    assert.ok(
      !resolved.skills.has('ui-review'),
      'ui-review should NOT be in hand-authored standard profile (correctly full-only after reconciliation)',
    );
  });

  test('SOFT gate does NOT throw — only returns warnings', () => {
    // Even with reconciliation gaps, runConsistencyGate must NOT throw
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    let warnings;
    assert.doesNotThrow(
      () => { warnings = runConsistencyGate(clusters, profiles, capMap); },
      'SOFT gate must not throw — only collect warnings',
    );
    assert.ok(Array.isArray(warnings), 'runConsistencyGate must return an array');
  });

  test('buildRegistry._reconciliationWarnings is empty for reconciled ui (tier:full)', () => {
    // After reconciliation: ui is tier:full → no pending-reconciliation warnings.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(
      Array.isArray(registry._reconciliationWarnings),
      'registry._reconciliationWarnings should be an array',
    );
    const uiWarnings = registry._reconciliationWarnings.filter(
      (w) => w.includes('ui-phase') || w.includes('ui-review')
    );
    assert.deepStrictEqual(
      uiWarnings,
      [],
      'No reconciliation warnings expected for reconciled ui capability, got: ' + JSON.stringify(uiWarnings),
    );
  });

  test('reconciliation warnings are NOT in serialized registry output (determinism gate)', () => {
    // Warnings must appear ONLY on stderr, not in the generated .cjs file
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);
    assert.ok(
      !content.includes('pending-reconciliation'),
      'Serialized registry must NOT contain "pending-reconciliation" text (warnings are stderr-only)',
    );
    assert.ok(
      !content.includes('_reconciliationWarnings'),
      'Serialized registry must NOT contain _reconciliationWarnings key',
    );
  });

  test('a cap whose skill IS already in the standard profile emits no reconciliation warning', () => {
    // 'plan-phase' IS in the hand-authored standard profile. A synthetic cap
    // with tier=standard and skill=plan-phase should NOT generate a warning.
    const cap = makeSyntheticCap('planner-cap', 'standard', ['plan-phase']);
    const capMap = new Map([['planner-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const planPhaseWarnings = warnings.filter((w) => w.includes('plan-phase'));
    assert.deepEqual(
      planPhaseWarnings, [],
      'No reconciliation warning expected for plan-phase (already in standard profile), got: ' + JSON.stringify(planPhaseWarnings),
    );
  });

  test('a core-tier cap with skills already in core profile emits no reconciliation warning', () => {
    // 'new-project' IS in the hand-authored core profile.
    const cap = makeSyntheticCap('np-cap', 'core', ['new-project']);
    const capMap = new Map([['np-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const npWarnings = warnings.filter((w) => w.includes('new-project'));
    assert.deepEqual(
      npWarnings, [],
      'No reconciliation warning expected for new-project (already in core profile), got: ' + JSON.stringify(npWarnings),
    );
  });
});

describe('ADR-857 phase 4a: requires-closure tier-monotone (synthetic)', () => {
  test('tier-monotone: a required capability must be same-or-lower tier', () => {
    // Cap A at 'core' requiring cap B at 'standard' violates tier-monotone.
    // validateCrossCapability already tests this; here we verify the rule via
    // a profileMembership structural check: if A is core → B must have rank ≤ core.
    const capA = makeSyntheticCap('tier-a', 'core', ['a-skill']);
    capA.requires = ['tier-b'];
    const capB = makeSyntheticCap('tier-b', 'standard', ['b-skill']);
    const capMap = new Map([['tier-a', capA], ['tier-b', capB]]);

    // validateCrossCapability enforces the rule
    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    assert.ok(
      errors.some((e) => e.includes('tier-monotone')),
      'Expected tier-monotone error, got: ' + JSON.stringify(errors),
    );
  });

  test('tier-monotone: same-tier requires is accepted', () => {
    const capA = makeSyntheticCap('mono-a', 'standard', ['ma-skill']);
    capA.requires = ['mono-b'];
    const capB = makeSyntheticCap('mono-b', 'standard', ['mb-skill']);
    const capMap = new Map([['mono-a', capA], ['mono-b', capB]]);

    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    const monotoneErrors = errors.filter((e) => e.includes('tier-monotone'));
    assert.deepEqual(monotoneErrors, [], 'Same-tier requires should be accepted, got: ' + JSON.stringify(monotoneErrors));
  });

  test('tier-monotone: higher-tier requiring lower-tier is accepted (full requires core)', () => {
    const capA = makeSyntheticCap('full-a', 'full', ['fa-skill']);
    capA.requires = ['core-b'];
    const capB = makeSyntheticCap('core-b', 'core', ['cb-skill']);
    const capMap = new Map([['full-a', capA], ['core-b', capB]]);

    const { validateCrossCapability: vcc } = require('../scripts/gen-capability-registry.cjs');
    const errors = vcc(capMap, new Set());
    const monotoneErrors = errors.filter((e) => e.includes('tier-monotone'));
    assert.deepEqual(
      monotoneErrors, [],
      'full requiring core should be accepted (higher tier can require lower tier), got: ' + JSON.stringify(monotoneErrors),
    );
  });
});

describe('ADR-857 phase 4a: --check determinism after --write', () => {
  test('serializeRegistry produces identical output for two calls (determinism)', () => {
    // Regression guard: --check would fail if output is non-deterministic
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content1 = serializeRegistry(registry, capMap);
    const content2 = serializeRegistry(registry, capMap);
    assert.strictEqual(content1, content2, 'serializeRegistry output must be deterministic');
  });
});

// ─── 17. FIX 1: SOFT gate uses real manifest for requires-closure expansion ────

describe('FIX 1: SOFT gate uses closure-resolved manifest (not empty)', () => {
  test('plan-phase is transitively in standard — no reconciliation warning', () => {
    // plan-phase is in PROFILES.standard directly; resolved (with real manifest) = in standard.
    // A standard-tier cap with skill=plan-phase must NOT generate a reconciliation warning.
    const cap = makeSyntheticCap('plan-cap', 'standard', ['plan-phase']);
    const capMap = new Map([['plan-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const planWarnings = warnings.filter((w) => w.includes('plan-phase'));
    assert.deepEqual(
      planWarnings, [],
      'plan-phase is in standard profile — no warning expected, got: ' + JSON.stringify(planWarnings),
    );
  });

  test('FIX 1: skill only transitively in standard (requires-closure) emits no warning', () => {
    // 'code-review' is brought into standard via requires-closure expansion (not in raw base).
    // FIX 1 ensures the real manifest is used, so no false-positive warning is emitted.
    const cap = makeSyntheticCap('cr-cap', 'standard', ['code-review']);
    const capMap = new Map([['cr-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const crWarnings = warnings.filter((w) => w.includes('code-review'));
    assert.deepEqual(
      crWarnings, [],
      'code-review is transitively in standard via requires-closure — no warning expected, got: ' + JSON.stringify(crWarnings),
    );
  });
});

// ─── 18. FIX 2: globally-sorted capId emission ───────────────────────────────

describe('FIX 2: globally-sorted capId emission (determinism with mixed feature+runtime)', () => {
  test('feature cap "analytics" and feature cap "ui" are globally sorted in serialized output', () => {
    // "analytics" < "ui" alphabetically — must appear first in both derived views
    const analyticsCap = makeSyntheticCap('analytics', 'standard', ['analytics-skill']);
    const capDir = makeTempCapDir({ analytics: analyticsCap, ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const content = serializeRegistry(registry, capMap);

    // Find the positions of "analytics" and "ui" in the capabilityClusters block
    const clustersStart = content.indexOf('const capabilityClusters');
    const clustersEnd = content.indexOf('const profileMembership');
    const clustersBlock = content.slice(clustersStart, clustersEnd);

    const analyticsPos = clustersBlock.indexOf('"analytics"');
    const uiPos = clustersBlock.indexOf('"ui"');
    assert.ok(
      analyticsPos < uiPos,
      'analytics must appear before ui in capabilityClusters (global alphabetical sort)',
    );

    // Same check for profileMembership
    const profileStart = content.indexOf('const profileMembership');
    const profileEnd = content.indexOf('const _requiresGraph');
    const profileBlock = content.slice(profileStart, profileEnd);

    const analyticsProfilePos = profileBlock.indexOf('"analytics"');
    const uiProfilePos = profileBlock.indexOf('"ui"');
    assert.ok(
      analyticsProfilePos < uiProfilePos,
      'analytics must appear before ui in profileMembership (global alphabetical sort)',
    );
  });

  test('serialized output is stable across two calls (determinism)', () => {
    const analyticsCap = makeSyntheticCap('analytics', 'standard', ['analytics-skill']);
    const capDir = makeTempCapDir({ analytics: analyticsCap, ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    const s1 = serializeRegistry(registry, capMap);
    const s2 = serializeRegistry(registry, capMap);
    assert.strictEqual(s1, s2, 'Two serializeRegistry calls must produce identical output');
  });
});

// ─── 19. FIX 3: consistent role scoping across both derived views ─────────────

describe('FIX 3: consistent scope — capabilities that own skills', () => {
  test('feature cap with empty skills does not appear in capabilityClusters', () => {
    // A feature cap with an empty skills array must NOT appear in capabilityClusters
    const emptySkillsCap = {
      id: 'empty-skills', role: 'feature', title: 'Empty', description: 'No skills',
      tier: 'standard', requires: [],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['empty-skills', emptySkillsCap]]);
    const clusters = deriveCapabilityClusters(capMap);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(clusters, 'empty-skills'),
      'Cap with empty skills array must not appear in capabilityClusters',
    );
  });

  test('feature cap with empty skills does not appear in profileMembership', () => {
    // FIX 3: profileMembership must also exclude caps with no skills (consistent scope)
    const emptySkillsCap = {
      id: 'empty-skills', role: 'feature', title: 'Empty', description: 'No skills',
      tier: 'standard', requires: [],
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    const capMap = new Map([['empty-skills', emptySkillsCap]]);
    const profiles = deriveProfileMembership(capMap);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(profiles, 'empty-skills'),
      'Cap with empty skills array must not appear in profileMembership (FIX 3: consistent scope)',
    );
  });
});

// ─── 20. FIX 4: de-duplicated reconciliation warnings ────────────────────────

describe('FIX 4: de-duplicated reconciliation warnings (one per skill, not per profile)', () => {
  test('core-tier cap with skill missing from both core and standard emits ONE warning', () => {
    // ui-phase is not in the hand-authored core or standard profiles.
    // A core-tier cap with ui-phase must emit exactly 1 warning (listing both profiles).
    const cap = makeSyntheticCap('core-ui-cap', 'core', ['ui-phase']);
    const capMap = new Map([['core-ui-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    const uiPhaseWarnings = warnings.filter((w) => w.includes('ui-phase'));
    assert.strictEqual(
      uiPhaseWarnings.length, 1,
      'Expected exactly 1 warning for ui-phase (FIX 4: one per skill, not per profile), got: ' + JSON.stringify(uiPhaseWarnings),
    );
    // Warning must list both missing profiles
    assert.ok(
      uiPhaseWarnings[0].includes('core') && uiPhaseWarnings[0].includes('standard'),
      'Warning must list both missing profiles (core and standard), got: ' + uiPhaseWarnings[0],
    );
  });

  test('standard-tier cap with skill missing from standard emits ONE warning with <standard>', () => {
    const cap = makeSyntheticCap('std-ui-cap', 'standard', ['ui-phase']);
    const capMap = new Map([['std-ui-cap', cap]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    const warnings = runConsistencyGate(clusters, profiles, capMap);
    assert.strictEqual(warnings.length, 1, 'Expected exactly 1 warning, got: ' + JSON.stringify(warnings));
    assert.ok(
      warnings[0].includes('profile(s): <standard>'),
      'Warning must use "profile(s): <standard>" format, got: ' + warnings[0],
    );
  });
});

// ─── 21. FIX 5: tierIdx -1 throws loudly ─────────────────────────────────────

describe('FIX 5: tierIdx === -1 throws loudly (VALID_TIERS/PROFILE_RANK drift guard)', () => {
  test('normal usage (standard/core/full) does not throw in deriveProfileMembership', () => {
    const cap = makeSyntheticCap('drift-test', 'standard', ['s1']);
    const capMap = new Map([['drift-test', cap]]);
    assert.doesNotThrow(
      () => deriveProfileMembership(capMap),
      'deriveProfileMembership must not throw for valid tiers',
    );
  });
});

// ─── 22. FIX 6: UI true-negative doesNotThrow ─────────────────────────────────

describe('FIX 6: runConsistencyGate does NOT throw for real UI capability (true-negative)', () => {
  test('buildRegistry with real UI cap does not throw (HARD gate true-negative)', () => {
    // The real UI cap has skills = [ui-phase, ui-review] which matches CLUSTERS.ui exactly.
    // The HARD gate must NOT throw.
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    assert.doesNotThrow(
      () => buildRegistry(capMap),
      'buildRegistry must not throw for the real UI capability (CLUSTERS match expected)',
    );
  });

  test('runConsistencyGate does NOT throw for real UI cap (cluster match true-negative)', () => {
    // Explicit doesNotThrow covering runConsistencyGate directly
    const capMap = new Map([['ui', UI_CAP]]);
    const clusters = deriveCapabilityClusters(capMap);
    const profiles = deriveProfileMembership(capMap);
    assert.doesNotThrow(
      () => runConsistencyGate(clusters, profiles, capMap),
      'runConsistencyGate must not throw for UI cap (CLUSTERS.ui matches ui.skills)',
    );
  });
});

// ─── 23. ADR-959: commands field + commandFamilies index ──────────────────────

/**
 * Build a minimal feature capability for ADR-959 command tests.
 * skills/agents/etc. kept minimal-valid so validateCapability passes.
 */
function makeCommandCap(id, commands) {
  return {
    id,
    role: 'feature',
    version: '1.0.0',
    title: 'Test cap ' + id,
    description: 'Synthetic capability for ADR-959 command tests.',
    tier: 'full',
    requires: [],
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    commands,
  };
}

describe('ADR-959: validateCommandEntry — valid entry', () => {
  test('valid minimal entry (no subcommands) passes', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.deepEqual(errors, []);
  });

  test('valid entry with subcommands passes', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'bar',
      module: 'bar-router.cjs',
      router: 'routeBar',
      subcommands: ['query', 'status'],
    }, 'commands[0]');
    assert.deepEqual(errors, []);
  });
});

describe('ADR-959: validateCommandEntry — adversarial rejects', () => {
  test('missing family → error', () => {
    const errors = validateCommandEntry('my-cap', { module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('family')), 'Expected family error, got: ' + JSON.stringify(errors));
  });

  test('empty family → error', () => {
    const errors = validateCommandEntry('my-cap', { family: '', module: 'foo.cjs', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('family')), 'Expected family error, got: ' + JSON.stringify(errors));
  });

  test('missing module → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', router: 'routeFoo' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module error, got: ' + JSON.stringify(errors));
  });

  test('missing router → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('router')), 'Expected router error, got: ' + JSON.stringify(errors));
  });

  test('non-string router → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'foo.cjs', router: 42 }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('router')), 'Expected router error, got: ' + JSON.stringify(errors));
  });

  test('traversal module "../evil.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: '../evil.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module traversal error, got: ' + JSON.stringify(errors));
  });

  test('absolute module "/abs/path.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: '/abs/path.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module absolute error, got: ' + JSON.stringify(errors));
  });

  test('module with "/" separator "lib/foo.cjs" → error', () => {
    const errors = validateCommandEntry('my-cap', { family: 'foo', module: 'lib/foo.cjs', router: 'r' }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('module')), 'Expected module separator error, got: ' + JSON.stringify(errors));
  });

  test('subcommands non-array → error', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'foo', module: 'foo.cjs', router: 'r', subcommands: 'not-array',
    }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('subcommands')), 'Expected subcommands error, got: ' + JSON.stringify(errors));
  });

  test('subcommands with non-string entry → error', () => {
    const errors = validateCommandEntry('my-cap', {
      family: 'foo', module: 'foo.cjs', router: 'r', subcommands: ['ok', 42],
    }, 'commands[0]');
    assert.ok(errors.some((e) => e.includes('subcommands')), 'Expected subcommands[1] error, got: ' + JSON.stringify(errors));
  });
});

describe('ADR-959: validateCrossCapability — duplicate family ownership', () => {
  test('duplicate family across two capabilities → error', () => {
    const capA = makeCommandCap('cap-a', [{ family: 'shared', module: 'a.cjs', router: 'rA' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'shared', module: 'b.cjs', router: 'rB' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(
      errors.some((e) => e.includes('shared') && e.includes('cap-a') && e.includes('cap-b')),
      'Expected duplicate family error mentioning both caps, got: ' + JSON.stringify(errors),
    );
  });

  test('unique families in two capabilities → no error', () => {
    const capA = makeCommandCap('cap-a', [{ family: 'alpha', module: 'alpha.cjs', router: 'rA' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'beta', module: 'beta.cjs', router: 'rB' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const errors = validateCrossCapability(capMap, new Set());
    assert.ok(
      !errors.some((e) => e.includes('owned by both')),
      'Expected no duplicate-ownership error, got: ' + JSON.stringify(errors),
    );
  });
});

describe('ADR-959: buildRegistry — commandFamilies index shape', () => {
  test('cap with valid commands entry produces commandFamilies entry', () => {
    const cap = makeCommandCap('test-cmd', [
      { family: 'myfamily', module: 'myfamily.cjs', router: 'routeMyFamily' },
    ]);
    const capMap = new Map([['test-cmd', cap]]);
    const registry = buildRegistry(capMap);
    assert.ok(registry.commandFamilies, 'commandFamilies must be present');
    const entry = registry.commandFamilies['myfamily'];
    assert.ok(entry, 'commandFamilies["myfamily"] must exist');
    assert.strictEqual(entry.capId, 'test-cmd');
    assert.strictEqual(entry.module, 'myfamily.cjs');
    assert.strictEqual(entry.router, 'routeMyFamily');
  });

  test('cap without commands → commandFamilies is empty', () => {
    const capDir = makeTempCapDir({ ui: UI_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);
    assert.ok(registry.commandFamilies, 'commandFamilies must be present');
    assert.deepEqual(Object.keys(registry.commandFamilies), [], 'commandFamilies must be empty for real registry');
  });

  test('commandFamilies keys are sorted in serialized output (determinism)', () => {
    // Two caps with commands in z→a order; expect a→z in the commandFamilies section
    const capA = makeCommandCap('cap-a', [{ family: 'zebra', module: 'z.cjs', router: 'rZ' }]);
    const capB = makeCommandCap('cap-b', [{ family: 'alpha', module: 'a.cjs', router: 'rA' }]);
    const capMap = new Map([['cap-a', capA], ['cap-b', capB]]);
    const registry = buildRegistry(capMap);
    const serialized = serializeRegistry(registry, capMap);

    // Find the commandFamilies section specifically (not the full capabilities JSON)
    const cfStart = serialized.indexOf('const commandFamilies = ');
    assert.ok(cfStart >= 0, 'commandFamilies section must be present');
    const cfEnd = serialized.indexOf('\n};', cfStart) + 3; // closing }; of const assignment
    const cfSection = serialized.slice(cfStart, cfEnd);

    const alphaIdx = cfSection.indexOf('"alpha"');
    const zebraIdx = cfSection.indexOf('"zebra"');
    assert.ok(alphaIdx >= 0, '"alpha" must appear in commandFamilies section');
    assert.ok(zebraIdx >= 0, '"zebra" must appear in commandFamilies section');
    assert.ok(alphaIdx < zebraIdx, 'commandFamilies section must list "alpha" before "zebra" (sorted)');
  });
});

describe('ADR-959: validateCapability — commands field on feature role', () => {
  test('valid commands entry on feature cap passes validateCapability', () => {
    const cap = makeCommandCap('cmd-cap', [
      { family: 'testfamily', module: 'testfamily.cjs', router: 'routeTestFamily' },
    ]);
    const errors = validateCapability(cap, 'cmd-cap');
    assert.deepEqual(errors, [], 'Expected no errors: ' + JSON.stringify(errors));
  });

  test('commands: null on feature cap → error', () => {
    const cap = makeCommandCap('cmd-cap', null);
    const errors = validateCapability(cap, 'cmd-cap');
    assert.ok(errors.some((e) => e.includes('commands')), 'Expected commands error, got: ' + JSON.stringify(errors));
  });
});

// ─── 24. ADR-1016 phase 5a: runtime capability descriptors ───────────────────

const {
  validateConfigHome,
  validateArtifactLayout,
  VALID_CONFIG_HOME_KINDS,
  VALID_COMMAND_STYLES,
  VALID_HOOKS_SURFACES,
  VALID_HOOK_EVENTS,
  VALID_SANDBOX_TIERS,
  VALID_ARTIFACT_KIND_NAMES,
  VALID_ARTIFACT_NESTINGS,
} = require('../scripts/gen-capability-registry.cjs');

// VALID_EXTENSION_EVENTS is imported from the validator directly (not from
// gen-capability-registry) to avoid changing gen-capability-registry.cjs — that
// file is an installed artifact captured by golden-install-parity (#1943).
const VALID_EXTENSION_EVENTS = capValidatorModule.VALID_EXTENSION_EVENTS;

// Runtime ids are derived from the built registry (the single source of truth)
// so this file stays fluid when a runtime descriptor is added or removed.
const RUNTIME_IDS = Object.keys(buildRegistry(loadAndValidate(new Set()).capMap).runtimes);

// Helper: build a minimal valid runtime capability object for fixture-based tests
function makeRuntimeCap(overrides) {
  return {
    id: 'test-rt',
    role: 'runtime',
    version: '1.0.0',
    title: 'Test Runtime',
    description: 'A synthetic runtime capability for testing.',
    tier: 'core',
    requires: [],
    runtime: {
      configHome: { kind: 'dot-home', name: '.test-rt', env: ['TEST_RT_DIR'] },
      localConfigDir: '.test-rt',
      configFormat: 'settings-json',
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'settings-json',
      hookEvents: 'claude',
      sandboxTier: 'none',
      supportTier: 1,
      installSurface: 'settings-json',
      writesSharedSettings: true,
      permissionWriter: null,
      extendedHookEvents: [],
      hostIntegration: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false },
        modelMode: 'passive',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
      ...((overrides && overrides.runtime) ? overrides.runtime : {}),
    },
    ...overrides,
  };
}

// ── 24a. Every role:runtime capability appears in the runtimes index ─────────
// Count-agnostic: the built registry's runtime set must exactly equal the set
// of capability folders whose descriptor declares role:"runtime". Adding a
// runtime descriptor extends coverage with zero edits here.

describe('ADR-1016 phase 5a: every role:runtime capability is in the registry index', () => {
  let registry;

  test('loadAndValidate + buildRegistry indexes exactly the role:runtime capabilities on disk', () => {
    const { capMap, errors } = loadAndValidate(new Set());
    const hardErrors = errors.filter((e) => !e.includes('pending-migration'));
    assert.deepEqual(hardErrors, [], 'Expected no hard errors: ' + JSON.stringify(hardErrors));
    registry = buildRegistry(capMap);

    // Derive the expected runtime id set from the loaded capability map — not a
    // hand-pinned count. This is the contract: every role:runtime descriptor on
    // disk becomes a runtimes-index entry, no more, no less.
    const expectedRuntimeIds = [...capMap.entries()]
      .filter(([, cap]) => cap && cap.role === 'runtime')
      .map(([id]) => id)
      .sort();
    const runtimeKeys = Object.keys(registry.runtimes).sort();
    assert.ok(expectedRuntimeIds.length > 0, 'expected at least one role:runtime capability on disk');
    assert.deepEqual(runtimeKeys, expectedRuntimeIds,
      'runtimes index must exactly equal the role:runtime capabilities on disk. got: ' + runtimeKeys.join(', '));
    for (const id of RUNTIME_IDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(registry.runtimes, id),
        'runtimes index must contain "' + id + '"',
      );
    }
  });

  test('every runtimes entry has role: "runtime"', () => {
    const { capMap } = loadAndValidate(new Set());
    registry = buildRegistry(capMap);
    for (const id of RUNTIME_IDS) {
      assert.strictEqual(
        registry.runtimes[id] && registry.runtimes[id].role, 'runtime',
        'runtimes["' + id + '"].role must be "runtime"',
      );
    }
  });

  test('every runtimes entry has all 6 axes present in runtime object', () => {
    const { capMap } = loadAndValidate(new Set());
    registry = buildRegistry(capMap);
    const requiredAxes = ['configHome', 'configFormat', 'artifactLayout', 'commandStyle', 'hooksSurface', 'sandboxTier'];
    for (const id of RUNTIME_IDS) {
      const rt = registry.runtimes[id] && registry.runtimes[id].runtime;
      assert.ok(rt, 'runtimes["' + id + '"].runtime must exist');
      for (const axis of requiredAxes) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(rt, axis),
          'runtimes["' + id + '"].runtime.' + axis + ' must be present',
        );
      }
      // supportTier also required
      assert.ok(
        rt.supportTier === 1 || rt.supportTier === 2,
        'runtimes["' + id + '"].runtime.supportTier must be 1 or 2 (got: ' + rt.supportTier + ')',
      );
    }
  });
});

// ── 24b. Sample axis value assertions ────────────────────────────────────────

describe('ADR-1016 phase 5a: sample axis value assertions', () => {
  test('codex: commandStyle === shell-var and sandboxTier === codex-agent-sandbox', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['codex'].runtime;
    assert.strictEqual(rt.commandStyle, 'shell-var', 'codex.commandStyle must be "shell-var"');
    assert.strictEqual(rt.sandboxTier, 'codex-agent-sandbox', 'codex.sandboxTier must be "codex-agent-sandbox"');
  });

  test('codex: configHome.kind === dot-home, name === .codex', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['codex'].runtime;
    assert.strictEqual(rt.configHome.kind, 'dot-home', 'codex.configHome.kind must be "dot-home"');
    assert.strictEqual(rt.configHome.name, '.codex', 'codex.configHome.name must be ".codex"');
    assert.ok(Array.isArray(rt.configHome.env) && rt.configHome.env.includes('CODEX_HOME'),
      'codex.configHome.env must include "CODEX_HOME"');
  });

  test('claude: commandStyle === slash-hyphen, sandboxTier === none', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['claude'].runtime;
    assert.strictEqual(rt.commandStyle, 'slash-hyphen', 'claude.commandStyle must be "slash-hyphen"');
    assert.strictEqual(rt.sandboxTier, 'none', 'claude.sandboxTier must be "none"');
  });

  test('claude: configHome.kind === dot-home', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['claude'].runtime;
    assert.strictEqual(rt.configHome.kind, 'dot-home', 'claude.configHome.kind must be "dot-home"');
  });

  test('antigravity: configHome.kind === dot-home-nested with parent .gemini', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['antigravity'].runtime;
    assert.strictEqual(rt.configHome.kind, 'dot-home-nested', 'antigravity.configHome.kind must be "dot-home-nested"');
    assert.strictEqual(rt.configHome.parent, '.gemini', 'antigravity.configHome.parent must be ".gemini"');
    assert.ok(Array.isArray(rt.configHome.probe), 'antigravity.configHome.probe must be an array');
    assert.ok(rt.configHome.probe.length > 0, 'antigravity.configHome.probe must be non-empty');
  });

  test('kilo: configHome.skillsHome is present', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['kilo'].runtime;
    assert.ok(rt.configHome.skillsHome, 'kilo.configHome.skillsHome must be present');
    assert.ok(typeof rt.configHome.skillsHome.kind === 'string', 'kilo.configHome.skillsHome.kind must be a string');
  });

  test('windsurf: configHome.kind === dot-home-nested with parent .codeium', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['windsurf'].runtime;
    assert.strictEqual(rt.configHome.kind, 'dot-home-nested', 'windsurf.configHome.kind must be "dot-home-nested"');
    assert.strictEqual(rt.configHome.parent, '.codeium', 'windsurf.configHome.parent must be ".codeium"');
  });

  test('kimi: configHome.kind === generic-agents-root', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['kimi'].runtime;
    assert.strictEqual(rt.configHome.kind, 'generic-agents-root', 'kimi.configHome.kind must be "generic-agents-root"');
  });

  test('antigravity: hookEvents === gemini', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['antigravity'].runtime;
    assert.strictEqual(rt.hookEvents, 'gemini', 'antigravity.hookEvents must be "gemini"');
  });

  test('opencode: hooksSurface === none, no hookEvents (registers zero lifecycle hooks)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['opencode'].runtime;
    assert.strictEqual(rt.hooksSurface, 'none', 'opencode.hooksSurface must be "none" (no managed lifecycle hooks)');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(rt, 'hookEvents'),
      'opencode.runtime must NOT have hookEvents (no lifecycle hook registration)',
    );
  });

  test('opencode: extensionEvents === opencode (the extension-system event dialect — #1943)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['opencode'].runtime;
    assert.strictEqual(rt.extensionEvents, 'opencode',
      'opencode declares the extension-system event subset via extensionEvents (NOT hookEvents)');
  });

  test('kilo: hooksSurface === none, no hookEvents (registers zero lifecycle hooks)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['kilo'].runtime;
    assert.strictEqual(rt.hooksSurface, 'none', 'kilo.hooksSurface must be "none" (no managed lifecycle hooks)');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(rt, 'hookEvents'),
      'kilo.runtime must NOT have hookEvents (no lifecycle hook registration)',
    );
  });

  test('kimi: configHome.probeExists === "skills" (probe selects first candidate with skills/ dir)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const rt = registry.runtimes['kimi'].runtime;
    assert.strictEqual(
      rt.configHome.probeExists, 'skills',
      'kimi.configHome.probeExists must be "skills" (selects first probe candidate where <candidate>/skills exists)',
    );
  });

  test('copilot/trae/windsurf/cline/opencode/kilo: hooksSurface none or copilot-inline/cline-rules, no hookEvents', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    // opencode and kilo register ZERO lifecycle hooks → hooksSurface none, no hookEvents
    // #2095: kimi moved OUT of this group — it now has hooksSurface:'kimi-hooks-toml'
    // and hookEvents:'claude' (see the dedicated kimi hooksSurface test below).
    const noEventsRuntimes = ['trae', 'windsurf', 'opencode', 'kilo'];
    for (const id of noEventsRuntimes) {
      const rt = registry.runtimes[id].runtime;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(rt, 'hookEvents'),
        id + '.runtime must NOT have hookEvents (no hook events for this runtime)',
      );
    }
    // cline has cline-rules surface but no hookEvents
    const clineRt = registry.runtimes['cline'].runtime;
    assert.strictEqual(clineRt.hooksSurface, 'cline-rules', 'cline.hooksSurface must be "cline-rules"');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(clineRt, 'hookEvents'),
      'cline.runtime must NOT have hookEvents',
    );
    // copilot has copilot-inline surface but no hookEvents
    const copilotRt = registry.runtimes['copilot'].runtime;
    assert.strictEqual(copilotRt.hooksSurface, 'copilot-inline', 'copilot.hooksSurface must be "copilot-inline"');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(copilotRt, 'hookEvents'),
      'copilot.runtime must NOT have hookEvents',
    );
  });

  test('kimi: hooksSurface === kimi-hooks-toml, hookEvents === claude, extendedHookEvents wired (#2095)', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const kimiRt = registry.runtimes['kimi'].runtime;
    assert.strictEqual(kimiRt.hooksSurface, 'kimi-hooks-toml', 'kimi.hooksSurface must be "kimi-hooks-toml"');
    assert.strictEqual(kimiRt.hookEvents, 'claude', 'kimi.hookEvents must be "claude" (Kimi\'s 13 lifecycle events include exact-name equivalents for the Claude dialect)');
    assert.deepStrictEqual(
      [...kimiRt.extendedHookEvents].sort(),
      ['PreCompact', 'Stop', 'SubagentStart', 'SubagentStop'].sort(),
      'kimi.extendedHookEvents must wire SubagentStop/Stop/PreCompact/SubagentStart',
    );
    // installSurface stays profile-marker-only — the native config.toml
    // [[hooks]] write is independent of the artifact-install surface (#2095).
    assert.strictEqual(kimiRt.installSurface, 'profile-marker-only', 'kimi.installSurface must remain "profile-marker-only"');
  });

  test('codex: hooksSurface === codex-hooks-json, cursor: hooksSurface === cursor-hooks-json', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    assert.strictEqual(registry.runtimes['codex'].runtime.hooksSurface, 'codex-hooks-json',
      'codex.hooksSurface must be "codex-hooks-json"');
    assert.strictEqual(registry.runtimes['cursor'].runtime.hooksSurface, 'cursor-hooks-json',
      'cursor.hooksSurface must be "cursor-hooks-json"');
  });

  test('tier-1 runtimes: claude, codex, antigravity have supportTier === 1', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    for (const id of ['claude', 'codex', 'antigravity']) {
      assert.strictEqual(
        registry.runtimes[id].runtime.supportTier, 1,
        id + '.runtime.supportTier must be 1 (tier-1 support)',
      );
    }
  });

  test('tier-2 runtimes: cursor through windsurf have supportTier === 2', () => {
    const { capMap } = loadAndValidate(new Set());
    const registry = buildRegistry(capMap);
    const tier2 = ['cursor', 'opencode', 'kilo', 'copilot', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy', 'cline', 'kimi', 'windsurf'];
    for (const id of tier2) {
      assert.strictEqual(
        registry.runtimes[id].runtime.supportTier, 2,
        id + '.runtime.supportTier must be 2 (tier-2 support)',
      );
    }
  });
});

// ── 24c. Closed-vocab REJECTION tests ────────────────────────────────────────

describe('ADR-1016 phase 5a: closed-vocab rejection — tightened validateRuntimeBody', () => {
  test('bad configHome.kind → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { configHome: { kind: 'custom-home', name: '.test', env: [] } } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('configHome') && e.includes('kind')),
      'Expected configHome.kind error, got: ' + JSON.stringify(errors),
    );
  });

  test('configHome is a string (old shape) → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { configHome: '~/.test-rt' } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('configHome')),
      'Expected configHome object error (string not accepted), got: ' + JSON.stringify(errors),
    );
  });

  test('dot-home-nested without parent → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { configHome: { kind: 'dot-home-nested', name: 'foo', env: [] } } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('parent') && e.includes('dot-home-nested')),
      'Expected parent required for dot-home-nested, got: ' + JSON.stringify(errors),
    );
  });

  test('bad commandStyle → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { commandStyle: 'slash-colon' } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('commandStyle')),
      'Expected commandStyle error, got: ' + JSON.stringify(errors),
    );
  });

  test('bad hooksSurface → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { hooksSurface: 'custom-hooks' } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('hooksSurface')),
      'Expected hooksSurface error, got: ' + JSON.stringify(errors),
    );
  });

  test('bad hookEvents → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { hookEvents: 'my-dialect' } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('hookEvents')),
      'Expected hookEvents error, got: ' + JSON.stringify(errors),
    );
  });

  test('bad sandboxTier → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { sandboxTier: 'workspace-sandbox' } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('sandboxTier')),
      'Expected sandboxTier error, got: ' + JSON.stringify(errors),
    );
  });

  test('artifactLayout is an array (old shape) → validation error', () => {
    const cap = makeRuntimeCap({ id: 'test-rt', runtime: { artifactLayout: [] } });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('artifactLayout')),
      'Expected artifactLayout shape error (old array not accepted), got: ' + JSON.stringify(errors),
    );
  });

  test('bad ArtifactKind.kind in artifactLayout → validation error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'magic-kind', destSubpath: 'x', prefix: 'g-', nesting: 'flat', recursive: false, converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('kind')),
      'Expected ArtifactKind.kind error, got: ' + JSON.stringify(errors),
    );
  });

  test('bad ArtifactKind.nesting → validation error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'deep', recursive: false, converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('nesting')),
      'Expected nesting error, got: ' + JSON.stringify(errors),
    );
  });

  test('valid runtime descriptor passes validateCapability with no errors', () => {
    const cap = makeRuntimeCap({ id: 'test-rt' });
    const errors = validateCapability(cap, 'test-rt');
    assert.deepEqual(errors, [], 'Expected no errors for valid runtime cap: ' + JSON.stringify(errors));
  });
});

// ── 24d. validateConfigHome + validateArtifactLayout unit tests ───────────────

describe('ADR-1016 phase 5a: validateConfigHome unit tests', () => {
  test('valid dot-home with env → no errors', () => {
    const errors = validateConfigHome('test', { kind: 'dot-home', name: '.test', env: ['TEST_DIR'] });
    assert.deepEqual(errors, []);
  });

  test('valid dot-home-nested with parent → no errors', () => {
    const errors = validateConfigHome('test', { kind: 'dot-home-nested', name: 'foo', parent: '.bar', env: [] });
    assert.deepEqual(errors, []);
  });

  test('valid xdg → no errors', () => {
    const errors = validateConfigHome('test', { kind: 'xdg', name: 'opencode', env: ['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
    assert.deepEqual(errors, []);
  });

  test('valid generic-agents-root with probe → no errors', () => {
    const errors = validateConfigHome('test', { kind: 'generic-agents-root', name: 'agents', env: ['KIMI_CONFIG_DIR'], probe: ['~/.config/agents'] });
    assert.deepEqual(errors, []);
  });

  test('null configHome → error', () => {
    const errors = validateConfigHome('test', null);
    assert.ok(errors.length > 0 && errors.some((e) => e.includes('configHome')));
  });

  test('string configHome → error', () => {
    const errors = validateConfigHome('test', '~/.test');
    assert.ok(errors.length > 0 && errors.some((e) => e.includes('configHome')));
  });

  test('unknown kind → error mentioning the valid set', () => {
    const errors = validateConfigHome('test', { kind: 'unknown', name: '.x', env: [] });
    assert.ok(errors.some((e) => e.includes('kind') && e.includes('dot-home')),
      'Error should list valid kinds, got: ' + JSON.stringify(errors));
  });

  test('dot-home-nested missing parent → error', () => {
    const errors = validateConfigHome('test', { kind: 'dot-home-nested', name: 'x', env: [] });
    assert.ok(errors.some((e) => e.includes('parent')));
  });

  test('skillsHome with valid kind → no errors', () => {
    const errors = validateConfigHome('test', {
      kind: 'xdg', name: 'kilo', env: [],
      skillsHome: { kind: 'dot-home', name: '.kilo', env: [] },
    });
    assert.deepEqual(errors, []);
  });

  test('skillsHome with bad kind → error', () => {
    const errors = validateConfigHome('test', {
      kind: 'xdg', name: 'kilo', env: [],
      skillsHome: { kind: 'exotic', name: '.kilo', env: [] },
    });
    assert.ok(errors.some((e) => e.includes('skillsHome') && e.includes('kind')));
  });
});

describe('ADR-1016 phase 5a: validateArtifactLayout unit tests', () => {
  test('valid empty global/local → no errors', () => {
    const errors = validateArtifactLayout('test', { global: [], local: [] });
    assert.deepEqual(errors, []);
  });

  test('valid skills entry in global → no errors', () => {
    const errors = validateArtifactLayout('test', {
      global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: null }],
      local: [],
    });
    assert.deepEqual(errors, []);
  });

  test('array (old shape) → error', () => {
    const errors = validateArtifactLayout('test', []);
    assert.ok(errors.some((e) => e.includes('artifactLayout')));
  });

  test('missing global → error', () => {
    const errors = validateArtifactLayout('test', { local: [] });
    assert.ok(errors.some((e) => e.includes('global')));
  });

  test('missing local → error', () => {
    const errors = validateArtifactLayout('test', { global: [] });
    assert.ok(errors.some((e) => e.includes('local')));
  });

  test('bad kind in global[0] → error', () => {
    const errors = validateArtifactLayout('test', {
      global: [{ kind: 'bad-kind', destSubpath: 'x', prefix: '', nesting: 'flat', recursive: false, converter: null }],
      local: [],
    });
    assert.ok(errors.some((e) => e.includes('kind')));
  });

  test('bad nesting in global[0] → error', () => {
    const errors = validateArtifactLayout('test', {
      global: [{ kind: 'skills', destSubpath: 'x', prefix: '', nesting: 'trilateral', recursive: false, converter: null }],
      local: [],
    });
    assert.ok(errors.some((e) => e.includes('nesting')));
  });

  test('kimi-agents kind → no errors', () => {
    const errors = validateArtifactLayout('test', {
      global: [{ kind: 'kimi-agents', destSubpath: 'agents', prefix: 'gsd', nesting: 'flat', recursive: false, converter: null }],
      local: [],
    });
    assert.deepEqual(errors, []);
  });
});

// ── 24d-extra. FIX 3: tightened validateRuntimeBody / validateConfigHome ──────

describe('FIX 3: tightened runtime validator — configHome.env required', () => {
  test('configHome missing env → validation error', () => {
    // env is now required; omitting it must produce an error
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: { configHome: { kind: 'dot-home', name: '.test-rt' } },  // no env
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('env') && (e.includes('required') || e.includes('array'))),
      'Expected configHome.env required error, got: ' + JSON.stringify(errors),
    );
  });

  test('configHome with env: [] (empty array) is accepted', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: { configHome: { kind: 'dot-home', name: '.test-rt', env: [] } },
    });
    const errors = validateCapability(cap, 'test-rt');
    const envErrors = errors.filter((e) => e.includes('env'));
    assert.deepEqual(envErrors, [], 'Empty env array should be accepted, got: ' + JSON.stringify(envErrors));
  });

  test('configHome with env: null → validation error (not an array)', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: { configHome: { kind: 'dot-home', name: '.test-rt', env: null } },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('env')),
      'Expected env error for null, got: ' + JSON.stringify(errors),
    );
  });
});

describe('FIX 3: tightened runtime validator — skillsHome recursive validation', () => {
  test('skillsHome with bad kind → validation error via full recursive check', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        configHome: {
          kind: 'xdg', name: 'test', env: [],
          skillsHome: { kind: 'exotic-kind', name: '.test', env: [] },
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('skillsHome') && e.includes('kind')),
      'Expected skillsHome.kind error for exotic-kind, got: ' + JSON.stringify(errors),
    );
  });

  test('skillsHome missing env → validation error (env required in recursive check)', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        configHome: {
          kind: 'xdg', name: 'test', env: [],
          skillsHome: { kind: 'dot-home', name: '.test' },  // no env
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('skillsHome') && e.includes('env')),
      'Expected skillsHome.env required error, got: ' + JSON.stringify(errors),
    );
  });

  test('kilo descriptor: skillsHome passes full validation', () => {
    // kilo has skillsHome: { kind: "dot-home", name: ".kilo", env: [] } — must pass
    const { capMap, errors } = loadAndValidate(new Set());
    const hardErrors = errors.filter((e) => !e.includes('pending-migration'));
    assert.deepEqual(hardErrors, [], 'No hard errors expected for kilo, got: ' + JSON.stringify(hardErrors));
    const kiloRt = capMap.get('kilo');
    assert.ok(kiloRt, 'kilo must be in capMap');
    assert.ok(kiloRt.runtime.configHome.skillsHome, 'kilo.configHome.skillsHome must be present');
    assert.strictEqual(kiloRt.runtime.configHome.skillsHome.kind, 'dot-home');
    assert.strictEqual(kiloRt.runtime.configHome.skillsHome.name, '.kilo');
  });
});

describe('FIX 3: tightened runtime validator — ArtifactKind field type checks', () => {
  test('ArtifactKind with recursive: "yes" (non-boolean) → validation error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: 'yes', converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('recursive') && e.includes('boolean')),
      'Expected recursive non-boolean error, got: ' + JSON.stringify(errors),
    );
  });

  test('ArtifactKind with recursive: true (boolean) → no error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: true, converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    const recursiveErrors = errors.filter((e) => e.includes('recursive'));
    assert.deepEqual(recursiveErrors, [], 'recursive: true must be accepted, got: ' + JSON.stringify(recursiveErrors));
  });

  test('ArtifactKind with prefix: 42 (non-string) → validation error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 42, nesting: 'flat', recursive: false, converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('prefix') && e.includes('string')),
      'Expected prefix non-string error, got: ' + JSON.stringify(errors),
    );
  });

  test('ArtifactKind with converter: 123 (non-string, non-null) → validation error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: 123 }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(
      errors.some((e) => e.includes('converter') && (e.includes('string') || e.includes('null'))),
      'Expected converter type error, got: ' + JSON.stringify(errors),
    );
  });

  test('ArtifactKind with converter: null → no error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: false, converter: null }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    const converterErrors = errors.filter((e) => e.includes('converter'));
    assert.deepEqual(converterErrors, [], 'converter: null must be accepted, got: ' + JSON.stringify(converterErrors));
  });

  test('ArtifactKind with converter: "convertClaudeCommandToKiloSkill" (string) → no error', () => {
    const cap = makeRuntimeCap({
      id: 'test-rt',
      runtime: {
        artifactLayout: {
          global: [{ kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', nesting: 'flat', recursive: true, converter: 'convertClaudeCommandToKiloSkill' }],
          local: [],
        },
      },
    });
    const errors = validateCapability(cap, 'test-rt');
    const converterErrors = errors.filter((e) => e.includes('converter'));
    assert.deepEqual(converterErrors, [], 'converter: string must be accepted, got: ' + JSON.stringify(converterErrors));
  });
});

describe('FIX 3: tightened runtime validator — probeExists optional string', () => {
  test('probeExists: "skills" is accepted', () => {
    const errors = validateConfigHome('test', {
      kind: 'generic-agents-root', name: 'agents', env: ['KIMI_CONFIG_DIR'],
      probe: ['~/.config/agents', '~/.agents'],
      probeExists: 'skills',
    });
    assert.deepEqual(errors, [], 'probeExists: "skills" must be accepted, got: ' + JSON.stringify(errors));
  });

  test('probeExists: "" (empty string) → error', () => {
    const errors = validateConfigHome('test', {
      kind: 'generic-agents-root', name: 'agents', env: [],
      probeExists: '',
    });
    assert.ok(
      errors.some((e) => e.includes('probeExists')),
      'Expected probeExists empty string error, got: ' + JSON.stringify(errors),
    );
  });

  test('probeExists: 42 (non-string) → error', () => {
    const errors = validateConfigHome('test', {
      kind: 'generic-agents-root', name: 'agents', env: [],
      probeExists: 42,
    });
    assert.ok(
      errors.some((e) => e.includes('probeExists')),
      'Expected probeExists non-string error, got: ' + JSON.stringify(errors),
    );
  });

  test('probeExists absent → no error (optional)', () => {
    const errors = validateConfigHome('test', {
      kind: 'generic-agents-root', name: 'agents', env: ['KIMI_CONFIG_DIR'],
      probe: ['~/.config/agents'],
    });
    const probeExistsErrors = errors.filter((e) => e.includes('probeExists'));
    assert.deepEqual(probeExistsErrors, [], 'probeExists is optional — no error when absent, got: ' + JSON.stringify(probeExistsErrors));
  });
});

// ── 24e. Closed-vocab set exports are correct ─────────────────────────────────

describe('ADR-1016 phase 5a: closed-vocab set exports', () => {
  test('VALID_CONFIG_HOME_KINDS has exactly the 5 expected values', () => {
    assert.ok(VALID_CONFIG_HOME_KINDS instanceof Set);
    // 'none' added #2103 — a runtime with NO file-projected config directory
    // at all (e.g. vscode — Marketplace/VSIX-distributed).
    for (const v of ['dot-home', 'dot-home-nested', 'xdg', 'generic-agents-root', 'none']) {
      assert.ok(VALID_CONFIG_HOME_KINDS.has(v), 'VALID_CONFIG_HOME_KINDS must contain "' + v + '"');
    }
    assert.strictEqual(VALID_CONFIG_HOME_KINDS.size, 5, 'VALID_CONFIG_HOME_KINDS must have exactly 5 members');
  });

  test('VALID_COMMAND_STYLES has exactly 2 values', () => {
    assert.ok(VALID_COMMAND_STYLES instanceof Set);
    assert.ok(VALID_COMMAND_STYLES.has('slash-hyphen'));
    assert.ok(VALID_COMMAND_STYLES.has('shell-var'));
    assert.strictEqual(VALID_COMMAND_STYLES.size, 2);
  });

  test('VALID_HOOKS_SURFACES has exactly 8 values', () => {
    assert.ok(VALID_HOOKS_SURFACES instanceof Set);
    for (const v of ['settings-json', 'codex-hooks-json', 'cursor-hooks-json', 'copilot-inline', 'cline-rules', 'kimi-hooks-toml', 'windsurf-hooks-json', 'none']) {
      assert.ok(VALID_HOOKS_SURFACES.has(v), 'VALID_HOOKS_SURFACES must contain "' + v + '"');
    }
    assert.strictEqual(VALID_HOOKS_SURFACES.size, 8);
  });

  test('VALID_HOOK_EVENTS has exactly 2 managed-hook dialects (claude/gemini)', () => {
    assert.ok(VALID_HOOK_EVENTS instanceof Set);
    for (const v of ['claude', 'gemini']) {
      assert.ok(VALID_HOOK_EVENTS.has(v), 'VALID_HOOK_EVENTS must contain "' + v + '"');
    }
    assert.strictEqual(VALID_HOOK_EVENTS.size, 2);
    assert.ok(!VALID_HOOK_EVENTS.has('opencode-subset'),
      'opencode-subset is NOT a hookEvents value — it is the extensionEvents vocabulary (#1943)');
  });

  test('VALID_EXTENSION_EVENTS has the extension-system dialects (opencode/pi/hermes/kilo/none — #1943/#2091/#2093)', () => {
    assert.ok(VALID_EXTENSION_EVENTS instanceof Set);
    for (const v of ['opencode', 'pi', 'hermes', 'kilo', 'none']) {
      assert.ok(VALID_EXTENSION_EVENTS.has(v), 'VALID_EXTENSION_EVENTS must contain "' + v + '"');
    }
    assert.strictEqual(VALID_EXTENSION_EVENTS.size, 5);
  });

  test('VALID_SANDBOX_TIERS has exactly 2 values', () => {
    assert.ok(VALID_SANDBOX_TIERS instanceof Set);
    assert.ok(VALID_SANDBOX_TIERS.has('none'));
    assert.ok(VALID_SANDBOX_TIERS.has('codex-agent-sandbox'));
    assert.strictEqual(VALID_SANDBOX_TIERS.size, 2);
  });

  test('VALID_ARTIFACT_KIND_NAMES has exactly 4 values', () => {
    assert.ok(VALID_ARTIFACT_KIND_NAMES instanceof Set);
    for (const v of ['commands', 'agents', 'skills', 'kimi-agents']) {
      assert.ok(VALID_ARTIFACT_KIND_NAMES.has(v), 'VALID_ARTIFACT_KIND_NAMES must contain "' + v + '"');
    }
    assert.strictEqual(VALID_ARTIFACT_KIND_NAMES.size, 4);
  });

  test('VALID_ARTIFACT_NESTINGS has exactly 2 values', () => {
    assert.ok(VALID_ARTIFACT_NESTINGS instanceof Set);
    assert.ok(VALID_ARTIFACT_NESTINGS.has('flat'));
    assert.ok(VALID_ARTIFACT_NESTINGS.has('nested'));
    assert.strictEqual(VALID_ARTIFACT_NESTINGS.size, 2);
  });
});

// ─── 25. ADR-857 phase 5e: closed ConverterName enum (Part B) ─────────────────

describe('ADR-857 phase 5e: VALID_CONVERTER_NAMES closed enum', () => {
  test('VALID_CONVERTER_NAMES has exactly 29 entries (18 command/skill/workflow + 11 agent converters)', () => {
    assert.ok(VALID_CONVERTER_NAMES instanceof Set, 'VALID_CONVERTER_NAMES must be a Set');
    assert.strictEqual(VALID_CONVERTER_NAMES.size, 29, 'VALID_CONVERTER_NAMES must have exactly 29 entries, got: ' + VALID_CONVERTER_NAMES.size);
  });

  test('VALID_CONVERTER_NAMES contains all expected converter names', () => {
    const expected = [
      // command/skill converters (pre-existing)
      'convertClaudeCommandToAntigravitySkill',
      'convertClaudeCommandToAugmentSkill',
      'convertClaudeCommandToClineSkill',
      'convertClaudeCommandToClaudeSkill',
      'convertClaudeCommandToCodebuddyCommand',
      'convertClaudeCommandToCodebuddySkill',
      'convertClaudeCommandToCodexSkill',
      'convertClaudeCommandToCopilotSkill',
      'convertClaudeCommandToCursorCommand',
      'convertClaudeCommandToCursorSkill',
      'convertClaudeCommandToKiloSkill',
      'convertClaudeCommandToKimiSkill',
      'convertClaudeCommandToOpencodeSkill',
      'convertClaudeCommandToQoderSkill',
      'convertClaudeCommandToTraeSkill',
      'convertClaudeCommandToWindsurfSkill',
      'convertClaudeCommandToWindsurfWorkflow',
      // agent converters (#1173 — descriptor-driven agent conversion wiring)
      'convertClaudeAgentToCopilotAgent',
      'convertClaudeAgentToAntigravityAgent',
      'convertClaudeAgentToCursorAgent',
      'convertClaudeAgentToWindsurfAgent',
      'convertClaudeAgentToAugmentAgent',
      'convertClaudeAgentToTraeAgent',
      'convertClaudeAgentToCodebuddyAgent',
      'convertClaudeAgentToClineAgent',
      'convertClaudeAgentToQoderAgent',
      'convertClaudeAgentToCodexAgent',
      // ADR-1239 / #2092 Phase B Upgrade 1 — native .qwen/agents/*.md subagent projection.
      'convertClaudeAgentToQwenAgent',
    ];
    for (const name of expected) {
      assert.ok(VALID_CONVERTER_NAMES.has(name), 'VALID_CONVERTER_NAMES must contain "' + name + '"');
    }
  });
});

describe('ADR-857 phase 5e: validateArtifactKindEntry — ConverterName enum (FAIL-FIRST regression)', () => {
  // Helper to build a minimal valid ArtifactKind entry
  function makeArtifactEntry(overrides) {
    return {
      kind: 'skills',
      destSubpath: 'skills',
      nesting: 'flat',
      prefix: 'gsd-',
      recursive: false,
      converter: null,
      ...overrides,
    };
  }

  // FAIL-FIRST: unknown converter name must be rejected
  test('REJECTED: converter "convertClaudeCommandToUnknownRuntime" is not a known ConverterName', () => {
    const entry = makeArtifactEntry({ converter: 'convertClaudeCommandToUnknownRuntime' });
    const errors = validateArtifactKindEntry('test-cap', entry, 'artifactLayout.global[0]');
    assert.ok(errors.length > 0, 'Expected rejection for unknown converter name, got: ' + JSON.stringify(errors));
    assert.ok(
      errors.some((e) => e.includes('convertClaudeCommandToUnknownRuntime') && e.includes('not a known ConverterName')),
      'Error must name the bad converter and say "not a known ConverterName", got: ' + JSON.stringify(errors),
    );
  });

  // Valid known name must be accepted
  test('ACCEPTED: converter "convertClaudeCommandToKiloSkill" is a known ConverterName', () => {
    const entry = makeArtifactEntry({ converter: 'convertClaudeCommandToKiloSkill' });
    const errors = validateArtifactKindEntry('test-cap', entry, 'artifactLayout.global[0]');
    const converterErrors = errors.filter((e) => e.includes('converter'));
    assert.deepEqual(converterErrors, [], 'Known converter name must be accepted, got: ' + JSON.stringify(converterErrors));
  });

  // null converter is always accepted (means "no conversion")
  test('ACCEPTED: converter: null is always accepted', () => {
    const entry = makeArtifactEntry({ converter: null });
    const errors = validateArtifactKindEntry('test-cap', entry, 'artifactLayout.global[0]');
    const converterErrors = errors.filter((e) => e.includes('converter'));
    assert.deepEqual(converterErrors, [], 'converter: null must always be accepted, got: ' + JSON.stringify(converterErrors));
  });

  // Parity: every role:runtime descriptor's converters must be in the valid set (or null).
  // Count-agnostic: iterates the real capability map rather than a hand-pinned runtime list.
  test('every real runtime descriptor has converters in VALID_CONVERTER_NAMES or null', () => {
    const { capMap, errors } = loadAndValidate(new Set());
    const hardErrors = errors.filter((e) => !e.includes('pending-migration'));
    assert.deepEqual(hardErrors, [], 'Expected no hard errors from real capabilities, got: ' + JSON.stringify(hardErrors));

    const runtimeIds = [...capMap.entries()]
      .filter(([, cap]) => cap && cap.role === 'runtime')
      .map(([id]) => id);
    assert.ok(runtimeIds.length > 0, 'expected at least one role:runtime capability');
    for (const id of runtimeIds) {
      const cap = capMap.get(id);
      assert.ok(cap, 'capMap must contain "' + id + '"');
      const r = cap.runtime;
      const allEntries = [
        ...(r.artifactLayout && Array.isArray(r.artifactLayout.global) ? r.artifactLayout.global : []),
        ...(r.artifactLayout && Array.isArray(r.artifactLayout.local) ? r.artifactLayout.local : []),
      ];
      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        if (entry.converter !== null) {
          assert.ok(
            VALID_CONVERTER_NAMES.has(entry.converter),
            id + ' artifactLayout[' + i + '].converter "' + entry.converter +
            '" is not in VALID_CONVERTER_NAMES',
          );
        }
      }
    }
  });

  // validateCapability end-to-end: unknown converter propagates through the full chain
  test('validateCapability REJECTS a runtime cap with unknown converter in artifactLayout', () => {
    const cap = {
      id: 'test-rt',
      role: 'runtime',
      title: 'Test Runtime',
      description: 'Test runtime with unknown converter.',
      tier: 'core',
      requires: [],
      runtime: {
        configHome: { kind: 'dot-home', name: '.test-rt', env: [] },
        configFormat: 'settings-json',
        artifactLayout: {
          global: [{
            kind: 'skills',
            destSubpath: 'skills',
            nesting: 'flat',
            prefix: 'gsd-',
            recursive: false,
            converter: 'convertClaudeCommandToUnknownRuntime',
          }],
          local: [],
        },
        commandStyle: 'slash-hyphen',
        hooksSurface: 'settings-json',
        sandboxTier: 'none',
        supportTier: 1,
      },
    };
    const errors = validateCapability(cap, 'test-rt');
    assert.ok(errors.length > 0, 'Expected validation errors for unknown converter, got: ' + JSON.stringify(errors));
    assert.ok(
      errors.some((e) => e.includes('convertClaudeCommandToUnknownRuntime') && e.includes('not a known ConverterName')),
      'Error must mention the unknown converter name, got: ' + JSON.stringify(errors),
    );
  });
});

// ─── 26. ADR-857 phase 5e: configFormat ↔ installSurface parity gate (Part A) ─

describe('ADR-857 phase 5e: configFormat ↔ installSurface parity gate', () => {
  // Helper: build a minimal runtime capMap for parity tests.
  // installSurface must be supplied for any runtime that should be checked by the gate;
  // omit it (undefined) to simulate a runtime with no installSurface (gate skips it).
  function makeRuntimeCapMap(runtimeId, configFormat, installSurface) {
    const runtime = {
      configHome: { kind: 'dot-home', name: '.' + runtimeId, env: [] },
      configFormat,
      artifactLayout: { global: [], local: [] },
      commandStyle: 'slash-hyphen',
      hooksSurface: 'none',
      sandboxTier: 'none',
      supportTier: 1,
    };
    if (installSurface !== undefined) {
      runtime.installSurface = installSurface;
    }
    const cap = {
      id: runtimeId,
      role: 'runtime',
      title: 'Test ' + runtimeId,
      description: 'Synthetic runtime for parity gate testing.',
      tier: 'core',
      requires: [],
      runtime,
    };
    return new Map([[runtimeId, cap]]);
  }

  // FAIL-FIRST: parity mismatch must throw
  test('THROWS: claude with wrong configFormat "toml" (installSurface=settings-json → expected settings-json)', () => {
    // claude has installSurface=settings-json → expected configFormat=settings-json
    // Giving it configFormat=toml must trigger the HARD gate
    const capMap = makeRuntimeCapMap('claude', 'toml', 'settings-json');
    assert.throws(
      () => runConfigFormatParityGate(capMap),
      (err) => {
        assert.ok(err instanceof Error, 'Must throw an Error');
        assert.ok(
          err.message.includes('claude') && err.message.includes('parity gate FAILED'),
          'Error must name the runtime and say "parity gate FAILED", got: ' + err.message,
        );
        assert.ok(
          err.message.includes('settings-json') && err.message.includes('toml'),
          'Error must name both the expected and actual configFormat, got: ' + err.message,
        );
        return true;
      },
    );
  });

  test('THROWS: codex with wrong configFormat "settings-json" (installSurface=codex-toml → expected toml)', () => {
    const capMap = makeRuntimeCapMap('codex', 'settings-json', 'codex-toml');
    assert.throws(
      () => runConfigFormatParityGate(capMap),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('codex') && err.message.includes('parity gate FAILED'));
        return true;
      },
    );
  });

  // All 16 real runtime descriptors must pass the parity gate (true-negative)
  test('all 16 real runtime descriptors pass the configFormat parity gate (DOES NOT THROW)', () => {
    const { capMap, errors } = loadAndValidate(new Set());
    const hardErrors = errors.filter((e) => !e.includes('pending-migration'));
    assert.deepEqual(hardErrors, [], 'No hard errors expected: ' + JSON.stringify(hardErrors));

    // runConfigFormatParityGate must not throw for the real registry
    assert.doesNotThrow(
      () => runConfigFormatParityGate(capMap),
      'runConfigFormatParityGate must not throw for the real 16 runtime descriptors',
    );
  });

  // buildRegistry must not throw for the real registry (end-to-end integration)
  test('buildRegistry with real 16 runtime descriptors does not throw (parity gate integrated)', () => {
    const { capMap } = loadAndValidate(new Set());
    assert.doesNotThrow(
      () => buildRegistry(capMap),
      'buildRegistry must not throw for the real registry (parity gate must pass)',
    );
  });

  // INSTALL_SURFACE_TO_CONFIG_FORMAT export check
  test('INSTALL_SURFACE_TO_CONFIG_FORMAT covers all 7 installSurface values with correct mappings', () => {
    assert.ok(INSTALL_SURFACE_TO_CONFIG_FORMAT instanceof Map, 'Must be a Map');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.size, 7, 'Must cover 7 installSurface values');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('settings-json'),        'settings-json');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('codex-toml'),           'toml');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('copilot-instructions'), 'markdown');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('cline-rules'),          'markdown-dir');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('cursor-hooks-json'),    'none');
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('profile-marker-only'),  'none');
    // 'none' added #2103 — a runtime with no CLI install surface at all (e.g.
    // vscode) has no config-file format to write either.
    assert.strictEqual(INSTALL_SURFACE_TO_CONFIG_FORMAT.get('none'),                'none');
  });

  // Feature capabilities (role:feature) are silently ignored by the gate
  test('feature capabilities (role:feature) are ignored by the parity gate — does not throw', () => {
    // Use the real UI cap (role:feature, has no installSurface) — gate must pass silently
    const capMap = new Map([['ui', UI_CAP]]);
    assert.doesNotThrow(
      () => runConfigFormatParityGate(capMap),
      'Feature capabilities must be ignored by the configFormat parity gate',
    );
  });

  // Runtimes with no installSurface in their descriptor are excluded from the gate.
  // The gate reads installSurface from cap.runtime.installSurface (the descriptor level);
  // if it is absent (typeof !== 'string'), the runtime is soft-skipped.
  // NOTE: the gate no longer uses the adapter registry — it reads purely from the descriptor.
  test('runtime with no installSurface in descriptor (e.g. hypothetical "grok") is excluded from parity gate — does not throw', () => {
    // 'grok' has no installSurface → gate must soft-skip (typeof r.installSurface !== 'string')
    const grokCap = {
      id: 'grok',
      role: 'runtime',
      title: 'Grok',
      description: 'Hypothetical grok runtime',
      tier: 'core',
      requires: [],
      runtime: {
        configHome: { kind: 'dot-home', name: '.grok', env: [] },
        configFormat: 'settings-json',  // any value — gate should not check this (no installSurface)
        artifactLayout: { global: [], local: [] },
        commandStyle: 'slash-hyphen',
        hooksSurface: 'none',
        sandboxTier: 'none',
        supportTier: 2,
        // intentionally no installSurface — gate must skip this entry
      },
    };
    const capMap = new Map([['grok', grokCap]]);
    assert.doesNotThrow(
      () => runConfigFormatParityGate(capMap),
      'Runtimes with no installSurface in their descriptor must be excluded from the parity gate',
    );
  });
});

// ─── 27. ADR-857 phase 5f: cross-field consistency gate rejection tests ────────

describe('ADR-857 phase 5f: cross-field consistency gate rejection tests (DEFECT.GENERATIVE-FIX)', () => {
  // Helper: build a minimal VALID runtime cap for cross-field rejection tests.
  // Override any field via the overrides object.
  function makeValidRuntimeCap(overrides) {
    const base = {
      id: 'test-runtime',
      role: 'runtime',
      title: 'Test runtime',
      description: 'Synthetic runtime for cross-field gate rejection testing.',
      tier: 'core',
      requires: [],
      runtime: {
        configHome: { kind: 'dot-home', name: '.test-runtime', env: [] },
        localConfigDir: '.test-runtime',
        configFormat: 'settings-json',
        artifactLayout: { global: [], local: [] },
        commandStyle: 'slash-hyphen',
        hooksSurface: 'settings-json',
        hookEvents: 'claude',
        sandboxTier: 'none',
        supportTier: 1,
        installSurface: 'settings-json',
        writesSharedSettings: true,
        permissionWriter: null,
        extendedHookEvents: [],
        hostIntegration: {
          embeddingMode: 'imperative',
          commandSurface: 'slash-file',
          dispatch: { namedDispatch: true, nested: true, maxDepth: -1, background: true, subagentToolkit: 'full', backgroundDispatch: false },
          modelMode: 'passive',
          hookBus: 'host',
          stateIO: 'filesystem',
          transport: 'mcp',
          runtime: 'node',
        },
      },
    };
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides)) {
        if (k === 'runtime' && typeof v === 'object') {
          Object.assign(base.runtime, v);
        } else {
          base[k] = v;
        }
      }
    }
    return base;
  }

  test('REJECTS: installSurface not in VALID_INSTALL_SURFACES → throws validation error', () => {
    const cap = makeValidRuntimeCap({ runtime: { installSurface: 'bogus-surface' } });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('installSurface') && e.includes('bogus-surface')),
      'Expected error about invalid installSurface, got: ' + JSON.stringify(errors),
    );
  });

  test('REJECTS: permissionWriter not null and not in {opencode,kilo} → throws validation error', () => {
    const cap = makeValidRuntimeCap({ runtime: { permissionWriter: 'notarealwriter' } });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('permissionWriter') && e.includes('notarealwriter')),
      'Expected error about invalid permissionWriter, got: ' + JSON.stringify(errors),
    );
  });

  test('REJECTS: extendedHookEvents containing a bogus event ("SubagentStopTypo") → throws validation error', () => {
    const cap = makeValidRuntimeCap({ runtime: { extendedHookEvents: ['SubagentStopTypo'] } });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('extendedHookEvents') && e.includes('SubagentStopTypo')),
      'Expected error about invalid extendedHookEvents entry, got: ' + JSON.stringify(errors),
    );
  });

  test('REJECTS: writesSharedSettings not a boolean → throws validation error', () => {
    const cap = makeValidRuntimeCap({ runtime: { writesSharedSettings: 'yes' } });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('writesSharedSettings') && e.includes('"yes"')),
      'Expected error about writesSharedSettings not boolean, got: ' + JSON.stringify(errors),
    );
  });

  test('GATE A REJECTS: profile-marker-only + hooksSurface="settings-json" → validation error', () => {
    // profile-marker-only installSurface only allows hooksSurface='none'
    const cap = makeValidRuntimeCap({
      runtime: {
        installSurface: 'profile-marker-only',
        hooksSurface: 'settings-json',
        configFormat: 'none', // correct for profile-marker-only
      },
    });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('hooksSurface') && e.includes('profile-marker-only')),
      'Expected GATE A error for profile-marker-only + hooksSurface=settings-json, got: ' + JSON.stringify(errors),
    );
  });

  test('GATE B REJECTS: hookEvents="claude" + extendedHookEvents=["BeforeAgent"] → validation error', () => {
    // BeforeAgent is a Gemini agent-event — requires hookEvents='gemini', not 'claude'
    const cap = makeValidRuntimeCap({
      runtime: {
        hookEvents: 'claude',
        extendedHookEvents: ['BeforeAgent'],
      },
    });
    const errors = validateRuntimeBody(cap);
    assert.ok(
      errors.some((e) => e.includes('BeforeAgent') && e.includes('"gemini"')),
      'Expected GATE B error for hookEvents=claude + extendedHookEvents=[BeforeAgent], got: ' + JSON.stringify(errors),
    );
  });

  // #2103: configHome.kind==='none' carve-out (VS Code — Marketplace/VSIX, no
  // file-projected config directory). Adversarial review flagged AC4's
  // "accept vscode AND reject a faked configHome" requirement as untested —
  // the real vscode descriptor validating clean (tests/capability-registry.test.cjs's
  // "ADR-1016 phase 5a" suite, capability-validator-parity tests, etc.) only
  // proves the ACCEPT half. These three tests are the REJECT half: they prove
  // the two new branches in validateRuntimeBody/validateConfigHome actually
  // fire, quoting their EXACT error strings so a future edit that silently
  // weakens either branch fails loudly here.
  describe('#2103 configHome.kind==="none" carve-out (vscode) — accept/reject pair', () => {
    test('ACCEPT: configHome.kind:"none" + localConfigDir:null + installSurface:"none" + hooksSurface:"none" validates with ZERO errors', () => {
      const cap = makeValidRuntimeCap({
        runtime: {
          configHome: { kind: 'none', name: 'test-none-rt', env: [] },
          localConfigDir: null,
          configFormat: 'none',
          installSurface: 'none',
          hooksSurface: 'none',
        },
      });
      const errors = validateRuntimeBody(cap);
      assert.deepEqual(errors, [], 'a genuinely kind:"none" descriptor (vscode-shaped) must validate clean, got: ' + JSON.stringify(errors));
    });

    test('REJECT #1: localConfigDir non-null while configHome.kind==="none" → exact validateRuntimeBody error', () => {
      const cap = makeValidRuntimeCap({
        runtime: {
          configHome: { kind: 'none', name: 'test-none-rt', env: [] },
          localConfigDir: '.vscode', // faked — a kind:'none' descriptor must not also claim a local dir
          configFormat: 'none',
          installSurface: 'none',
          hooksSurface: 'none',
        },
      });
      const errors = validateRuntimeBody(cap);
      assert.deepEqual(
        errors,
        ['runtime.localConfigDir must be null or absent when configHome.kind is "none"; got: ".vscode"'],
        'expected the exact localConfigDir-vs-kind:"none" rejection, got: ' + JSON.stringify(errors),
      );
    });

    test('REJECT #2: configHome.name present-but-empty while configHome.kind==="none" → exact validateConfigHome error', () => {
      const cap = makeValidRuntimeCap({
        runtime: {
          configHome: { kind: 'none', name: '', env: [] }, // faked — present name must still be non-empty
          localConfigDir: null,
          configFormat: 'none',
          installSurface: 'none',
          hooksSurface: 'none',
        },
      });
      const errors = validateRuntimeBody(cap);
      assert.deepEqual(
        errors,
        ['capability "test-runtime" runtime.configHome.name must be a non-empty string if present when kind is "none"'],
        'expected the exact configHome.name-vs-kind:"none" rejection, got: ' + JSON.stringify(errors),
      );
    });
  });

  // Verify the new constants are well-formed
  test('INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES covers all 7 installSurface values', () => {
    assert.ok(INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES instanceof Map, 'Must be a Map');
    assert.strictEqual(INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES.size, 7, 'Must cover 7 installSurface values');
    for (const installSurface of VALID_INSTALL_SURFACES) {
      assert.ok(
        INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES.has(installSurface),
        'INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES must include installSurface "' + installSurface + '"',
      );
    }
  });

  test('VALID_EXTENDED_HOOK_EVENTS covers all 8 known extended events', () => {
    assert.ok(VALID_EXTENDED_HOOK_EVENTS instanceof Set, 'Must be a Set');
    assert.strictEqual(VALID_EXTENDED_HOOK_EVENTS.size, 8, 'Must cover 8 extended hook events');
    // SubagentStart added #2092 Phase B Upgrade 2 (qwen-only today).
    for (const ev of ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'SubagentStart']) {
      assert.ok(VALID_EXTENDED_HOOK_EVENTS.has(ev), 'Must include event "' + ev + '"');
    }
  });

  test('VALID_PERMISSION_WRITERS covers exactly {opencode, kilo, antigravity}', () => {
    assert.ok(VALID_PERMISSION_WRITERS instanceof Set, 'Must be a Set');
    assert.strictEqual(VALID_PERMISSION_WRITERS.size, 3, 'Must cover 3 permission writers');
    assert.ok(VALID_PERMISSION_WRITERS.has('opencode'), 'Must include opencode');
    assert.ok(VALID_PERMISSION_WRITERS.has('kilo'), 'Must include kilo');
    assert.ok(VALID_PERMISSION_WRITERS.has('antigravity'), 'Must include antigravity (#2096)');
  });

  // Confirm the valid base fixture does NOT produce errors (sanity)
  test('valid runtime fixture produces no validation errors', () => {
    const cap = makeValidRuntimeCap({});
    const errors = validateRuntimeBody(cap);
    assert.deepEqual(errors, [], 'Valid fixture must produce no errors, got: ' + JSON.stringify(errors));
  });
});

// ─── Change A: loadCentralConfigKeys ENOENT vs parse-error distinction ────────

describe('loadCentralConfigKeys — ENOENT vs parse-error (Issue #1124)', () => {
  test('ENOENT: nonexistent path returns empty Set without throwing or writing stderr', () => {
    const stderrWrites = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg, ...rest) => { stderrWrites.push(msg); return origWrite(msg, ...rest); };
    let result;
    try {
      const nonexistent = path.join(os.tmpdir(), 'cfgkeys-nonexistent-' + Date.now() + '.json');
      result = loadCentralConfigKeys(nonexistent);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(result instanceof Set, 'should return a Set');
    assert.strictEqual(result.size, 0, 'Set should be empty for ENOENT');
    const warnings = stderrWrites.filter((m) => typeof m === 'string' && m.length > 0);
    assert.deepEqual(warnings, [], 'No stderr output expected for ENOENT, got: ' + JSON.stringify(warnings));
  });

  test('malformed JSON: throws and writes stderr containing the file path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgkeys-'));
    const badFile = path.join(tmpDir, 'bad-schema.json');
    fs.writeFileSync(badFile, '<<<<<<< HEAD\nnot json\n>>>>>>> main', 'utf8');
    const stderrWrites = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg, ...rest) => { stderrWrites.push(msg); return origWrite(msg, ...rest); };
    let thrownErr;
    try {
      loadCentralConfigKeys(badFile);
    } catch (err) {
      thrownErr = err;
    } finally {
      process.stderr.write = origWrite;
    }
    // Clean up
    cleanup(tmpDir);
    assert.ok(thrownErr !== undefined, 'Expected loadCentralConfigKeys to throw on malformed JSON');
    assert.strictEqual(thrownErr.name, 'ExitError', 'thrown error must be an ExitError, got: ' + thrownErr.name);
    assert.strictEqual(thrownErr.code, 1, 'ExitError must have code 1, got: ' + thrownErr.code);
    const combined = stderrWrites.join('');
    assert.ok(
      combined.includes(badFile),
      'stderr should include the file path, got: ' + combined,
    );
  });

  test('valid file: returns Set containing the declared keys', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgkeys-'));
    const goodFile = path.join(tmpDir, 'good-schema.json');
    fs.writeFileSync(goodFile, JSON.stringify({ validKeys: ['a', 'b'] }), 'utf8');
    let result;
    try {
      result = loadCentralConfigKeys(goodFile);
    } finally {
      cleanup(tmpDir);
    }
    assert.ok(result instanceof Set, 'should return a Set');
    assert.ok(result.has('a'), "Set should contain 'a'");
    assert.ok(result.has('b'), "Set should contain 'b'");
    assert.strictEqual(result.size, 2, 'Set should have exactly 2 entries');
  });

  test('non-ENOENT read error (path is a directory) throws ExitError and warns', () => {
    // fs.readFileSync on a directory throws EISDIR (code !== 'ENOENT'), which must
    // hit the non-ENOENT read-error branch: throw ExitError(1) and write stderr.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgkeys-dir-'));
    const stderrWrites = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg, ...rest) => { stderrWrites.push(msg); return origWrite(msg, ...rest); };
    let thrownErr;
    try {
      loadCentralConfigKeys(tmpDir);
    } catch (err) {
      thrownErr = err;
    } finally {
      process.stderr.write = origWrite;
    }
    cleanup(tmpDir);
    assert.ok(thrownErr !== undefined, 'Expected loadCentralConfigKeys to throw on EISDIR (directory path)');
    assert.strictEqual(thrownErr.name, 'ExitError', 'thrown error must be an ExitError, got: ' + thrownErr.name);
    assert.strictEqual(thrownErr.code, 1, 'ExitError must have code 1, got: ' + thrownErr.code);
    const combined = stderrWrites.join('');
    assert.ok(
      combined.includes(tmpDir),
      'stderr should include the directory path, got: ' + combined,
    );
  });
});

// ─── Change B: duplicate-producer invariant at gen time (Issue #1123) ─────────

describe('duplicate-producer invariant — same artifact same point (Issue #1123)', () => {
  // Minimal base capability clone helper (deep-clone UI_CAP then override key fields)
  function makeFeatureCap(overrides) {
    return Object.assign(JSON.parse(JSON.stringify(UI_CAP)), overrides);
  }

  test('REJECTION: two caps each producing DUP.md at plan:pre → throws with artifact/point/ids in message', () => {
    // Note: omit 'when' and use config:{} so there are no config-key validation errors.
    // Caps must pass per-capability validation to enter capMap and trigger the global check.
    const capA = makeFeatureCap({
      id: 'dup-a',
      skills: ['dup-a-skill'],
      agents: ['gsd-dup-a-agent'],
      config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'dup-a-skill' },
          produces: ['DUP.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        },
      ],
      gates: [],
      contributions: [],
    });
    const capB = makeFeatureCap({
      id: 'dup-b',
      skills: ['dup-b-skill'],
      agents: ['gsd-dup-b-agent'],
      config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'dup-b-skill' },
          produces: ['DUP.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        },
      ],
      gates: [],
      contributions: [],
    });
    // The duplicate-producer check fires during loadAndValidate (in validateConsumesGlobal)
    // or during buildRegistry — test wraps the entire build flow.
    const capDir = makeTempCapDir({ 'dup-a': capA, 'dup-b': capB });
    let threw = false;
    let errorMsg = '';
    try {
      const { capMap } = loadAndValidate(new Set(), capDir);
      buildRegistry(capMap);
    } catch (err) {
      threw = true;
      errorMsg = err.message || String(err);
    }
    assert.ok(threw, 'Expected build flow to throw for duplicate producers at the same point');
    assert.ok(errorMsg.includes('DUP.md'), 'Error message should mention DUP.md, got: ' + errorMsg);
    assert.ok(errorMsg.includes('plan:pre'), 'Error message should mention the point, got: ' + errorMsg);
    assert.ok(
      errorMsg.includes('dup-a') && errorMsg.includes('dup-b'),
      'Error message should mention both cap ids, got: ' + errorMsg,
    );
  });

  test('PASSING: same artifact at DIFFERENT points does not trigger duplicate-producer error', () => {
    // cap-diff-a produces SAME.md at plan:pre; cap-diff-b produces SAME.md at execute:post
    // Different pointIdx → must not throw the duplicate-producer error.
    // NOTE: both points must be wired (have render-hooks call sites in host workflows)
    // to pass the validateHooksWired gen-time guard added in #1196.
    const capDiffA = makeFeatureCap({
      id: 'diff-a',
      skills: ['diff-a-skill'],
      agents: ['gsd-diff-a-agent'],
      config: {},
      steps: [
        {
          point: 'plan:pre',
          ref: { skill: 'diff-a-skill' },
          produces: ['SAME.md'],
          consumes: ['CONTEXT.md'],
          onError: 'skip',
        },
      ],
      gates: [],
      contributions: [],
    });
    const capDiffB = makeFeatureCap({
      id: 'diff-b',
      skills: ['diff-b-skill'],
      agents: ['gsd-diff-b-agent'],
      config: {},
      steps: [
        {
          point: 'execute:post',
          ref: { skill: 'diff-b-skill' },
          produces: ['SAME.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      gates: [],
      contributions: [],
    });
    const capDir = makeTempCapDir({ 'diff-a': capDiffA, 'diff-b': capDiffB });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'Expected no validation errors for different-point fixtures, got: ' + JSON.stringify(errors));
    // buildRegistry must NOT throw — if the duplicate-producer bug regressed it would throw here
    assert.doesNotThrow(
      () => buildRegistry(capMap),
      'Should NOT throw duplicate-producer error for same artifact at DIFFERENT points',
    );
  });
});

// ─── #1196 — discuss loop wiring + wired-point guard ─────────────────────────

describe('#1196 — discuss loop wiring + wired-point guard', () => {
  // ─── Defect 1 — discuss is now wireable ─────────────────────────────────────

  describe('Defect 1: discuss is a wireable loop host', () => {
    test('HOST_LOOP_FILES includes discuss-phase.md', () => {
      assert.ok(
        Array.isArray(HOST_LOOP_FILES),
        'HOST_LOOP_FILES must be an array',
      );
      assert.ok(
        HOST_LOOP_FILES.includes('gsd-core/workflows/discuss-phase.md'),
        `HOST_LOOP_FILES must include 'gsd-core/workflows/discuss-phase.md'. Got: ${JSON.stringify(HOST_LOOP_FILES)}`,
      );
    });

    test('getWiredLoopPoints(ROOT) contains discuss:pre', () => {
      const wired = getWiredLoopPoints(ROOT);
      assert.ok(
        wired instanceof Set,
        'getWiredLoopPoints must return a Set',
      );
      assert.ok(
        wired.has('discuss:pre'),
        `getWiredLoopPoints(ROOT) must contain 'discuss:pre'. Got: ${JSON.stringify([...wired])}`,
      );
    });

    test('getWiredLoopPoints(ROOT) contains discuss:post', () => {
      const wired = getWiredLoopPoints(ROOT);
      assert.ok(
        wired.has('discuss:post'),
        `getWiredLoopPoints(ROOT) must contain 'discuss:post'. Got: ${JSON.stringify([...wired])}`,
      );
    });
  });

  // ─── Defect 2 — gen-time wired guard ────────────────────────────────────────

  describe('Defect 2: validateHooksWired gen-time guard', () => {
    /** Minimal capability fixture with one hook at a given point */
    function makeCapWithStep(point) {
      return {
        id: 'test-cap',
        role: 'feature',
        steps: [{ point, ref: { skill: 'my-skill' }, produces: [], consumes: [], onError: 'skip' }],
        contributions: [],
        gates: [],
        config: {},
      };
    }

    function makeCapWithContribution(point) {
      return {
        id: 'test-cap',
        role: 'feature',
        steps: [],
        contributions: [{ point, into: 'orchestrator', fragment: { inline: 'hi' }, produces: [], consumes: [] }],
        gates: [],
        config: {},
      };
    }

    function makeCapWithGate(point) {
      return {
        id: 'test-cap',
        role: 'feature',
        steps: [],
        contributions: [],
        gates: [{ point, check: { query: 'test-query' }, blocking: false, onError: 'skip' }],
        config: {},
      };
    }

    test('returns non-empty error array mentioning "not wired" when step point is not in wiredSet', () => {
      const cap = makeCapWithStep('discuss:pre');
      const wiredSet = new Set(['plan:pre', 'plan:post']); // discuss:pre absent
      const errs = validateHooksWired(cap, wiredSet);
      assert.ok(Array.isArray(errs), 'must return an array');
      assert.ok(errs.length > 0, 'must return errors when point is unwired');
      const joined = errs.join(' ');
      assert.match(joined, /not wired/i, 'error must mention "not wired"');
      assert.match(joined, /discuss:pre/, 'error must name the point');
      assert.match(joined, /test-cap/, 'error must name the capability id');
    });

    test('returns non-empty error array when contribution point is not in wiredSet', () => {
      const cap = makeCapWithContribution('discuss:pre');
      const wiredSet = new Set(['plan:pre']); // discuss:pre absent
      const errs = validateHooksWired(cap, wiredSet);
      assert.ok(errs.length > 0, 'must return errors for unwired contribution point');
      assert.match(errs.join(' '), /not wired/i);
    });

    test('returns non-empty error array when gate point is not in wiredSet', () => {
      const cap = makeCapWithGate('discuss:pre');
      const wiredSet = new Set(['plan:pre']); // discuss:pre absent
      const errs = validateHooksWired(cap, wiredSet);
      assert.ok(errs.length > 0, 'must return errors for unwired gate point');
      assert.match(errs.join(' '), /not wired/i);
    });

    test('returns empty array when all declared points are in wiredSet', () => {
      const cap = makeCapWithStep('plan:pre');
      const wiredSet = new Set(['plan:pre', 'plan:post', 'execute:post']);
      const errs = validateHooksWired(cap, wiredSet);
      assert.deepEqual(errs, [], 'must return empty array when all points are wired');
    });

    test('boundary: cap declaring discuss:pre is rejected against wiredSet lacking it', () => {
      const cap = makeCapWithStep('discuss:pre');
      const smallSet = new Set(['plan:pre', 'plan:post']);
      const errs = validateHooksWired(cap, smallSet);
      assert.ok(errs.length > 0, 'must reject discuss:pre against a set that lacks it');
    });

    test('boundary: cap declaring discuss:pre is accepted against real getWiredLoopPoints(ROOT) post-fix', () => {
      const cap = makeCapWithStep('discuss:pre');
      const realWired = getWiredLoopPoints(ROOT);
      const errs = validateHooksWired(cap, realWired);
      assert.deepEqual(
        errs, [],
        `discuss:pre must be wired after the fix. Errors: ${errs.join('; ')}`,
      );
    });

    test('boundary: cap declaring discuss:post is accepted against real getWiredLoopPoints(ROOT) post-fix', () => {
      const cap = makeCapWithContribution('discuss:post');
      const realWired = getWiredLoopPoints(ROOT);
      const errs = validateHooksWired(cap, realWired);
      assert.deepEqual(
        errs, [],
        `discuss:post must be wired after the fix. Errors: ${errs.join('; ')}`,
      );
    });

    test('invalid points (not in VALID_LOOP_POINTS) are not flagged as "unwired" (already caught by schema validator)', () => {
      const cap = {
        id: 'test-cap',
        role: 'feature',
        steps: [{ point: 'not:a:real:point', ref: { skill: 'x' }, produces: [], consumes: [], onError: 'skip' }],
        contributions: [],
        gates: [],
        config: {},
      };
      const wiredSet = new Set(['plan:pre']); // the invalid point is not here either
      const errs = validateHooksWired(cap, wiredSet);
      // Should NOT flag it — invalid points are the schema validator's job
      const notWiredErrors = errs.filter((e) => /not wired/i.test(e));
      assert.deepEqual(
        notWiredErrors, [],
        'validateHooksWired must not flag invalid points as "not wired" (those are caught by schema validation)',
      );
    });
  });

  // ─── Anti-pattern parity guards ──────────────────────────────────────────────

  describe('Anti-pattern parity: host-file set has a single source of truth', () => {
    test('every STEP_WORKFLOWS entry file exists on disk and contains a gsd:loop-host marker', () => {
      for (const { file, step } of STEP_WORKFLOWS) {
        const absPath = path.join(ROOT, 'gsd-core', 'workflows', file);
        assert.ok(
          fs.existsSync(absPath),
          `STEP_WORKFLOWS entry ${file} (step: ${step}) does not exist on disk at ${absPath}`,
        );
        const content = fs.readFileSync(absPath, 'utf8');
        assert.match(
          content,
          /<!--\s*gsd:loop-host/,
          `${file} (step: ${step}) is listed in STEP_WORKFLOWS but lacks a gsd:loop-host marker`,
        );
      }
    });

    test('HOST_LOOP_FILES matches STEP_WORKFLOWS (single source of truth)', () => {
      const expectedFromStepWorkflows = STEP_WORKFLOWS.map((w) => 'gsd-core/workflows/' + w.file);
      assert.deepEqual(
        HOST_LOOP_FILES,
        expectedFromStepWorkflows,
        'HOST_LOOP_FILES must be derived from STEP_WORKFLOWS, not a separate hardcoded list',
      );
    });

    test('every workflow file carrying a gsd:loop-host marker is present in STEP_WORKFLOWS', () => {
      const workflowsDir = path.join(ROOT, 'gsd-core', 'workflows');

      // Find all .md files in workflows dir (non-recursive — top-level only, subdirs are mode files)
      const allMdFiles = fs.readdirSync(workflowsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

      const stepWorkflowFiles = new Set(STEP_WORKFLOWS.map((w) => w.file));
      const missingFromStepWorkflows = [];

      for (const mdFile of allMdFiles) {
        const absPath = path.join(workflowsDir, mdFile);
        const content = fs.readFileSync(absPath, 'utf8');
        if (/<!--\s*gsd:loop-host/.test(content) && !stepWorkflowFiles.has(mdFile)) {
          missingFromStepWorkflows.push(mdFile);
        }
      }

      assert.deepEqual(
        missingFromStepWorkflows, [],
        `These workflow files have a gsd:loop-host marker but are absent from STEP_WORKFLOWS: ` +
        `${missingFromStepWorkflows.join(', ')}. Add them to STEP_WORKFLOWS in scripts/gen-loop-host-contract.cjs.`,
      );
    });

    test('POINT_ORDER (capability-registry) === flattened LOOP_HOST_CONTRACT points — schema/contract drift guard', () => {
      // Flatten all contract points in order
      const contractPoints = [];
      for (const entry of LOOP_HOST_CONTRACT) {
        contractPoints.push(...entry.points);
      }

      assert.deepEqual(
        POINT_ORDER,
        contractPoints,
        'POINT_ORDER in gen-capability-registry must equal the flattened LOOP_HOST_CONTRACT points in order. ' +
        `POINT_ORDER: ${JSON.stringify(POINT_ORDER)}, contract flatten: ${JSON.stringify(contractPoints)}`,
      );
    });

    test('CANONICAL_POINTS (gen-loop-host-contract) matches POINT_ORDER (gen-capability-registry)', () => {
      assert.deepEqual(
        [...CANONICAL_POINTS],
        POINT_ORDER,
        'CANONICAL_POINTS in gen-loop-host-contract must equal POINT_ORDER in gen-capability-registry',
      );
    });
  });

  // ─── Property test ────────────────────────────────────────────────────────────

  describe('Property: scanWiredPoints is a correct extractor', () => {
    test('fc: scanWiredPoints(text) returns exactly the set of points whose call sites appear in text', () => {
      // The canonical 12 points from CANONICAL_POINTS
      const allPoints = [...CANONICAL_POINTS];

      fc.assert(
        fc.property(
          fc.subarray(allPoints, { minLength: 0, maxLength: allPoints.length }),
          (subset) => {
            // Build a synthetic text containing one call site per point in the subset
            const lines = subset.map((p) => `HOOKS_JSON=$(gsd_run loop render-hooks ${p} --raw)`);
            // Add some noise to exercise robustness
            const noise = ['# comment', 'echo hello', `gsd_run loop some-other-command`, ''];
            const text = [...lines, ...noise].join('\n');

            const result = scanWiredPoints(text);

            // result must be a Set
            if (!(result instanceof Set)) return false;

            // result must contain exactly the subset points
            const resultArr = [...result].sort();
            const subsetArr = [...subset].sort();
            if (resultArr.length !== subsetArr.length) return false;
            for (let i = 0; i < subsetArr.length; i++) {
              if (resultArr[i] !== subsetArr[i]) return false;
            }
            return true;
          },
        ),
        { numRuns: 200 },
      );
    });

    test('NIT-02: scanWiredPoints does not match an incomplete occurrence (no point token after render-hooks)', () => {
      // A line with `loop render-hooks` but no following point token must not match
      const incompleteText = 'HOOKS_JSON=$(gsd_run loop render-hooks\n)';
      const result = scanWiredPoints(incompleteText);
      assert.strictEqual(
        result.size,
        0,
        'scanWiredPoints must return an empty Set when the render-hooks call has no point token. ' +
        `Got: ${JSON.stringify([...result])}`,
      );
    });
  });
});

// ─── activationKey validation (issue #1304 Phase 1) ─────────────────────────

describe('activationKey validation', () => {
  // Minimal valid feature capability fixture for activationKey tests.
  // Uses UI_CAP as a base so all required fields are satisfied.
  function makeCapWithActivationKey(activationKey) {
    const cap = { ...UI_CAP, activationKey };
    if (activationKey === undefined) delete cap.activationKey;
    return cap;
  }

  // (a) valid activationKey referencing a key declared in the cap's own config slice
  test('(a) valid activationKey referencing own config key: no errors, emitted in registry', () => {
    // UI_CAP declares 'workflow.ui_phase' (boolean) in its config — use that as activationKey
    const cap = makeCapWithActivationKey('workflow.ui_phase');
    const errors = validateCapability(cap, 'ui');
    assert.deepEqual(
      errors,
      [],
      'Expected no validation errors for activationKey that matches own config key, got: ' +
        JSON.stringify(errors),
    );

    // Confirm activationKey is emitted in the built registry
    const capDir = makeTempCapDir({ ui: cap });
    const { capMap, errors: loadErrors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(loadErrors, [], 'Expected no load errors: ' + JSON.stringify(loadErrors));
    const registry = buildRegistry(capMap);
    assert.strictEqual(
      registry.capabilities.ui.activationKey,
      'workflow.ui_phase',
      'registry.capabilities.ui.activationKey must equal the declared activationKey',
    );
  });

  // (b) activationKey referencing an UNKNOWN config key → a specific error naming the cap + key
  test('(b) activationKey referencing unknown config key: specific error emitted', () => {
    const cap = makeCapWithActivationKey('no-such-key.enabled');
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey references an unknown config key',
    );
    const joined = errors.join('\n');
    assert.ok(
      joined.includes('no-such-key.enabled'),
      'Error must name the bad activationKey, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      joined.includes('ui') || joined.includes('(unknown)'),
      'Error must name the capability id, got: ' + JSON.stringify(errors),
    );
    assert.ok(
      joined.includes('config'),
      'Error must reference the config slice, got: ' + JSON.stringify(errors),
    );
  });

  // (c) activationKey absent → valid (back-compat)
  test('(c) activationKey absent: valid (back-compat — no errors)', () => {
    const cap = makeCapWithActivationKey(undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cap, 'activationKey'),
      'Fixture must not have activationKey when undefined is passed',
    );
    const errors = validateCapability(cap, 'ui');
    assert.deepEqual(
      errors,
      [],
      'Expected no validation errors when activationKey is absent, got: ' + JSON.stringify(errors),
    );
  });

  // (d) activationKey present but empty string → error
  test('(d) activationKey empty string: error', () => {
    const cap = makeCapWithActivationKey('');
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is an empty string',
    );
    assert.ok(
      errors.some((e) => e.includes('activationKey') && e.includes('non-empty')),
      'Error must mention activationKey and non-empty, got: ' + JSON.stringify(errors),
    );
  });

  // (d-extra) activationKey non-string (number) → error
  test('(d-extra) activationKey non-string (number): error', () => {
    const cap = { ...UI_CAP, activationKey: 42 };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is a number',
    );
    assert.ok(
      errors.some((e) => e.includes('activationKey') && e.includes('non-empty')),
      'Error must mention activationKey and non-empty string requirement, got: ' + JSON.stringify(errors),
    );
  });

  // (e) reserved-name guard: activationKey === '__proto__' → reserved-name error, not not-declared error
  test('(e) activationKey "__proto__": reserved-name error (not not-declared error)', () => {
    const cap = makeCapWithActivationKey('__proto__');
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is "__proto__"',
    );
    assert.ok(
      errors.some((e) => e.includes('__proto__') && e.includes('reserved')),
      'Error must mention "__proto__" and "reserved", got: ' + JSON.stringify(errors),
    );
    // Must NOT emit the not-declared error (the guard runs before hasOwnProperty.call)
    assert.ok(
      !errors.some((e) => e.includes('is not declared in this capability\'s config slice')),
      'Reserved-name guard must fire before the not-declared check; got: ' + JSON.stringify(errors),
    );
  });

  // (f) reserved-name guard: activationKey === 'constructor' → reserved-name error
  test('(f) activationKey "constructor": reserved-name error', () => {
    const cap = makeCapWithActivationKey('constructor');
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is "constructor"',
    );
    assert.ok(
      errors.some((e) => e.includes('constructor') && e.includes('reserved')),
      'Error must mention "constructor" and "reserved", got: ' + JSON.stringify(errors),
    );
    assert.ok(
      !errors.some((e) => e.includes('is not declared in this capability\'s config slice')),
      'Reserved-name guard must fire before the not-declared check; got: ' + JSON.stringify(errors),
    );
  });

  // (g) reserved-name guard: activationKey === 'prototype' → reserved-name error
  test('(g) activationKey "prototype": reserved-name error', () => {
    const cap = makeCapWithActivationKey('prototype');
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is "prototype"',
    );
    assert.ok(
      errors.some((e) => e.includes('prototype') && e.includes('reserved')),
      'Error must mention "prototype" and "reserved", got: ' + JSON.stringify(errors),
    );
    assert.ok(
      !errors.some((e) => e.includes('is not declared in this capability\'s config slice')),
      'Reserved-name guard must fire before the not-declared check; got: ' + JSON.stringify(errors),
    );
  });

  // (h) regression guard: activationKey === null → non-empty-string error (typeof null === 'object' footgun)
  test('(h) activationKey null: non-empty-string error (typeof null footgun regression guard)', () => {
    const cap = { ...UI_CAP, activationKey: null };
    const errors = validateCapability(cap, 'ui');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when activationKey is null',
    );
    assert.ok(
      errors.some((e) => e.includes('activationKey') && e.includes('non-empty')),
      'Error must mention activationKey and non-empty string requirement (typeof null === "object" must not bypass the check), got: ' + JSON.stringify(errors),
    );
    // Must NOT emit the reserved-name error
    assert.ok(
      !errors.some((e) => e.includes('reserved')),
      'null must not trigger the reserved-name guard, got: ' + JSON.stringify(errors),
    );
  });

  // Registry integration: activationKey absent → field absent in registry entry (omit semantics)
  test('activationKey absent: field omitted from registry capabilities entry', () => {
    const cap = makeCapWithActivationKey(undefined);
    const capDir = makeTempCapDir({ ui: cap });
    const { capMap, errors } = loadAndValidate(new Set(), capDir);
    assert.deepEqual(errors, [], 'Expected no load errors: ' + JSON.stringify(errors));
    const registry = buildRegistry(capMap);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(registry.capabilities.ui, 'activationKey'),
      'activationKey must be absent from registry.capabilities.ui when not declared',
    );
  });

  // Verify graphify capability.json declares correct activationKey
  test('graphify capability.json declares activationKey matching its own config key', () => {
    const graphifyCap = JSON.parse(
      require('node:fs').readFileSync(
        require('node:path').join(ROOT, 'capabilities', 'graphify', 'capability.json'),
        'utf8',
      ),
    );
    assert.strictEqual(
      graphifyCap.activationKey,
      'graphify.enabled',
      'graphify capability.json must declare activationKey: "graphify.enabled"',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(graphifyCap.config, 'graphify.enabled'),
      'graphify capability.json config must contain key "graphify.enabled"',
    );
  });

  // Verify intel capability.json declares correct activationKey
  test('intel capability.json declares activationKey matching its own config key', () => {
    const intelCap = JSON.parse(
      require('node:fs').readFileSync(
        require('node:path').join(ROOT, 'capabilities', 'intel', 'capability.json'),
        'utf8',
      ),
    );
    assert.strictEqual(
      intelCap.activationKey,
      'intel.enabled',
      'intel capability.json must declare activationKey: "intel.enabled"',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(intelCap.config, 'intel.enabled'),
      'intel capability.json config must contain key "intel.enabled"',
    );
  });

  // (i) role:runtime capability with activationKey → feature-only field error
  test('(i) role:runtime with activationKey: feature-only field error', () => {
    const cap = {
      id: 'cursor', role: 'runtime', title: 'Cursor', description: 'Cursor IDE runtime',
      tier: 'standard', requires: [],
      activationKey: 'some.key',
      runtime: {
        configHome: { kind: 'dot-home', name: '.cursor', env: ['CURSOR_CONFIG_DIR'] },
        configFormat: 'settings-json',
        artifactLayout: { global: [], local: [] },
        commandStyle: 'slash-hyphen',
        hooksSurface: 'cursor-hooks-json',
        hookEvents: 'claude',
        sandboxTier: 'none',
        supportTier: 2,
        installSurface: 'cursor-hooks-json',
        writesSharedSettings: false,
        permissionWriter: null,
        extendedHookEvents: [],
        hostIntegration: {
          embeddingMode: 'declarative',
          commandSurface: 'slash-file',
          dispatch: { namedDispatch: true, nested: true, maxDepth: 2, background: false, subagentToolkit: 'full', backgroundDispatch: false },
          modelMode: 'passive',
          hookBus: 'host',
          stateIO: 'filesystem',
          transport: 'mcp',
          runtime: 'node',
        },
      },
    };
    const errors = validateCapability(cap, 'cursor');
    assert.ok(
      errors.length > 0,
      'Expected at least one error when role:runtime declares activationKey',
    );
    assert.ok(
      errors.some((e) => e.includes('activationKey') && e.includes('feature-only')),
      'Error must mention activationKey and feature-only, got: ' + JSON.stringify(errors),
    );
  });
});

// ─── ADR-1244 D2: validator extraction generative parity ──────────────────────
//
// The validator now lives in gsd-core/bin/lib/capability-validator.cjs and is
// re-exported by the generator. These assertions guarantee the build-time
// generator and the runtime overlay share ONE validator implementation — no
// divergent copy can drift between them, because the generator re-exports the
// very same object references.
describe('ADR-1244 D2: validator extraction generative parity', () => {
  const CORE = [
    'validateCapability', 'validateCrossCapability', 'validateVersionEnvelope',
    'validateConsumesGlobal', 'validateAgainstContract', 'validateConfigSliceEntry',
    'validateRuntimeBody', 'classifyCrossErrors',
  ];

  test('the runtime validator module exposes the full validator surface', () => {
    for (const sym of [...CORE, 'SEMVER_RE', 'SEMVER_RANGE_RE', 'POINT_ORDER', 'VALID_LOOP_POINTS', 'VALID_TIERS']) {
      assert.ok(sym in capValidatorModule, `validator module must export ${sym}`);
    }
    assert.strictEqual(typeof capValidatorModule.validateCapability, 'function');
    assert.ok(capValidatorModule.SEMVER_RE instanceof RegExp);
  });

  test('every generator-re-exported validator symbol is the SAME object as the validator module (no drift)', () => {
    const shared = Object.keys(capValidatorModule).filter((k) => Object.prototype.hasOwnProperty.call(generatorModule, k));
    assert.ok(shared.length >= 20, `expected the generator to re-export the validator surface, got ${shared.length}`);
    for (const k of shared) {
      assert.strictEqual(
        generatorModule[k],
        capValidatorModule[k],
        `generator export "${k}" must be the SAME reference as the validator module's (drift detected)`,
      );
    }
  });

  test('core validators are re-exported identically by the generator', () => {
    for (const sym of CORE) {
      assert.strictEqual(
        generatorModule[sym], capValidatorModule[sym],
        `${sym} must be re-exported by the generator as the validator module's reference`,
      );
    }
  });

  test('the extracted validator runs standalone (no generator/build-time deps required)', () => {
    // Proves the module is genuinely runtime-callable: a clean require + validate
    // with no install-profiles/clusters/config-schema machinery present.
    const { validateCapability } = capValidatorModule;
    const cap = {
      id: 'demo', role: 'feature', version: '1.0.0', title: 'Demo', description: 'demo',
      tier: 'standard', requires: [], runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    };
    assert.deepEqual(validateCapability(cap, 'demo'), []);
    const { version: _v, ...noVersion } = cap;
    assert.ok(validateCapability(noVersion, 'demo').some((e) => e.includes('version')));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2530-valid-config-keys.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2530-valid-config-keys (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression tests for config key bugs:
 * #2530 — workflow._auto_chain_active is internal state, must not be in VALID_CONFIG_KEYS
 * #2531 — hooks.workflow_guard is used by hook and documented but missing from VALID_CONFIG_KEYS
 * #2532 — workflow.ui_review is used in autonomous.md but missing from config validation
 * #2533 — workflow.max_discuss_passes is used in discuss-phase.md but missing from VALID_CONFIG_KEYS
 * #2535 — sub_repos and plan_checker legacy keys need CONFIG_KEY_SUGGESTIONS migration hints
 * #3162 — resolve_model_ids missing from VALID_CONFIG_KEYS; workflow._auto_chain_active must be
 *          accepted by isValidConfigKey (written by workflows) without being user-visible
 * #1747 — buildNewProjectConfig emits four search-provider keys (tavily_search, ref_search,
 *          perplexity, jina) that research-provider.cts consumes but were missing from
 *          VALID_CONFIG_KEYS, causing /gsd-settings unknown-key warnings on fresh projects
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  VALID_CONFIG_KEYS,
  isCentralConfigKey,
  isValidConfigKey,
} = require('../gsd-core/bin/lib/config-schema.cjs');

const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

describe('VALID_CONFIG_KEYS correctness', () => {
  test('#2530: workflow._auto_chain_active must not be in VALID_CONFIG_KEYS (internal state)', () => {
    assert.ok(
      !VALID_CONFIG_KEYS.has('workflow._auto_chain_active'),
      'workflow._auto_chain_active is internal runtime state and must not be user-settable'
    );
  });

  test('#2531: hooks.workflow_guard must be in VALID_CONFIG_KEYS (used by hook, documented)', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('hooks.workflow_guard'),
      'hooks.workflow_guard is read by gsd-workflow-guard.js hook and documented in CONFIGURATION.md'
    );
  });

  test('#2532: workflow.ui_review must remain valid but is no longer centrally owned', () => {
    assert.strictEqual(
      isValidConfigKey('workflow.ui_review'),
      true,
      'workflow.ui_review is still user-facing config and must validate'
    );
    assert.strictEqual(
      isCentralConfigKey('workflow.ui_review'),
      false,
      'workflow.ui_review is owned by the UI capability after ADR-857 Phase 6 cutover'
    );
  });

  test('#2533: workflow.max_discuss_passes must be in VALID_CONFIG_KEYS (used in discuss-phase.md)', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('workflow.max_discuss_passes'),
      'workflow.max_discuss_passes is read in discuss-phase.md via gsd-sdk query config-get'
    );
  });

  test('#3162: resolve_model_ids must be in VALID_CONFIG_KEYS (documented user-facing key)', () => {
    assert.ok(
      VALID_CONFIG_KEYS.has('resolve_model_ids'),
      'resolve_model_ids is documented in CONFIGURATION.md and read by core.cjs/session-runner.ts'
    );
  });

  test('#3162: workflow._auto_chain_active must be accepted by isValidConfigKey (written by workflows)', () => {
    assert.strictEqual(
      isValidConfigKey('workflow._auto_chain_active'),
      true,
      'workflow._auto_chain_active is written by plan-phase, execute-phase, discuss-phase, transition workflows via config-set'
    );
  });
});

describe('#1747: new-project config emits only schema-recognized provider keys', () => {
  // buildNewProjectConfig emits seven search-provider availability flags and
  // research-provider.cts providerAvailability() consumes all seven, but only
  // three were in VALID_CONFIG_KEYS → /gsd-settings warned on the four
  // unregistered keys (tavily_search, ref_search, perplexity, jina) for every
  // freshly generated .planning/config.json.

  // The four keys that were emitted + consumed but missing from the schema.
  const MISSING_KEYS = ['tavily_search', 'ref_search', 'perplexity', 'jina'];

  // Every config-driven provider flag read by providerAvailability() in
  // src/research-provider.cts. context7/websearch are excluded: hardcoded
  // `true`, not config-gated, so no config key to register.
  const PROVIDER_CONFIG_KEYS = [
    'brave_search',
    'firecrawl',
    'exa_search',
    'tavily_search',
    'ref_search',
    'perplexity',
    'jina',
  ];

  test('the four previously-missing provider keys are in VALID_CONFIG_KEYS', () => {
    const absent = MISSING_KEYS.filter((k) => !VALID_CONFIG_KEYS.has(k));
    assert.deepStrictEqual(
      absent,
      [],
      `These provider keys are emitted by buildNewProjectConfig and consumed by research-provider.cts but missing from VALID_CONFIG_KEYS:\n  ${absent.join('\n  ')}\n\nAdd them to gsd-core/bin/shared/config-schema.manifest.json (validKeys).`
    );
  });

  test('every config-driven research-provider flag is registered in the schema (drift guard)', () => {
    const drifted = PROVIDER_CONFIG_KEYS.filter((k) => !VALID_CONFIG_KEYS.has(k));
    assert.deepStrictEqual(
      drifted,
      [],
      `These research-provider config flags are not in VALID_CONFIG_KEYS — a fresh /gsd-new-project config would trigger an unknown-key warning under /gsd-settings:\n  ${drifted.join('\n  ')}\n\nWhen you add a provider to providerAvailability() in src/research-provider.cts, also register its config key in gsd-core/bin/shared/config-schema.manifest.json.`
    );
  });
});

describe('ADR-857 Phase 6 capability config ownership', () => {
  test('migrated capability config keys are valid through the registry, not central schema residue', () => {
    const capabilityKeys = Object.keys(capabilityRegistry.configSchema || {}).sort();
    assert.ok(capabilityKeys.length > 0, 'expected generated registry config schema keys');

    for (const key of capabilityKeys) {
      assert.strictEqual(isValidConfigKey(key), true, `${key} must remain accepted by config validation`);
      assert.strictEqual(isCentralConfigKey(key), false, `${key} must be capability-owned, not central`);
      assert.strictEqual(VALID_CONFIG_KEYS.has(key), false, `${key} must not remain in central VALID_CONFIG_KEYS`);
    }
  });
});

describe('CONFIG_KEY_SUGGESTIONS migration hints (#2535)', () => {
  let tmpDir;

  test('config-set sub_repos emits "Did you mean planning.sub_repos?" suggestion', (t) => {
    tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'sub_repos', '[]'], tmpDir);
    assert.ok(!result.success, 'config-set sub_repos should fail');
    const combined = result.error + result.output;
    assert.ok(
      combined.includes('Did you mean') && combined.includes('planning.sub_repos'),
      `Expected "Did you mean planning.sub_repos?" in error, got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
  });

  test('config-set plan_checker emits "Did you mean workflow.plan_check?" suggestion', (t) => {
    tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    const result = runGsdTools(['config-set', 'plan_checker', 'true'], tmpDir);
    assert.ok(!result.success, 'config-set plan_checker should fail');
    const combined = result.error + result.output;
    assert.ok(
      combined.includes('Did you mean') && combined.includes('workflow.plan_check'),
      `Expected "Did you mean workflow.plan_check?" in error, got:\nstdout: ${result.output}\nstderr: ${result.error}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2851-workflow-bare-gsd-tools.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2851-workflow-bare-gsd-tools (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #2851: plan-phase.md §13e calls bare `gsd-tools` — incomplete fix of #2245
 *
 * Workflow bodies should not call `gsd-tools` as an unguarded bare command.
 * Use the resolver snippets for SDK calls, or an explicit local CJS path when
 * a command intentionally targets the checked-in legacy script:
 *
 *   node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" <subcommand> [args]
 *
 * As of #621, the §13e gap-analysis call uses the `gsd_run` launcher (the
 * canonical resolvable form) instead of the absolute-$HOME path above.
 * Both forms are resolvable; `gsd_run` is now the preferred canonical form.
 *
 * Some workflow markdown files leaked the bare `gsd-tools <subcommand>` form,
 * which fails with `command not found` at runtime.
 *
 * This test parses every markdown file in gsd-core/workflows/ structurally:
 * it tokenizes the content into fenced code blocks, then on each shell-block
 * line checks whether `gsd-tools` appears as a bare command (not preceded by
 * `node `, not part of the filename `gsd-tools.cjs`, not inside a comment).
 *
 * Per project rule: this test does NOT use grep/regex .includes() on raw file
 * content as the assertion surface. Instead, it splits into code-fenced blocks
 * and tokenizes each line — only command-position tokens count as violations.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

/**
 * Extract shell-fenced code blocks from a markdown file.
 * Returns an array of { startLine, lines } where lines are the contents
 * between the ```bash / ```sh / ```shell fence markers.
 */
function extractShellBlocks(content) {
  const allLines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockLang = null;
  let blockStart = 0;
  let blockLines = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const fenceOpen = line.match(/^```(\w+)?/);
    if (!inBlock && fenceOpen) {
      inBlock = true;
      blockLang = (fenceOpen[1] || '').toLowerCase();
      blockStart = i + 2; // 1-indexed line number of first content line
      blockLines = [];
      continue;
    }
    if (inBlock && /^```\s*$/.test(line)) {
      if (['bash', 'sh', 'shell', 'zsh', ''].includes(blockLang)) {
        blocks.push({ startLine: blockStart, lines: blockLines });
      }
      inBlock = false;
      blockLang = null;
      blockLines = [];
      continue;
    }
    if (inBlock) {
      blockLines.push(line);
    }
  }
  return blocks;
}

/**
 * Check a single shell-block line for a bare `gsd-tools` command-position token.
 * Returns true if the line is a violation.
 */
function lineHasBareGsdTools(line) {
  // Strip leading whitespace and any prompt prefix ($ , > , # )
  let l = line.replace(/^\s*[$>]\s*/, '');
  // Skip pure comment lines
  if (/^\s*#/.test(l)) return false;
  // Strip inline comment (# preceded by whitespace, not inside a string)
  // Conservative: only strip if # appears after whitespace and outside quotes —
  // we just look for the first ` #` outside of quoted context. For our needs,
  // splitting on `^[^"']*?(\s#)` is good enough.
  const hashIdx = l.search(/(?:^|[^"'\w])#/);
  if (hashIdx > 0) l = l.slice(0, hashIdx);

  // Unwrap command-substitution forms so the substituted command is in
  // command position. `$(cmd …)` and `` `cmd …` `` both run the inner string
  // as a fresh command, so a bare `gsd-tools` inside them is just as broken
  // as one at the start of the line. Iterate until stable for nested forms.
  let prev;
  do {
    prev = l;
    l = l.replace(/\$\(([^()]*)\)/g, ' $1 ').replace(/`([^`]*)`/g, ' $1 ');
  } while (l !== prev);

  // Tokenize on whitespace, semicolons, pipes, and && / ||
  // Then walk tokens — a violation is a token that starts with `gsd-tools`
  // followed by a word boundary (so `gsd-tools.cjs` does NOT match), and the
  // preceding token is NOT `node`.
  const segments = l.split(/(?:\s*(?:&&|\|\||;|\|)\s*)/);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // Skip env var assignments at the start (FOO=bar gsd-tools …, tmp=1 gsd-tools …).
    // POSIX shell variable names are [A-Za-z_][A-Za-z0-9_]*; lowercase is valid.
    let cmdIdx = 0;
    while (cmdIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmdIdx])) {
      cmdIdx++;
    }
    if (cmdIdx >= tokens.length) continue;
    const cmd = tokens[cmdIdx];
    // Match `gsd-tools` exactly (no extension), as command position.
    if (cmd === 'gsd-tools') return true;
  }
  return false;
}

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

describe('bug #1041: agent files must not call bare gsd-tools (all-runtime resolver)', () => {
  test('no agents/gsd-*.md file contains a bare gsd-tools command', () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected agent files to exist');

    const violations = [];
    for (const f of files) {
      const full = path.join(AGENTS_DIR, f);
      const content = fs.readFileSync(full, 'utf-8');
      const blocks = extractShellBlocks(content);
      for (const blk of blocks) {
        for (let i = 0; i < blk.lines.length; i++) {
          if (lineHasBareGsdTools(blk.lines[i])) {
            violations.push(`${f}:${blk.startLine + i}: ${blk.lines[i].trim()}`);
          }
        }
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Bare `gsd-tools` invocations found in agent shell blocks. ' +
        'Inject the runtime-launcher preamble (_runtime-launcher.snippet.sh) and use `gsd_run` instead.\n' +
        violations.join('\n'),
    );
  });
});

describe('bug-2851: workflow files must not call bare `gsd-tools` (#2245 sweep regression)', () => {
  test('no gsd-core/workflows/*.md file contains a bare gsd-tools command', () => {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected workflow files to exist');

    const violations = [];
    for (const f of files) {
      const full = path.join(WORKFLOWS_DIR, f);
      const content = fs.readFileSync(full, 'utf-8');
      const blocks = extractShellBlocks(content);
      for (const blk of blocks) {
        for (let i = 0; i < blk.lines.length; i++) {
          if (lineHasBareGsdTools(blk.lines[i])) {
            violations.push(`${f}:${blk.startLine + i}: ${blk.lines[i].trim()}`);
          }
        }
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Bare `gsd-tools` invocations found in workflow shell blocks. ' +
        'Use a resolver snippet or `node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" <subcommand>` instead.\n' +
        violations.join('\n'),
    );
  });

  test('plan-phase.md §13e gap-analysis dispatches via gsd_run loop render-hooks plan:post (ADR-857 capability gate, #621)', () => {
    const planPhase = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    const blocks = extractShellBlocks(planPhase);
    let foundPlanPostDispatch = false;
    for (const blk of blocks) {
      for (const line of blk.lines) {
        if (/gsd_run\s+loop\s+render-hooks\s+plan:post\s+--raw/.test(line) && !/^\s*#/.test(line)) {
          foundPlanPostDispatch = true;
        }
      }
    }
    assert.ok(
      foundPlanPostDispatch,
      'expected plan-phase.md §13e to dispatch gsd_run loop render-hooks plan:post --raw (gap-analysis moved to capability gate plan:post in ADR-857 migration)',
    );
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    const planPostPoint = (registry.byLoopPoint || {})['plan:post'] || {};
    const gates = planPostPoint.gates || [];
    const gapAnalysisGate = gates.find((g) => g.capId === 'gap-analysis');
    assert.ok(
      gapAnalysisGate,
      'gap-analysis capability must be registered as a plan:post gate in capability-registry.cjs',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1628-config-set-validation.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1628-config-set-validation (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression test suite for bug #1628: config-set validation gaps.
 *
 * This file consolidates all #1628 config-set validation regression tests:
 *   1. Security-key enum guards (workflow.security_block_on, workflow.security_asvs_level)
 *   2. JSON-array coercion bypass: every affected string-enum key
 *   3. Generic capability-registry validation (enum/boolean/number/string keys)
 *
 * Covers:
 * - workflow.security_block_on must be one of: critical | high | medium | low | none
 * - workflow.security_asvs_level must be an integer in {1, 2, 3}
 * - JSON-array (["<member>"]) and JSON-object ({"x":1}) values must be REJECTED for
 *   all string-enum keys (typeof check before enum guard)
 * - capability-registry-owned keys: ENUM, BOOLEAN, NUMBER, STRING
 *
 * Boundary coverage per RULESET.TESTS.boundary-coverage:
 *   security_asvs_level: 0 (limit-1), 1 (limit), 2, 3 (limit), 4 (limit+1)
 *   security_block_on: each valid enum member + bogus values
 *
 * Registry canary: verifies capability registry's .values for workflow.security_block_on
 * matches the canonical enum (guards against silent gutting per DEFECT.GENERATIVE-FIX).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// ─── Registry canary ──────────────────────────────────────────────────────────
// Verify the capability registry's declared .values for workflow.security_block_on
// matches the canonical enum. config.cts sources its allowed set DIRECTLY from the
// registry, so this canary guards against the registry being silently gutted — which
// would cause every config-set call to fail (per DEFECT.GENERATIVE-FIX).
describe('fix-1628: registry canary — capability registry declares the canonical security_block_on enum', () => {
  test('registry workflow.security_block_on.values declares the expected canonical enum', () => {
    // Load the capability registry as a module (behavioral call, not source grep).
    // The registry IS the source of truth: config.cts reads from it at runtime.
    // This assertion guards against the registry entry being gutted or values removed.
    const { configSchema } = require('../gsd-core/bin/lib/capability-registry.cjs');
    const entry = configSchema['workflow.security_block_on'];
    assert.ok(entry, 'capability registry must have an entry for workflow.security_block_on');
    assert.ok(Array.isArray(entry.values), 'registry entry must have a .values array');

    const EXPECTED = ['critical', 'high', 'medium', 'low', 'none'];
    assert.deepEqual(
      [...entry.values].sort(),
      [...EXPECTED].sort(),
      `Registry workflow.security_block_on.values must be ${JSON.stringify(EXPECTED)} — update ` +
      `the capability registry if the canonical enum changes`
    );
  });
});

// ─── workflow.security_block_on ───────────────────────────────────────────────

describe('fix-1628: workflow.security_block_on enum validation', () => {
  const VALID_VALUES = ['critical', 'high', 'medium', 'low', 'none'];
  const INVALID_VALUES = ['bogus', 'High', 'CRITICAL', '', 'all', 'urgent'];

  for (const v of VALID_VALUES) {
    test(`config-set workflow.security_block_on=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', v],
        tmpDir
      );
      assert.ok(
        result.success,
        [
          `config-set workflow.security_block_on=${v} must succeed,`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  for (const v of INVALID_VALUES) {
    test(`config-set workflow.security_block_on=${JSON.stringify(v)} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', v],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_block_on=${JSON.stringify(v)} must fail, but it succeeded`
      );
      const combined = (result.output || '') + (result.error || '');
      // Error message must mention the valid values
      assert.ok(
        combined.includes('critical') && combined.includes('none'),
        `Error message must mention valid values (got: ${combined})`
      );
    });
  }
});

// ─── workflow.security_block_on — JSON-parse coercion bypass ─────────────────
// Regression for the String(parsedValue) coercion bug: an array like ["high"]
// coerces to "high" via String(), bypassing the enum check and writing an array
// to a string-enum key. The fix requires typeof parsedValue === 'string'.

describe('fix-1628: workflow.security_block_on rejects JSON-parsed non-string inputs', () => {
  const JSON_BYPASS_CASES = [
    { val: '["high"]',   label: 'JSON array with valid member' },
    { val: '["bogus"]',  label: 'JSON array with invalid member' },
    { val: '{"high":1}', label: 'JSON object' },
  ];

  for (const { val, label } of JSON_BYPASS_CASES) {
    test(`config-set workflow.security_block_on=${label} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_block_on', val],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_block_on=${label} must fail, but it succeeded`
      );
    });
  }
});

// ─── workflow.security_asvs_level ─────────────────────────────────────────────

describe('fix-1628: workflow.security_asvs_level range validation', () => {
  // Boundary: 0 (below limit), 1 (min valid), 2 (mid), 3 (max valid), 4 (above limit)
  const ACCEPTED_INTEGERS = [1, 2, 3];
  const REJECTED_VALUES = [
    { val: '0',   label: '0 (below lower bound)' },
    { val: '4',   label: '4 (above upper bound)' },
    { val: '2.5', label: '2.5 (non-integer float)' },
    { val: 'abc', label: '"abc" (non-numeric string)' },
    { val: '-1',  label: '-1 (negative)' },
  ];

  for (const n of ACCEPTED_INTEGERS) {
    test(`config-set workflow.security_asvs_level=${n} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_asvs_level', String(n)],
        tmpDir
      );
      assert.ok(
        result.success,
        [
          `config-set workflow.security_asvs_level=${n} must succeed,`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  for (const { val, label } of REJECTED_VALUES) {
    test(`config-set workflow.security_asvs_level=${label} is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(
        ['config-set', 'workflow.security_asvs_level', val],
        tmpDir
      );
      assert.ok(
        !result.success,
        `config-set workflow.security_asvs_level=${label} must fail, but it succeeded`
      );
      const combined = (result.output || '') + (result.error || '');
      assert.ok(
        combined.includes('security_asvs_level'),
        `Error message must reference the key name (got: ${combined})`
      );
    });
  }
});

// ─── JSON-array coercion bypass — parameterised matrix ───────────────────────
// The root cause: cmdConfigSet JSON-parses any value starting with '[' or '{'
// BEFORE per-key enum guards run. Guards using `.includes(String(parsedValue))`
// are then fooled because `String(["mid-flight"]) === "mid-flight"`, so the
// array bypasses the guard and gets stored in a scalar key.
//
// The fix: `assertEnumValue()` checks `typeof parsedValue === 'string'` FIRST,
// so a parsed array is rejected regardless of its string coercion.
//
// Coverage: every affected string-enum key.
// - `["<member>"]` (JSON array with valid member) → REJECTED
// - `{"x":1}` (JSON object) → REJECTED
// - `<member>` (plain string, valid) → ACCEPTED

// Each row: { key, member } where `member` is a valid enum value for `key`.
// Verified against VALID_* arrays in src/config.cts.
const ENUM_KEYS = [
  { key: 'context',                              member: 'research'   },
  { key: 'workflow.drift_action',                member: 'warn'       },
  { key: 'workflow.human_verify_mode',           member: 'mid-flight' },
  { key: 'workflow.context_guard_mode',          member: 'off'        },
  { key: 'statusline.context_position',          member: 'front'      },
  { key: 'statusline.state_format',              member: 'compact'    },
  { key: 'code_quality.fallow.scope',            member: 'phase'      },
  { key: 'code_quality.fallow.profile',          member: 'standard'   },
  { key: 'plan_review.source_grounding_authority', member: 'grep'     },
  { key: 'workflow.security_block_on',           member: 'high'       },
];

for (const { key, member } of ENUM_KEYS) {
  describe(`fix-1628 coercion bypass: ${key}`, () => {
    // ── JSON array with valid member must be REJECTED ────────────────────────
    test(`["${member}"] (JSON array with valid member) is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const val = `["${member}"]`;
      const result = runGsdTools(['config-set', key, val], tmpDir);
      assert.ok(
        !result.success,
        [
          `config-set ${key}=${val} must be REJECTED (JSON-array coercion bypass)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });

    // ── JSON object must be REJECTED ─────────────────────────────────────────
    test(`{"x":1} (JSON object) is REJECTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const val = '{"x":1}';
      const result = runGsdTools(['config-set', key, val], tmpDir);
      assert.ok(
        !result.success,
        [
          `config-set ${key}=${val} must be REJECTED (JSON-object bypass)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });

    // ── Plain valid string must be ACCEPTED ──────────────────────────────────
    test(`"${member}" (plain valid string) is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', key, member], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set ${key}=${member} must be ACCEPTED (plain string, valid enum member)`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  });
}

// ─── ENUM: workflow.code_review_depth ────────────────────────────────────────

describe('fix-1628 capability validation: workflow.code_review_depth (enum)', () => {
  const VALID_VALUES = ['quick', 'standard', 'deep'];

  for (const v of VALID_VALUES) {
    test(`config-set workflow.code_review_depth=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', 'workflow.code_review_depth', v], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set workflow.code_review_depth=${v} must succeed`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  test('config-set workflow.code_review_depth=["standard"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.code_review_depth', '["standard"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.code_review_depth=["standard"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.code_review_depth=garbage is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.code_review_depth', 'garbage'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.code_review_depth=garbage must be REJECTED (out-of-enum)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── ENUM: mempalace.memory_mode ─────────────────────────────────────────────

describe('fix-1628 capability validation: mempalace.memory_mode (enum)', () => {
  const VALID_VALUES = ['augment', 'kg_backend', 'replace'];

  for (const v of VALID_VALUES) {
    test(`config-set mempalace.memory_mode=${v} is ACCEPTED`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      const result = runGsdTools(['config-set', 'mempalace.memory_mode', v], tmpDir);
      assert.ok(
        result.success,
        [
          `config-set mempalace.memory_mode=${v} must succeed`,
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n')
      );
    });
  }

  test('config-set mempalace.memory_mode=["augment"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.memory_mode', '["augment"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.memory_mode=["augment"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.memory_mode=garbage is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.memory_mode', 'garbage'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.memory_mode=garbage must be REJECTED (out-of-enum)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── ROUTING CONTRACT: mempalace.memory_mode wired behavior (#2007) ───────────
//
// memory_mode is an instruction-only contract: `augment`/`kg_backend`/`replace`
// change how the mempalace recall/capture/curator markdown tells the agent to
// treat the palace vs. GSD native memory. There is no code branch to unit-test,
// so the governed surface IS the instruction text across five parallel surfaces
// plus the capability schema. This block asserts (a) every mode is named with
// distinct, non-forward-declared routing, and (b) the parallel surfaces stay in
// parity so a future edit can't silently revert one to the inert state
// (CLAUDE.md Generative Fix Divergence). Reads .md/.json only — the no-source-grep
// rule targets .cjs/.js/.ts source reads, so no allow-test-rule exemption applies.

describe('#2007 mempalace.memory_mode routing contract (instruction surfaces)', () => {
  const MODES = ['augment', 'kg_backend', 'replace'];

  // The five parallel instruction surfaces that must express per-mode routing.
  const SURFACES = [
    'capabilities/mempalace/fragments/recall-discuss.md',
    'capabilities/mempalace/fragments/capture-problems.md',
    'commands/gsd/mempalace-recall.md',
    'commands/gsd/mempalace-capture.md',
    'agents/gsd-mempalace-curator.md',
  ];

  // Retired forward-declaration hedges — the presence of any one means a surface
  // reverted to the pre-#2007 inert state where the modes did nothing.
  const RETIRED_HEDGES = [
    'forward-declared',
    'behave as `augment`',
    'behaves as `augment`',
    'not yet functional',
    'routing seam not yet',
    'Only `augment` is currently wired',
    'Only `augment` is wired',
  ];

  for (const rel of SURFACES) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    test(`${rel} names all three memory modes`, () => {
      for (const m of MODES) {
        assert.ok(
          body.includes('`' + m + '`'),
          `${rel} must reference mode \`${m}\``
        );
      }
    });

    test(`${rel} carries no retired forward-declaration hedge`, () => {
      for (const hedge of RETIRED_HEDGES) {
        assert.ok(
          !body.includes(hedge),
          `${rel} still contains retired hedge "${hedge}" — memory_mode must describe wired per-mode routing, not a forward-declaration`
        );
      }
    });

    test(`${rel} expresses both halves of the routing contract (palace-primary + native-fallback)`, () => {
      // The wired contract is a duality: kg_backend/replace make the palace
      // primary/authoritative, AND every mode keeps native memory as a
      // fallback/mirror so the capability stays default-resilient (an unreachable
      // palace never loses memory). A surface that expresses only one half is a
      // defect — this guards the exact contradiction the #2007 review surfaced.
      assert.match(
        body,
        /primary|authoritative|source of truth/i,
        `${rel} must describe kg_backend/replace treating the palace as primary/authoritative`
      );
      assert.match(
        body,
        /fallback|mirror|additive|supplement/i,
        `${rel} must describe the native-memory fallback/mirror relationship (default-resilience)`
      );
      assert.ok(
        body.includes('.planning/graphs'),
        `${rel} must anchor the native memory surface (.planning/graphs/) that the palace augments/falls back to`
      );
    });
  }

  test('capability.json memory_mode schema declares the three modes and drops the not-implemented claim', () => {
    const cap = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'capabilities/mempalace/capability.json'),
        'utf8'
      )
    );
    const mode = cap.config['mempalace.memory_mode'];
    assert.deepEqual(
      mode.values,
      MODES,
      'enum values must be exactly [augment, kg_backend, replace]'
    );
    assert.equal(
      mode.default,
      'augment',
      'default stays augment (default-resilient)'
    );
    for (const hedge of [
      'forward-declared',
      'not yet built',
      'behave as',
      'behaves the same as',
    ]) {
      assert.ok(
        !mode.description.includes(hedge),
        `schema description must not claim the modes are unimplemented (found "${hedge}")`
      );
    }
  });
});

// ─── BOOLEAN: workflow.tdd_mode ──────────────────────────────────────────────

describe('fix-1628 capability validation: workflow.tdd_mode (boolean)', () => {
  test('config-set workflow.tdd_mode=true is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'true'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.tdd_mode=true must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=false is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'false'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.tdd_mode=false must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=["true"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '["true"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=["true"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode={"x":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '{"x":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode={"x":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=maybe (non-boolean string) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', 'maybe'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=maybe must be REJECTED (non-boolean string)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.tdd_mode=1 (numeric 1 coerces to number, not boolean) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.tdd_mode', '1'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.tdd_mode=1 must be REJECTED (number, not boolean)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── BOOLEAN: graphify.enabled ────────────────────────────────────────────────

describe('fix-1628 capability validation: graphify.enabled (boolean)', () => {
  test('config-set graphify.enabled=true is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'true'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set graphify.enabled=true must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=false is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'false'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set graphify.enabled=false must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=["true"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '["true"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=["true"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled={"x":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '{"x":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled={"x":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=maybe (non-boolean string) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', 'maybe'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=maybe must be REJECTED (non-boolean string)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set graphify.enabled=1 (numeric 1, not boolean) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'graphify.enabled', '1'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set graphify.enabled=1 must be REJECTED (number, not boolean)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── NUMBER: workflow.drift_threshold ────────────────────────────────────────

describe('fix-1628 capability validation: workflow.drift_threshold (number)', () => {
  test('config-set workflow.drift_threshold=5 is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.drift_threshold', '5'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set workflow.drift_threshold=5 must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set workflow.drift_threshold=["3"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'workflow.drift_threshold', '["3"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set workflow.drift_threshold=["3"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});

// ─── STRING: mempalace.wing ───────────────────────────────────────────────────

describe('fix-1628 capability validation: mempalace.wing (string)', () => {
  test('config-set mempalace.wing=myWing is ACCEPTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', 'myWing'], tmpDir);
    assert.ok(
      result.success,
      [
        'config-set mempalace.wing=myWing must succeed',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.wing=["x"] (JSON array bypass) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', '["x"]'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.wing=["x"] must be REJECTED (JSON-array coercion bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });

  test('config-set mempalace.wing={"a":1} (JSON object) is REJECTED', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(['config-set', 'mempalace.wing', '{"a":1}'], tmpDir);
    assert.ok(
      !result.success,
      [
        'config-set mempalace.wing={"a":1} must be REJECTED (JSON-object bypass)',
        'stdout: ' + result.output,
        'stderr: ' + result.error,
      ].join('\n')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1055-config-intent-descriptor-drive.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1055-config-intent-descriptor-drive (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * ADR-857 phase 5g drive 2: resolveRuntimeConfigIntent is now driven by the
 * runtime capability descriptor (capability-registry.cjs) rather than a
 * hand-kept REGISTRY const.
 *
 * This golden-master test pins the observable contract: the return shape and
 * values must be identical to the pre-change behavior for all 15 runtimes.
 * Purely behavioral — no source-grep.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeConfigIntent,
  ALLOWED_CONFIG_RUNTIMES,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-config-adapter-registry.cjs'));
const enh1055Registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

// ---------------------------------------------------------------------------
// Expected table — DERIVED from the capability registry descriptors. The
// contract being pinned is the PROJECTION (descriptor fields → intent), not a
// frozen per-runtime value snapshot. Adding a runtime descriptor extends
// coverage with zero edits here.
// ---------------------------------------------------------------------------

const EXPECTED = Object.keys(enh1055Registry.runtimes).map((id) => {
  const r = enh1055Registry.runtimes[id].runtime;
  const pw = r.permissionWriter;
  return {
    runtime: id,
    installSurface: r.installSurface,
    writesSharedSettings: r.writesSharedSettings,
    finishPermissionWriter: pw == null ? null : pw,
  };
});

// ---------------------------------------------------------------------------
// Test 1: Projection contract — every registry runtime resolves to its
// descriptor-derived intent (count-agnostic).
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: resolveRuntimeConfigIntent projection contract', () => {
  test('every registry runtime resolves to its descriptor-derived intent', () => {
    assert.ok(EXPECTED.length > 0, 'registry must contain at least one runtime');
    for (const row of EXPECTED) {
      assert.deepStrictEqual(resolveRuntimeConfigIntent(row.runtime), {
        runtime: row.runtime,
        installSurface: row.installSurface,
        writesSharedSettings: row.writesSharedSettings,
        finishPermissionWriter: row.finishPermissionWriter,
      }, `resolveRuntimeConfigIntent('${row.runtime}') must match the descriptor projection`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Unknown runtime throws TypeError
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: unknown runtime throws TypeError', () => {
  test('throws TypeError for "bogus-runtime"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('bogus-runtime'), TypeError);
  });

  test('throws TypeError for empty string', () => {
    assert.throws(() => resolveRuntimeConfigIntent(''), TypeError);
  });

  test('throws TypeError for undefined', () => {
    assert.throws(() => resolveRuntimeConfigIntent(undefined), TypeError);
  });

  test('throws TypeError for "__proto__"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('__proto__'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Test 4: ALLOWED_CONFIG_RUNTIMES equals the registry runtimes that declare an
// installSurface (count-agnostic; derived from the same source as production).
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: ALLOWED_CONFIG_RUNTIMES completeness', () => {
  test('equals the registry runtimes that declare an installSurface', () => {
    const descriptorAllowed = new Set(
      Object.entries(enh1055Registry.runtimes)
        // installSurface:'none' (#2103 vscode — extension-distributed, no config
        // directory) is NOT a config-adapter runtime: production ALLOWED_CONFIG_RUNTIMES
        // excludes it so `allRuntimes === ALLOWED_CONFIG_RUNTIMES` (issue-57) stays true.
        .filter(([, cap]) => cap && cap.runtime && typeof cap.runtime.installSurface === 'string' && cap.runtime.installSurface !== 'none')
        .map(([id]) => id),
    );
    assert.deepStrictEqual(new Set(ALLOWED_CONFIG_RUNTIMES), descriptorAllowed);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Descriptor drive — the function reads from the descriptor, not
// a hardcoded local constant. This is proven indirectly: the golden master
// passes, meaning capability-registry.cjs (the live descriptor) matches the
// expected table. If the adapter had its own REGISTRY, a descriptor change
// would diverge silently; with drive, it cannot.
// ---------------------------------------------------------------------------

describe('enh-1055 descriptor-drive: finishPermissionWriter passthrough', () => {
  test('opencode → "opencode" (descriptor permissionWriter)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('opencode').finishPermissionWriter, 'opencode');
  });

  test('kilo → "kilo" (descriptor permissionWriter)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kilo').finishPermissionWriter, 'kilo');
  });

  test('all other runtimes have finishPermissionWriter === null', () => {
    const nullExpected = EXPECTED
      .filter(r => r.finishPermissionWriter === null)
      .map(r => r.runtime);
    for (const runtime of nullExpected) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(runtime).finishPermissionWriter,
        null,
        `${runtime} should have finishPermissionWriter null`,
      );
    }
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1592-plan-drift-precheck.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1592-plan-drift-precheck (consolidation epic #1969 B6 #1975)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product see #1592
// The plan-phase.md host-dispatch assertions below read the workflow .md file — its text IS the
// deployed contract the runtime loads (CONTRIBUTING.md exemption category). The registry assertions
// are behavioral: they build the registry from the REAL capabilities/drift declaration via the
// generator, so they fail if the plan:pre gate is ever removed or mutated.

/**
 * Enhancement (#1592): plan-time codebase-map freshness pre-check.
 *
 * The `drift` capability gains a non-blocking `plan:pre` codebase-drift gate so a stale codebase map is
 * flagged BEFORE planning, instead of being discovered mid-execution by the existing
 * `execute:wave:post` codebase-drift gate. Warn-only at `plan:pre` (no mapper-agent spawn): the
 * capability's `drift_action: auto-remap` stays at `execute:wave:post`, so plan time never pays
 * speculative mapper-agent cost.
 *
 * Per maintainer review on #1592 (mod 1a), the plan:pre gate is gated on a DEDICATED
 * `workflow.plan_drift_precheck` toggle (default true) rather than reusing `workflow.schema_drift_gate`,
 * so autonomous/CI runs can silence the plan-time advisory without disabling the execute-time gates.
 * The gate declaration conforms to ADR-857 (`plan:pre` is an enumerated, additive-only loop point).
 *
 * Issue: #1592 (open-gsd/gsd-core).
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadAndValidate, buildRegistry } = require('../scripts/gen-capability-registry.cjs');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DRIFT_CAP = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'drift', 'capability.json'), 'utf8'),
);
const PLAN_PHASE = fs.readFileSync(
  path.join(REPO_ROOT, 'gsd-core', 'workflows', 'plan-phase.md'),
  'utf8',
);

// Track every temp dir created so the suite can remove them on teardown — leaked
// mkdtemp dirs have been a flake source here before (per #1592 review).
const tempCapDirs = [];

function makeTempCapDir(capabilities) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-1592-'));
  tempCapDirs.push(tmpDir);
  for (const [id, cap] of Object.entries(capabilities)) {
    const subDir = path.join(tmpDir, id);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return tmpDir;
}

after(() => {
  for (const dir of tempCapDirs) {
    cleanup(dir);
  }
});

function planPreDriftGate() {
  const capDir = makeTempCapDir({ drift: DRIFT_CAP });
  const { capMap, errors } = loadAndValidate(new Set(), capDir);
  assert.deepEqual(errors, [], 'drift capability should validate cleanly: ' + JSON.stringify(errors));
  const registry = buildRegistry(capMap);
  const planPreGates = registry.byLoopPoint['plan:pre'].gates;
  assert.ok(Array.isArray(planPreGates), 'plan:pre.gates should be an array');
  return planPreGates.find(
    (g) => g.capId === 'drift' && g.check && g.check.query === 'verify.codebase-drift',
  );
}

describe('#1592 — drift plan:pre codebase-drift gate (registry, behavioral)', () => {
  test('the real drift capability registers a non-blocking plan:pre codebase-drift gate', () => {
    const driftGate = planPreDriftGate();
    assert.ok(driftGate, 'plan:pre.gates must contain the drift codebase-drift gate');
    assert.strictEqual(driftGate.blocking, false, 'plan-time drift gate must be NON-blocking');
    assert.strictEqual(driftGate.onError, 'skip', 'must fail-soft (skip) — never halt planning');
  });

  test('the plan:pre gate is gated on the dedicated plan_drift_precheck toggle (mod 1a)', () => {
    const driftGate = planPreDriftGate();
    assert.strictEqual(
      driftGate.when,
      'workflow.plan_drift_precheck',
      'plan:pre drift gate must use the dedicated toggle so CI/autonomous runs can silence it ' +
        'without disabling the execute-time gates',
    );
  });

  test('the execute:wave:post codebase-drift gate is preserved and keeps its OWN toggle (no regression)', () => {
    const capDir = makeTempCapDir({ drift: DRIFT_CAP });
    const { capMap } = loadAndValidate(new Set(), capDir);
    const registry = buildRegistry(capMap);

    const execGates = registry.byLoopPoint['execute:wave:post'].gates;
    const stillThere = execGates.find(
      (g) => g.capId === 'drift' && g.check && g.check.query === 'verify.codebase-drift',
    );
    assert.ok(stillThere, 'execute:wave:post codebase-drift gate must remain after adding the plan:pre gate');
    assert.strictEqual(stillThere.blocking, false, 'execute codebase-drift gate stays non-blocking');
    assert.strictEqual(
      stillThere.when,
      'workflow.schema_drift_gate',
      'the execute-time gate keeps schema_drift_gate — the plan-time toggle is separable from it',
    );
  });

  test('plan_drift_precheck is a separate toggle from schema_drift_gate (silencing is independent)', () => {
    const planWhen = planPreDriftGate().when;
    assert.notStrictEqual(
      planWhen,
      'workflow.schema_drift_gate',
      'silencing the plan-time advisory must not require disabling the execute-time gates',
    );
  });

  test('plan_drift_precheck is declared as a boolean defaulting to true', () => {
    const cfg = DRIFT_CAP.config['workflow.plan_drift_precheck'];
    assert.ok(cfg, 'workflow.plan_drift_precheck must be declared in the drift capability config');
    assert.strictEqual(cfg.type, 'boolean', 'plan_drift_precheck must be a boolean');
    assert.strictEqual(cfg.default, true, 'plan_drift_precheck must default to true (on by default)');
  });

  test('exactly one new config key is introduced (the dedicated plan_drift_precheck toggle)', () => {
    const keys = Object.keys(DRIFT_CAP.config).sort();
    assert.deepStrictEqual(
      keys,
      [
        'workflow.drift_action',
        'workflow.drift_threshold',
        'workflow.plan_drift_precheck',
        'workflow.schema_drift_gate',
      ],
      'the plan:pre gate adds exactly the dedicated plan_drift_precheck toggle — no other new keys',
    );
  });
});

describe('#1592 — plan-phase host dispatches the drift plan:pre gate before planning', () => {
  const SECTION = PLAN_PHASE.slice(
    PLAN_PHASE.indexOf('5.65. Codebase Map Freshness Pre-Check'),
    PLAN_PHASE.indexOf('## 6. Check Existing Plans'),
  );

  test('§5.65 invokes the verify codebase-drift check', () => {
    assert.match(PLAN_PHASE, /5\.65\. Codebase Map Freshness Pre-Check/, 'plan-phase must declare §5.65');
    assert.match(PLAN_PHASE, /gsd_run verify codebase-drift/, '§5.65 must invoke `verify codebase-drift`');
  });

  test('the drift pre-check runs BEFORE the planner spawn (load-bearing ordering)', () => {
    const preCheckIdx = PLAN_PHASE.indexOf('5.65. Codebase Map Freshness Pre-Check');
    const plannerIdx = PLAN_PHASE.indexOf('## 8. Spawn gsd-planner Agent');
    assert.ok(preCheckIdx > 0, '§5.65 must exist');
    assert.ok(plannerIdx > 0, '§8 planner spawn must exist');
    assert.ok(
      preCheckIdx < plannerIdx,
      'the drift map-freshness pre-check must run before the planner is spawned — the whole point of #1592',
    );
  });

  test('§5.65 is documented as non-blocking and warn-only (no spawn)', () => {
    assert.match(SECTION, /non-blocking/i, '§5.65 must state the gate is non-blocking');
    assert.match(SECTION, /never blocks, never spawns/i, '§5.65 must state it never spawns the mapper at plan time');
  });

  test('§5.65 gates on the dedicated plan_drift_precheck toggle (mod 1a)', () => {
    assert.match(
      SECTION,
      /workflow\.plan_drift_precheck/,
      '§5.65 must dispatch on the dedicated plan_drift_precheck toggle, not schema_drift_gate',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1464-docs-manifest-validation.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1464-docs-manifest-validation (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product see #1464
// Tutorial docs are the product surface users follow. Reading JSON code blocks
// from them and validating through validateCapability is behavioral, not
// source-grep — it proves the manifests work, not just that they "mention" a term.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateCapability } = require('../scripts/gen-capability-registry.cjs');

const ROOT = path.join(__dirname, '..');

// ─── Extractor ───────────────────────────────────────────────────────────────

// Required top-level fields that distinguish a complete capability manifest
// from a partial output snippet (list-entry, install-result, etc.).
// Partial output snippets have id+role but lack steps/contributions/gates/config.
const MANIFEST_REQUIRED_KEYS = new Set([
  'id', 'role', 'title', 'description', 'tier',
  'requires', 'runtimeCompat', 'skills', 'agents',
  'config', 'steps', 'contributions', 'gates',
]);

/**
 * Extract JSON code blocks from markdown that are complete capability manifests.
 * A complete manifest has ALL keys in MANIFEST_REQUIRED_KEYS.
 * Partial output snippets (list-entries, install-results) have only id+role and are skipped.
 */
function extractManifests(mdContent) {
  const manifests = [];
  const fenceRe = /```json\s*\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(mdContent)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = new Set(Object.keys(parsed));
      if ([...MANIFEST_REQUIRED_KEYS].every((k) => keys.has(k))) {
        manifests.push(parsed);
      }
    }
  }
  return manifests;
}

// ─── Suite 1: tutorial manifests validate ────────────────────────────────────

describe('docs tutorial manifests pass validateCapability (#1464 regression)', () => {
  test('build-your-first-capability.md: every manifest passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'tutorials', 'build-your-first-capability.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in build tutorial',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `build tutorial manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });

  test('install-your-first-capability.md: every manifest passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'tutorials', 'install-your-first-capability.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in install tutorial',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `install tutorial manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });

  test('capability-manifest.md reference example passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'reference', 'capability-manifest.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in reference doc',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `reference manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });
});

// ─── Suite 2: adversarial — #1464 failure modes caught ───────────────────────
//
// These are the EXACT failure shapes from issue #1464.
// They must fail validateCapability — proving this test would have caught the bug.

describe('validateCapability catches original #1464 bug shapes', () => {
  // #1464 high-1: step missing ref → validateStep rejects it
  test('step without ref fails (the original broken tutorial step)', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Test fixture for #1464 regression.',
      tier: 'standard',
      requires: [],
      engines: { gsd: '>=1.6.0' },
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [
        {
          // Missing ref — this was the #1464 high-1 bug in the original tutorial
          point: 'plan:pre',
          produces: ['HELLO.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [],
      gates: [],
    };
    const errors = validateCapability(cap, 'hello-note');
    assert.ok(errors.length > 0, 'expected validation errors for step without ref');
    assert.ok(
      errors.some((e) => /ref/.test(e)),
      `expected an error mentioning "ref"; got: ${errors.join('; ')}`,
    );
  });

  // #1464 shape: id must match folder name (folderId contract)
  test('id not matching folderId fails', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Test fixture for id/folderId mismatch.',
      tier: 'standard',
      requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [],
      contributions: [],
      gates: [],
    };
    const errors = validateCapability(cap, 'wrong-folder');
    assert.ok(errors.length > 0, 'expected id/folderId mismatch to fail validation');
    assert.ok(
      errors.some((e) => /folder/.test(e) || /equal/.test(e) || /id/.test(e)),
      `expected error about id/folderId mismatch; got: ${errors.join('; ')}`,
    );
  });

  // Corrected shape: contribution with fragment + into (the PR #1495 fix)
  test('contribution with fragment.path + into passes (the PR #1495 fix shape)', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Injects a greeting note at plan:pre and produces HELLO.md.',
      tier: 'standard',
      requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [],
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { path: 'fragments/plan-pre.md' },
          produces: ['HELLO.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      gates: [],
    };
    const errors = validateCapability(cap, 'hello-note');
    assert.deepStrictEqual(
      errors,
      [],
      `corrected contribution manifest has unexpected errors: ${errors.join('; ')}`,
    );
  });
});

// ─── Suite 3: extractManifests helper ────────────────────────────────────────

describe('extractManifests helper unit tests', () => {
  test('returns empty array for plain text with no JSON fences', () => {
    assert.deepStrictEqual(extractManifests('No code blocks here.'), []);
  });

  test('skips JSON blocks without all required manifest keys', () => {
    // Partial list-entry block — only has id, role, version but not steps/contributions/etc.
    const md = '```json\n{"id":"x","role":"feature","version":"1.0.0"}\n```';
    assert.deepStrictEqual(extractManifests(md), []);
  });

  function makeCompleteManifest(overrides) {
    return {
      id: 'test-cap', role: 'feature', title: 'T', description: 'D',
      tier: 'standard', requires: [], runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], config: {}, steps: [], contributions: [], gates: [],
      ...overrides,
    };
  }

  test('extracts a complete manifest (all required keys present)', () => {
    const cap = makeCompleteManifest({ id: 'x' });
    const md = '```json\n' + JSON.stringify(cap, null, 2) + '\n```';
    const result = extractManifests(md);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'x');
  });

  test('skips malformed JSON blocks silently', () => {
    const complete = makeCompleteManifest({ id: 'y' });
    const md = '```json\n{bad json here\n```\n```json\n' + JSON.stringify(complete) + '\n```';
    const result = extractManifests(md);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'y');
  });

  test('extracts multiple complete manifests from one doc', () => {
    const a = makeCompleteManifest({ id: 'cap-a' });
    const b = makeCompleteManifest({ id: 'cap-b' });
    const md = [
      '```json\n' + JSON.stringify(a) + '\n```',
      '```json\n' + JSON.stringify(b) + '\n```',
    ].join('\n');
    const result = extractManifests(md);
    assert.strictEqual(result.length, 2);
  });
});
  });
}

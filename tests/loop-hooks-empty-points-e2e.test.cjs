'use strict';
/**
 * E2E content tests for the GSD capability engine — ADR-857 phase 6
 *
 * Hook points tested: discuss:pre, discuss:post, execute:pre, execute:wave:pre,
 *                     verify:pre, ship:post
 *
 * 5 of these points have zero hooks in the real registry by design.
 * verify:pre graduated out of the empty set in #1562 (it now carries the
 * ai-integration `api-coverage.verify-pre` blocking gate); SECTION 5 pins the
 * new contract + retains synthetic extension-point-mechanics coverage.
 * Tests pin: exact envelope shape, placeholder string contract (Hyrum's Law),
 * resolver-filter mechanics (schema default / config-override / capabilityStatesById),
 * CLI contract (missing-arg, invalid-point), and Postel-leniency (malformed config).
 *
 * Rules:
 *   - Every test drives a real command (CLI subprocess or real resolver + real registry).
 *   - No readFileSync(...).includes() source-grep.
 *   - Negative/BVA cases assert the SPECIFIC differing value so regression is caught.
 *   - Each test is independently isolated with its own temp dir.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanup, installSpawnEnv } = require('./helpers.cjs');

const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { resolveLoopHooks, renderLoopHooks } = require('../gsd-core/bin/lib/loop-resolver.cjs');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Create a bare temp dir with .planning/ layout (no config.json) */
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-loop-e2e-'));
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  return dir;
}

/** Create a temp dir with .planning/config.json set to the given object */
function makeTempProjectWithConfig(configObj) {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(configObj));
  return dir;
}

/** Create a bare temp dir with no .planning directory at all */
function makeBareDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-loop-bare-'));
}

/**
 * Spawn gsd-tools via raw spawnSync; returns { status, stdout, stderr }.
 *
 * #4291: env: installSpawnEnv() sandboxes HOME so capability-loader's
 * overlayRoots (which falls back to os.homedir()) never reaches the real
 * machine — without it, a capability genuinely installed on the host
 * running the suite (e.g. beads, markdown-linting) leaked into these
 * empty-point/exact-shape assertions.
 */
function spawnGsd(args, cwd) {
  return spawnSync(process.execPath, [GSD_TOOLS, ...args], {
    cwd: cwd || os.tmpdir(),
    encoding: 'utf8',
    timeout: 60000,
    env: installSpawnEnv(),
  });
}

/**
 * Build a synthetic registry that has ALL 12 canonical byLoopPoint keys
 * (required so resolveLoopHooks does not reject valid canonical points),
 * with a single step at `targetPoint` that activates on `when` config key.
 */
function buildSyntheticRegistry({ targetPoint, when, schemaDefault }) {
  const allPoints = [
    'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
    'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
    'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
  ];
  const byLoopPoint = {};
  for (const p of allPoints) {
    byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  }
  // Add the step (or gate) at the target point
  byLoopPoint[targetPoint] = {
    steps: [{
      capId: 'future-cap',
      when,
      ref: { skill: 'future-skill' },
    }],
    contributions: [],
    gates: [],
  };
  const configSchema = {};
  if (when !== undefined && schemaDefault !== undefined) {
    configSchema[when] = { default: schemaDefault };
  }
  return { byLoopPoint, configSchema };
}

// ─── Shared all-caps-on config (used by multiple tests) ──────────────────────
const ALL_CAPS_ON_CONFIG = {
  workflow: {
    ui_phase: true,
    ui_review: true,
    ui_safety_gate: true,
    security_enforcement: true,
    tdd_mode: true,
    code_review: true,
    nyquist_validation: true,
    schema_drift_gate: true,
    post_planning_gaps: true,
    intel: { enabled: true },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: discuss:pre
// ─────────────────────────────────────────────────────────────────────────────

describe('discuss:pre — real registry empty-resolution', () => {
  let tmpDir;
  before(() => { tmpDir = makeTempProject(); });
  after(() => { cleanup(tmpDir); });

  it('[happy] discuss:pre with real registry returns exact 3-key envelope with empty activeHooks (Gall\'s Law E2E pin)', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'discuss:pre', '--cwd', tmpDir, '--raw'], tmpDir);
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'discuss:pre');
    assert.deepEqual(envelope.activeHooks, []);
    assert.strictEqual(envelope.rendered, '_No active hooks at discuss:pre._');
    assert.deepEqual(Object.keys(envelope).sort(), ['activeHooks', 'point', 'rendered'], 'envelope must have exactly 3 keys');
  });

  it('[bva] discuss:pre with all capability config keys enabled still returns activeHooks:[] — config does not activate phantom hooks', () => {
    const configDir = makeTempProjectWithConfig(ALL_CAPS_ON_CONFIG);
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'discuss:pre', '--cwd', configDir, '--raw'], configDir);
      assert.strictEqual(result.status, 0);
      const envelope = JSON.parse(result.stdout.trim());
      assert.deepEqual(envelope.activeHooks, [], 'No capability config should activate hooks at discuss:pre');
      assert.strictEqual(envelope.rendered, '_No active hooks at discuss:pre._');
    } finally {
      cleanup(configDir);
    }
  });

  it('[happy] discuss:pre with real registry pure-function resolveLoopHooks returns empty activeHooks', () => {
    const resolved = resolveLoopHooks({ point: 'discuss:pre', registry: realRegistry, config: {} });
    assert.strictEqual(resolved.point, 'discuss:pre');
    assert.deepEqual(resolved.activeHooks, []);
  });

  it('[happy] renderLoopHooks for discuss:pre empty state pins the exact Hyrum\'s-Law contract string', () => {
    const rendered = renderLoopHooks({ point: 'discuss:pre', activeHooks: [] });
    assert.strictEqual(rendered, '_No active hooks at discuss:pre._');
  });

  it('[negative] discuss:pre missing-point argument to CLI exits non-zero with clear message', () => {
    const result = spawnGsd(['loop', 'render-hooks', '--raw'], tmpDir);
    assert.notStrictEqual(result.status, 0, 'must exit non-zero when point arg is missing');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /render-hooks requires a .point. argument/i);
  });

  it('[bva] discuss:pre close-typo "discuss:pre " (trailing space) exits non-zero — boundary for point name validation', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'discuss:pre ', '--raw'], tmpDir);
    assert.notStrictEqual(result.status, 0, 'must exit non-zero for invalid point');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /Invalid loop point/i);
    // Must list valid points so callers know what to use
    assert.match(combined, /discuss:pre[,\s]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: discuss:post — resolution + synthetic mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe('discuss:post — E2E empty envelope + synthetic resolver mechanics', () => {
  let tmpDir;
  before(() => { tmpDir = makeTempProjectWithConfig({}); });
  after(() => { cleanup(tmpDir); });

  it('[empty-resolution] discuss:post E2E subprocess returns exact empty envelope — activeHooks:[], 3-key shape, placeholder string pinned', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'discuss:post', '--raw', '--cwd', tmpDir], tmpDir);
    assert.strictEqual(result.status, 0, `expected exit 0. stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'discuss:post');
    assert.deepEqual(envelope.activeHooks, []);
    assert.strictEqual(envelope.rendered, '_No active hooks at discuss:post._');
    assert.deepEqual(Object.keys(envelope).sort(), ['activeHooks', 'point', 'rendered']);
    assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'warnings'), 'must not have spurious warnings field');
  });

  it('[happy] discuss:post E2E with no .planning directory returns empty hooks (Postel leniency path)', () => {
    const bareDir = makeBareDir();
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'discuss:post', '--raw', '--cwd', bareDir], bareDir);
      assert.strictEqual(result.status, 0, `expected exit 0 even with no .planning dir. stderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.activeHooks.length, 0);
      assert.strictEqual(envelope.rendered, '_No active hooks at discuss:post._');
    } finally {
      cleanup(bareDir);
    }
  });

  it('[happy] discuss:post with real registry resolveLoopHooks returns activeHooks:[] (real registry, not synthetic)', () => {
    const resolved = resolveLoopHooks({ point: 'discuss:post', registry: realRegistry, config: {} });
    assert.strictEqual(resolved.point, 'discuss:post');
    assert.strictEqual(resolved.activeHooks.length, 0, 'Real registry must have 0 hooks at discuss:post');
  });

  it('[bva] discuss:post with synthetic capability, schema default=false + config absent → hook absent (schema default=false suppresses hook)', () => {
    const reg = buildSyntheticRegistry({
      targetPoint: 'discuss:post',
      when: 'workflow.testcap_on',
      schemaDefault: false,
    });
    const resolved = resolveLoopHooks({ point: 'discuss:post', registry: reg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 0, 'schema default=false must suppress hook when config absent');
  });

  it('[bva] discuss:post with synthetic capability, schema default=true + config absent → hook active; explicit config=false overrides → hook absent (BVA at config-wins threshold)', () => {
    const reg = buildSyntheticRegistry({
      targetPoint: 'discuss:post',
      when: 'workflow.testcap_on',
      schemaDefault: true,
    });

    // Sub-case a: schema default=true, no config → active
    const resolvedA = resolveLoopHooks({ point: 'discuss:post', registry: reg, config: {} });
    assert.strictEqual(resolvedA.activeHooks.length, 1, 'schema default=true must activate hook when config absent');

    // Sub-case b: explicit config=false → overrides schema default → inactive
    const resolvedB = resolveLoopHooks({
      point: 'discuss:post',
      registry: reg,
      config: { workflow: { testcap_on: false } },
    });
    assert.strictEqual(resolvedB.activeHooks.length, 0, 'explicit config=false must override schema default=true');
  });

  it('[bva] discuss:post with synthetic capability, capabilityStatesById active=false → hook absent even when config=true', () => {
    const reg = buildSyntheticRegistry({
      targetPoint: 'discuss:post',
      when: 'workflow.testcap_on',
      schemaDefault: true,
    });
    const resolved = resolveLoopHooks({
      point: 'discuss:post',
      registry: reg,
      config: { workflow: { testcap_on: true } },
      // Phase 4: resolver gates on `active` (not `enabled`); pass active:false to suppress.
      capabilityStatesById: new Map([['future-cap', { enabled: false, active: false }]]),
    });
    assert.strictEqual(resolved.activeHooks.length, 0, 'capabilityStatesById active=false must suppress hook even when config=true');
  });

  it('[negative] discuss:post with invalid point name "discuss:past" exits non-zero and lists valid points', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'discuss:past', '--raw', '--cwd', tmpDir], tmpDir);
    assert.notStrictEqual(result.status, 0, 'must exit non-zero for typo point name');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /discuss:past|Invalid loop point/i);
    assert.match(combined, /discuss:pre/);
  });

  it('[negative] discuss:post E2E with malformed config.json → still exits 0 with empty hooks (Postel)', () => {
    const malformedDir = makeTempProject();
    fs.writeFileSync(path.join(malformedDir, '.planning', 'config.json'), '{invalid json');
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'discuss:post', '--raw', '--cwd', malformedDir], malformedDir);
      assert.strictEqual(result.status, 0, `must not crash on malformed config. stderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.activeHooks.length, 0);
      assert.strictEqual(envelope.rendered, '_No active hooks at discuss:post._');
    } finally {
      cleanup(malformedDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: execute:pre
// ─────────────────────────────────────────────────────────────────────────────

describe('execute:pre — real registry empty-resolution + synthetic resolver mechanics', () => {
  it('[happy] execute:pre with real registry + all capability flags enabled returns 0 active hooks and exact placeholder', () => {
    const allOnDir = makeTempProjectWithConfig(ALL_CAPS_ON_CONFIG);
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'execute:pre', '--raw', '--cwd', allOnDir], allOnDir);
      assert.strictEqual(result.status, 0, `expected exit 0. stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.point, 'execute:pre');
      assert.strictEqual(parsed.activeHooks.length, 0);
      assert.strictEqual(parsed.rendered, '_No active hooks at execute:pre._');
    } finally {
      cleanup(allOnDir);
    }
  });

  it('[empty-resolution] execute:pre with no config.json returns 0 active hooks (empty-project negative space)', () => {
    const emptyDir = makeTempProject();
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'execute:pre', '--raw', '--cwd', emptyDir], emptyDir);
      assert.strictEqual(result.status, 0);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.activeHooks.length, 0);
      assert.strictEqual(parsed.rendered, '_No active hooks at execute:pre._');
    } finally {
      cleanup(emptyDir);
    }
  });

  it('[happy] execute:pre with synthetic step+contribution+gate registered and when-flag=true → all 3 hooks activated', () => {
    const allPoints = [
      'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
    ];
    const byLoopPoint = {};
    for (const p of allPoints) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    byLoopPoint['execute:pre'] = {
      steps: [{ capId: 'future-cap', when: 'workflow.future_enabled', ref: { skill: 'step-skill' } }],
      contributions: [{ capId: 'future-cap', when: 'workflow.future_enabled', into: 'context' }],
      gates: [{ capId: 'future-cap', when: 'workflow.future_enabled', check: { query: 'future.gate' }, blocking: true, onError: 'halt' }],
    };
    const syntheticReg = {
      byLoopPoint,
      configSchema: { 'workflow.future_enabled': { default: false } },
    };

    const resolved = resolveLoopHooks({
      point: 'execute:pre',
      registry: syntheticReg,
      config: { workflow: { future_enabled: true } },
    });
    assert.strictEqual(resolved.activeHooks.length, 3, 'All 3 hooks (step, contribution, gate) must be active when when-flag=true');
    assert.strictEqual(resolved.activeHooks[0].kind, 'step');
    assert.strictEqual(resolved.activeHooks[1].kind, 'contribution');
    assert.strictEqual(resolved.activeHooks[2].kind, 'gate');
  });

  it('[negative] execute:pre with synthetic hook registered but when-flag=false → hook filtered, activeHooks=[], rendered is placeholder', () => {
    const reg = buildSyntheticRegistry({ targetPoint: 'execute:pre', when: 'workflow.future_enabled', schemaDefault: false });
    const resolved = resolveLoopHooks({
      point: 'execute:pre',
      registry: reg,
      config: { workflow: { future_enabled: false } },
    });
    assert.strictEqual(resolved.activeHooks.length, 0, 'when-flag=false must filter hook');
    const rendered = renderLoopHooks(resolved);
    assert.strictEqual(rendered, '_No active hooks at execute:pre._');
  });

  it('[negative] execute:pre with synthetic unconditional hook but capability disabled via capabilityStatesById → hook filtered', () => {
    const allPoints = [
      'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
    ];
    const byLoopPoint = {};
    for (const p of allPoints) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    // No `when` = unconditional hook
    byLoopPoint['execute:pre'] = {
      steps: [{ capId: 'future-cap', ref: { skill: 'future-skill' } }],
      contributions: [],
      gates: [],
    };
    const syntheticReg = { byLoopPoint, configSchema: {} };

    const resolved = resolveLoopHooks({
      point: 'execute:pre',
      registry: syntheticReg,
      config: {},
      // Phase 4: resolver gates on `active` (not `enabled`); pass active:false to suppress.
      capabilityStatesById: new Map([['future-cap', { enabled: false, active: false }]]),
    });
    assert.strictEqual(resolved.activeHooks.length, 0, 'capabilityStatesById disabled must filter unconditional hook');
  });

  it('[bva] execute:pre with schema default=true synthetic hook and NO config → hook activates (schema default boundary)', () => {
    const reg = buildSyntheticRegistry({
      targetPoint: 'execute:pre',
      when: 'workflow.future_enabled',
      schemaDefault: true,
    });
    const resolved = resolveLoopHooks({ point: 'execute:pre', registry: reg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 1, 'schema default=true must activate hook even with absent config');
  });

  it('[negative] real registry has exactly 0 hooks at execute:pre — guard against accidental registration', () => {
    const entry = realRegistry.byLoopPoint['execute:pre'];
    assert.ok(entry, 'execute:pre must be present in real registry byLoopPoint');
    assert.strictEqual(entry.steps.length, 0, 'execute:pre must have 0 steps in real registry');
    assert.strictEqual(entry.contributions.length, 0, 'execute:pre must have 0 contributions in real registry');
    assert.strictEqual(entry.gates.length, 0, 'execute:pre must have 0 gates in real registry');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: execute:wave:pre
// ─────────────────────────────────────────────────────────────────────────────

describe('execute:wave:pre — real registry empty-resolution + synthetic mechanics', () => {
  it('[empty-resolution] execute:wave:pre with real registry returns empty activeHooks and exact placeholder text', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'execute:wave:pre', '--raw'], os.tmpdir());
    assert.strictEqual(result.status, 0, `expected exit 0. stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'execute:wave:pre');
    assert.ok(Array.isArray(envelope.activeHooks), 'activeHooks must be an array');
    assert.strictEqual(envelope.activeHooks.length, 0);
    assert.strictEqual(envelope.rendered, '_No active hooks at execute:wave:pre._');
  });

  it('[happy] execute:wave:pre with synthetic registry containing a gate hook resolves it correctly', () => {
    const allPoints = [
      'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
    ];
    const byLoopPoint = {};
    for (const p of allPoints) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    byLoopPoint['execute:wave:pre'] = {
      steps: [],
      contributions: [],
      gates: [{
        capId: 'future-cap',
        // no `when` = unconditional
        check: { query: 'future.gate' },
        blocking: true,
        onError: 'halt',
      }],
    };
    const syntheticReg = { byLoopPoint, configSchema: {} };

    const resolved = resolveLoopHooks({ point: 'execute:wave:pre', registry: syntheticReg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 1);
    const gate = resolved.activeHooks[0];
    assert.strictEqual(gate.kind, 'gate');
    assert.strictEqual(gate.capId, 'future-cap');
    assert.deepEqual(gate.check, { query: 'future.gate' });
    assert.strictEqual(gate.blocking, true);
    assert.strictEqual(gate.onError, 'halt');
  });

  it('[negative] execute:wave:pre with synthetic step hook and when=false config → hook filtered → empty', () => {
    const reg = buildSyntheticRegistry({
      targetPoint: 'execute:wave:pre',
      when: 'workflow.wave_pre_enabled',
      schemaDefault: true,
    });

    // BVA: schema default=true without override → active
    const resolvedDefault = resolveLoopHooks({ point: 'execute:wave:pre', registry: reg, config: {} });
    assert.strictEqual(resolvedDefault.activeHooks.length, 1, 'schema default=true with no config override must activate');

    // BVA: config override false → inactive
    const resolvedOff = resolveLoopHooks({
      point: 'execute:wave:pre',
      registry: reg,
      config: { workflow: { wave_pre_enabled: false } },
    });
    assert.strictEqual(resolvedOff.activeHooks.length, 0, 'explicit config=false must override schema default=true');
  });

  it('[bva] execute:wave:pre BVA: schema default=true → active (threshold=on), schema default=false → inactive (threshold=off)', () => {
    const regA = buildSyntheticRegistry({ targetPoint: 'execute:wave:pre', when: 'workflow.flag', schemaDefault: true });
    const regB = buildSyntheticRegistry({ targetPoint: 'execute:wave:pre', when: 'workflow.flag', schemaDefault: false });

    const resolvedA = resolveLoopHooks({ point: 'execute:wave:pre', registry: regA, config: {} });
    assert.strictEqual(resolvedA.activeHooks.length, 1, 'registry A (default=true) must activate hook');

    const resolvedB = resolveLoopHooks({ point: 'execute:wave:pre', registry: regB, config: {} });
    assert.strictEqual(resolvedB.activeHooks.length, 0, 'registry B (default=false) must NOT activate hook');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: verify:pre
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: verify:pre was an empty extension point until #1562 added the
// ai-integration `api-coverage.verify-pre` blocking gate (default-on, opt-out
// via workflow.api_coverage_gate=false). The real-registry assertions below pin
// the NEW contract; the synthetic BVA tests retain extension-point-mechanics
// coverage. Empty-point coverage for the other 5 points is unaffected.

describe('verify:pre — real registry carries the api-coverage gate (#1562); synthetic mechanics', () => {
  let tmpEmptyProjectDir;
  let tmpProjectDirAllOn;
  before(() => {
    tmpEmptyProjectDir = makeTempProject();
    tmpProjectDirAllOn = makeTempProjectWithConfig(ALL_CAPS_ON_CONFIG);
  });
  after(() => {
    cleanup(tmpEmptyProjectDir);
    cleanup(tmpProjectDirAllOn);
  });

  it('[default-on] verify:pre with real registry and no config yields the api-coverage blocking gate (full-coverage-by-default)', () => {
    const resolved = resolveLoopHooks({ point: 'verify:pre', registry: realRegistry, config: {} });
    const gate = resolved.activeHooks.find((h) => h.capId === 'ai-integration' && h.kind === 'gate');
    assert.ok(gate, 'ai-integration api-coverage gate must register at verify:pre by default');
    assert.strictEqual(gate.blocking, true);
    assert.strictEqual(gate.check.query, 'api-coverage.verify-pre');
  });

  it('[happy] verify:pre E2E subprocess returns a well-formed envelope carrying the gate (Hyrum\'s Law contract pin)', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'verify:pre', '--cwd', tmpEmptyProjectDir, '--raw'], tmpEmptyProjectDir);
    assert.strictEqual(result.status, 0, `expected exit 0. stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout.trim());
    assert.strictEqual(envelope.point, 'verify:pre');
    assert.ok(Array.isArray(envelope.activeHooks));
    assert.ok(envelope.activeHooks.some((h) => h.capId === 'ai-integration' && h.kind === 'gate'));
    assert.deepEqual(Object.keys(envelope).sort(), ['activeHooks', 'point', 'rendered']);
  });

  it('[opt-out] verify:pre with workflow.api_coverage_gate=false yields NO ai-integration gate — config opt-out empties the point', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:pre',
      registry: realRegistry,
      config: { workflow: { api_coverage_gate: false } },
    });
    assert.strictEqual(
      resolved.activeHooks.find((h) => h.capId === 'ai-integration'),
      undefined,
      'opting out api_coverage_gate must remove the gate from verify:pre'
    );
  });

  it('[negative] verify:pre with unrelated capability keys on does not bleed non-verify:pre hooks into the point', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:pre',
      registry: realRegistry,
      config: { workflow: { ui_phase: true, ui_review: true, ui_safety_gate: true } },
    });
    // The only verify:pre hook is the api-coverage gate; UI/other hooks must not bleed in.
    for (const h of resolved.activeHooks) {
      assert.notStrictEqual(h.capId, 'ui', 'UI capability must not bleed through to verify:pre');
    }
  });

  it('[bva] Synthetic step at verify:pre with configSchema default=true fires correctly — extension point readiness', () => {
    const reg = buildSyntheticRegistry({ targetPoint: 'verify:pre', when: 'workflow.future_enabled', schemaDefault: true });
    const resolved = resolveLoopHooks({ point: 'verify:pre', registry: reg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 1, 'synthetic step at verify:pre with default=true must activate');
    assert.strictEqual(resolved.activeHooks[0].capId, 'future-cap');
    assert.strictEqual(resolved.activeHooks[0].kind, 'step');
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /future-skill/);
    assert.match(rendered, /future-cap/);
  });

  it('[bva] Synthetic step at verify:pre with when=false (config override) filters correctly — activation logic applies at this point', () => {
    const reg = buildSyntheticRegistry({ targetPoint: 'verify:pre', when: 'workflow.future_enabled', schemaDefault: true });
    const resolved = resolveLoopHooks({
      point: 'verify:pre',
      registry: reg,
      config: { workflow: { future_enabled: false } },
    });
    assert.strictEqual(resolved.activeHooks.length, 0, 'config explicit false must beat schema default=true');
  });

  it('[negative] verify:pre with malformed config.json in .planning/ degrades leniently (Postel\'s Law at this point)', () => {
    const malformedDir = makeTempProject();
    fs.writeFileSync(path.join(malformedDir, '.planning', 'config.json'), '{invalid json');
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'verify:pre', '--cwd', malformedDir, '--raw'], malformedDir);
      assert.strictEqual(result.status, 0, `must not crash on malformed config. stderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      // Malformed config degrades to defaults (gate default-on); the contract
      // here is leniency (exit 0, well-formed envelope), not emptiness.
      assert.strictEqual(envelope.point, 'verify:pre');
      assert.ok(Array.isArray(envelope.activeHooks));
    } finally {
      cleanup(malformedDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: ship:post
// ─────────────────────────────────────────────────────────────────────────────

describe('ship:post — real registry empty-resolution + resilience to registry edge-cases', () => {
  it('[happy] ship:post E2E subprocess returns typed envelope: point=\'ship:post\', activeHooks=[], rendered=placeholder, no extra keys', () => {
    const tmpDir = makeTempProject();
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'ship:post', '--raw', '--cwd', tmpDir], tmpDir);
      assert.strictEqual(result.status, 0, `expected exit 0. stderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.point, 'ship:post');
      assert.deepEqual(envelope.activeHooks, []);
      assert.strictEqual(envelope.rendered, '_No active hooks at ship:post._');
      assert.deepEqual(Object.keys(envelope).sort(), ['activeHooks', 'point', 'rendered']);
      assert.ok(!Object.prototype.hasOwnProperty.call(envelope, 'warnings'), 'must not have warnings key');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('[bva] ship:post returns empty activeHooks regardless of any capability config being enabled — no config leaks hooks into this point', () => {
    const allOnDir = makeTempProjectWithConfig(ALL_CAPS_ON_CONFIG);
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'ship:post', '--raw', '--cwd', allOnDir], allOnDir);
      assert.strictEqual(result.status, 0);
      const envelope = JSON.parse(result.stdout.trim());
      assert.deepEqual(envelope.activeHooks, [], 'Maximum capability activation must still produce zero hooks at ship:post');
    } finally {
      cleanup(allOnDir);
    }
  });

  it('[happy] resolveLoopHooks with real capability-registry at ship:post returns empty activeHooks (mempalace step inactive by default) and well-formed byLoopPoint entry with 1 step', () => {
    // mempalace.enabled defaults to false → step not activated with empty config
    const resolved = resolveLoopHooks({ point: 'ship:post', registry: realRegistry, config: {} });
    assert.strictEqual(resolved.point, 'ship:post');
    assert.ok(Array.isArray(resolved.activeHooks));
    assert.strictEqual(resolved.activeHooks.length, 0);

    const entry = realRegistry.byLoopPoint['ship:post'];
    assert.ok(entry, 'ship:post must be present in real registry byLoopPoint');
    assert.strictEqual(entry.steps.length, 1, 'ship:post must have 1 step (mempalace curator)');
    assert.strictEqual(entry.steps[0].capId, 'mempalace', 'ship:post step must be from mempalace');
    assert.strictEqual(entry.contributions.length, 0, 'ship:post must have 0 contributions');
    assert.strictEqual(entry.gates.length, 0, 'ship:post must have 0 gates');
  });

  it('[negative] ship:post E2E exits 0 and returns empty envelope when project has no .planning directory at all', () => {
    const bareDir = makeBareDir();
    try {
      const result = spawnGsd(['loop', 'render-hooks', 'ship:post', '--raw', '--cwd', bareDir], bareDir);
      assert.strictEqual(result.status, 0, `expected exit 0 even with no .planning dir. stderr: ${result.stderr}`);
      const envelope = JSON.parse(result.stdout.trim());
      assert.strictEqual(envelope.activeHooks.length, 0);
      assert.strictEqual(envelope.rendered, '_No active hooks at ship:post._');
    } finally {
      cleanup(bareDir);
    }
  });

  it('[negative] resolveLoopHooks does not throw and returns empty hooks when byLoopPoint[\'ship:post\'] is null', () => {
    const allPoints = [
      'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
    ];
    const byLoopPoint = {};
    for (const p of allPoints) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    byLoopPoint['ship:post'] = null;
    const syntheticReg = { byLoopPoint, configSchema: {} };

    const resolved = resolveLoopHooks({ point: 'ship:post', registry: syntheticReg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 0, 'null byLoopPoint entry must not throw and must return 0 hooks');
  });

  it('[negative] resolveLoopHooks does not throw when byLoopPoint[\'ship:post\'] exists but has no steps/contributions/gates keys', () => {
    const allPoints = [
      'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post',
      'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
      'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
    ];
    const byLoopPoint = {};
    for (const p of allPoints) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    byLoopPoint['ship:post'] = {}; // No arrays at all
    const syntheticReg = { byLoopPoint, configSchema: {} };

    const resolved = resolveLoopHooks({ point: 'ship:post', registry: syntheticReg, config: {} });
    assert.strictEqual(resolved.activeHooks.length, 0, 'missing arrays in byLoopPoint entry must not throw');
  });

  it('[bva] ship:post returns empty activeHooks even when security_enforcement=true — security gate lives at ship:pre not ship:post', () => {
    const securityOnDir = makeTempProjectWithConfig({ workflow: { security_enforcement: true } });
    try {
      // ship:post must be empty
      const postResult = spawnGsd(['loop', 'render-hooks', 'ship:post', '--raw', '--cwd', securityOnDir], securityOnDir);
      assert.strictEqual(postResult.status, 0);
      const postEnvelope = JSON.parse(postResult.stdout.trim());
      assert.deepEqual(postEnvelope.activeHooks, [], 'ship:post must be empty even with security_enforcement=true');

      // ship:pre must have the security gate (proves the config actually works and the difference is real)
      const preResult = spawnGsd(['loop', 'render-hooks', 'ship:pre', '--raw', '--cwd', securityOnDir], securityOnDir);
      assert.strictEqual(preResult.status, 0);
      const preEnvelope = JSON.parse(preResult.stdout.trim());
      const secGate = preEnvelope.activeHooks.find(h => h.capId === 'security');
      assert.ok(secGate, 'ship:pre must have a security gate when security_enforcement=true');
    } finally {
      cleanup(securityOnDir);
    }
  });

  it('[happy] ship:post byLoopPoint entry exists in the real registry with 1 step (mempalace), 0 contributions, 0 gates', () => {
    const entry = realRegistry.byLoopPoint['ship:post'];
    assert.ok(entry, 'ship:post must be present in real registry byLoopPoint');
    assert.strictEqual(entry.steps.length, 1, 'ship:post must have 1 step (mempalace curator step)');
    assert.strictEqual(entry.steps[0].capId, 'mempalace', 'ship:post step must be from mempalace capability');
    assert.strictEqual(entry.contributions.length, 0, 'ship:post must have 0 contributions');
    assert.strictEqual(entry.gates.length, 0, 'ship:post must have 0 gates');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: CLI contract (shared across all 6 points)
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI contract — missing/invalid point argument (shared across all 6 empty points)', () => {
  it('[negative] missing point argument exits non-zero and includes render-hooks syntax in error message', () => {
    const result = spawnGsd(['loop', 'render-hooks', '--raw'], os.tmpdir());
    assert.notStrictEqual(result.status, 0, 'must exit non-zero when point arg is missing');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /render-hooks requires a .point. argument/i);
  });

  it('[bva] "discuss:post " with trailing space exits non-zero — boundary: trailing whitespace makes point invalid', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'discuss:post ', '--raw'], os.tmpdir());
    assert.notStrictEqual(result.status, 0, 'must reject point with trailing space');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /Invalid loop point/i);
  });

  it('[bva] "execute:pre." with trailing period exits non-zero — boundary: period suffix makes point invalid', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'execute:pre.', '--raw'], os.tmpdir());
    assert.notStrictEqual(result.status, 0, 'must reject point with trailing period');
    const combined = (result.stdout + result.stderr);
    assert.match(combined, /Invalid loop point/i);
  });

  it('[negative] error message for invalid point includes list of valid points so callers can self-correct', () => {
    const result = spawnGsd(['loop', 'render-hooks', 'verify:future', '--raw'], os.tmpdir());
    assert.notStrictEqual(result.status, 0);
    const combined = (result.stdout + result.stderr);
    // Must include at least several valid points in the error message
    assert.match(combined, /discuss:pre/);
    assert.match(combined, /ship:post/);
    assert.match(combined, /verify:pre/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: Parametric empty-point sweep across all 6 points (E2E regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('Parametric E2E sweep — 4 empty points return correct envelope shape via real registry (ship:post excluded — mempalace registers 1 step there; verify:pre excluded since #1562 added the api-coverage gate)', () => {
  const EMPTY_POINTS = [
    'discuss:pre',
    'discuss:post',
    'execute:pre',
    'execute:wave:pre',
  ];

  for (const point of EMPTY_POINTS) {
    it(`[parametric] ${point} — E2E subprocess exits 0 with {point, activeHooks:[], rendered:placeholder}`, () => {
      const tmpDir = makeTempProject();
      try {
        const result = spawnGsd(['loop', 'render-hooks', point, '--raw', '--cwd', tmpDir], tmpDir);
        assert.strictEqual(result.status, 0, `${point}: expected exit 0. stderr: ${result.stderr}`);
        const envelope = JSON.parse(result.stdout.trim());
        assert.strictEqual(envelope.point, point, `${point}: envelope.point mismatch`);
        assert.ok(Array.isArray(envelope.activeHooks), `${point}: activeHooks must be an array`);
        assert.strictEqual(envelope.activeHooks.length, 0, `${point}: activeHooks must be empty`);
        assert.strictEqual(envelope.rendered, `_No active hooks at ${point}._`, `${point}: rendered placeholder mismatch`);
      } finally {
        cleanup(tmpDir);
      }
    });

    it(`[parametric] ${point} — pure-function resolveLoopHooks with real registry returns 0 activeHooks`, () => {
      const resolved = resolveLoopHooks({ point, registry: realRegistry, config: {} });
      assert.strictEqual(resolved.point, point);
      assert.strictEqual(resolved.activeHooks.length, 0, `${point}: real registry must have 0 hooks at this point`);
    });
  }
});

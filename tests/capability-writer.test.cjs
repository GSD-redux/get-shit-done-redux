'use strict';

/**
 * capability-writer.test.cjs — TDD tests for capability-writer.cjs.
 *
 * ADR-1213: write-side inverse of the capability resolver.
 * Uses node:test + node:assert/strict.
 * Tests run against the REAL registry and compiled .cjs in gsd-core/bin/lib/.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');

const { setCapabilityState } = require('../gsd-core/bin/lib/capability-writer.cjs');
const { readSurface } = require('../gsd-core/bin/lib/surface.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp runtimeConfigDir and cwd pair for a test.
 * - rcd has no .gsd-profile file → default 'full' profile → installedSkills='*'
 * - cwd has .planning/config.json (empty)
 */
function makeTempDirs() {
  const rcd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-writer-rcd-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-writer-cwd-'));
  // Ensure .planning dir + empty config
  const planningDir = path.join(cwd, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');
  return { rcd, cwd };
}

function readConfig(cwd) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('capability-writer: setCapabilityState', () => {

  // ── Test 1: disable a skill-owning capability ─────────────────────────────
  test('disable ui: surface gets disabledClusters=["ui"], ui.enabled===false, all ui hooks active===false', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      const result = setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: false }]);
      assert.ok(Array.isArray(result.capabilities), 'capabilities is array');
      assert.ok(Array.isArray(result.warnings), 'warnings is array');

      const uiCap = result.capabilities.find((c) => c.id === 'ui');
      assert.ok(uiCap, 'ui capability present in result');
      assert.equal(uiCap.enabled, false, 'ui.enabled should be false');
      // All hooks for ui should be active===false
      assert.ok(uiCap.hooks.every((h) => h.active === false), 'all ui hooks should be inactive');

      // Surface file should have ui in disabledClusters
      const surface = readSurface(rcd);
      assert.ok(surface !== null, 'surface file written');
      assert.ok(surface.disabledClusters.includes('ui'), 'ui in disabledClusters');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 2: re-enable ─────────────────────────────────────────────────────
  test('re-enable ui: off then on → ui.enabled===true; disabledClusters excludes ui', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // First disable
      setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: false }]);
      // Then re-enable
      const result = setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: true }]);

      const uiCap = result.capabilities.find((c) => c.id === 'ui');
      assert.ok(uiCap, 'ui capability present');
      assert.equal(uiCap.enabled, true, 'ui.enabled should be true after re-enable');

      const surface = readSurface(rcd);
      assert.ok(surface !== null, 'surface file exists');
      assert.ok(!surface.disabledClusters.includes('ui'), 'ui NOT in disabledClusters after re-enable');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 3: gate within enabled capability ────────────────────────────────
  test('gate code-review off: hook configured===false; config.json has workflow.code_review===false', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      const result = setCapabilityState(cwd, rcd, [
        { id: 'code-review', gates: { 'workflow.code_review': false } },
      ]);

      const crCap = result.capabilities.find((c) => c.id === 'code-review');
      assert.ok(crCap, 'code-review capability present');
      // code-review has skills so enabled should be true (full install + surfaced)
      assert.equal(crCap.enabled, true, 'code-review should be enabled (full install)');
      // The hook gated by workflow.code_review should be configured===false
      const gatedHook = crCap.hooks.find((h) => h.when === 'workflow.code_review');
      assert.ok(gatedHook !== undefined, 'found hook with when=workflow.code_review');
      assert.equal(gatedHook.configured, false, 'hook configured===false after gate set to false');

      // Config should have the value persisted
      const config = readConfig(cwd);
      assert.ok(config.workflow, 'workflow section in config');
      assert.equal(config.workflow.code_review, false, 'workflow.code_review===false in config');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 4: re-enable preserves prior gates ───────────────────────────────
  test('re-enable preserves prior gates: gate false → disable → re-enable → gate still false', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // Set gate to false
      setCapabilityState(cwd, rcd, [
        { id: 'code-review', gates: { 'workflow.code_review': false } },
      ]);
      // Disable code-review
      setCapabilityState(cwd, rcd, [{ id: 'code-review', enabled: false }]);
      // Re-enable code-review (no gate change)
      setCapabilityState(cwd, rcd, [{ id: 'code-review', enabled: true }]);

      // Config should still have workflow.code_review===false
      const config = readConfig(cwd);
      assert.equal(config?.workflow?.code_review, false, 'workflow.code_review still false after re-enable');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 5: present-but-dead warning ─────────────────────────────────────
  test('present-but-dead warning: gate all hooks off for research → warning emitted', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // research has skills:[] (vacuously installed/surfaced) and a hook gated by workflow.research
      // Set workflow.research=false to gate off its only hook
      const result = setCapabilityState(cwd, rcd, [
        { id: 'research', gates: { 'workflow.research': false } },
      ]);

      // research is enabled (vacuously surfaced since no skills) but hook is gated off
      const researchCap = result.capabilities.find((c) => c.id === 'research');
      assert.ok(researchCap, 'research capability present');
      assert.equal(researchCap.enabled, true, 'research enabled (vacuously)');
      assert.ok(researchCap.hooks.length > 0, 'research has hooks');
      assert.ok(researchCap.hooks.every((h) => !h.configured), 'all research hooks configured===false');

      // Should have a present-but-dead warning
      const deadWarning = result.warnings.find(
        (w) => w.includes('research') && w.includes('gated off'),
      );
      assert.ok(deadWarning !== undefined, `expected present-but-dead warning for research, got: ${JSON.stringify(result.warnings)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 6: skill-less enabled:false warns ────────────────────────────────
  test('skill-less enabled:false: research warns "owns no skills", disabledClusters unchanged', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      const result = setCapabilityState(cwd, rcd, [{ id: 'research', enabled: false }]);

      const noSkillsWarning = result.warnings.find(
        (w) => w.includes('research') && w.includes('no skills'),
      );
      assert.ok(noSkillsWarning !== undefined, `expected no-skills warning, got: ${JSON.stringify(result.warnings)}`);

      // Surface should NOT have research in disabledClusters
      const surface = readSurface(rcd);
      // No surface file written (or if it exists, research not in disabledClusters)
      if (surface !== null) {
        assert.ok(!surface.disabledClusters.includes('research'), 'research NOT in disabledClusters');
      }
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 7: unknown id ────────────────────────────────────────────────────
  test('unknown id: error emitted (not warning), no throw', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      let result;
      assert.doesNotThrow(() => {
        result = setCapabilityState(cwd, rcd, [{ id: 'does-not-exist', enabled: false }]);
      });
      assert.ok(result, 'result returned');
      assert.ok(Array.isArray(result.errors), 'errors is array');
      const unknownError = result.errors.find((e) => e.includes('does-not-exist'));
      assert.ok(unknownError !== undefined, `expected unknown error, got errors: ${JSON.stringify(result.errors)}`);
      // Must NOT be in warnings
      const unknownWarning = result.warnings.find((w) => w.includes('does-not-exist'));
      assert.equal(unknownWarning, undefined, `unknown id must not appear in warnings, got: ${JSON.stringify(result.warnings)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 8: invalid gate key ──────────────────────────────────────────────
  test('invalid gate key: error emitted (not warning), no throw, key NOT written to config', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      let result;
      assert.doesNotThrow(() => {
        result = setCapabilityState(cwd, rcd, [
          { id: 'ui', gates: { 'workflow.not_a_key': false } },
        ]);
      });
      assert.ok(result, 'result returned');
      assert.ok(Array.isArray(result.errors), 'errors is array');
      const invalidKeyError = result.errors.find((e) => e.includes('workflow.not_a_key'));
      assert.ok(invalidKeyError !== undefined, `expected invalid-gate error, got errors: ${JSON.stringify(result.errors)}`);
      // Must NOT be in warnings
      const invalidKeyWarning = result.warnings.find((w) => w.includes('workflow.not_a_key'));
      assert.equal(invalidKeyWarning, undefined, `invalid gate key must not appear in warnings, got: ${JSON.stringify(result.warnings)}`);

      // Config should NOT have the key
      const config = readConfig(cwd);
      assert.equal(config?.workflow?.not_a_key, undefined, 'invalid key not written to config');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 9: batch disable ─────────────────────────────────────────────────
  test('batch: disable ui and code-review → both in disabledClusters, both enabled===false', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      const result = setCapabilityState(cwd, rcd, [
        { id: 'ui', enabled: false },
        { id: 'code-review', enabled: false },
      ]);

      const uiCap = result.capabilities.find((c) => c.id === 'ui');
      const crCap = result.capabilities.find((c) => c.id === 'code-review');
      assert.ok(uiCap, 'ui capability present');
      assert.ok(crCap, 'code-review capability present');
      assert.equal(uiCap.enabled, false, 'ui.enabled===false');
      assert.equal(crCap.enabled, false, 'code-review.enabled===false');

      const surface = readSurface(rcd);
      assert.ok(surface !== null, 'surface file written');
      assert.ok(surface.disabledClusters.includes('ui'), 'ui in disabledClusters');
      assert.ok(surface.disabledClusters.includes('code-review'), 'code-review in disabledClusters');
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 10: scoping regression — touching ui must not mention intel ──────
  test('scoping: setCapabilityState([{id:"ui", enabled:false}]) must not mention intel in warnings or errors', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      const result = setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: false }]);
      assert.ok(Array.isArray(result.warnings), 'warnings is array');
      assert.ok(Array.isArray(result.errors), 'errors is array');

      const intelInWarnings = result.warnings.some((w) => w.includes('intel'));
      assert.equal(intelInWarnings, false,
        `warnings must not mention intel, got: ${JSON.stringify(result.warnings)}`);

      const intelInErrors = result.errors.some((e) => e.includes('intel'));
      assert.equal(intelInErrors, false,
        `errors must not mention intel, got: ${JSON.stringify(result.errors)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 11: CLI exit-code tests ──────────────────────────────────────────
  test('CLI: capability set ui --off exits 0; capability set ui --on exits 0; unknown id exits non-zero', () => {
    const rcd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-rcd-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-cwd-'));
    try {
      // Create .planning/config.json so the resolver has a valid project
      const planningDir = path.join(cwd, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');

      const gsdToolsBin = path.resolve(__dirname, '../gsd-core/bin/gsd-tools.cjs');

      // Test: capability set ui --off (--config-dir rcd) exits 0
      const offResult = runNode([gsdToolsBin, 'capability', 'set', 'ui', '--off', '--config-dir', rcd], {
        cwd,
        timeoutMs: 15000,
      });
      assert.equal(offResult.exitCode, 0,
        `capability set ui --off should exit 0, got ${String(offResult.exitCode)}. stderr: ${offResult.stderr}`);

      // Test: capability set ui --on (--config-dir rcd) exits 0
      const onResult = runNode([gsdToolsBin, 'capability', 'set', 'ui', '--on', '--config-dir', rcd], {
        cwd,
        timeoutMs: 15000,
      });
      assert.equal(onResult.exitCode, 0,
        `capability set ui --on should exit 0, got ${String(onResult.exitCode)}. stderr: ${onResult.stderr}`);

      // Test: unknown id exits non-zero
      const unknownResult = runNode([gsdToolsBin, 'capability', 'set', 'does-not-exist', '--off', '--config-dir', rcd], {
        cwd,
        timeoutMs: 15000,
      });
      assert.notEqual(unknownResult.exitCode, 0,
        `capability set does-not-exist --off should exit non-zero, got ${String(unknownResult.exitCode)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 12: validate-before-write atomicity ──────────────────────────────
  test('validate-before-write: mixed-error batch leaves substrates untouched', () => {
    // If a batch has ANY error (e.g. invalid gate key), NEITHER the surface
    // NOR the config must be written — even for the valid entries in the batch.
    const { rcd, cwd } = makeTempDirs();
    try {
      // Batch: ui has an invalid gate key (error), plus code-review enabled:false (valid)
      // Because there is an error, NEITHER should be written.
      let result;
      assert.doesNotThrow(() => {
        result = setCapabilityState(cwd, rcd, [
          { id: 'ui', gates: { 'workflow.not_a_key': false } }, // invalid gate key → error
          { id: 'code-review', enabled: false },                // valid, but should NOT write
        ]);
      });

      assert.ok(result.errors.length > 0, `expected errors, got: ${JSON.stringify(result.errors)}`);
      const invalidKeyError = result.errors.find((e) => e.includes('workflow.not_a_key'));
      assert.ok(invalidKeyError !== undefined, `expected invalid-gate error, got: ${JSON.stringify(result.errors)}`);

      // Surface must NOT be written (code-review must NOT be in disabledClusters)
      const surface = readSurface(rcd);
      if (surface !== null) {
        assert.ok(
          !surface.disabledClusters.includes('code-review'),
          `code-review must not be in disabledClusters when batch has errors; surface: ${JSON.stringify(surface)}`,
        );
      }

      // Config must NOT be written
      const config = readConfig(cwd);
      assert.equal(
        config?.workflow?.not_a_key,
        undefined,
        'invalid gate key must not appear in config.json',
      );
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 13: disable→enable round-trip confirms enabled:true ─────────────
  test('enable after disable: round-trip still yields ui.enabled===true', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // Disable first
      setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: false }]);
      // Re-enable
      const result = setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: true }]);
      const uiCap = result.capabilities.find((c) => c.id === 'ui');
      assert.ok(uiCap, 'ui capability present in result');
      assert.equal(uiCap.enabled, true, 'ui.enabled should be true after re-enable');
      assert.equal(result.errors.length, 0,
        `no errors expected on re-enable, got: ${JSON.stringify(result.errors)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 13b (Fix A + Fix B): explicitAdds disable interaction ──────────
  test('Fix A: disable when explicitAdds holds cap skill stems → skill stems removed, ui.enabled===false, no errors', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // Seed surface with ui skill stems already in explicitAdds
      const surfacePath = path.join(rcd, '.gsd-surface.json');
      fs.writeFileSync(surfacePath, JSON.stringify({
        baseProfile: 'full',
        disabledClusters: [],
        explicitAdds: ['ui-phase', 'ui-review'],
        explicitRemoves: [],
      }));

      const result = setCapabilityState(cwd, rcd, [{ id: 'ui', enabled: false }]);

      // Fix B covers this: if disable didn't work, the post-check would emit an error
      assert.equal(result.errors.length, 0,
        `no errors expected, got: ${JSON.stringify(result.errors)}`);

      const uiCap = result.capabilities.find((c) => c.id === 'ui');
      assert.ok(uiCap, 'ui capability present in result');
      assert.equal(uiCap.enabled, false, 'ui.enabled should be false after disable');

      const surface = readSurface(rcd);
      assert.ok(surface !== null, 'surface file exists');
      assert.ok(surface.disabledClusters.includes('ui'), 'ui in disabledClusters');
      // Skill stems must have been removed from explicitAdds
      assert.ok(!surface.explicitAdds.includes('ui-phase'),
        `ui-phase must be removed from explicitAdds, got: ${JSON.stringify(surface.explicitAdds)}`);
      assert.ok(!surface.explicitAdds.includes('ui-review'),
        `ui-review must be removed from explicitAdds, got: ${JSON.stringify(surface.explicitAdds)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 15 (Fix C): materialise failure → error, not warning ─────────────
  test('Fix C: materialise failure is an error (not a warning)', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // Use an invalid runtime that throws in resolveRuntimeArtifactLayout
      const result = setCapabilityState(
        cwd, rcd,
        [{ id: 'ui', enabled: false }],
        { materialize: { runtime: 'definitely-not-a-runtime', scope: 'global' } },
      );

      assert.ok(result.errors.length > 0,
        `expected errors for materialise failure, got: ${JSON.stringify(result.errors)}`);
      const materialiseError = result.errors.find((e) => e.includes('materialize failed'));
      assert.ok(materialiseError !== undefined,
        `expected "materialize failed" error, got errors: ${JSON.stringify(result.errors)}`);
      // Must NOT appear in warnings
      const materialiseWarning = result.warnings.find((w) => w.includes('materialize failed'));
      assert.equal(materialiseWarning, undefined,
        `materialise failure must not appear in warnings, got: ${JSON.stringify(result.warnings)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 16 (Fix D): malformed config.json → error, surface NOT written ───
  test('Fix D: malformed config.json pre-check blocks write and surface not created', () => {
    const { rcd, cwd } = makeTempDirs();
    try {
      // Write malformed config.json
      const planningDirPath = path.join(cwd, '.planning');
      fs.mkdirSync(planningDirPath, { recursive: true });
      fs.writeFileSync(path.join(planningDirPath, 'config.json'), '{ not json');

      const result = setCapabilityState(cwd, rcd, [
        { id: 'code-review', gates: { 'workflow.code_review': false } },
      ]);

      assert.ok(result.errors.length > 0,
        `expected errors for malformed config, got: ${JSON.stringify(result.errors)}`);
      const malformedError = result.errors.find(
        (e) => e.includes('malformed') || e.includes('config.json'),
      );
      assert.ok(malformedError !== undefined,
        `expected malformed config error, got errors: ${JSON.stringify(result.errors)}`);

      // Surface must NOT have been written (no partial write)
      const surface = readSurface(rcd);
      assert.equal(surface, null,
        `surface must not have been written when config is malformed, got: ${JSON.stringify(surface)}`);
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

  // ── Test 14: CLI conflicting --on --off flags → non-zero exit ─────────────
  test('CLI: capability set ui --on --off exits non-zero (conflicting flags)', () => {
    const rcd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-conflict-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-conflict-cwd-'));
    try {
      const planningDir = path.join(cwd, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(path.join(planningDir, 'config.json'), '{}');

      const gsdToolsBin = path.resolve(__dirname, '../gsd-core/bin/gsd-tools.cjs');

      const conflictResult = runNode(
        [gsdToolsBin, 'capability', 'set', 'ui', '--on', '--off', '--config-dir', rcd],
        { cwd, timeoutMs: 15000 },
      );
      assert.notEqual(
        conflictResult.exitCode, 0,
        `capability set ui --on --off should exit non-zero, got ${String(conflictResult.exitCode)}. stderr: ${conflictResult.stderr}`,
      );
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

});

// ─── Null-intermediate config tests ──────────────────────────────────────────

describe('capability-writer: null-intermediate config guard', () => {

  test('null intermediate: gate write into {workflow:null} produces {workflow:{key:false}} without throw', () => {
    // Regression for Fix 2: typeof null === 'object' caused _setNestedValue to
    // traverse null and throw TypeError at null[key].
    const rcd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-null-rcd-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-null-cwd-'));
    try {
      const planningDir = path.join(cwd, '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      // Pre-write a config where the intermediate 'workflow' key is null
      fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ workflow: null }));

      // code-review owns workflow.code_review; writing it should replace null with {}
      let result;
      assert.doesNotThrow(() => {
        result = setCapabilityState(cwd, rcd, [
          { id: 'code-review', gates: { 'workflow.code_review': false } },
        ]);
      }, 'setCapabilityState must not throw when an intermediate config node is null');

      assert.ok(result.errors.length === 0,
        `expected no errors, got: ${JSON.stringify(result.errors)}`);

      // Config should have workflow.code_review=false (null replaced with object)
      const config = readConfig(cwd);
      assert.equal(
        config?.workflow?.code_review,
        false,
        'workflow.code_review must be false after gate write into null-intermediate config',
      );
    } finally {
      cleanup(rcd);
      cleanup(cwd);
    }
  });

});

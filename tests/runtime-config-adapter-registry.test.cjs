'use strict';

// Tests for runtime-config-adapter-registry.cjs (issue #60).
//
// 1.7.0 (ADR-1016 / ADR-1239) makes runtimes pluggable data descriptors, and
// resolveRuntimeConfigIntent / resolveInstallPlan are PURE PROJECTIONS of those
// descriptors. So this file asserts the PROJECTION CONTRACT — that each
// function maps descriptor fields to the intent/plan shape correctly (right
// field names, right null-handling, right types) — for EVERY runtime in the
// registry, rather than pinning a frozen per-runtime value snapshot that would
// have to be hand-edited on every runtime addition. The EXPECTED_TABLE below is
// DERIVED from the capability registry at load time; adding a runtime descriptor
// requires zero changes here.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  resolveRuntimeConfigIntent,
  resolveInstallPlan,
  resolveInstallPlanFromRuntimes,
  ALLOWED_CONFIG_RUNTIMES,
  INSTALL_SURFACES,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-config-adapter-registry.cjs'));
const registry = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));

// Folded from tests/issue-57-runtime-install-no-drift.test.cjs (issue #57).
process.env.GSD_TEST_MODE = '1'; // must precede require of bin/install.js
const fs = require('node:fs');
const os = require('node:os');
const { allRuntimes, runtimeMap } = require(path.join(ROOT, 'bin', 'install.js'));
const { resolveRuntimeArtifactLayout } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs'),
);
const { getGlobalConfigDir } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));
const { createTempDir, cleanup } = require('./helpers.cjs');

const sorted = (iterable) => [...iterable].sort();

// ---------------------------------------------------------------------------
// Source-of-truth table — DERIVED from the capability registry descriptors.
// Each row is the descriptor projection of one runtime's config intent. This is
// deliberately non-circular: production reads the descriptor too, and this
// asserts the mapping (field names, null-coalescing of permissionWriter, etc.)
// is correct for every present and future runtime.
// ---------------------------------------------------------------------------

const EXPECTED_TABLE = Object.keys(registry.runtimes).map((id) => {
  const r = registry.runtimes[id].runtime;
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

describe('resolveRuntimeConfigIntent — projection contract', () => {
  test('every registry runtime resolves to its descriptor-derived intent', () => {
    assert.ok(EXPECTED_TABLE.length > 0, 'registry must contain at least one runtime');
    for (const row of EXPECTED_TABLE) {
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
// Test 2: Unknown runtime fails loudly (AC#2)
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — unknown runtime throws TypeError', () => {
  test('throws TypeError for unknown string "grok"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('grok'), TypeError);
  });

  test('throws TypeError for unknown string "xyzunknown"', () => {
    assert.throws(() => resolveRuntimeConfigIntent('xyzunknown'), TypeError);
  });

  test('throws TypeError for empty string ""', () => {
    assert.throws(() => resolveRuntimeConfigIntent(''), TypeError);
  });

  test('throws TypeError for undefined', () => {
    assert.throws(() => resolveRuntimeConfigIntent(undefined), TypeError);
  });

  test('throws TypeError for "__proto__" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('__proto__'), TypeError);
  });

  test('throws TypeError for "constructor" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('constructor'), TypeError);
  });

  test('throws TypeError for "hasOwnProperty" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('hasOwnProperty'), TypeError);
  });

  test('throws TypeError for "toString" (prototype-chain key)', () => {
    assert.throws(() => resolveRuntimeConfigIntent('toString'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Test 3: writesSharedSettings — derived equivalence (count-agnostic).
// The runtimes resolving to false are exactly those whose descriptor declares
// writesSharedSettings===false.
// ---------------------------------------------------------------------------

describe('writesSharedSettings — descriptor-driven equivalence', () => {
  test('runtimes resolving writesSharedSettings===false are exactly the descriptor-declared false set', () => {
    const falseRuntimes = EXPECTED_TABLE
      .filter(r => r.writesSharedSettings === false)
      .map(r => r.runtime)
      .sort();
    const descriptorFalse = Object.keys(registry.runtimes)
      .filter((id) => registry.runtimes[id].runtime.writesSharedSettings === false)
      .sort();
    assert.deepStrictEqual(falseRuntimes, descriptorFalse);
  });
});

// ---------------------------------------------------------------------------
// Test 4: finishPermissionWriter — opencode/kilo are non-null, the rest null.
// Spot-check the two non-null writers (stable curated values) plus the
// descriptor-derived null set.
// ---------------------------------------------------------------------------

describe('finishPermissionWriter', () => {
  test('opencode -> "opencode"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('opencode').finishPermissionWriter, 'opencode');
  });

  test('kilo -> "kilo"', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('kilo').finishPermissionWriter, 'kilo');
  });

  test('every registry runtime whose descriptor permissionWriter is null/absent resolves to null', () => {
    for (const row of EXPECTED_TABLE.filter((r) => r.finishPermissionWriter === null)) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(row.runtime).finishPermissionWriter,
        null,
        `${row.runtime} should have finishPermissionWriter null`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: installSurface — spot-check the stable dedicated surfaces, plus a
// descriptor-driven assertion that every runtime resolves to its declared
// surface (count-agnostic).
// ---------------------------------------------------------------------------

describe('installSurface correctness', () => {
  test('dedicated surfaces are stable (spot-check)', () => {
    assert.strictEqual(resolveRuntimeConfigIntent('codex').installSurface, 'codex-toml');
    assert.strictEqual(resolveRuntimeConfigIntent('copilot').installSurface, 'copilot-instructions');
    assert.strictEqual(resolveRuntimeConfigIntent('cline').installSurface, 'cline-rules');
    assert.strictEqual(resolveRuntimeConfigIntent('cursor').installSurface, 'cursor-hooks-json');
    assert.strictEqual(resolveRuntimeConfigIntent('windsurf').installSurface, 'profile-marker-only');
    assert.strictEqual(resolveRuntimeConfigIntent('trae').installSurface, 'profile-marker-only');
  });

  test('every registry runtime resolves to its descriptor-declared installSurface', () => {
    for (const row of EXPECTED_TABLE) {
      assert.strictEqual(
        resolveRuntimeConfigIntent(row.runtime).installSurface,
        row.installSurface,
        `${row.runtime} must resolve its descriptor installSurface`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Returned intent is a fresh object (no shared reference mutation)
// ---------------------------------------------------------------------------

describe('resolveRuntimeConfigIntent — fresh object each call', () => {
  test('mutating the returned object does not affect a subsequent resolve', () => {
    const first = resolveRuntimeConfigIntent('claude');
    first.installSurface = 'MUTATED';
    first.writesSharedSettings = false;

    const second = resolveRuntimeConfigIntent('claude');
    assert.strictEqual(second.installSurface, 'settings-json');
    assert.strictEqual(second.writesSharedSettings, true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Completeness — ALLOWED_CONFIG_RUNTIMES equals the set of registry
// runtimes that declare an installSurface (count-agnostic; derived from the
// same source as the production Set).
// ---------------------------------------------------------------------------

describe('ALLOWED_CONFIG_RUNTIMES completeness', () => {
  test('ALLOWED_CONFIG_RUNTIMES equals the registry runtimes that declare a real (non-"none") installSurface', () => {
    // #2103: installSurface 'none' means "no CLI install surface at all"
    // (e.g. vscode — Marketplace/VSIX-distributed, never CLI-installed), so
    // it is excluded from the config-adapter runtime set by definition — this
    // mirrors the exclusion already baked into the production
    // ALLOWED_CONFIG_RUNTIMES filter (src/runtime-config-adapter-registry.cts).
    const descriptorAllowed = new Set(
      Object.entries(registry.runtimes)
        .filter(([, cap]) => cap && cap.runtime && typeof cap.runtime.installSurface === 'string' && cap.runtime.installSurface !== 'none')
        .map(([id]) => id),
    );
    assert.deepStrictEqual(new Set(ALLOWED_CONFIG_RUNTIMES), descriptorAllowed);
  });

  test('#2103: vscode declares installSurface "none" and is registered but intentionally excluded from ALLOWED_CONFIG_RUNTIMES', () => {
    assert.strictEqual(registry.runtimes.vscode.runtime.installSurface, 'none');
    assert.ok(!ALLOWED_CONFIG_RUNTIMES.has('vscode'),
      'vscode must not be a config-adapter runtime — it has no CLI install surface');
  });

  test('every member of ALLOWED_CONFIG_RUNTIMES resolves without throwing', () => {
    for (const runtime of ALLOWED_CONFIG_RUNTIMES) {
      assert.doesNotThrow(() => resolveRuntimeConfigIntent(runtime), `${runtime} should resolve without throwing`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: INSTALL_SURFACES export
// ---------------------------------------------------------------------------

describe('INSTALL_SURFACES export', () => {
  const EXPECTED_SURFACES = new Set([
    'settings-json',
    'codex-toml',
    'copilot-instructions',
    'cline-rules',
    'cursor-hooks-json',
    'profile-marker-only',
    // 'none' added #2103 — vscode has no CLI install surface at all.
    'none',
  ]);

  test('INSTALL_SURFACES contains exactly the 7 surface strings', () => {
    assert.deepStrictEqual(new Set(INSTALL_SURFACES), EXPECTED_SURFACES);
  });
});

describe('resolveInstallPlan — hooksSurface is descriptor-owned', () => {
  test('real descriptor-owned none surface is preserved for opencode and kilo', () => {
    assert.strictEqual(resolveInstallPlan('opencode').hooksSurface, 'none');
    assert.strictEqual(resolveInstallPlan('kilo').hooksSurface, 'none');
  });

  test('synthetic descriptor resolves hooksSurface without runtime-name fallback', () => {
    const runtimes = {
      futurecli: {
        runtime: {
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: null,
          hookEvents: 'claude',
          extendedHookEvents: ['Stop'],
          hooksSurface: 'settings-json',
          sandboxTier: 'none',
        },
      },
    };

    assert.deepStrictEqual(resolveInstallPlanFromRuntimes(runtimes, 'futurecli'), {
      runtime: 'futurecli',
      installSurface: 'settings-json',
      writesSharedSettings: true,
      finishPermissionWriter: null,
      hookEvents: 'claude',
      extendedHookEvents: ['Stop'],
      hooksSurface: 'settings-json',
      sandboxTier: 'none',
    });
  });

  test('missing hooksSurface fails loudly instead of falling back from runtime name', () => {
    const runtimes = {
      opencode: {
        runtime: {
          installSurface: 'settings-json',
          writesSharedSettings: true,
          permissionWriter: 'opencode',
          extendedHookEvents: [],
        },
      },
    };

    assert.throws(
      () => resolveInstallPlanFromRuntimes(runtimes, 'opencode'),
      /runtime\.hooksSurface/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveInstallPlan — descriptor-projection contract (replaces the frozen
// per-runtime golden master). Asserts that for EVERY registry runtime,
// resolveInstallPlan(id) deep-equals the plan built directly from that runtime's
// descriptor fields. Count-agnostic: adding a runtime descriptor extends
// coverage with zero edits here. Folded from enh-1082 (consolidation epic #1969).
// ---------------------------------------------------------------------------

describe('resolveInstallPlan — descriptor-projection contract (count-agnostic)', () => {
  const RUNTIME_IDS = Object.keys(registry.runtimes);

  test('covers every registry runtime', () => {
    assert.ok(RUNTIME_IDS.length > 0, 'registry must contain at least one runtime');
  });

  // Build the expected plan directly from each descriptor — the same mapping
  // resolveInstallPlan performs, asserted rather than trusted.
  function expectedPlanFromDescriptor(id) {
    const desc = registry.runtimes[id].runtime;
    const pw = desc.permissionWriter;
    return {
      runtime: id,
      installSurface: desc.installSurface,
      writesSharedSettings: desc.writesSharedSettings,
      finishPermissionWriter: pw == null ? null : pw,
      hookEvents: desc.hookEvents,
      extendedHookEvents: Array.isArray(desc.extendedHookEvents) ? [...desc.extendedHookEvents] : [],
      hooksSurface: desc.hooksSurface,
      sandboxTier: desc.sandboxTier,
    };
  }

  for (const id of RUNTIME_IDS) {
    test(`resolveInstallPlan('${id}') matches the descriptor projection`, () => {
      assert.deepStrictEqual(
        resolveInstallPlan(id),
        expectedPlanFromDescriptor(id),
        `InstallPlan for '${id}' diverged from its descriptor projection`,
      );
    });
  }

  test('resolveInstallPlan throws TypeError for unknown runtime', () => {
    assert.throws(
      () => resolveInstallPlan('bogus'),
      (err) => err instanceof TypeError && /bogus/.test(err.message),
    );
  });

  test('extendedHookEvents is always an array for every runtime', () => {
    for (const id of RUNTIME_IDS) {
      assert.ok(Array.isArray(resolveInstallPlan(id).extendedHookEvents),
        `${id}: extendedHookEvents should be an array`);
    }
  });

  test('hooksSurface is always a non-empty string for every runtime', () => {
    for (const id of RUNTIME_IDS) {
      const plan = resolveInstallPlan(id);
      assert.strictEqual(typeof plan.hooksSurface, 'string', `${id}: hooksSurface should be a string`);
      assert.ok(plan.hooksSurface.length > 0, `${id}: hooksSurface should not be empty`);
    }
  });

  test('parity: resolveInstallPlan config-intent fields match resolveRuntimeConfigIntent', () => {
    // Guard that resolveInstallPlan composes resolveRuntimeConfigIntent correctly —
    // any drift between the two would silently break install().
    for (const id of RUNTIME_IDS) {
      const plan = resolveInstallPlan(id);
      const intent = resolveRuntimeConfigIntent(id);
      assert.strictEqual(plan.installSurface, intent.installSurface, `${id}: installSurface mismatch`);
      assert.strictEqual(plan.writesSharedSettings, intent.writesSharedSettings, `${id}: writesSharedSettings mismatch`);
      assert.strictEqual(plan.finishPermissionWriter, intent.finishPermissionWriter, `${id}: finishPermissionWriter mismatch`);
    }
  });
});

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-57-runtime-install-no-drift', () => {
// ---------------------------------------------------------------------------
// Folded from tests/issue-57-runtime-install-no-drift.test.cjs (issue #57,
// H3 Wave 4 consolidation). Protects the Runtime Install Policy Module
// boundary (ADR-58) and the explicit Runtime Config Adapter Registry (#60):
// these guards fail when supported-runtime metadata bypasses the registry
// projection (AC1) or config-mutation dispatch bypasses the explicit adapter
// registry (AC2). Known intentional asymmetry: `grok` appears in
// runtime-homes.cjs's getGlobalConfigDir switch but not in the registry /
// artifact-layout supported sets, and getGlobalConfigDir() falls back to
// ~/.claude for an unknown runtime instead of throwing (deliberately
// liberal) — only the registry and artifact-layout projections are loud
// gates. One source case was dropped as subsumed (see note below).
// ---------------------------------------------------------------------------

describe('issue-57 AC1 — supported-runtime metadata has one projected source of truth', () => {
  test('installer allRuntimes, interactive runtimeMap, and registry agree on the supported set', () => {
    const installable = sorted(allRuntimes);
    assert.deepStrictEqual(
      installable,
      sorted(Object.values(runtimeMap)),
      'Drift: bin/install.js `allRuntimes` and the interactive `runtimeMap` selection menu '
        + 'diverged. A runtime selectable in the prompt but absent from allRuntimes (or vice '
        + 'versa) is a supported-runtime call site that skipped the projection.',
    );
    assert.deepStrictEqual(
      installable,
      sorted(ALLOWED_CONFIG_RUNTIMES),
      'Drift: bin/install.js `allRuntimes` and `ALLOWED_CONFIG_RUNTIMES` (runtime config '
        + 'adapter registry) diverged. A runtime added to an installer call site without a '
        + 'registry adapter entry bypasses the registry projection — register it in '
        + 'src/runtime-config-adapter-registry.cts.',
    );
  });

  // NOTE: source also asserted `resolveRuntimeConfigIntent(runtime).runtime === runtime`
  // for every `allRuntimes` entry — dropped here as subsumed by the
  // descriptor-projection contract test above (deep-equal over every registry
  // runtime, a strict superset of `allRuntimes` per the equality just asserted).

  test('every installable runtime resolves a global config dir through runtime-homes', () => {
    for (const runtime of allRuntimes) {
      const dir = getGlobalConfigDir(runtime);
      assert.equal(typeof dir, 'string', `${runtime} config dir must be a string`);
      assert.ok(dir.length > 0, `${runtime} must resolve a non-empty global config dir`);
    }
  });
});

describe('issue-57 AC2 — config-mutation dispatch is closed over the explicit registry', () => {
  test('every config intent uses a registry-declared install surface', () => {
    const surfaces = new Set(INSTALL_SURFACES);
    for (const runtime of allRuntimes) {
      const { installSurface } = resolveRuntimeConfigIntent(runtime);
      assert.ok(
        surfaces.has(installSurface),
        `${runtime} dispatches config via unregistered surface "${installSurface}" — add it `
          + 'to INSTALL_SURFACES in the registry instead of branching on it inline.',
      );
    }
  });

  test('every finishInstall permission writer is null or a registry-known runtime', () => {
    for (const runtime of allRuntimes) {
      const { finishPermissionWriter } = resolveRuntimeConfigIntent(runtime);
      assert.ok(
        finishPermissionWriter === null || ALLOWED_CONFIG_RUNTIMES.has(finishPermissionWriter),
        `${runtime} uses finishPermissionWriter "${finishPermissionWriter}", which is neither `
          + 'null nor a registry-known runtime — route it through a registered adapter.',
      );
    }
  });

  test('unknown runtime fails loudly through both strict projections (no silent fallthrough)', () => {
    const SENTINEL = '__drift_sentinel_runtime__';
    assert.throws(
      () => resolveRuntimeConfigIntent(SENTINEL),
      TypeError,
      'config adapter registry must reject an unknown runtime, not dispatch it silently',
    );
    assert.throws(
      () => resolveRuntimeArtifactLayout(SENTINEL, path.join(os.tmpdir(), 'gsd-57'), 'global'),
      TypeError,
      'artifact-layout projection must reject an unknown runtime',
    );
  });

  test('registry rejects prototype-chain keys (no proto-pollution dispatch bypass)', () => {
    // Overlaps __proto__/constructor/toString with the individually-named
    // cases above; folded anyway to keep the 'prototype' key covered (not
    // asserted individually elsewhere in this file).
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
      assert.throws(
        () => resolveRuntimeConfigIntent(key),
        TypeError,
        `${key} must throw, not resolve via the prototype chain`,
      );
    }
  });

  // allow-test-rule: structural-regression-guard (#3336)
  // structural guard over bin/install.js source. Behavioral assertions
  // cannot observe inline `runtime === '...'` config branching, so this enforces that
  // every inline per-runtime branch references a runtime the adapter registry knows
  // about — a NEW branch against an unregistered runtime name fails here. ESLint cannot
  // currently see this grep because no-source-grep's TEXT_METHODS omits matchAll (#3464).
  test('every inline `runtime === "..."` branch references a registry-known runtime', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
    const literals = new Set(
      [...src.matchAll(/runtime === (?:'([a-z][a-z0-9-]*)'|"([a-z][a-z0-9-]*)")/g)]
        .map((m) => m[1] ?? m[2]),
    );
    assert.ok(literals.size > 0, 'expected to find inline runtime comparisons in bin/install.js');
    const unregistered = [...literals].filter((r) => !ALLOWED_CONFIG_RUNTIMES.has(r));
    assert.deepStrictEqual(
      unregistered,
      [],
      `inline 'runtime === "..."' branch(es) reference runtimes absent from the config adapter `
        + `registry: ${unregistered.join(', ')} — register them in `
        + 'src/runtime-config-adapter-registry.cts or route the logic through '
        + 'resolveRuntimeConfigIntent instead of branching inline.',
    );
  });

  // allow-test-rule: structural-regression-guard (#2103)
  // VS Code is a registry runtime but is NEVER CLI-installed (Marketplace/VSIX
  // extension); it must stay fully descriptor-driven — bin/install.js must
  // never special-case it by name. ESLint cannot currently see this grep because
  // no-source-grep's TEXT_METHODS omits matchAll (#3464).
  test('#2103: bin/install.js has ZERO runtime === "vscode" / isVscode branches (vscode stays fully descriptor-driven)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
    const runtimeComparisons = [...src.matchAll(/runtime === (?:'vscode'|"vscode")/g)];
    assert.deepStrictEqual(
      runtimeComparisons.map((m) => m[0]),
      [],
      'bin/install.js must not special-case vscode via `runtime === "vscode"` — vscode has no '
        + 'install surface at all (installSurface: "none") and is never CLI-installed; any '
        + 'vscode-specific behavior belongs in capabilities/vscode/capability.json, not an inline branch.',
    );
    const isVscodeRefs = [...src.matchAll(/\bisVscode\b/g)];
    assert.deepStrictEqual(
      isVscodeRefs.map((m) => m[0]),
      [],
      'bin/install.js must not introduce an isVscode flag — vscode is intentionally excluded '
        + 'from runtimeFlags (Marketplace-distributed, never CLI-installed).',
    );
  });

  // Behavioral replacement for the delegation-presence source grep (#3466).
  //
  // The EXPECTED_TABLE / resolveInstallPlan projection-contract tests above
  // (`resolveInstallPlan — descriptor-projection contract`) prove resolveInstallPlan
  // ITSELF maps every registry descriptor correctly — but they call the registry
  // function directly and never touch bin/install.js, so they cannot by themselves
  // prove install.js actually CONSULTS it rather than reimplementing an equivalent
  // per-runtime branch. This test closes that gap: it stubs the registry's
  // resolveInstallPlan (the SAME module object bin/install.js requires and
  // destructures) so it reports a different installSurface for every runtime,
  // re-requires a fresh bin/install.js so its destructured reference picks up the
  // stub, and asserts a REAL install(false, 'copilot') run STOPS producing the
  // copilot-instructions.md artifact that installSurface === 'copilot-instructions'
  // gates directly inside install() (bin/install.js:~12164 — no finishInstall/CLI
  // orchestration layer involved, so this is reachable from install() alone). If
  // install.js ever reverts to a `runtime === 'copilot'` inline branch instead of
  // reading resolveInstallPlan(runtime).installSurface, the stub has no effect on
  // that branch and the artifact keeps getting written — which is exactly the
  // divergence this test would then catch (verified by mutating install.js to that
  // exact inline form during authoring: the assertion below goes red).
  test('bin/install.js dispatches config through the REAL resolveInstallPlan (stubbing it changes install() output)', () => {
    const installPath = require.resolve('../bin/install.js');
    const registryPath = require.resolve('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
    const registryModule = require(registryPath);
    const originalResolveInstallPlan = registryModule.resolveInstallPlan;

    registryModule.resolveInstallPlan = (runtime) => ({
      ...originalResolveInstallPlan(runtime),
      // Force every gate bin/install.js checks against
      // resolveInstallPlan(runtime).installSurface to read as "nothing special for
      // this runtime" — including copilot's own surface, which the real descriptor
      // sets to 'copilot-instructions'.
      installSurface: 'settings-json',
    });

    delete require.cache[installPath];
    const stubbedInstaller = require(installPath);

    const tmpDir = createTempDir('gsd-3466-delegation-guard-');
    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = stubbedInstaller.install(false, 'copilot');
      const instructionsPath = path.join(result.configDir, 'copilot-instructions.md');
      assert.equal(
        fs.existsSync(instructionsPath), false,
        'with resolveInstallPlan stubbed to report installSurface: "settings-json" for every '
          + 'runtime, install(\'copilot\') must NOT write copilot-instructions.md — if it still '
          + 'does, bin/install.js is not actually gating on resolveInstallPlan(runtime) for this '
          + 'decision (a regression to scattered per-runtime branching)',
      );
    } finally {
      process.chdir(previousCwd);
      cleanup(tmpDir);
      registryModule.resolveInstallPlan = originalResolveInstallPlan;
      delete require.cache[installPath];
    }
  });
});
  });
}

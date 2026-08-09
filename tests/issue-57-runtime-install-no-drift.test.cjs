'use strict';

// Issue #57 — Runtime Install No-Drift Tests.
//
// Protects the Runtime Install Policy Module boundary (ADR-58) and the explicit
// Runtime Config Adapter Registry (#60) now that the policy boundary (#58),
// explicit adapter registry (#60), and legacy directory-helper retirement (#56)
// have landed. These guards FAIL when:
//
//   (AC1) supported-runtime metadata is added to an installer/query call site
//         without going through the runtime registry projection, or
//   (AC2) config-mutation dispatch bypasses the explicit adapter registry.
//
// (AC3) Assertions are behavioral (require + reflect on live exports) wherever
// behavior can cover the contract; the two source-text assertions are structural
// guards that behavioral checks cannot replace, and are annotated per repo
// convention. (AC4) The existing installer / runtime-policy / runtime-global-skills
// suites must stay green — verified by running them alongside this file, not
// asserted here.
//
// Known INTENTIONAL asymmetries — these are not drift; do not "fix" them by
// tightening the invariants:
//   - `grok` appears in runtime-homes.cjs's getGlobalConfigDir switch but NOT in
//     the registry / artifact-layout supported sets (it resolves a config-dir home
//     but is not an installable artifact target). So runtime-homes' full switch set
//     is never tied into the equality invariant — it is only probed forward, per
//     installable runtime.
//   - getGlobalConfigDir() falls back to ~/.claude for an UNKNOWN runtime instead
//     of throwing (a deliberately liberal projection). Only the registry and
//     artifact-layout projections are loud gates, so only those are asserted to
//     throw on an unknown runtime.
//
// Coverage boundary (deliberate, see #57 follow-up): the structural guard below
// catches a NEW inline `runtime === '...'` branch against an UNREGISTERED runtime.
// It cannot catch a duplicate inline config write added for an ALREADY-registered
// runtime — distinguishing that from the ~169 legitimate per-runtime comparisons in
// the installer requires driving install()/finishInstall() against a mocked
// filesystem and asserting the written surfaces match resolveRuntimeConfigIntent().
// That behavioral install-driver harness is out of scope for this no-drift pass.
//
// The forward invariant `allRuntimes ⊆ artifact-layout` is already covered by
// tests/install-runtime-artifacts.test.cjs; this file does not duplicate it.

process.env.GSD_TEST_MODE = '1'; // must precede require of bin/install.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');

const { allRuntimes, runtimeMap } = require(path.join(ROOT, 'bin', 'install.js'));
const {
  resolveRuntimeConfigIntent,
  ALLOWED_CONFIG_RUNTIMES,
  INSTALL_SURFACES,
} = require(path.join(LIB, 'runtime-config-adapter-registry.cjs'));
const { resolveRuntimeArtifactLayout } = require(
  path.join(LIB, 'runtime-artifact-layout.cjs'),
);
const { getGlobalConfigDir } = require(path.join(LIB, 'runtime-homes.cjs'));

const sorted = (iterable) => [...iterable].sort();

// A runtime name that is deliberately not real and is not a prototype-chain key.
const SENTINEL = '__drift_sentinel_runtime__';

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

  test('every installable runtime resolves a config intent through the registry', () => {
    for (const runtime of allRuntimes) {
      const intent = resolveRuntimeConfigIntent(runtime);
      assert.equal(
        intent.runtime,
        runtime,
        `${runtime} must resolve its own config intent through resolveRuntimeConfigIntent`,
      );
    }
  });

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
    // Registry-derived (no hand-maintained vocabulary): a permission writer either
    // names a runtime that is itself in the registry, or is null. A writer pointing
    // at an unregistered runtime would mean finishInstall dispatches a config mutation
    // outside the registry's known set.
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
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
      assert.throws(
        () => resolveRuntimeConfigIntent(key),
        TypeError,
        `${key} must throw, not resolve via the prototype chain`,
      );
    }
  });

  // allow-test-rule: structural-regression-guard
  // structural guard over bin/install.js source. Behavioral assertions
  // cannot observe inline `runtime === '...'` config branching, so this enforces that
  // every inline per-runtime branch references a runtime the adapter registry knows
  // about — a NEW branch against an unregistered runtime name fails here. It matches
  // positive equality only (`runtime === '<name>'` / `runtime === "<name>"`, both quote
  // styles), so `runtime !== 'string'`-style type guards are not implicated. See the
  // "coverage boundary" note at the top of the file for what this can and cannot catch.
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
  // structural guard over bin/install.js source. VS Code
  // (capabilities/vscode/capability.json) is a registry runtime (role:runtime, for
  // validator/host-integration coverage) but is NEVER CLI-installed — it is a
  // Marketplace/VSIX extension with no --vscode flag and no allRuntimes membership
  // (see NON_INSTALLABLE_RUNTIMES in tests/runtime-flags.test.cjs). It must stay
  // fully descriptor-driven: bin/install.js must never special-case it by name.
  // This is a stricter, clearer-failure-message sibling of the generic
  // "every inline runtime === ..." guard above (which would also catch this, but
  // with a misleading "register it in the adapter registry" suggestion — vscode
  // must never be registered there at all, see the ALLOWED_CONFIG_RUNTIMES filter
  // in src/runtime-config-adapter-registry.cts).
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

  // allow-test-rule: structural-regression-guard
  // delegation-presence guard. Catches wholesale removal of the registry
  // dispatch (a regression to scattered per-runtime config branching). Presence-style, not
  // absence-grep, so it does not bite on incidental non-config `runtime === '...'` checks.
  test('bin/install.js requires the config adapter registry and dispatches through it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
    assert.ok(
      src.includes('runtime-config-adapter-registry'),
      'bin/install.js no longer requires the runtime config adapter registry',
    );
    assert.ok(
      src.includes('resolveInstallPlan('),
      'bin/install.js no longer dispatches config through resolveInstallPlan',
    );
  });
});

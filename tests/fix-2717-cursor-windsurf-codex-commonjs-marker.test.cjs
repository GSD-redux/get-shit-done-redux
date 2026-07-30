'use strict';

// Regression tests for #2717: cursor, windsurf, and codex stage `.js` hook
// scripts via dedicated paths that bypass installSharedHooksBundle (the only
// writer of the {"type":"commonjs"} marker). Under a config root declaring
// {"type":"module"}, Node loaded those scripts as ESM and every require() failed
// with "require is not defined", silently disabling the runtime's lifecycle
// hooks.
//
// These tests assert the invariant structurally: whenever a runtime stages one
// or more `.js` hooks into its GSD-owned hooks directory, a package.json forcing
// CommonJS mode exists in that SAME directory, and a require()-using hook
// actually loads under an ESM-typed parent.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');

const COMMONJS_MARKER = '{"type":"commonjs"}\n';

// Runtimes that stage `.js` hooks via the dedicated cursor/windsurf/codex paths
// (skipSharedHooksInstall or the !isCodex gate) — the three #2717 covers.
const AFFECTED_RUNTIMES = [
  { runtime: 'cursor', sampleHook: 'gsd-cursor-session-start.js' },
  { runtime: 'windsurf', sampleHook: 'gsd-windsurf-pre-write.js' },
  { runtime: 'codex', sampleHook: 'gsd-check-update.js' },
];

function readMarker(configDir) {
  const p = path.join(configDir, 'hooks', 'package.json');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

describe('#2717 CommonJS marker for staged .js hooks', () => {
  for (const { runtime, sampleHook } of AFFECTED_RUNTIMES) {
    test(`${runtime}: install writes {"type":"commonjs"} into hooks/ alongside the staged .js scripts`, (t) => {
      const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
      t.after(() => cleanup(root));

      // The sample hook must actually be staged (sanity — confirms the install
      // reached the dedicated .js-staging path for this runtime).
      const hookPath = path.join(configDir, 'hooks', sampleHook);
      assert.ok(
        fs.existsSync(hookPath),
        `${runtime} install must stage ${sampleHook} (got: ${fs.readdirSync(path.join(configDir, 'hooks')).join(',')})`,
      );

      // The marker must exist in the SAME directory, with GSD's exact content.
      const marker = readMarker(configDir);
      assert.strictEqual(
        marker,
        COMMONJS_MARKER,
        `${runtime}: hooks/package.json must be exactly {"type":"commonjs"}\\n so Node loads the staged .js hooks as CommonJS even when the config root declares {"type":"module"}`,
      );
    });
  }

  test('cursor: a require()-using hook loads under an ESM-typed config root after install', (t) => {
    // Reproduces the exact failure mode in the issue: a config-root package.json
    // declaring {"type":"module"}. Pre-fix, Node walked up from the .js hook,
    // found this file, and loaded the hook as ESM → require() threw. Post-fix,
    // the GSD-written hooks/package.json is nearer and wins.
    const { configDir, root } = runMinimalInstall({ runtime: 'cursor', scope: 'global' });
    t.after(() => cleanup(root));

    // Plant the hostile ESM-typed package.json at the config root.
    fs.writeFileSync(path.join(configDir, 'package.json'), '{"type":"module"}\n');

    const hookPath = path.join(configDir, 'hooks', 'gsd-cursor-session-start.js');
    assert.ok(fs.existsSync(hookPath), 'cursor sessionStart hook must be staged');

    // The hook must load WITHOUT throwing "require is not defined". It reads
    // workspace_roots from stdin (cursor protocol); give it an empty payload so
    // it runs its main path and returns. A non-zero exit or an ESM error on
    // stderr is the failure signal.
    let stderr = '';
    let threw = false;
    try {
      execFileSync(process.execPath, [hookPath], {
        cwd: root,
        input: JSON.stringify({ workspace_roots: [] }),
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // The hook may exit non-zero for benign reasons (e.g. no STATE.md to
      // report). The ONLY failure we care about is the ESM/require error.
      threw = true;
      stderr = String(e.stderr || '');
    }
    assert.ok(
      !/require is not defined/i.test(stderr),
      `cursor hook must load as CommonJS under an ESM-typed config root; got ESM error:\n${stderr}`,
    );
    // threw is allowed (benign non-zero exit); the assertion above is the gate.
  });

  test('uninstall path: removeCommonJsMarkerIfGsdOwned removes only GSD-owned markers', (t) => {
    // The uninstall cleanup uses removeCommonJsMarkerIfGsdOwned (exported from
    // the runtime-hooks-surface). Assert its contract directly: it deletes a
    // GSD-written marker but never a user-authored package.json.
    const {
      removeCommonJsMarkerIfGsdOwned,
      ensureCommonJsMarker,
    } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

    // Case 1: GSD-owned marker is removed.
    const dirA = createTempDir('gsd-2717-rmA-');
    t.after(() => cleanup(dirA));
    assert.ok(ensureCommonJsMarker(dirA), 'ensureCommonJsMarker writes the marker');
    const markerA = path.join(dirA, 'package.json');
    assert.strictEqual(fs.readFileSync(markerA, 'utf8'), COMMONJS_MARKER);
    assert.ok(removeCommonJsMarkerIfGsdOwned(dirA), 'removes a GSD-owned marker');
    assert.ok(!fs.existsSync(markerA), 'GSD-owned marker is gone');

    // Case 2: user-authored package.json is preserved.
    const dirB = createTempDir('gsd-2717-keepB-');
    t.after(() => cleanup(dirB));
    const userContent = '{"name":"user-owned","type":"module"}\n';
    fs.writeFileSync(path.join(dirB, 'package.json'), userContent);
    assert.ok(!removeCommonJsMarkerIfGsdOwned(dirB), 'does not remove a non-GSD package.json');
    assert.strictEqual(fs.readFileSync(path.join(dirB, 'package.json'), 'utf8'), userContent);

    // Case 3: no marker → no-op, no throw.
    const dirC = createTempDir('gsd-2717-noopC-');
    t.after(() => cleanup(dirC));
    assert.ok(!removeCommonJsMarkerIfGsdOwned(dirC), 'no-op when no marker exists');

    // Case 4: ensureCommonJsMarker is idempotent and does not clobber a user file.
    const dirD = createTempDir('gsd-2717-idemD-');
    t.after(() => cleanup(dirD));
    fs.writeFileSync(path.join(dirD, 'package.json'), userContent);
    assert.ok(!ensureCommonJsMarker(dirD), 'does not overwrite a user-authored package.json');
    assert.strictEqual(fs.readFileSync(path.join(dirD, 'package.json'), 'utf8'), userContent);
  });
});

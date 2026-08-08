/**
 * Regression tests for:
 *   #1656 — 3 bash hooks referenced in settings.json but never installed
 *   #1657 — SDK install prompt fires and fails during interactive install
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');

// ─── #1656 ───────────────────────────────────────────────────────────────────

describe('#1656: community .sh hooks must be present in hooks/dist', () => {
  // Run the build script once before checking outputs.
  // hooks/dist/ is gitignored so it must be generated; this mirrors what
  // `npm run build:hooks` (prepublishOnly) does before publish.
  before(() => {
    const result = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS });
    throwIfFailed(result, `node ${BUILD_SCRIPT}`);
  });

  test('gsd-session-state.sh exists in hooks/dist', () => {
    const p = path.join(HOOKS_DIST, 'gsd-session-state.sh');
    assert.ok(fs.existsSync(p), 'gsd-session-state.sh must be in hooks/dist/ so the installer can copy it');
  });

  test('gsd-validate-commit.sh exists in hooks/dist', () => {
    const p = path.join(HOOKS_DIST, 'gsd-validate-commit.sh');
    assert.ok(fs.existsSync(p), 'gsd-validate-commit.sh must be in hooks/dist/ so the installer can copy it');
  });

  test('gsd-phase-boundary.sh exists in hooks/dist', () => {
    const p = path.join(HOOKS_DIST, 'gsd-phase-boundary.sh');
    assert.ok(fs.existsSync(p), 'gsd-phase-boundary.sh must be in hooks/dist/ so the installer can copy it');
  });
});

// ─── #1657 / #191 follow-up ──────────────────────────────────────────────────
//
// The retired SDK package seam means installer/package metadata must no longer
// expose sdk-specific flags or publish sdk/* artifacts.

describe('#1657 / #191: installer/package metadata retires sdk seam', () => {
  let src;
  test('install.js does not contain the legacy promptSdk() prompt (#1657)', () => {
    src = fs.readFileSync(INSTALL_SRC, 'utf-8');
    assert.ok(
      !src.includes('promptSdk('),
      'promptSdk() must not be reintroduced — the old interactive prompt flow was broken'
    );
  });

  test('install.js does not parse --sdk / --no-sdk flags (#191)', () => {
    src = src || fs.readFileSync(INSTALL_SRC, 'utf-8');
    assert.ok(
      !src.includes("args.includes('--sdk')"),
      '--sdk flag must not be parsed after sdk package retirement'
    );
    assert.ok(
      !src.includes("args.includes('--no-sdk')"),
      '--no-sdk flag must not be parsed after sdk package retirement'
    );
  });

  test('install.js does not invoke installSdkIfNeeded during install (#191)', () => {
    src = src || fs.readFileSync(INSTALL_SRC, 'utf-8');
    assert.ok(
      !src.includes('installSdkIfNeeded({'),
      'installer must not invoke installSdkIfNeeded during runtime install flow'
    );
  });

  test('package.json does not publish sdk/* artifacts (#191)', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    const files = rootPkg.files || [];
    assert.ok(
      files.every((f) => !String(f).startsWith('sdk')),
      'root package.json files must not include sdk paths'
    );
  });

  test('root tsconfig project references resolve to existing paths (#191)', () => {
    const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return;

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    const references = tsconfig.references || [];
    for (const ref of references) {
      const refPath = String(ref.path || '');
      assert.notEqual(refPath, 'sdk', 'root tsconfig must not reference retired sdk project');
      assert.ok(
        fs.existsSync(path.join(__dirname, '..', refPath)),
        `root tsconfig reference must exist: ${refPath}`
      );
    }
  });
});

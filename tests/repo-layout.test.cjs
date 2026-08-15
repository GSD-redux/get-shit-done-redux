'use strict';

/**
 * Governance tests for the gsd-core repository root layout.
 *
 * Invariant: the repository root must not contain ad-hoc AI instruction files
 * (such as AGENTS.md) that would become an untracked source of truth running
 * in parallel with the canonical CONTEXT.md and docs/adr/ records.
 *
 * Context: bin/install.js (local Copilot install path, issue #786) writes an
 * AGENTS.md to process.cwd() when `gsd install copilot` is run inside a repo
 * checkout. If that file is ever committed, editors and AI tools that auto-load
 * repo-root instruction files will silently pick up GSD's installer-generated
 * stub rather than the authoritative documentation. This test ensures that
 * artefact never lands in source control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGit, runNode } = require('./helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');

test('repo-layout: root AGENTS.md is not git-tracked — no ad-hoc AI instruction file committed alongside CONTEXT.md', () => {
  // The installer legitimately writes AGENTS.md to process.cwd() when
  // `gsd install copilot` runs inside a repo checkout (issue #786). The file
  // may exist on disk — that's expected after a local install. What must NOT
  // happen is committing it to git, where editors and AI tools would silently
  // pick up the installer-generated stub instead of CONTEXT.md.
  const r = runGit(['ls-files', '--error-unmatch', 'AGENTS.md'], {
    cwd: ROOT, timeoutMs: GIT_TIMEOUT_MS,
  });
  const tracked = r.exitCode === 0;
  assert.equal(
    tracked,
    false,
    [
      'root AGENTS.md must not be git-tracked.',
      'This file is written by `gsd install copilot` (bin/install.js, local Copilot path, issue #786)',
      'when the installer runs inside a repo checkout — its presence on disk is fine,',
      'but it must never be committed.',
      'The repository source of truth for architecture and contributor guidance is',
      'CONTEXT.md and docs/adr/ — not an installer-generated instruction stub.',
      'Run `git rm --cached AGENTS.md` to untrack it if accidentally staged.',
    ].join(' '),
  );
});

test('repo-layout: installer writes AGENTS.md for a LOCAL Copilot install (cwd), confirming the artifact is scoped', () => {
  // Behavioral replacement for a source-grep/brace-walk assertion (#3466):
  // runs the REAL installer (`bin/install.js --copilot --local`) with its cwd
  // pointed at an isolated temp dir, and asserts AGENTS.md is actually written
  // there. This directly observes the file-output side effect the guard
  // controls, rather than parsing install.js's lexical structure.
  const localRoot = createTempDir('gsd-repo-layout-copilot-local-');
  try {
    const result = runNode(
      [INSTALL_SCRIPT, '--copilot', '--local'],
      { cwd: localRoot, env: installerEnv({ HOME: localRoot, USERPROFILE: localRoot }), timeoutMs: INSTALL_TIMEOUT_MS },
    );
    assert.strictEqual(
      result.exitCode, 0,
      `local Copilot install must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.ok(
      fs.existsSync(path.join(localRoot, 'AGENTS.md')),
      'a LOCAL Copilot install (issue #786) must write AGENTS.md to its cwd — ' +
      'if this ever stops happening, Copilot CLI loses its primary repo-root instructions file',
    );
  } finally {
    cleanup(localRoot);
  }
});

test('repo-layout: installer does NOT write AGENTS.md for a GLOBAL Copilot install, confirming the commit risk is scoped', () => {
  // Companion to the local-install test above (#3466): a GLOBAL Copilot
  // install is already covered by ~/.copilot/copilot-instructions.md (per
  // the comment at the `if (!isGlobal)` guard's call site in bin/install.js),
  // so it must NOT also write a repo-root AGENTS.md. Both the cwd AND the
  // global --config-dir are isolated temp dirs distinct from this checkout,
  // so even if the guard under test were broken, this run cannot pollute the
  // real repository root.
  const globalCwd = createTempDir('gsd-repo-layout-copilot-global-cwd-');
  const globalConfigDir = createTempDir('gsd-repo-layout-copilot-global-config-');
  try {
    const result = runNode(
      [INSTALL_SCRIPT, '--copilot', '--global', '--config-dir', globalConfigDir],
      { cwd: globalCwd, env: installerEnv({ HOME: globalCwd, USERPROFILE: globalCwd }), timeoutMs: INSTALL_TIMEOUT_MS },
    );
    assert.strictEqual(
      result.exitCode, 0,
      `global Copilot install must exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.equal(
      fs.existsSync(path.join(globalCwd, 'AGENTS.md')), false,
      'a GLOBAL Copilot install must NOT write AGENTS.md to the working directory — ' +
      'that artifact is scoped to local installs only (issue #786); a global install is ' +
      'already covered by ~/.copilot/copilot-instructions.md',
    );
  } finally {
    cleanup(globalCwd);
    cleanup(globalConfigDir);
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-191-retire-sdk-package.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-191-retire-sdk-package (consolidation epic #1969 B5 #1974)", () => {
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const INSTALL_PATH = path.join(ROOT, 'bin', 'install.js');
const ACTIVE_GUIDANCE_PATHS = [
  'docs/contributing/bootstrap.md',
];

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

test('enhancement #191: sdk package artifacts are removed from repository layout', () => {
  const sdkDir = path.join(ROOT, 'sdk');
  const shimPath = path.join(ROOT, 'bin', 'gsd-sdk.js');

  assert.equal(fs.existsSync(sdkDir), false, 'sdk/ directory must be deleted');
  assert.equal(fs.existsSync(shimPath), false, 'bin/gsd-sdk.js must be deleted');
});

test('enhancement #191: published package no longer exposes gsd-sdk artifacts', () => {
  const pkg = readPackageJson();

  assert.equal(Object.prototype.hasOwnProperty.call(pkg.bin || {}, 'gsd-sdk'), false,
    'package.json bin must not expose gsd-sdk');
  assert.equal(pkg.bin && pkg.bin['gsd-tools'], 'gsd-core/bin/gsd-tools.cjs',
    'package.json bin.gsd-tools must point to gsd-core/bin/gsd-tools.cjs');

  const publishedFiles = Array.isArray(pkg.files) ? pkg.files : [];
  const hasSdkPublishedPaths = publishedFiles.some((entry) => String(entry).startsWith('sdk'));
  assert.equal(hasSdkPublishedPaths, false,
    'package.json files must not include sdk artifacts');
});

test('enhancement #191: installer does not maintain gsd-sdk shim compatibility path', () => {
  const installJs = fs.readFileSync(INSTALL_PATH, 'utf8');

  assert.equal(/\b--sdk\b/.test(installJs), false,
    'bin/install.js must not expose --sdk flag');
  assert.equal(/\b--no-sdk\b/.test(installJs), false,
    'bin/install.js must not expose --no-sdk flag');
  assert.equal(/installSdkIfNeeded\(\{/.test(installJs), false,
    'bin/install.js must not run installSdkIfNeeded during installation');
});

test('enhancement #191: active contributor guidance does not reference retired SDK build steps', () => {
  for (const relPath of ACTIVE_GUIDANCE_PATHS) {
    const body = fs.readFileSync(path.join(ROOT, relPath), 'utf8');

    assert.equal(
      /\bbuild:sdk\b|\bcd sdk\b|\bsdk\/dist\b|\bsdk\/src\b/.test(body),
      false,
      `${relPath} must not direct contributors or agents to use the retired SDK package workflow`,
    );
  }
});
  });
}

'use strict';
// allow-test-rule: structural-regression-guard (#1188)
// Guard-placement verification in bin/install.js requires source-text
// analysis; install.js is a non-exportable CLI script and the guard must be
// in a specific lexical scope which require()+behavior cannot verify.

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
const { runGit } = require('./helpers/process-seam.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

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

test('repo-layout: installer writes AGENTS.md only for local Copilot scope (not global), confirming the commit risk is scoped', () => {
  // Verify the installer source encodes the "!isGlobal" guard that restricts
  // AGENTS.md emission to local installs. If that guard were removed, the file
  // could be silently created in any directory the installer runs from,
  // including the repo root during development. This test is a static read of
  // the install source — it does not execute the installer.
  //
  // Why structural rather than a fixed-window regex: a 200-char sliding-window
  // regex between `if (!isGlobal)` and the assignment produces false failures
  // on semantically-equivalent refactors (early-return guards, added comments,
  // interposed conditions that push the tokens apart). The structural approach
  // instead verifies that the agentsMdPath assignment appears INSIDE the body
  // of the `if (!isGlobal)` block in the copilot-instructions surface handler
  // — which is the invariant that actually matters.
  const installJs = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');

  // Step 1: Locate the copilot-instructions surface block.
  const copilotBlockStart = installJs.indexOf("plan.installSurface === 'copilot-instructions'");
  assert.ok(
    copilotBlockStart !== -1,
    "bin/install.js must contain a 'copilot-instructions' surface handler; " +
    "the Copilot AGENTS.md guard lives inside it.",
  );

  // Step 2: Slice to the next installSurface branch so we don't accidentally
  // match tokens from a sibling surface handler.
  const nextSurface = installJs.indexOf('plan.installSurface ===', copilotBlockStart + 1);
  const copilotBlock = installJs.substring(
    copilotBlockStart,
    nextSurface > copilotBlockStart ? nextSurface : copilotBlockStart + 5000,
  );

  // Step 3: Find the `if (!isGlobal)` guard inside the copilot block.
  const guardIdx = copilotBlock.indexOf('if (!isGlobal)');
  assert.ok(
    guardIdx !== -1,
    'bin/install.js copilot-instructions surface handler must contain an `if (!isGlobal)` guard; ' +
    'removing that guard would allow a local Copilot install to silently create AGENTS.md ' +
    'in any working directory, including this repo checkout.',
  );

  // Step 4: Walk the brace tree to extract the body of the `if (!isGlobal)` block.
  const openBrace = copilotBlock.indexOf('{', guardIdx);
  assert.ok(openBrace !== -1, 'if (!isGlobal) guard must have an opening brace');
  let depth = 0;
  let i = openBrace;
  while (i < copilotBlock.length) {
    if (copilotBlock[i] === '{') depth++;
    else if (copilotBlock[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  const guardBody = copilotBlock.substring(openBrace, i + 1);

  // Step 5: Assert the repo-root AGENTS.md write site lives inside the guard body.
  assert.ok(
    guardBody.includes('agentsMdPath = path.join(process.cwd()'),
    'bin/install.js must assign `agentsMdPath = path.join(process.cwd(), ...)` INSIDE the ' +
    '`if (!isGlobal)` block in the copilot-instructions surface handler. ' +
    'If this assignment moves outside that block the installer would unconditionally create ' +
    'AGENTS.md in the working directory on every Copilot install, including repo-root runs.',
  );
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

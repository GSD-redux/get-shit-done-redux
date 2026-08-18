'use strict';

/**
 * Build a hermetic "cold tree" install fixture for #3582 — a copy of hooks/
 * plus gsd-core/bin/ensure-runtime-build.cjs with the compiled
 * gsd-core/bin/lib/*.cjs directory and tsconfig.build.json deliberately
 * ABSENT, mirroring a raw plugin-marketplace / git-clone install that never
 * ran `npm run build:lib`.
 *
 * Deliberately NOT `tests/helpers/copy-script-fixture.cjs`'s
 * `copyScriptWithDeps`: that helper walks the require graph and copies every
 * dependency it finds — including gsd-core/bin/lib/*.cjs, which exist in
 * THIS repo's already-built tree — so it would faithfully reproduce a WARM
 * tree, the opposite of what a cold-tree test needs. This helper copies only
 * hooks/ and the seam module itself, and never touches gsd-core/bin/lib/ or
 * tsconfig.build.json — so `ensureRuntimeBuild()` inside the fixture
 * deterministically throws `RuntimeBuildError` ("tsconfig.build.json not
 * found") the first time any fixture hook reaches it, without ever deleting
 * or touching the real repo's gsd-core/bin/lib/.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {(dir: string) => void} [t.after]  optional node:test `t` for auto-cleanup registration; caller may also ignore and use the returned `cleanup`.
 * @returns {{ dir: string, hooksDir: string, cleanup: () => void }}
 */
function buildColdInstallTree() {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-cold-tree-'));

  // hooks/ — entire directory (top-level hook scripts + hooks/lib/*.js +
  // managed-hooks-registry.cjs + hooks.json). hooks/dist/ (gitignored,
  // build-hooks.js output) is excluded — it is not present in a raw
  // marketplace checkout either.
  fs.cpSync(path.join(REPO_ROOT, 'hooks'), path.join(dir, 'hooks'), {
    recursive: true,
    filter: (src) => path.basename(src) !== 'dist',
  });

  // gsd-core/bin/ensure-runtime-build.cjs — the seam itself. Deliberately
  // NOT gsd-core/bin/lib/ (absent — isBuilt() reads false) and NOT
  // tsconfig.build.json at the fixture root (absent — ensureRuntimeBuild's
  // "cannot auto-build" branch fires deterministically).
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'),
    path.join(dir, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'),
  );

  function cleanup() {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }

  return { dir, hooksDir: path.join(dir, 'hooks'), cleanup };
}

module.exports = { buildColdInstallTree, REPO_ROOT };

'use strict';

/**
 * gen-context-index-fs-fixture.cjs — `--require` preload used to fixture-isolate
 * scripts/gen-context-index.cjs for integration tests.
 *
 * WHY THIS EXISTS: gen-context-index.cjs hardcodes CONTEXT_PATH and INDEX_PATH
 * to the real repo-root CONTEXT.md and the real committed
 * gsd-core/bin/lib/context-index.cjs (no --cwd flag, no env override). A
 * genuine CLI-integration test that mutates CONTEXT.md content, removes the
 * committed index, or corrupts it therefore has no fixture-tree seam to hook —
 * spawning the real script always touches the real repo files.
 *
 * This preload patches the three `node:fs` entry points the script's own
 * source calls directly (fs.readFileSync, fs.existsSync, fs.writeFileSync) so
 * that any read/write targeting the REAL absolute CONTEXT.md / context-index.cjs
 * paths is transparently redirected to fixture paths supplied via environment
 * variables. Every other path (e.g. the compiled context-predicates.cjs lib)
 * passes through untouched. The real CONTEXT.md and the real committed index
 * are NEVER read or written for their real content once a fixture path is set
 * for that seam — this is the "operate on a temp tree" contract for a
 * generator that has no --cwd flag of its own, verified empirically (see
 * tests/gen-context-index.test.cjs) that Node's CJS loader itself reads
 * `require()`-d `.cjs` source via the same patchable fs.readFileSync, so
 * `require(INDEX_PATH)` inside the script also observes the redirect.
 *
 * Env vars (both optional; absence means "do not touch that seam"):
 *   GSD_TEST_GCI_CONTEXT_MD  - absolute path to a fixture CONTEXT.md, or the
 *                              sentinel '__FAULT__' to make every read of the
 *                              real CONTEXT.md throw an injected EACCES error
 *                              (row F11 — never chmod 0o000, see CONTRIBUTING.md).
 *   GSD_TEST_GCI_INDEX       - absolute path to a fixture context-index.cjs.
 *                              May point at a path that does not exist on disk
 *                              (naturally reproduces "index missing", row F8)
 *                              or at a file with deliberately unparseable
 *                              content (row F9).
 *
 * Never used to redirect any path outside the exact two absolute constants
 * this module computes below — nothing else the target script touches is
 * intercepted.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_CONTEXT_PATH = path.join(REPO_ROOT, 'CONTEXT.md');
const REAL_INDEX_PATH = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'context-index.cjs');

const FAULT_SENTINEL = '__FAULT__';
const fixtureContextMd = process.env.GSD_TEST_GCI_CONTEXT_MD;
const fixtureIndex = process.env.GSD_TEST_GCI_INDEX;

const origReadFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(p, ...rest) {
  if (fixtureContextMd !== undefined && p === REAL_CONTEXT_PATH) {
    if (fixtureContextMd === FAULT_SENTINEL) {
      const err = new Error(`EACCES: permission denied, open '${p}' (injected by test fixture, never a real fs fault)`);
      err.code = 'EACCES';
      throw err;
    }
    return origReadFileSync.call(fs, fixtureContextMd, ...rest);
  }
  if (fixtureIndex !== undefined && p === REAL_INDEX_PATH) {
    return origReadFileSync.call(fs, fixtureIndex, ...rest);
  }
  return origReadFileSync.call(fs, p, ...rest);
};

const origExistsSync = fs.existsSync;
fs.existsSync = function patchedExistsSync(p) {
  if (fixtureIndex !== undefined && p === REAL_INDEX_PATH) {
    return origExistsSync.call(fs, fixtureIndex);
  }
  return origExistsSync.call(fs, p);
};

const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function patchedWriteFileSync(p, ...rest) {
  if (fixtureIndex !== undefined && p === REAL_INDEX_PATH) {
    return origWriteFileSync.call(fs, fixtureIndex, ...rest);
  }
  return origWriteFileSync.call(fs, p, ...rest);
};

module.exports = { REAL_CONTEXT_PATH, REAL_INDEX_PATH, FAULT_SENTINEL };

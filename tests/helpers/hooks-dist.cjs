'use strict';

/**
 * Ensure hooks/dist is populated before any suite that reads it.
 * hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
 * In CI the scoped/windows test jobs do NOT run build:hooks before running
 * tests, so the first test that needs hooks/dist would fail. This mirrors
 * the pattern used in bug-3357-codex-legacy-hooks-json-migration.test.cjs.
 *
 * Idempotent: only rebuilds when the directory is absent or empty of .js
 * files. Extracted from six behaviorally-identical copies that had
 * accumulated across tests/install.test.cjs (x2) and
 * tests/install-minimal-hooks.test.cjs (x4) — see #2704's Failure B, where a
 * seventh suite (tests/mcp-catalog-parity.install.test.cjs) needed the same
 * guard but had no copy of its own, and so failed only on lanes where no
 * other suite happened to build hooks/dist first.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./process-seam.cjs');
const { throwIfFailed } = require('./git-fixture.cjs');
const { BUILD_TIMEOUT_MS } = require('./timeouts.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter((f) => f.endsWith('.js')).length === 0) {
    throwIfFailed(runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }), `node ${BUILD_HOOKS_SCRIPT}`);
  }
}

module.exports = { ensureHooksDist, HOOKS_DIST_DIR, BUILD_HOOKS_SCRIPT };

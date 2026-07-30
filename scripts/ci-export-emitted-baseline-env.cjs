#!/usr/bin/env node
'use strict';

/**
 * ci-export-emitted-baseline-env.cjs — exports GSD_EMITTED_BASELINE for the
 * differential attribution check when its baseline cache was restored (#2724,
 * ADR-2719 §5).
 *
 * A plain `node <script>` invocation on purpose, not a shell script. The repo's H1
 * shell policy (scripts/workflow-policy.cjs) requires every CI step to run under its
 * job/matrix-declared NATIVE shell — pwsh on Windows, zsh on macOS (test-full's own
 * `shell: 'zsh {0}'`), bash on Linux — and a step that hardcodes `shell: bash`
 * violates that on the other two. A cross-platform Node script run via a bare
 * `node scripts/...` command line has no shell-specific syntax at all, so it is
 * valid unmodified under bash, zsh, AND pwsh — sidestepping the conflict instead of
 * picking one shell and being wrong on the other two.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_PATH = path.join(REPO_ROOT, '.gsd-cache', 'emitted-baseline.json');

/**
 * Decide whether a restored baseline may be published to `GSD_EMITTED_BASELINE`.
 *
 * IO is INJECTED (`readJson`) so every branch is unit-testable without touching the
 * filesystem — the same convention `tests/helpers/emitted-baseline.cjs` uses, and for
 * the same reason.
 *
 * @param {object}   opts
 * @param {string}   opts.cachePath   restored artifact path
 * @param {function} opts.readJson    (path) => parsed | null  (null when absent)
 * @returns {{export: boolean, reason: string}}
 */
function decideBaselineExport({ cachePath, readJson }) {
  let doc = null;
  try {
    doc = readJson(cachePath);
  } catch (err) {
    return { export: false, reason: `${cachePath}: unreadable — ${err.message}` };
  }

  if (doc === null || doc === undefined) {
    return { export: false, reason: `${cachePath}: absent (cache miss) — nothing to export` };
  }

  return { export: true, reason: `${cachePath}: present` };
}

function readJsonOrNull(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function main() {
  const githubEnv = process.env.GITHUB_ENV;

  const decision = decideBaselineExport({ cachePath: CACHE_PATH, readJson: readJsonOrNull });
  if (!decision.export) {
    console.log(`ci-export-emitted-baseline-env: ${decision.reason}`);
    return 0;
  }

  if (!githubEnv) {
    // Not fatal: running this locally or outside Actions should not break anything.
    console.log('ci-export-emitted-baseline-env: GITHUB_ENV not set — skipping export (not running under Actions?)');
    return 0;
  }

  fs.appendFileSync(githubEnv, `GSD_EMITTED_BASELINE=${CACHE_PATH}\n`, 'utf8');
  console.log(`ci-export-emitted-baseline-env: exported GSD_EMITTED_BASELINE=${CACHE_PATH}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { decideBaselineExport, CACHE_PATH };

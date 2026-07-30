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

const { validateBaseline } = require('../tests/helpers/emitted-baseline.cjs');
const { resolveBase } = require('../tests/helpers/emitted-runtime.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_PATH = path.join(REPO_ROOT, '.gsd-cache', 'emitted-baseline.json');

/**
 * Decide whether a restored baseline may be published to `GSD_EMITTED_BASELINE`.
 *
 * #2854: this step is the BOUNDARY, and it must be conservative in what it sends.
 * `GSD_EMITTED_BASELINE` is an operator pin — `resolveBaseline()` treats a mismatch
 * there as a hard stop, because "the operator said use this one". A cache restore is
 * not an operator, and the restore is keyed on the PR's RECORDED base sha while the
 * gate resolves the base ref LIVE, so the two drift whenever `next` advances between a
 * PR's last sync and its run. Publishing a drifted restore through the pin door turned
 * a recoverable cache into a fatal error on diffs that touched nothing related.
 *
 * Exporting only a baseline that is valid FOR THE SHA UNDER TEST keeps the fast path
 * intact and lets everything else fall through to `resolveBaseline()`'s cache branch,
 * which degrades to the in-job build exactly as ADR-2719 §5 specifies.
 *
 * Freshness is judged by `validateBaseline` rather than a local sha comparison, so the
 * staleness rule has one definition and cannot drift between the two surfaces.
 *
 * IO is INJECTED (`readJson`) so every branch is unit-testable without touching the
 * filesystem — the same convention `tests/helpers/emitted-baseline.cjs` uses, and for
 * the same reason.
 *
 * @param {object}   opts
 * @param {string}   opts.cachePath    restored artifact path
 * @param {string}   opts.expectedSha  the `next` sha this PR is evaluated against
 * @param {function} opts.readJson     (path) => parsed | null  (null when absent)
 * @returns {{export: boolean, reason: string}}
 */
function decideBaselineExport({ cachePath, expectedSha, readJson }) {
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    // No resolvable base sha means freshness is unprovable. Refusing is the safe
    // direction: the gate rebuilds in-job rather than trusting an unchecked artifact.
    return {
      export: false,
      reason: `base sha unresolved (${JSON.stringify(expectedSha)}) — freshness unprovable, not exporting`,
    };
  }

  let doc = null;
  try {
    doc = readJson(cachePath);
  } catch (err) {
    return { export: false, reason: `${cachePath}: unreadable — ${err.message}` };
  }

  if (doc === null || doc === undefined) {
    return { export: false, reason: `${cachePath}: absent (cache miss) — nothing to export` };
  }

  const verdict = validateBaseline(doc, expectedSha, cachePath);
  if (!verdict.ok) {
    return { export: false, reason: verdict.errors.join('; ') };
  }

  return { export: true, reason: `${cachePath}: valid for ${expectedSha}` };
}

function readJsonOrNull(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function main() {
  const githubEnv = process.env.GITHUB_ENV;

  // Same resolution the gate itself uses, so the sha this is validated against is the
  // sha the gate will compare with. A divergent lookup here would recreate the bug.
  const base = resolveBase();
  const decision = decideBaselineExport({
    cachePath: CACHE_PATH,
    expectedSha: base ? base.sha : null,
    readJson: readJsonOrNull,
  });
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

#!/usr/bin/env node
'use strict';

/**
 * gen-emitted-baseline.cjs — publishes the emitted-baseline artifact the
 * differential attribution check reads via `resolveBaseline()` (#2724, ADR-2719 §5).
 *
 * ## Why this exists
 *
 * Phase 3 (#2723) built `resolveBaseline()` (tests/helpers/emitted-baseline.cjs) and its
 * cache-key staleness discipline, but nothing produced the artifact it reads — the
 * dual-run window instead read the baseline straight off the committed golden fixtures
 * at the base ref (`baselineManifestsAtRef`). Phase 4 deletes those fixtures, so
 * something has to build and publish `{version, sha, manifests, sizes}` for real.
 *
 * ## What it does
 *
 * Builds the emitted manifest set (19 real installer spawns) and the workflow/agent size
 * maps for WHATEVER commit is currently checked out — this script does not know or care
 * whether that is `next` HEAD or a worktree checked out at an older ref; the caller
 * decides that by what it has checked out before running this script. Writes the result
 * to `--out <path>` (default `.gsd-cache/emitted-baseline.json`).
 *
 * ## Callers
 *
 *   1. CI's push-to-`next` job runs this straight after `next` advances, then uploads
 *      `.gsd-cache/emitted-baseline.json` as a cache entry keyed on the merge sha
 *      (.github/workflows/test.yml, `publish-emitted-baseline` job).
 *   2. `tests/emitted-attribution.test.cjs`'s real-tree test passes
 *      `buildBaselineAtRef` (tests/helpers/emitted-runtime.cjs) to `resolveBaseline()`
 *      as the `buildFallback` for a cache miss: it checks out `base` into a throwaway
 *      `git worktree`, symlinks in `node_modules` and runs `npm run build:lib` there
 *      (this script and the test helpers are Node-builtins-only per CONTRIBUTING.md's
 *      "No external dependencies in core", but `tests/helpers/install-shared.cjs`
 *      requires the TSC-compiled, gitignored `gsd-core/bin/lib/*.cjs`, so that one build
 *      step is unavoidable), spawns `node gen-emitted-baseline.cjs --out <tmp>` there,
 *      then reads the artifact back.
 *
 * Every git subprocess is bounded (CLAUDE.md → KNOWN DEFECTS: unbounded subprocesses
 * hang CI silently).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runMain, ExitError } = require('./lib/cli-exit.cjs');
const { BUILD_SCRIPT } = require('../tests/helpers/install-shared.cjs');
const { currentManifests, currentSizes } = require('../tests/helpers/emitted-runtime.cjs');
const { BASELINE_VERSION } = require('../tests/helpers/emitted-baseline.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.gsd-cache', 'emitted-baseline.json');
const GIT_TIMEOUT_MS = 30_000;

function resolveHeadSha(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else {
      throw new ExitError(2, `gen-emitted-baseline: unknown argument "${argv[i]}"`);
    }
  }
  if (!out || typeof out !== 'string') {
    throw new ExitError(2, 'gen-emitted-baseline: --out requires a path');
  }
  return { out: path.isAbsolute(out) ? out : path.join(process.cwd(), out) };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));

  const sha = resolveHeadSha(REPO_ROOT);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ExitError(1, `gen-emitted-baseline: HEAD did not resolve to a 40-hex sha: ${sha}`);
  }

  // hooks/dist is gitignored and built; a scoped CI checkout may not have run
  // build:hooks yet. Idempotent, mirrors the real-tree test.
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });

  const manifests = currentManifests();
  const sizes = currentSizes();

  const artifact = { version: BASELINE_VERSION, sha, manifests, sizes };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const familyCount = Object.keys(manifests).length;
  const sizeCount = Object.keys(sizes).length;
  process.stdout.write(
    `gen-emitted-baseline: wrote ${out} (sha=${sha.slice(0, 12)}, ${familyCount} families, ${sizeCount} sized files)\n`,
  );
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = { parseArgs, resolveHeadSha, DEFAULT_OUT };

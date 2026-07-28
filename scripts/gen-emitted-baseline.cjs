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
 * maps for the tree at `--dir <path>` (default: THIS script's own checkout — i.e.
 * whatever commit is currently checked out where `gen-emitted-baseline.cjs` itself
 * lives). Writes the result to `--out <path>` (default `.gsd-cache/emitted-baseline.json`).
 *
 * `--dir` decouples "which copy of this script runs" from "which tree gets measured"
 * (#2767). The MEASUREMENT SCHEMA — this script, and the `currentManifests`/
 * `currentSizes`/`buildParityManifest` functions it calls — always comes from wherever
 * `gen-emitted-baseline.cjs` itself is being run from (relative `require`s resolve
 * there); only the tree being measured (which `bin/install.js` gets spawned, which
 * `hooks/`/`gsd-core/workflows/`/`agents/` get read) moves to `--dir`. That is what lets
 * a differential apply ONE definition of "the emitted manifest" to two different
 * commits and stay comparable even as that definition evolves — see
 * `tests/helpers/emitted-runtime.cjs`'s `buildBaselineAtRef` for the caller that
 * exercises this for real, and why it must NOT run the `--dir` tree's own copy of this
 * script (which may be an older version, or — for any base ref that predates the PR
 * that added this script at all — may not exist there yet).
 *
 * ## Callers
 *
 *   1. CI's push-to-`next` job runs this straight after `next` advances (no `--dir`,
 *      measuring its own checkout), then uploads `.gsd-cache/emitted-baseline.json` as a
 *      cache entry keyed on the merge sha (.github/workflows/test.yml,
 *      `publish-emitted-baseline` job).
 *   2. `tests/emitted-attribution.test.cjs`'s real-tree test passes
 *      `buildBaselineAtRef` (tests/helpers/emitted-runtime.cjs) to `resolveBaseline()`
 *      as the `buildFallback` for a cache miss: it checks out `base` into a throwaway
 *      `git worktree`, symlinks in `node_modules` and runs `npm run build:lib` there
 *      (this script and the test helpers are Node-builtins-only per CONTRIBUTING.md's
 *      "No external dependencies in core", but `tests/helpers/install-shared.cjs`
 *      requires the TSC-compiled, gitignored `gsd-core/bin/lib/*.cjs`, so that one build
 *      step is unavoidable), then spawns THIS repo's OWN `gen-emitted-baseline.cjs`
 *      with `--dir <worktree> --out <tmp>` and reads the artifact back.
 *
 * Every git subprocess is bounded (CLAUDE.md → KNOWN DEFECTS: unbounded subprocesses
 * hang CI silently).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runMain, ExitError } = require('./lib/cli-exit.cjs');
const { BUILD_SCRIPT } = require('../tests/helpers/install-shared.cjs');
const { currentManifests, currentSizes, git } = require('../tests/helpers/emitted-runtime.cjs');
const { BASELINE_VERSION } = require('../tests/helpers/emitted-baseline.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.gsd-cache', 'emitted-baseline.json');

// Reuses emitted-runtime.cjs's `git()` (not a local execFileSync) so the
// `-c safe.directory=<dir>` fix for the remote runner's dubious-ownership
// mount (#2767) has exactly one source of truth — see that module's
// `safeDirArgs` doc comment.
function resolveHeadSha(cwd) {
  return git(['rev-parse', 'HEAD'], { cwd }).trim();
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let dir = REPO_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--dir') {
      dir = argv[i + 1];
      i++;
    } else {
      throw new ExitError(2, `gen-emitted-baseline: unknown argument "${argv[i]}"`);
    }
  }
  if (!out || typeof out !== 'string') {
    throw new ExitError(2, 'gen-emitted-baseline: --out requires a path');
  }
  if (!dir || typeof dir !== 'string') {
    throw new ExitError(2, 'gen-emitted-baseline: --dir requires a path');
  }
  return {
    out: path.isAbsolute(out) ? out : path.join(process.cwd(), out),
    dir: path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir),
  };
}

async function main() {
  const { out, dir } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(dir)) {
    throw new ExitError(1, `gen-emitted-baseline: --dir "${dir}" does not exist`);
  }

  const sha = resolveHeadSha(dir);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ExitError(1, `gen-emitted-baseline: HEAD of "${dir}" did not resolve to a 40-hex sha: ${sha}`);
  }

  // hooks/dist is gitignored and built; a scoped CI checkout may not have run
  // build:hooks yet. Idempotent, mirrors the real-tree test. Built INSIDE `dir` — the
  // MEASURED tree's own hooks/ source, not this script's — so a `--dir` pointed at a
  // different checkout (e.g. a base-ref worktree) reflects that checkout's hooks, not
  // the caller's. `dir === REPO_ROOT` (the default, no `--dir`) collapses to the
  // pre-#2767 behavior of building this own repo's hooks/dist.
  const buildScript = dir === REPO_ROOT ? BUILD_SCRIPT : path.join(dir, 'scripts', 'build-hooks.js');
  execFileSync(process.execPath, [buildScript], { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });

  // The measurement SCHEMA (currentManifests/currentSizes/buildParityManifest) is
  // always THIS script's own — only the tree being measured moves with `repoRoot`.
  const manifests = currentManifests({ repoRoot: dir });
  const sizes = currentSizes({ repoRoot: dir });

  const artifact = { version: BASELINE_VERSION, sha, manifests, sizes };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const familyCount = Object.keys(manifests).length;
  const sizeCount = Object.keys(sizes).length;
  process.stdout.write(
    `gen-emitted-baseline: wrote ${out} (dir=${dir}, sha=${sha.slice(0, 12)}, ${familyCount} families, ${sizeCount} sized files)\n`,
  );
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = { parseArgs, resolveHeadSha, DEFAULT_OUT, REPO_ROOT };

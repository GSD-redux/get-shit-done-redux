#!/usr/bin/env node
'use strict';

/**
 * gsd-pretest-baseline.cjs — the "gsd:pretest-baseline" project hook the
 * gsd-test-runner remote runner invokes (see `reporter/run-and-die.sh` in
 * open-gsd/gsd-test-runner) AFTER `npm ci`/`npm run build` and BEFORE the
 * watchdog handoff — i.e. entirely OUTSIDE the watchdog deadline (ADR-0021
 * Decision 1, gsd-test-runner).
 *
 * ## Why this exists
 *
 * `tests/emitted-attribution.test.cjs`'s differential-attribution gate needs an
 * emitted-baseline artifact built at the BASE ref (`resolveBaseline()`,
 * `tests/helpers/emitted-baseline.cjs`). GitHub CI publishes that artifact via
 * `actions/cache/save` (`.github/workflows/test.yml`'s `publish-emitted-baseline`
 * job) — a GitHub-Actions-only API the dockerized gsd-test remote runner cannot
 * reach. Absent a cache hit, `resolveBaseline()` falls back to an in-job build
 * (`buildBaselineAtRef`, `tests/helpers/emitted-runtime.cjs`): a `git worktree
 * add` + `npm run build:lib` + ~20 sequential installer spawns, run from INSIDE
 * the parallel `node --test` suite in the runner's `--cpus 2 --memory 2g`
 * container. That contention is what makes the in-job fallback slow/flaky there.
 *
 * Running the exact same build ONCE, SERIALLY, before the parallel suite starts
 * — on an otherwise-idle container with both CPUs to itself — is materially
 * faster and removes the contention. That is the entirety of what this script
 * does: it is a thin CLI wrapper around `buildBaselineAtRef`, not a second copy
 * of its procedure (a second copy is exactly the divergence class ADR-3180
 * exists to remove).
 *
 * ## THE correctness trap this script exists to avoid
 *
 * `gen-emitted-baseline.cjs --out ...` (no `--dir`) measures the CURRENT tree,
 * and CI only ever runs that form on `next`. Inside the remote-runner
 * container the checked-out tree is the BRANCH UNDER TEST, not the base. If
 * this script measured HEAD and published that as "the base ref's baseline",
 * the differential-attribution diff would come back EMPTY — a false pass that
 * is worse than the failure this script exists to avoid.
 *
 * This script NEVER measures HEAD. It always builds at `GSD_TEST_BASE_REF` via
 * `buildBaselineAtRef(ref, ...)`, which checks out a THROWAWAY `git worktree` at
 * `ref` and measures THAT — see that function's doc comment in
 * `tests/helpers/emitted-runtime.cjs` for the full mechanics. If
 * `GSD_TEST_BASE_REF` is unset, empty, or does not resolve, this script writes
 * NOTHING and exits 0 — `resolveBaseline()`'s existing in-job-build fallback
 * covers that case exactly as it does today.
 *
 * ## Failure posture
 *
 * This is pre-work, not a gate. It NEVER fails the run: every error path logs to
 * stderr and returns/exits 0. A pre-step that could abort `run-and-die.sh`
 * before a single test runs would be strictly worse than doing nothing and
 * letting `resolveBaseline()`'s documented fallback run in-job.
 *
 * The write to `.gsd-cache/emitted-baseline.json` is atomic (write to a
 * same-directory tmp file, then `fs.renameSync`) so a crash mid-write can never
 * leave `resolveBaseline()` reading a partial/corrupt file as "valid".
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { REPO_ROOT, git, buildBaselineAtRef } = require('../tests/helpers/emitted-runtime.cjs');
const { DEFAULT_CACHE_PATH } = require('../tests/helpers/emitted-baseline.cjs');

/**
 * Resolve `ref` to a 40-hex commit sha via `git rev-parse --verify`, or return
 * null. Mirrors `resolveBase()`'s own resolution check in emitted-runtime.cjs
 * (same command, same regex) without touching that function's env-derived
 * candidate list — that list answers a different question (what base is THIS
 * test run being evaluated against) than this script's (did the CALLER's
 * explicit `GSD_TEST_BASE_REF` resolve at all).
 */
function resolveRef(ref) {
  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function main() {
  const ref = process.env.GSD_TEST_BASE_REF;
  if (!ref || !ref.trim()) {
    process.stderr.write(
      'gsd:pretest-baseline: GSD_TEST_BASE_REF unset/empty; nothing to do '
      + '(resolveBaseline()\'s in-job-build fallback covers this).\n',
    );
    return;
  }

  const resolvedSha = resolveRef(ref);
  if (!resolvedSha) {
    process.stderr.write(
      `gsd:pretest-baseline: base ref "${ref}" (GSD_TEST_BASE_REF) did not resolve to a `
      + 'commit; skipping (the in-job-build fallback covers this).\n',
    );
    return;
  }

  let artifact;
  try {
    // buildBaselineAtRef checks out a THROWAWAY worktree AT ref and measures
    // THAT — never the caller's own working tree (see file doc above).
    artifact = buildBaselineAtRef(ref, { cwd: REPO_ROOT });
  } catch (err) {
    process.stderr.write(
      `gsd:pretest-baseline: buildBaselineAtRef("${ref}") failed: `
      + `${err && err.stack ? err.stack : err}\n`,
    );
    return;
  }

  const outPath = path.join(REPO_ROOT, DEFAULT_CACHE_PATH);
  const tmpPath = path.join(
    path.dirname(outPath),
    `.emitted-baseline.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
  );
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    // Same-directory rename is atomic on the filesystems this ever runs on
    // (POSIX rename(2) within one filesystem): resolveBaseline() can never
    // observe a partially-written file at outPath.
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    process.stderr.write(
      `gsd:pretest-baseline: writing ${outPath} failed: ${err && err.stack ? err.stack : err}\n`,
    );
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup; never mask the primary error above */
    }
    return;
  }

  process.stderr.write(
    `gsd:pretest-baseline: wrote ${outPath} (ref=${ref}, sha=${resolvedSha.slice(0, 12)})\n`,
  );
}

// No runMain/ExitError here (scripts/lib/cli-exit.cjs): this hook's contract is
// "never fail the run" (see file doc above), which is the opposite of
// cli-exit.cjs's generic-error -> exit(1) behavior. Every failure path inside
// main() above already logs + returns; this outer try/catch is the backstop
// for a genuinely unexpected throw (a bug in this script), and it degrades
// exactly the same way: log, exit 0.
try {
  main();
} catch (err) {
  process.stderr.write(
    `gsd:pretest-baseline: unexpected error (ignored, exiting 0): `
    + `${err && err.stack ? err.stack : err}\n`,
  );
}
process.exitCode = 0;

module.exports = { resolveRef, main };

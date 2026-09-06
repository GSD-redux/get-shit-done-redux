/**
 * Tests for the atomic cache publish in gsd-check-update-worker.js (#4091).
 *
 * Background (issue #4091):
 *   The worker used to write its result cache in place
 *   (`fs.writeFileSync(cacheFile, ...)`), which truncates before writing. The
 *   cache file is deliberately per-PACKAGE (#607/#1421), so on a machine with
 *   several runtimes (Claude Code + Codex + Cursor, ...) every runtime's
 *   SessionStart worker writes the SAME file while every statusline/banner
 *   refresh reads it. A reader landing mid-write saw an empty or truncated
 *   record; the readers' JSON.parse catch swallowed it, so the symptom was an
 *   intermittently blank update segment.
 *
 * The fix publishes via write-temp-then-rename — rename(2) over a file in the
 * same directory is atomic, so readers see either the old or the new record,
 * never a torn one.
 *
 * Source-grep policy: the torn write is a concurrency defect that cannot be
 * observed on POSIX CI without a genuine multi-process race (forbidden by
 * repo test rules), so the contract is asserted structurally on the write
 * shape — same policy as the #3103 platform-gate tests in
 * gsd-check-update-worker-platform-gate.test.cjs (structural-regression-guard).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { NPM_VIEW_TIMEOUT_MS } = require('../gsd-core/bin/check-latest-version.cjs');

const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');

// #4091/2026-09-06 Windows CI incident: the worker's real `npm view` call
// (checkLatestVersion, gsd-core/bin/check-latest-version.cjs) is bounded at
// NPM_VIEW_TIMEOUT_MS. This outer test harness timeout used to be hardcoded
// to the SAME 15000ms, so a slow registry response raced two SIGKILLs at the
// exact same wall-clock instant: the worker's own inner npm-view timeout
// fires and it needs real time to catch that failure, build a degraded
// result, and atomically publish the cache — but the outer harness could
// kill the whole process tree first (exitCode: null, empty stderr) before
// the worker ever got the chance. Windows's shell-wrapped npm subprocess
// (cmd.exe wrapper, see src/shell-command-projection.cts) adds enough spawn
// overhead to make this race lose more often there, but the zero-margin race
// itself is platform-agnostic. This margin gives the worker real headroom
// beyond the inner timeout it wraps.
const WORKER_TEARDOWN_MARGIN_MS = 10_000;

// allow-test-rule: structural-regression-guard (#4091)
// Feeds the real worker source (readFileSync) into the structural assertions
// below. The behavior it guards — rename-atomic publish of a file shared
// across runtime processes — needs a multi-process race to observe, which
// repo test rules forbid, so a structural assertion on the write shape is
// the minimum-cost contract (same policy as the #3103 platform gate).
function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own bounded hooks source, not adversarial input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own hooks source, not adversarial input
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
}

describe('gsd-check-update-worker.js: atomic cache publish (#4091)', () => {
  test('worker must not write the shared cache file in place', () => {
    const src = codeOnly(WORKER_PATH);
    // The only legitimate direct write target is a temp stage; the cache file
    // itself must never be the writeFileSync destination.
    assert.ok(
      !/writeFileSync\(\s*cacheFile\b/.test(src),
      'writeFileSync(cacheFile, ...) truncates the shared per-package cache in place; ' +
        'concurrent readers see a torn/empty record (#4091). Stage a temp file and rename it.',
    );
  });

  test('worker publishes the cache via rename-atomic replace (torn-write guard #4091)', () => {
    const src = codeOnly(WORKER_PATH);
    // Stage: write a unique temp derived from cacheFile (same directory =>
    // same filesystem => POSIX rename(2) atomicity).
    assert.match(
      src,
      /const\s+\w+\s*=\s*cacheFile\s*\+\s*['"][^'"]*tmp[^'"]*['"]/,
      'cache publish must stage a temp path derived from cacheFile (same-directory rename is atomic)',
    );
    // Publish: renameSync(tmp, cacheFile).
    assert.match(
      src,
      /renameSync\(\s*\w+\s*,\s*cacheFile\s*\)/,
      'cache publish must rename the staged temp into place, never write the cache file directly',
    );
  });

  test('temp stage path is same-directory by construction', () => {
    const src = codeOnly(WORKER_PATH);
    // A cross-filesystem temp (os.tmpdir()) would make the rename non-atomic
    // (copy+unlink fallback on some platforms) — rejected in #4091 diagnosis.
    assert.ok(
      !/os\.tmpdir\(\)/.test(src),
      'temp stage must be derived from cacheFile (same directory), not os.tmpdir()',
    );
    assert.match(
      src,
      /cacheFile\s*\+\s*['"][^'"]*['"]\s*\+\s*process\.pid/,
      'temp stage name must be unique per process (process.pid) so concurrent workers never share a stage path',
    );
  });

  // Behavioral end-to-end: the worker (run as a real child process, same seam
  // as the #3582 cold-tree test) must leave a parseable cache and no temp
  // residue. Guards the happy path of the rename publish.
  test('worker run leaves a valid cache and no temp residue', (t) => {
    const cacheDir = createTempDir('gsd-worker-atomic-');
    t.after(() => cleanup(cacheDir));
    const cacheFile = path.join(cacheDir, 'cache.json');
    // Pre-existing record from "another runtime" — the rename must replace it,
    // not truncate it (readers between runs always see a complete record).
    fs.writeFileSync(cacheFile, JSON.stringify({ update_available: false, installed: '0.0.1', latest: 'unknown', checked: 1, package_name: null }), 'utf8');

    const env = {
      ...process.env,
      GSD_CACHE_FILE: cacheFile,
      GSD_PROJECT_VERSION_FILE: path.join(cacheDir, 'no-such-project', 'VERSION'),
      GSD_GLOBAL_VERSION_FILE: path.join(cacheDir, 'no-such-global', 'VERSION'),
    };
    const r = runHookSeam(WORKER_PATH, [], { env, timeoutMs: NPM_VIEW_TIMEOUT_MS + WORKER_TEARDOWN_MARGIN_MS });
    assert.equal(r.exitCode, 0, `worker must exit 0; stderr: ${r.stderr}`);
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(cache.installed, '0.0.0', 'worker record replaced the pre-existing one');
    const residue = fs.readdirSync(cacheDir).filter((f) => f.startsWith('cache.json.tmp') || f.includes('.tmp-'));
    assert.deepEqual(residue, [], 'no temp stage files may remain after a successful publish');
  });

  test('outer worker-run timeout keeps real margin beyond the inner npm-view timeout (#4091 exact-tie race)', () => {
    assert.ok(
      WORKER_TEARDOWN_MARGIN_MS >= 5000,
      'the outer test timeout must give the worker real margin beyond the inner npm-view ' +
        'timeout (NPM_VIEW_TIMEOUT_MS) it wraps, or a slow registry response races the two ' +
        'SIGKILLs (see #4091/2026-09-06 Windows CI incident: exact-tie timeout killed the worker ' +
        'before it could degrade gracefully)',
    );
    assert.ok(
      NPM_VIEW_TIMEOUT_MS + WORKER_TEARDOWN_MARGIN_MS > NPM_VIEW_TIMEOUT_MS,
      'the combined outer timeout must strictly exceed the inner npm-view timeout it wraps',
    );
  });
});

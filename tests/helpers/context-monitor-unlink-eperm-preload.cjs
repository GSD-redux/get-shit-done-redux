'use strict';

/**
 * Preload fixture for #3709 review Blocker 2 — force `fs.unlinkSync` to throw
 * EPERM inside the SPAWNED gsd-context-monitor.js hook, so the PreCompact
 * unlink-failure fallback branch is actually executed.
 *
 * `GSD_TEST_UNLINK_EPERM_MATCH` selects WHICH unlink fails: any path containing
 * the substring throws EPERM; every other path unlinks for real. That lets one
 * row fail only the warn sentinel (`-warned.json`) and another only the metrics
 * bridge, so each half of the fallback is pinned separately.
 *
 * Loaded via `node --require <this file> hooks/gsd-context-monitor.js` — the
 * same seam as `shadow-report-throws-preload.cjs`, and for the same reasons:
 * this is NOT a chmod/mode-bit trick (CONTRIBUTING.md: those no-op under root,
 * so Docker/CI would pass the test with zero coverage), and NOT the in-process
 * `withFaultyFs` seam (in-process-only — a spawned subprocess offers no shared
 * memory to monkeypatch into). One-shot subprocess: no restoration needed.
 */

const fs = require('fs');

const realUnlinkSync = fs.unlinkSync;
const match = process.env.GSD_TEST_UNLINK_EPERM_MATCH || '';

if (match) {
  fs.unlinkSync = function unlinkSyncWithInjectedEperm(p) {
    if (String(p).includes(match)) {
      const err = new Error(`EPERM: operation not permitted, unlink '${p}'`);
      err.code = 'EPERM';
      throw err;
    }
    return realUnlinkSync.apply(fs, arguments);
  };
}

// `GSD_TEST_LSTAT_CLAIMS_FILE_MATCH`: make lstat CLAIM a regular file for
// matching paths — the lstat→open substitution-race shape (a symlink swapped in
// after the lstat), so the O_NOFOLLOW backstop is the guard actually under test
// (review of #3808, round 3, Minor 3). The real stat object is returned with
// only isFile overridden; everything else stays truthful.
const lstatMatch = process.env.GSD_TEST_LSTAT_CLAIMS_FILE_MATCH || '';

if (lstatMatch) {
  const realLstatSync = fs.lstatSync;
  fs.lstatSync = function lstatSyncClaimingFile(p) {
    const st = realLstatSync.apply(fs, arguments);
    if (String(p).includes(lstatMatch)) {
      st.isFile = () => true;
      // Engagement marker: without it, a match string that silently stops
      // matching lets the REAL lstat refuse the symlink and every assertion
      // in the substitution-race row still passes — without O_NOFOLLOW ever
      // being the guard under test (Codex review of #3808, round 3). The row
      // asserts this file exists.
      try {
        fs.writeFileSync(`${p}.gsd-test-lstat-claimed`, '1');
      } catch { /* marker is best-effort; the row will fail loudly without it */ }
    }
    return st;
  };
}

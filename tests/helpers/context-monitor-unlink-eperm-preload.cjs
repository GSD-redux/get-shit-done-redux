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

fs.unlinkSync = function unlinkSyncWithInjectedEperm(p) {
  if (match && String(p).includes(match)) {
    const err = new Error(`EPERM: operation not permitted, unlink '${p}'`);
    err.code = 'EPERM';
    throw err;
  }
  return realUnlinkSync.apply(fs, arguments);
};

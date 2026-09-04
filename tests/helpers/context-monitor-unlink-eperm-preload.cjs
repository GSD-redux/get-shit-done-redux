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

// `GSD_TEST_SHRINK_AFTER_LSTAT_MATCH`: TRUNCATE a matching file immediately after
// `lstatSync` has measured it, so the subsequent `readSync` returns FEWER bytes than
// the size the guard allocated for. That is the shape round 11's Minor names — a
// concurrent legitimate writer truncating mid-write, independent of the planted-object
// case the rest of readSentinel guards — and it cannot be produced by ordinary file
// setup, because the shrink has to land inside the window between the two calls.
//
// Layered over the lstat wrapper above rather than folded into it: the two injections
// are selected by different env vars and a row may want either alone.
const shrinkMatch = process.env.GSD_TEST_SHRINK_AFTER_LSTAT_MATCH || '';

if (shrinkMatch) {
  const beforeShrink = fs.lstatSync;
  fs.lstatSync = function lstatSyncThenShrink(p) {
    const st = beforeShrink.apply(fs, arguments);
    if (String(p).includes(shrinkMatch) && st.isFile() && st.size > 1) {
      // Truncate to a single byte: the read still succeeds, it just returns 1 instead
      // of `st.size`, which is exactly the short read the guard must refuse.
      //
      // Engagement marker, same reason as the lstat-claim one above and learned the same way:
      // the hook REWRITES this sentinel later in the same invocation, so a row that checked the
      // file's size afterwards would see it back at full length and pass whether the truncation
      // landed or not. The marker is the only durable evidence that this injection fired.
      try {
        fs.truncateSync(p, 1);
        fs.writeFileSync(`${p}.gsd-test-shrunk`, '1');
      } catch { /* best effort — the row asserts the marker and fails loudly without it */ }
    }
    return st;
  };
}

// `GSD_TEST_SHORT_WRITE_MATCH`: make `fs.writeSync` write only the FIRST BYTE for a
// matching fd's payload, once. A short write is permitted by the syscall and was
// previously discarded, so a truncated sentinel reached disk and every later read
// rejected it — the debounce accounting and the compaction watermark silently lost.
// The injection fires once so the retry loop under test can complete normally.
const shortWriteMatch = process.env.GSD_TEST_SHORT_WRITE_MATCH || '';

if (shortWriteMatch) {
  const realWriteSync = fs.writeSync;
  let fired = false;
  fs.writeSync = function writeSyncShort(fd, buf, off, len) {
    if (!fired && Buffer.isBuffer(buf) && len > 1) {
      fired = true;
      try { fs.writeFileSync(`${shortWriteMatch}.gsd-test-short-write`, '1'); } catch { /* marker best effort */ }
      return realWriteSync.call(fs, fd, buf, off, 1);
    }
    return realWriteSync.apply(fs, arguments);
  };
}


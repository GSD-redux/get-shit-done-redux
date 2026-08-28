'use strict';

/**
 * Preload fixture for #3808 — pin the SPAWNED context-monitor hook's
 * `Date.now()` to `GSD_TEST_NOW_MS`, so any wall-clock boundary can be driven
 * at exactly limit-1 / limit / limit+1. Added for STALE_SECONDS (review round 3,
 * Major 2); now also drives AC2, AC3, the COMPACT_GRACE_SECONDS trio and the
 * WATERMARK_SKEW_SECONDS trio, which is what lets those rows use the real
 * writer's timestamp shape instead of a future stamp (round 4, Major 1).
 *
 * Without this, the age of a bridge written by the parent drifts by however
 * long the child takes to start: a fixture built at age 60 can be read at 61
 * and flip the row's verdict — the boundary is REAL wall-clock. Pinning the
 * child's clock makes the arithmetic exact. Same `--require` seam as the
 * EPERM preload; one-shot subprocess, no restoration needed. Only Date.now is
 * patched — `new Date()` stays real, which is fine: the hook uses it only to
 * render a date string inside the breadcrumb text, never for comparisons.
 */

const fixed = Number(process.env.GSD_TEST_NOW_MS || '');

if (Number.isFinite(fixed) && fixed > 0) {
  Date.now = () => fixed;
}

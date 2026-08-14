'use strict';
// allow-test-rule: architectural-invariant (see #1531)
// writeStateMd's "scan happens INSIDE the lock" property is a concurrency invariant.
// A single-threaded test cannot observe the difference between scan-before-lock and
// scan-after-lock unless something mutates the disk in the window between the two.
// The afterAcquire test hook (fired inside writeStateMd right after the lock is
// taken) is the deterministic seam that simulates a concurrent writer landing in
// exactly that window — the only level at which the TOCTOU is observable.

/**
 * M8 — writeStateMd scans the disk (syncStateFrontmatter / PLAN-SUMMARY count)
 * BEFORE taking the lock, so a concurrent writer that commits a new PLAN/SUMMARY
 * between our scan and our lock acquisition makes writeStateMd stamp STALE
 * progress counts (a lost-update of the frontmatter progress block).
 * readModifyWriteStateMd (the atomic variant) correctly scans INSIDE its lock —
 * this non-atomic variant was the outlier.
 *
 * Deterministic repro (no wall-clock, no threads): the afterAcquire test hook
 * fires inside writeStateMd immediately after the lock is acquired and adds a
 * second PLAN file to the phase dir — simulating a concurrent writer who landed
 * in the scan→lock window. The written frontmatter's progress.total_plans then
 * reveals whether the scan ran before the hook (stale: 1) or after it (fresh: 2).
 *
 * RED  (pre-fix):  scan runs BEFORE acquire → before the hook → total_plans = 1.
 * GREEN (post-fix): scan runs AFTER acquire → after the hook  → total_plans = 2.
 *
 * Recurring closed family this guards: #500 / #905 / #1230 (STATE.md write
 * corruption). #453 deleted the flaky race tests in favor of seams, so this exact
 * path was under-tested — the hook restores deterministic coverage.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const stateMod = require('../gsd-core/bin/lib/state.cjs');
const { writeStateMd } = stateMod;
const { cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAL_STATE_MD = [
  '# Project State',
  '',
  '**Status:** Planning',
  '**Current Phase:** 01',
].join('\n') + '\n';

/** Parse progress.total_plans out of the STATE.md frontmatter block. */
function readTotalPlans(statePath) {
  const written = fs.readFileSync(statePath, 'utf-8');
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses STATE.md this test just wrote via a fixture, fixed-size test-controlled content
  const fmMatch = written.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fmMatch, 'STATE.md must have a frontmatter block after writeStateMd');
  const m = fmMatch[1].match(/total_plans:\s*(\d+)/);
  assert.ok(m, 'frontmatter must carry a progress.total_plans line');
  return parseInt(m[1], 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// M8 — afterAcquire hook proves the scan runs INSIDE the lock
// ─────────────────────────────────────────────────────────────────────────────

describe('M8: writeStateMd scans disk AFTER acquiring the lock (scan-in-lock)', () => {
  let tmpDir;
  let statePath;
  let phaseDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-m8-'));
    const planningDir = path.join(tmpDir, '.planning');
    phaseDir = path.join(planningDir, 'phases', '01-init');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Start with exactly ONE plan file on disk.
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '# Plan 01\n');
    statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, MINIMAL_STATE_MD);
  });

  afterEach(() => {
    stateMod._resetStateLockTestHooks();
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('a PLAN added in the post-acquire window is reflected in the written progress count', () => {
    // The hook simulates a concurrent writer who commits a second PLAN file in the
    // window between scan and lock. It MUST be observed only if the scan runs after
    // the lock (and therefore after this hook fires).
    let fired = 0;
    stateMod._setStateLockTestHooks({
      afterAcquire() {
        fired++;
        fs.writeFileSync(path.join(phaseDir, '02-PLAN.md'), '# Plan 02\n');
      },
    });

    writeStateMd(statePath, MINIMAL_STATE_MD, tmpDir);

    assert.equal(fired, 1, 'afterAcquire hook must fire exactly once inside writeStateMd');

    const totalPlans = readTotalPlans(statePath);
    // RED pre-fix: scan ran before the hook → counts only 01-PLAN.md → 1.
    // GREEN post-fix: scan ran after the hook → counts both PLANs → 2.
    assert.equal(
      totalPlans, 2,
      'writeStateMd must scan the disk INSIDE the lock (after the concurrent ' +
      'writer landed), stamping total_plans=2 — not the stale pre-lock count of 1'
    );
  });

  test('single-threaded callers (no hook) are byte-for-behaviour unchanged: count = 1', () => {
    // Regression guard: with no concurrent writer (hook unset), the count must be
    // exactly the on-disk truth — the fix must NOT change the uncontended result.
    writeStateMd(statePath, MINIMAL_STATE_MD, tmpDir);
    assert.equal(
      readTotalPlans(statePath), 1,
      'uncontended writeStateMd must stamp the real on-disk plan count (1)'
    );
  });
});

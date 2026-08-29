'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #1883 regression coverage on the LIVE path (#3813 re-point).
//
// The original #1883 suite asserted EACCES/EIO propagation on
// verify.cts's listMilestoneArchiveDirs — which lost its last production
// caller in Phase 12 (#3310) and survived only as a test seam, so the
// suite guarded dead code while the LIVE archived-phase enumeration
// (planning-snapshot.cts's buildArchivedPhaseTokensField) answered the
// same contract with a different, deliberate shape: a non-ENOENT
// milestones/ read failure yields scope UNREADABLE — never a silent
// COMPLETE "no archives". This suite pins the live shape.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildPlanningSnapshot } = require('../gsd-core/bin/lib/planning-snapshot.cjs');

function fsError(code, targetPath) {
  const err = new Error(`${code}: operation failed. scandir '${targetPath}'`);
  err.code = code;
  err.syscall = 'scandir';
  err.path = targetPath;
  return err;
}

// Inject a readdirSync fault scoped to the milestones/ path under test.
// t.mock auto-restores after each test — no chmod 0o000 (root bypasses mode bits).
function injectMilestonesFault(t, code, targetPath) {
  const originalReaddirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith(path.join('milestones'))) {
      throw fsError(code, targetPath);
    }
    return originalReaddirSync.call(this, p, ...rest);
  });
}

function scopeOf(snapshot) {
  const field = snapshot && snapshot.fields && snapshot.archivedPhaseTokens;
  return field ? field.scope : undefined;
}

describe('#1883 (live path, #3813): an unreadable milestones/ dir is UNREADABLE, never silent emptiness', () => {
  test('a permission (EACCES) failure yields scope UNREADABLE, not COMPLETE', (t) => {
    const planBase = path.join(os.tmpdir(), 'gsd-1883live-eacces-' + process.pid);
    injectMilestonesFault(t, 'EACCES', path.join(planBase, 'milestones'));
    const snap = buildPlanningSnapshot(planBase);
    assert.equal(
      scopeOf(snap),
      'unreadable',
      '#1883/#3813: an unreadable milestones/ dir must never read as genuine absence (COMPLETE)',
    );
  });

  test('any non-ENOENT failure (EIO) yields scope UNREADABLE', (t) => {
    const planBase = path.join(os.tmpdir(), 'gsd-1883live-eio-' + process.pid);
    injectMilestonesFault(t, 'EIO', path.join(planBase, 'milestones'));
    const snap = buildPlanningSnapshot(planBase);
    assert.equal(scopeOf(snap), 'unreadable', 'every non-ENOENT error must flag UNREADABLE');
  });

  test('an absent milestones/ dir (ENOENT) is a genuine empty: COMPLETE + []', () => {
    const planBase = path.join(os.tmpdir(), 'gsd-1883live-absent-' + process.pid);
    const snap = buildPlanningSnapshot(planBase);
    const field = snap.archivedPhaseTokens;
    assert.equal(field.scope, 'complete', 'genuine absence stays COMPLETE');
    assert.deepEqual(field.value, [], 'genuine absence yields no archived tokens');
  });
});

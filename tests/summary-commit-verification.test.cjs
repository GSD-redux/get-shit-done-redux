'use strict';

/**
 * #3968 — commit claims must be measured, never narrated.
 *
 * Across 14 plans / 3 phases in a real project, `commits: 1` appeared in every
 * SUMMARY while `git reflog` showed ZERO git activity in the window, and
 * HANDOFF.json asserted `uncommitted_files: []` over a dirty tree — invisible
 * because nothing downstream cross-checks the narration against git. The fix
 * (maintainer decision, option c) spans three shipped surfaces; their text IS
 * the runtime-loaded contract, so shape assertions are the faithful check.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('#3968 — measured commit claims', () => {
  test('executor measures commits, never narrates them', () => {
    const executor = read('agents/gsd-executor.md');
    // The ledger: HEAD captured at the plan's first commit, once per plan.
    assert.ok(executor.includes('PLAN_HEAD_BEFORE'),
      'the commit protocol must capture the pre-plan HEAD (PLAN_HEAD_BEFORE)');
    assert.ok(executor.includes('git rev-list --count'),
      'the SUMMARY commit count must come from git rev-list --count, not narration');
    // A measured zero WITH code changes is a HALT, never a narrated success.
    assert.ok(/HALT — do not\s+write the SUMMARY/i.test(executor),
      'a measured zero with uncommitted code changes must halt the SUMMARY write');
    // actuals.commits sources the same measured number (ADR-2629 shape kept).
    assert.ok(executor.includes('actuals'),
      'the actuals block is still present (calibration shape preserved)');
  });

  test('verify-work flags SUMMARY-vs-git mismatch as BLOCKER', () => {
    const verify = read('gsd-core/workflows/verify-work.md');
    assert.ok(verify.includes('Commit-claim reconciliation'),
      'verify-work must run a commit-claim reconciliation over each SUMMARY');
    assert.ok(verify.includes('git rev-list --count'),
      'the reconciliation compares the claimed count against rev-list');
    assert.ok(/BLOCKER/.test(verify.slice(verify.indexOf('Commit-claim reconciliation'), verify.indexOf('Commit-claim reconciliation') + 1800)),
      'a mismatch must be flagged BLOCKER — the phase must not read as done');
  });

  test('HANDOFF uncommitted_files come from git status --porcelain', () => {
    const pause = read('gsd-core/workflows/pause-work.md');
    assert.ok(pause.includes('git status --porcelain'),
      'uncommitted_files must be populated from an actual git status --porcelain call');
    // The asserted-empty template literal is gone as the only source.
    const idx = pause.indexOf('uncommitted_files');
    assert.ok(idx === -1 || /porcelain/.test(pause.slice(Math.max(0, idx - 3000), idx + 3000)),
      'the uncommitted_files field is defined by the porcelain command, not a narrated []');
  });
});

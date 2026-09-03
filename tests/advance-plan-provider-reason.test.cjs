'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3830 — `resolvePlanSetForPhase`'s abstention reasons must describe the
// enumeration the function actually performs.
//
// The provider reads the phases directory RAW — no milestone window, no
// sentinel filter — so that it selects the same directory `query
// phase-plan-index` selects. Its no-match reason nevertheless still said
// "not found among current-milestone phases", naming a scope that had been
// removed from the very same commit that rewrote the docblock and CLI-TOOLS.md
// prose for exactly this class of staleness.
//
// `advancePlanCore` branches on `.ok` and never reads `.reason`, so nothing in
// production surfaces this string today. That is precisely why it needs a test:
// an unread field has no other reader to notice when it goes stale, and the
// next caller to wire it into a log or an error surface inherits whatever it
// last said.
//
// Reaching it needs the transition seam rather than the CLI, because the
// provider closure is built inside `cmdStateAdvancePlan` and its result is
// consumed and discarded there. `state.cjs` DESTRUCTURES `transitionCore` at
// load time, so the stub has to be installed BEFORE `state.cjs` is required —
// hence the cache purge below, and hence this being its own file: a fresh
// `state.cjs` in a shared process would outlive the test that made it.
// ─────────────────────────────────────────────────────────────────────────────

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const TRANSITION_PATH = require.resolve(path.join(LIB, 'state-transition.cjs'));
const STATE_PATH = require.resolve(path.join(LIB, 'state.cjs'));

function writeState(tmpDir, phaseLine) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    [
      '# Project State',
      '',
      '## Current Position',
      '',
      phaseLine,
      'Plan: 1 of 3',
      'Status: Ready to execute',
      'Last Activity: 2026-08-01',
      '',
    ].join('\n'),
  );
}

// Run `state advance-plan` with `transitionCore` stubbed, and return whatever
// the real provider answered for the phase `## Current Position` names.
function captureProviderResult(tmpDir) {
  const realTransition = require(TRANSITION_PATH);
  const savedTransition = require.cache[TRANSITION_PATH];
  const savedState = require.cache[STATE_PATH];

  let captured = null;
  require.cache[TRANSITION_PATH] = {
    ...savedTransition,
    exports: {
      ...realTransition,
      // The dep object is the THIRD argument — (content, intent, deps).
      transitionCore: (content, _intent, deps) => {
        captured = deps.planSetProvider ? deps.planSetProvider() : null;
        return { content, updated: [], data: { advanced: false } };
      },
    },
  };
  delete require.cache[STATE_PATH];

  try {
    require(STATE_PATH).cmdStateAdvancePlan(tmpDir, true);
  } finally {
    require.cache[TRANSITION_PATH] = savedTransition;
    if (savedState) { require.cache[STATE_PATH] = savedState; } else { delete require.cache[STATE_PATH]; }
  }
  return captured;
}

describe('#3830: resolvePlanSetForPhase reasons describe the enumeration it performs', () => {
  let tmpDir;

  const seedUnrelatedPhase = () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\nstatus: complete\n---\n# Plan\n');
  };

  test('a phase with no directory reports absence from DISK, not from a milestone', () => {
    tmpDir = createTempProject();
    try {
      seedUnrelatedPhase();
      // Phase 99 exists in the prose and nowhere on disk. The enumeration is a
      // raw listing, so "absent" here means absent from every phase directory —
      // not absent from a milestone window this function no longer consults.
      writeState(tmpDir, 'Phase: 99 (Absent Phase) — EXECUTING');

      const result = captureProviderResult(tmpDir);

      assert.ok(result, 'the provider must have been built and called for a parseable phase');
      assert.strictEqual(result.ok, false, `an absent phase is an abstention; got ${JSON.stringify(result)}`);
      assert.match(result.reason, /not found among the phase directories on disk/,
        `the reason must describe the raw listing this function reads; got ${JSON.stringify(result.reason)}`);
      assert.doesNotMatch(result.reason, /milestone/i,
        'the enumeration is not milestone-scoped, so no reason of this function may say it is');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('the control: a phase that IS on disk resolves rather than abstaining', () => {
    tmpDir = createTempProject();
    try {
      seedUnrelatedPhase();
      writeState(tmpDir, 'Phase: 01 (Demo Phase) — EXECUTING');

      const result = captureProviderResult(tmpDir);

      // Not a guard against "the provider never ran" — the first test already
      // rules that out, by requiring a non-null result AND an exact string. What
      // this pins is the other half: that the no-match branch is reached because
      // the phase is genuinely absent, and not because this fixture cannot resolve
      // ANY phase. A provider that abstained unconditionally would satisfy the
      // first test and fail here.
      assert.ok(result, 'the provider must have been built and called');
      assert.strictEqual(result.ok, true, `phase 01 is on disk and must resolve; got ${JSON.stringify(result)}`);
      assert.strictEqual(result.planCount, 1, 'and it must report the one plan seeded');
    } finally {
      cleanup(tmpDir);
    }
  });
});

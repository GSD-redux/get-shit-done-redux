// allow-test-rule: source-text-is-the-product (see #3311)
// Reads .planning/STATE.md (and the milestone.lock claim JSON) because the
// deployed text of those files IS the contract under test: #3311 is exactly
// about two sessions silently overwriting each other's Current Position text.

'use strict';

// #3311 — milestone lock keyed by phase + session id.
//
// The defect: two sessions running different phases in ONE working tree both
// read-modify-write the single un-scoped `## Current Position` slot in
// STATE.md. Byte-level serialization already exists (STATE.md.lock, #464), so
// no write is lost — but the SEMANTIC clobber is silent: `state.advance-plan`
// takes no phase argument and advances whatever plan the (possibly just
// clobbered) Current Position names, and nothing ever surfaces that two
// sessions claimed two different phases.
//
// The fix (maintainer decision on #3311): an advisory claim file
// `.planning/milestone.lock` holding { phase, session, pid, updated_at }.
// A second session working a DIFFERENT phase gets a visible warning
// (stderr + typed `milestone_conflict` JSON field / phase.complete's
// warnings[]) instead of a silent overwrite.
//
// Session identity comes from getWorkstreamSessionKey() (env-first). Tests
// drive it with GSD_SESSION_KEY via runGsdTools's per-call env override;
// helpers blank ambient session identity, so default runs are headless
// (null session) deterministically.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers.cjs');
const { runGsdTools, createTempProject, cleanup, TOOLS_PATH, captureFdSync } = helpers;
const processSeam = require('./helpers/process-seam.cjs');
const { collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

// runGsdTools's legacy shape drops stderr on success, but the #3311 contract
// is exactly that a conflict is VISIBLE — these tests must see stderr. Drive
// the process seam directly for the conflicting invocations (same env base
// runGsdTools applies, exposed as the TEST_ENV_BASE getter).
function runToolsWithStderr(args, cwd, env = {}) {
  return processSeam.runNode([TOOLS_PATH, ...args], {
    cwd,
    env: { ...process.env, ...helpers.TEST_ENV_BASE, ...env },
    timeoutMs: 60000,
  });
}

const SESSION_A = { GSD_SESSION_KEY: 'session-a' };
const SESSION_B = { GSD_SESSION_KEY: 'session-b' };

// Pinned clock base for deterministic claim freshness (realClock.now() honors
// GSD_TEST_MODE + GSD_NOW_MS in the subprocess under test).
const T0 = Date.parse('2026-08-10T09:00:00.000Z');
// A delta comfortably past any plausible claim TTL (4h) — staleness driver.
const WEEK_LATER = T0 + 7 * 24 * 60 * 60 * 1000;

function milestoneLockPath(tmpDir) {
  return path.join(tmpDir, '.planning', 'milestone.lock');
}

function readClaim(tmpDir) {
  return JSON.parse(fs.readFileSync(milestoneLockPath(tmpDir), 'utf-8'));
}

const BEGIN_PHASE_STATE_MD = [
  '# Project State',
  '',
  '**Current Phase:** 1',
  '**Current Phase Name:** setup',
  '**Total Phases:** 5',
  '**Current Plan:** 0',
  '**Total Plans in Phase:** 0',
  '**Status:** Ready to plan',
  '**Last Activity:** 2026-03-20',
  '',
  '## Current Position',
  'Phase: 1 of 5 (setup)',
  'Plan: 0 of ? in current phase',
  'Status: Ready to plan',
  'Last activity: 2026-03-20 — roadmap created',
  'Progress: [..........] 0%',
  '',
].join('\n');

// STATE.md whose Current Position names phase 2 — the post-clobber state a
// session-A advance-plan must detect against its phase-1 claim.
const ADVANCE_POSITION_PHASE_2 = [
  '# Project State',
  '',
  '**Current Plan:** 1',
  '**Total Plans in Phase:** 3',
  '**Status:** Executing',
  '**Last Activity:** 2026-08-10',
  '',
  '## Current Position',
  'Phase: 2 of 5 (api)',
  'Plan: 1 of 3 in current phase',
  'Status: Executing',
  'Last activity: 2026-08-10 — began api work',
  '',
].join('\n');

/**
 * Minimal project where `phase complete <n>` reaches its transaction:
 * ROADMAP with two phases, phase dir with one plan + summary + passed
 * verification for phase 1, and an empty (already-verified) phase 2.
 */
function writePhaseCompleteFixture(tmpDir) {
  const planningDir = path.join(tmpDir, '.planning');
  const phase1Dir = path.join(planningDir, 'phases', '01-foundation');
  const phase2Dir = path.join(planningDir, 'phases', '02-api');
  fs.mkdirSync(phase1Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });

  fs.writeFileSync(
    path.join(planningDir, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Foundation',
      '- [ ] Phase 2: API',
      '',
      '### Phase 1: Foundation',
      '**Goal:** Setup',
      '**Plans:** 1 plans',
      '',
      '### Phase 2: API',
      '**Goal:** Build API',
      '**Plans:** 0 plans',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Foundation | 0/1 | Not started | - |',
      '| 02. API | 0/1 | Not started | - |',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    [
      '# State',
      '',
      '**Current Phase:** 01',
      '**Current Phase Name:** Foundation',
      '**Status:** In progress',
      '**Current Plan:** 01-01',
      '**Last Activity:** 2026-08-10',
      '',
      '## Current Position',
      'Phase: 1 of 2 (Foundation)',
      'Plan: 1 of 1 in current phase',
      'Status: Executing',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');
  fs.writeFileSync(
    path.join(phase1Dir, '01-VERIFICATION.md'),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(phase2Dir, '02-VERIFICATION.md'),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// M1–M4, M7, M8, M11 — begin-phase claim behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('#3311 milestone lock: begin-phase claims', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), BEGIN_PHASE_STATE_MD);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('M1: begin-phase records a milestone.lock claim with phase + session key', () => {
    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(result.success, `begin-phase failed: ${result.error}`);

    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '1', `claim phase must be 1; got ${JSON.stringify(claim)}`);
    assert.ok(
      typeof claim.session === 'string' && claim.session.includes('session-a'),
      `claim session must carry the session key; got ${JSON.stringify(claim)}`,
    );
    assert.strictEqual(claim.updated_at, T0, 'claim updated_at must be the pinned now');
  });

  test('M2: second session beginning a DIFFERENT phase gets a visible conflict, claim left intact, STATE.md still updated', () => {
    const first = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(first.success, `first begin-phase failed: ${first.error}`);

    const second = runToolsWithStderr(
      ['state', 'begin-phase', '--phase', '2', '--name', 'api', '--plans', '3'],
      tmpDir,
      { ...SESSION_B, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 1000) },
    );
    assert.strictEqual(second.exitCode, 0, `second begin-phase failed: ${second.stderr}`);

    const out = JSON.parse(second.stdout);
    assert.ok(
      out.milestone_conflict && out.milestone_conflict.locked_phase === '1',
      `output must carry milestone_conflict.locked_phase 1; got ${second.stdout}`,
    );
    assert.match(
      second.stderr || '',
      /milestone/i,
      'a visible stderr warning must accompany the conflict',
    );

    // Warn, not block: STATE.md still moves to phase 2 …
    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(stateContent, /^Phase:.*2.*EXECUTING/m, 'STATE.md must still be updated (warn, not block)');

    // … and the first session's claim is NOT overwritten, so the conflict
    // stays visible on every subsequent mutation.
    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '1', `session A's claim must be left intact; got ${JSON.stringify(claim)}`);
    assert.ok(claim.session.includes('session-a'), 'claim session must still be session A');
  });

  test('M3: same session re-targeting a different phase — no conflict, claim follows', () => {
    const first = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(first.success, `first begin-phase failed: ${first.error}`);
    assert.ok(!JSON.parse(first.output).milestone_conflict, 'no conflict on fresh claim');

    const second = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'api', '--plans', '3'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 1000) },
    );
    assert.ok(second.success, `second begin-phase failed: ${second.error}`);

    const out = JSON.parse(second.output);
    assert.ok(!out.milestone_conflict, `same session re-targeting must not conflict; got ${second.output}`);

    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '2', `claim must follow the session's new phase; got ${JSON.stringify(claim)}`);
  });

  test('M4: different session, SAME phase — no conflict (keyed by phase)', () => {
    const first = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(first.success, `first begin-phase failed: ${first.error}`);

    const second = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_B, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 1000) },
    );
    assert.ok(second.success, `second begin-phase failed: ${second.error}`);

    const out = JSON.parse(second.output);
    assert.ok(!out.milestone_conflict, `same phase from another session must not conflict; got ${second.output}`);
  });

  test('M7: headless sessions (no session identity) still conflict across phases', () => {
    // No session env at all — both invocations resolve a null session key.
    // A null key must never count as "same session", or the headless parallel
    // case (CI, cron) would be undetectable.
    const first = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(first.success, `first begin-phase failed: ${first.error}`);

    const second = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'api', '--plans', '3'],
      tmpDir,
      { GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 1000) },
    );
    assert.ok(second.success, `second begin-phase failed: ${second.error}`);

    const out = JSON.parse(second.output);
    assert.ok(
      out.milestone_conflict && out.milestone_conflict.locked_phase === '1',
      `headless cross-phase conflict must be detected; got ${second.output}`,
    );
  });

  test('M8: a claim older than the TTL is stale — takeover without conflict', () => {
    const first = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '4'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(first.success, `first begin-phase failed: ${first.error}`);

    // A week later, session B begins phase 2: the abandoned claim must not
    // fire a false conflict.
    const second = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'api', '--plans', '3'],
      tmpDir,
      { ...SESSION_B, GSD_TEST_MODE: '1', GSD_NOW_MS: String(WEEK_LATER) },
    );
    assert.ok(second.success, `second begin-phase failed: ${second.error}`);

    const out = JSON.parse(second.output);
    assert.ok(!out.milestone_conflict, `stale claim must not conflict; got ${second.output}`);

    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '2', `stale claim must be taken over; got ${JSON.stringify(claim)}`);
    assert.strictEqual(claim.updated_at, WEEK_LATER, 'takeover must re-stamp updated_at');
  });

  test('M11: a corrupt milestone.lock body is treated as no claim — no crash, no conflict', () => {
    fs.writeFileSync(milestoneLockPath(tmpDir), 'not-json{garbage');

    const result = runGsdTools(
      ['state', 'begin-phase', '--phase', '2', '--name', 'api', '--plans', '3'],
      tmpDir,
      { ...SESSION_B, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(result.success, `begin-phase failed on corrupt claim: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(!out.milestone_conflict, `corrupt claim must not conflict; got ${result.output}`);

    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '2', `corrupt claim must be replaced; got ${JSON.stringify(claim)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M5, M6 — advance-plan flip detection + heartbeat
// ─────────────────────────────────────────────────────────────────────────────

describe('#3311 milestone lock: advance-plan position checks', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('M5: position phase matching the claim advances silently and heartbeats the claim', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), BEGIN_PHASE_STATE_MD);
    const begin = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(begin.success, `begin-phase failed: ${begin.error}`);

    const before = readClaim(tmpDir);
    assert.strictEqual(before.updated_at, T0);

    const adv = runGsdTools(
      ['state', 'advance-plan'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 60_000) },
    );
    assert.ok(adv.success, `advance-plan failed: ${adv.error}`);

    const out = JSON.parse(adv.output);
    assert.ok(out.advanced === true, `advance-plan must advance; got ${adv.output}`);
    assert.ok(!out.milestone_conflict, `matching claim must not conflict; got ${adv.output}`);

    const after = readClaim(tmpDir);
    assert.strictEqual(after.phase, '1', 'claim phase unchanged');
    assert.strictEqual(
      after.updated_at,
      T0 + 60_000,
      `claim must be heartbeat-refreshed; got ${JSON.stringify(after)}`,
    );
  });

  test('M6: Current Position naming ANOTHER session\'s claimed phase is reported as a conflict', () => {
    // Session A legitimately began phase 1 …
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), BEGIN_PHASE_STATE_MD);
    const begin = runGsdTools(
      ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0) },
    );
    assert.ok(begin.success, `begin-phase failed: ${begin.error}`);

    // … then session B's begin-phase clobbered the single Current Position
    // slot to phase 2 (the #3311 flip). Session A's next advance-plan must
    // SAY SO instead of silently advancing phase 2's plan counter.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), ADVANCE_POSITION_PHASE_2);

    const adv = runToolsWithStderr(
      ['state', 'advance-plan'],
      tmpDir,
      { ...SESSION_A, GSD_TEST_MODE: '1', GSD_NOW_MS: String(T0 + 60_000) },
    );
    assert.strictEqual(adv.exitCode, 0, `advance-plan failed: ${adv.stderr}`);

    const out = JSON.parse(adv.stdout);
    assert.ok(
      out.milestone_conflict && out.milestone_conflict.locked_phase === '1',
      `position/claim mismatch must surface milestone_conflict; got ${adv.stdout}`,
    );
    assert.match(adv.stderr || '', /milestone/i, 'a visible stderr warning must accompany the conflict');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M9, M10 — phase.complete conflict warning + claim release
// ─────────────────────────────────────────────────────────────────────────────

describe('#3311 milestone lock: phase.complete', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    writePhaseCompleteFixture(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('M9: completing a phase while a live claim holds a DIFFERENT phase warns via warnings[]', () => {
    // Session A is mid-phase-1 (live claim) …
    fs.writeFileSync(path.join(tmpDir, '.planning', 'milestone.lock'), JSON.stringify({
      phase: '1',
      session: 'gsd-session-key-session-a',
      pid: 4242,
      updated_at: Date.now(),
    }));

    // … and session B completes phase 2 in the same tree.
    const result = runGsdTools(
      ['phase', 'complete', '2'],
      tmpDir,
      SESSION_B,
    );
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(
      Array.isArray(out.warnings) && out.warnings.some((w) => /milestone/i.test(w)),
      `warnings[] must carry the milestone-lock conflict; got ${result.output}`,
    );
    assert.strictEqual(out.has_warnings, true, 'has_warnings must be true');
    assert.ok(
      out.milestone_conflict && out.milestone_conflict.locked_phase === '1',
      `typed milestone_conflict must be present; got ${result.output}`,
    );

    // The live claim is left intact for the same reason as M2.
    const claim = readClaim(tmpDir);
    assert.strictEqual(claim.phase, '1', 'session A\'s claim must be left intact');
  });

  test('M10: completing the CLAIMED phase releases the claim', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'milestone.lock'), JSON.stringify({
      phase: '1',
      session: 'gsd-session-key-session-a',
      pid: 4242,
      updated_at: Date.now(),
    }));

    const result = runGsdTools(['phase', 'complete', '1'], tmpDir, SESSION_A);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(!out.milestone_conflict, `completing the claimed phase must not conflict; got ${result.output}`);

    assert.ok(
      !fs.existsSync(milestoneLockPath(tmpDir)),
      'milestone.lock must be released when the claimed phase completes',
    );
  });

  test('M10b: no claim file — phase.complete carries no conflict and creates no claim', () => {
    const result = runGsdTools(['phase', 'complete', '1'], tmpDir, SESSION_A);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.ok(!out.milestone_conflict, `no claim must mean no conflict; got ${result.output}`);
    assert.ok(
      !Array.isArray(out.warnings) || !out.warnings.some((w) => /milestone/i.test(w)),
      'no milestone warning without a claim',
    );
    assert.ok(!fs.existsSync(milestoneLockPath(tmpDir)), 'phase.complete must not create a claim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G1 — lock-domain serialization guard (triage brief regression test 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3311 guard: phase.complete does not lose a concurrent STATE.md write', () => {
  test('G1: a STATE.md edit landing while phase.complete waits on STATE.md.lock survives', () => {
    const tmpDir = createTempProject();
    try {
      writePhaseCompleteFixture(tmpDir);

      const stateMod = require('../gsd-core/bin/lib/state.cjs');
      const phaseMod = require('../gsd-core/bin/lib/phase.cjs');
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      const lockPath = statePath + '.lock';

      // Pre-hold STATE.md.lock the way a concurrent `state.advance-plan`
      // mid-transform would: a body with a pid the liveness probe reports as
      // VERIFIED-LIVE, so the phase.complete path must WAIT, not steal.
      fs.writeFileSync(lockPath, '4242');
      stateMod._setLockProbes({ isPidAlive: (pid) => pid === 4242 });

      let injected = false;
      stateMod._setStateLockTestHooks({
        onLoopIteration(ctx) {
          // Gate on iteration >= 1: the hook fires at the top of EVERY loop
          // iteration, so iteration 0 alone proves nothing. Injecting only
          // once the first open() has hit EEXIST proves the writer is
          // actually HONORING the held lock rather than bypassing it.
          if (ctx.iteration < 1 || injected) return;
          injected = true;
          // The "advance-plan write" lands on disk while phase.complete waits …
          fs.writeFileSync(
            statePath,
            fs.readFileSync(statePath, 'utf-8') + '\n## Concurrent Notes\nsurvived-concurrent-writer\n',
          );
          // … then the concurrent holder releases.
          fs.unlinkSync(lockPath);
        },
      });

      // Capture fd-1 writes (io.output writes JSON straight to fd 1).
      // Delegates to the shared, safe fd-capture helper (#4306) — see
      // tests/helpers.cjs's captureFdSync.
      const captured = [];
      let threw = null;
      try {
        captured.push(captureFdSync(1, () => phaseMod.cmdPhaseComplete(tmpDir, '1', true)));
      } catch (e) {
        threw = e;
      } finally {
        stateMod._resetStateLockTestHooks();
        stateMod._resetLockProbes();
      }
      assert.ok(!threw, `phase.complete must succeed under contention: ${threw && threw.message}`);
      assert.ok(injected, 'the EEXIST contention path must have been reached (lock honored)');

      const finalContent = fs.readFileSync(statePath, 'utf-8');
      assert.ok(
        finalContent.includes('survived-concurrent-writer'),
        `the concurrent writer's STATE.md edit must NOT be lost; got:\n${finalContent}`,
      );
      // And the completion itself also landed (both writes present).
      const payload = JSON.parse(captured.join('') || '{}');
      assert.strictEqual(payload.completed_phase, '1', `completion result must be phase 1; got ${captured.join('')}`);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G2 — targeted-field-replace guard (triage brief regression test 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3311 guard: advancePlan stays a targeted field replace', () => {
  test('G2: only Status / Last Activity / Plan lines change inside ## Current Position', () => {
    const { transitionCore } = require('../gsd-core/bin/lib/state-transition.cjs');

    const fixedClock = Object.freeze({
      today: () => '2026-08-10',
      localToday: () => '2026-08-10',
      nowIso: () => '2026-08-10T12:00:00.000Z',
    });

    const before = [
      '# Project State',
      '',
      '**Current Plan:** 1',
      '**Total Plans in Phase:** 3',
      '**Status:** Executing',
      '**Last Activity:** 2026-08-09',
      '',
      '## Current Position',
      'Phase: 2 of 5 (api)',
      'Plan: 1 of 3 in current phase',
      'Status: Executing',
      // Bare date = handler-generated shape, so advancePlan's template-aware
      // replace is permitted to update it (an executor-authored value like
      // "2026-08-09 — began api work" is deliberately preserved instead).
      'Last activity: 2026-08-09',
      'Owner: alice',
      '',
      '## Next Steps',
      '',
      'Do the thing.',
      '',
    ].join('\n');

    const result = transitionCore(before, { kind: 'advancePlan' }, { clock: fixedClock, sourcePath: 'STATE.md' });
    const after = result.content;

    const section = (text) => {
      const s = collectSection(text, (h) => /^Current Position$/i.test(h.text));
      assert.ok(s, 'Current Position section must exist');
      return s.body;
    };
    const beforeSection = section(before);
    assert.ok(beforeSection.length > 0, 'before-section must be non-empty');
    const afterSection = section(after);

    // Untouched lines — the triage's "must not turn into a whole-block rewrite".
    assert.match(afterSection, /^Phase: 2 of 5 \(api\)$/m, 'Phase line must be byte-identical');
    assert.match(afterSection, /^Owner: alice$/m, 'unrelated custom line must be byte-identical');
    assert.ok(
      after.includes('## Next Steps\n\nDo the thing.'),
      'the sibling ## Next Steps section must be untouched',
    );

    // Mutated lines.
    assert.match(afterSection, /^Plan: 2 of 3/m, 'Plan line must advance');
    assert.match(afterSection, /^Status: Ready to execute$/m, 'Status line must update');
    assert.match(afterSection, /^Last activity: 2026-08-10/m, 'Last activity line must update');
  });
});

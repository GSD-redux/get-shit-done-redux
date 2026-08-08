'use strict';

/**
 * Unit tests for the smart-entry situation classifier.
 *
 * Spec: docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md
 *
 * Covers: all 11 situations, priority ordering (paused beats blocked), JSON
 * shape invariants (exactly one recommended, commands are /gsd:* slash forms),
 * and the --json / human output modes.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const smartEntry = require('../gsd-core/bin/lib/smart-entry.cjs');
const { classify, classifyProject, detectSignals, SITUATIONS } = smartEntry;
const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Create a temp dir with a `.planning/` and optional STATE.md / ROADMAP.md.
 * @returns {string} tmpDir path
 */
function makeProject({ state, roadmap = false, git = false, verifyFail = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  if (state !== undefined) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), state);
  }
  if (roadmap) {
    // `roadmap === true` writes a minimal empty roadmap (no Progress table —
    // the legacy test default). A string is written verbatim so tests can
    // supply a real Progress table for the #2427 roadmap-derived completion
    // check.
    const content = typeof roadmap === 'string' ? roadmap : '# Roadmap\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
  }
  if (git) {
    gitOrThrow(['init'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.email', 't@t.com'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.name', 'T'], { cwd: tmpDir });
  }
  if (verifyFail) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-feat');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, 'SUMMARY.md'),
      '# Summary\n\nSTATUS: blocked\n',
    );
  }
  return tmpDir;
}

/** Minimal STATE.md frontmatter body. */
function state(opts) {
  const fm = { ...opts };
  // status goes in frontmatter as `status`; we also mirror as a body table for
  // robustness against either format the real STATE.md uses.
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '', '# State', '');
  if (fm.status) lines.push(`**Status:** ${fm.status}`);
  return lines.join('\n') + '\n';
}

const CLEANUP = [];
function track(dir) {
  CLEANUP.push(dir);
  return dir;
}
function removeAll() {
  for (const dir of CLEANUP) {
    cleanup(dir);
  }
  CLEANUP.length = 0;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('smart-entry: situation coverage', () => {
  afterEach(removeAll);

  const CASES = [
    ['no-project', () => {
      // Truly empty dir — no .planning at all.
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-none-'));
      return track(d);
    }],
    ['paused', () => track(makeProject({ state: state({ status: 'planning', paused_at: '2026-06-01T00:00:00Z' }), roadmap: true }))],
    ['blocked', () => track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2 }) + '\n## Blockers\n\n- Need API key\n', roadmap: true }))],
    ['verify-failed', () => track(makeProject({ state: state({ status: 'verify-failed', total_phases: 5, current_phase: 2 }), roadmap: true, verifyFail: true }))],
    ['needs-first-phase', () => track(makeProject({ state: state({ status: 'planning', total_phases: 0, current_phase: 0 }) }))],
    ['planning', () => track(makeProject({ state: state({ status: 'planning', total_phases: 5, current_phase: 2 }), roadmap: true }))],
    ['executing', () => track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2, progress: 60 }), roadmap: true }))],
    ['verify-pending', () => track(makeProject({ state: state({ status: 'needs-review', total_phases: 5, current_phase: 2 }), roadmap: true }))],
    ['complete', () => track(makeProject({ state: state({ status: 'complete', total_phases: 5, current_phase: 5 }), roadmap: true }))],
    ['unknown', () => track(makeProject({ state: state({ status: '', total_phases: 5, current_phase: 2 }), roadmap: true }))],
  ];

  for (const [expected, factory] of CASES) {
    test(`classifies "${expected}"`, () => {
      const dir = factory();
      const result = classifyProject(dir);
      assert.equal(result.situation, expected);
    });
  }

  test('SITUATIONS constant lists all 11 (incl unknown) and is frozen', () => {
    assert.equal(SITUATIONS.length, 11);
    assert.ok(SITUATIONS.includes('unknown'));
    assert.ok(Object.isFrozen(SITUATIONS));
  });
});

describe('smart-entry: idle-stranded (git-dependent)', () => {
  afterEach(removeAll);

  test('clean tree + unpushed commits → idle-stranded, recommended ship', () => {
    // idle-stranded is the fallback AFTER the status predicates: it fires for an
    // ambiguous status (matches none of planning/executing/verify/complete) with
    // unpushed committed work. Use an empty status to land here deterministically.
    const dir = track(makeProject({
      state: state({ status: '', total_phases: 5, current_phase: 2 }),
      roadmap: true,
      git: true,
    }));
    // Commit the .planning files so the working tree is clean (untracked files
    // would make git_dirty true and mask the stranded signal).
    gitOrThrow(['add', '-A'], { cwd: dir });
    gitOrThrow(['commit', '-m', 'init'], { cwd: dir });
    const base = detectSignals(dir);
    assert.equal(base.git_dirty, false);
    assert.equal(base.git_unpushed, false);

    // Force the stranded signal and assert the situation + recommendation.
    const forced = { ...base, git_unpushed: true };
    assert.equal(classify(forced), 'idle-stranded');
  });

  test('idle-stranded action set recommends ship', () => {
    const dir = track(makeProject({
      state: state({ status: '', total_phases: 5, current_phase: 2 }),
      roadmap: true,
    }));
    const base = detectSignals(dir);
    const forced = { ...base, git_unpushed: true };
    const situation = classify(forced);
    assert.equal(situation, 'idle-stranded');
    const actions = smartEntry.actionsFor(situation, forced);
    assert.equal(actions[0].id, 'ship');
    assert.equal(actions[0].recommended, true);
    assert.equal(actions[0].command, '/gsd:ship');
  });
});

describe('smart-entry: priority ordering', () => {
  afterEach(removeAll);

  test('verify-failed inspects current phase verify artifact', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: 100 }),
      roadmap: true,
    }));
    const phaseNinetyNine = path.join(dir, '.planning', 'phases', '99-old-phase');
    const phaseOneHundred = path.join(dir, '.planning', 'phases', '100-current-phase');
    fs.mkdirSync(phaseNinetyNine, { recursive: true });
    fs.mkdirSync(phaseOneHundred, { recursive: true });
    fs.writeFileSync(path.join(phaseNinetyNine, '99-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseOneHundred, '100-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'verify-failed');
    assert.equal(result.signals.verify_failed, true);
  });

  test('verify-failed ignores failure in a higher phase when state is on an earlier phase', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: 2 }),
      roadmap: true,
    }));
    const phaseTwo = path.join(dir, '.planning', 'phases', '02-active-phase');
    const phaseOneHundred = path.join(dir, '.planning', 'phases', '100-leftover-phase');
    fs.mkdirSync(phaseTwo, { recursive: true });
    fs.mkdirSync(phaseOneHundred, { recursive: true });
    fs.writeFileSync(path.join(phaseTwo, '02-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseOneHundred, '100-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'executing');
    assert.equal(result.signals.verify_failed, false);
  });

  test('verify-failed includes decimal phase directories for the current phase', () => {
    const dir = track(makeProject({
      state: state({ status: 'executing', total_phases: 10, current_phase: '7.1' }),
      roadmap: true,
    }));
    const phaseSeven = path.join(dir, '.planning', 'phases', '07-base-phase');
    const phaseSevenOne = path.join(dir, '.planning', 'phases', '07.1-inserted-phase');
    fs.mkdirSync(phaseSeven, { recursive: true });
    fs.mkdirSync(phaseSevenOne, { recursive: true });
    fs.writeFileSync(path.join(phaseSeven, '07-VERIFICATION.md'), 'STATUS: passed\n');
    fs.writeFileSync(path.join(phaseSevenOne, '07.1-VERIFICATION.md'), 'STATUS: failed\n');

    const result = classifyProject(dir);

    assert.equal(result.situation, 'verify-failed');
    assert.equal(result.signals.verify_failed, true);
  });

  test('paused beats blocked (earlier row wins)', () => {
    const dir = track(makeProject({
      // paused_at set AND blockers present AND a phase loop: must resolve paused.
      state: state({ status: 'executing', total_phases: 5, current_phase: 2, paused_at: '2026-06-01T00:00:00Z' })
        + '\n## Blockers\n\n- blocker one\n',
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'paused');
  });

  test('blocked beats planning (earlier row wins)', () => {
    const dir = track(makeProject({
      state: state({ status: 'planning', total_phases: 5, current_phase: 2 })
        + '\n## Blockers\n\n- blocker one\n',
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'blocked');
  });

  test('no-project beats everything (no .planning)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-empty-'));
    track(tmpDir);
    const result = classifyProject(tmpDir);
    assert.equal(result.situation, 'no-project');
  });
});

describe('smart-entry: real STATE.md schema (nested progress YAML + body Phase field)', () => {
  afterEach(removeAll);

  // Mirrors this repo's actual .planning/STATE.md: status + nested progress{}
  // in frontmatter, phase number in the body as `Phase: N`. Codex review found
  // the classifier originally misread this as needs-first-phase (#P1).
  function realState({ status, phase, totalPhases, percent }) {
    const fm = [
      '---',
      'gsd_state_version: 1.0',
      `status: ${status}`,
      'last_activity: 2026-06-13',
      'progress:',
      `  total_phases: ${totalPhases}`,
      `  percent: ${percent}`,
      '---',
      '',
      '# Project State',
      '',
      `Phase: ${phase}`,
      '',
      `**Status:** ${status}`,
      '',
    ].join('\n');
    return fm;
  }

  test('reads current_phase from body `Phase:` + total_phases/percent from nested progress{}', () => {
    const dir = track(makeProject({
      state: realState({ status: 'verifying', phase: 3, totalPhases: 5, percent: 40 }),
      roadmap: true,
    }));
    const signals = detectSignals(dir);
    assert.equal(signals.current_phase, 3, 'current_phase from body Phase: field');
    assert.equal(signals.total_phases, 5, 'total_phases from nested progress.total_phases');
    assert.equal(signals.progress, 40, 'percent from nested progress.percent');
    assert.equal(signals.status, 'verifying');
  });

  test('classifies verify-pending (not needs-first-phase) for an active real-schema project', () => {
    const dir = track(makeProject({
      state: realState({ status: 'verifying', phase: 3, totalPhases: 5, percent: 40 }),
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'verify-pending');
    // Forward motion delegates to the gated engine; verify-work stays available.
    assert.equal(result.recommended, 'progress-next');
    assert.match(result.summary, /Phase 3 of 5/);
  });

  test('executing status with nested progress schema classifies executing', () => {
    const dir = track(makeProject({
      state: realState({ status: 'executing', phase: 2, totalPhases: 5, percent: 60 }),
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'executing');
    // Forward motion delegates to /gsd:progress --next, not a raw execute-phase.
    assert.equal(result.recommended, 'progress-next');
  });
});

describe('smart-entry: in-project advancement delegates to the gated engine', () => {
  afterEach(removeAll);

  // Reconciliation guard (#1787): /gsd:next must not re-implement forward routing.
  // For every in-project forward-motion situation the recommended action is
  // `/gsd:progress --next` (workflows/next.md), so Route 0's resume-incomplete
  // -phase invariant + Gates 1-3 are never bypassed. Re-deriving advancement here
  // is what got the old flat /gsd-next removed (#3054). The specific command
  // (execute-phase / plan-phase / verify-work) stays as an explicit secondary.
  for (const situation of ['planning', 'executing', 'verify-pending']) {
    test(`${situation}: recommended action is /gsd:progress --next`, () => {
      const signals = {
        current_phase: 2, total_phases: 5, status: situation, progress: 40,
        has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
        paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
      };
      const actions = smartEntry.actionsFor(situation, signals);
      const recommended = actions.filter((a) => a.recommended);
      assert.equal(recommended.length, 1, 'exactly one recommended action');
      assert.equal(recommended[0].command, '/gsd:progress --next');
    });
  }

  // Remediation / lifecycle situations are OFF the linear advance path — they
  // keep direct specific recommendations (their distinct value over --next).
  const DIRECT = {
    'no-project': '/gsd:new-project',
    paused: '/gsd:resume-work',
    blocked: '/gsd:debug',
    'verify-failed': '/gsd:verify-work',
    'idle-stranded': '/gsd:ship',
    complete: '/gsd:new-milestone',
  };
  for (const [situation, command] of Object.entries(DIRECT)) {
    test(`${situation}: keeps its direct recommendation (${command})`, () => {
      const signals = {
        current_phase: 2, total_phases: 5, status: situation, progress: 40,
        has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
        paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
      };
      const actions = smartEntry.actionsFor(situation, signals);
      const recommended = actions.find((a) => a.recommended);
      assert.equal(recommended.command, command);
    });
  }
});

describe('smart-entry: per-situation action invariants (all 11)', () => {
  // Lock the action-set contract for EVERY situation, not just the 6 sampled by
  // the JSON-shape test: exactly one recommended, 1-4 actions, unique ids, and
  // /gsd:* command forms. Guards the reconciliation (and future edits) against
  // silently breaking these for a less-common situation.
  const sampleSignals = {
    current_phase: 2, total_phases: 5, status: 'executing', progress: 60,
    has_planning: true, has_roadmap: true, git_dirty: false, git_unpushed: false,
    paused: false, blockers: [], has_git: true, verify_failed: false, stale_activity: false,
  };
  for (const situation of SITUATIONS) {
    test(`${situation}: exactly one recommended, 1-4 unique-id /gsd:* actions`, () => {
      const actions = smartEntry.actionsFor(situation, sampleSignals);
      assert.ok(actions.length >= 1 && actions.length <= 4, `${situation}: 1-4 actions (got ${actions.length})`);
      assert.equal(actions.filter((a) => a.recommended).length, 1, `${situation}: exactly one recommended`);
      const ids = actions.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length, `${situation}: action ids are unique`);
      for (const a of actions) {
        assert.ok(a.command.startsWith('/gsd:'), `${situation}/${a.id}: command is a /gsd: slash form`);
      }
    });
  }
});

describe('smart-entry: JSON shape invariants', () => {
  afterEach(removeAll);

  test('every situation yields exactly one recommended action and /gsd:* commands', () => {
    const dirs = [
      track(makeProject()),                                            // no-project
      track(makeProject({ state: state({ status: 'planning', paused_at: '2026-06-01T00:00:00Z' }), roadmap: true })), // paused
      track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2 }) + '\n## Blockers\n- b\n', roadmap: true })), // blocked
      track(makeProject({ state: state({ status: 'executing', total_phases: 5, current_phase: 2, progress: 60 }), roadmap: true })), // executing
      track(makeProject({ state: state({ status: 'complete', total_phases: 5, current_phase: 5 }), roadmap: true })), // complete
      track(makeProject({ state: state({ status: '', total_phases: 5, current_phase: 2 }), roadmap: true })),         // unknown
    ];
    for (const dir of dirs) {
      const result = classifyProject(dir);
      const recommended = result.actions.filter((a) => a.recommended);
      assert.equal(recommended.length, 1, `${result.situation}: exactly one recommended`);
      assert.equal(recommended[0].id, result.recommended, `${result.situation}: recommended id matches`);
      for (const a of result.actions) {
        assert.ok(a.command.startsWith('/gsd:'), `${result.situation}/${a.id}: command is a slash form`);
      }
      assert.ok(result.summary.length > 0, `${result.situation}: summary non-empty`);
      assert.ok(result.actions.length >= 1 && result.actions.length <= 4, `${result.situation}: 1-4 actions`);
    }
  });
});

describe('smart-entry: CLI dispatch (gsd-tools smart-entry)', () => {
  afterEach(removeAll);

  test('--json in an empty dir returns no-project machine JSON', () => {
    // A bare tmpdir with no .planning is a true no-project.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-bare-'));
    track(bare);
    const r = runNode([TOOLS, 'smart-entry', '--json', '--cwd', bare], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, 'gsd-tools smart-entry --json');
    const j = JSON.parse(r.stdout);
    assert.equal(j.situation, 'no-project');
    assert.equal(j.recommended, 'new-project');
    assert.equal(j.actions[0].command, '/gsd:new-project');
  });

  test('default (human) mode prints a plain summary line, not JSON', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-se-human-'));
    track(bare);
    const r = runNode([TOOLS, 'smart-entry', '--cwd', bare], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, 'gsd-tools smart-entry');
    const out = r.stdout;
    assert.ok(!out.startsWith('{'), 'human mode is not JSON');
    assert.match(out, /No project yet/);
    assert.match(out, /Recommended:/);
  });
});

// ─── #2427: roadmap-grounded completion + tightened status regex ─────────────
//
// Pre-fix bug: isComplete compared global current_phase against stale
// milestone-scoped total_phases (written once at milestone-switch time) and
// matched any "shipped"/"done" substring in the status line — so a project
// mid-milestone with current_phase=7 > stale total_phases=4 AND a per-phase
// "Phase X shipped" status was falsely classified as "complete". The fix
// grounds completion in ROADMAP.md's Progress table (global, authoritative)
// and tightens the regex to require milestone-level language.

describe('#2427 — roadmap-grounded completion + tightened status regex', () => {
  afterEach(removeAll);

  /**
   * Build a ROADMAP.md with a `## Progress` table of N rows, M of which are
   * `Complete` and the rest `In Progress`. Matches the column-name-driven
   * Progress table shape deriveProgressFromRoadmap scans.
   */
  function roadmapWithProgress(total, completed) {
    const rows = [];
    for (let i = 1; i <= total; i++) {
      const status = i <= completed ? 'Complete' : 'In Progress';
      const phase = String(i).padStart(2, '0');
      rows.push(`| ${phase} | 0/1 | ${status} | ${status === 'Complete' ? '2026-01-01' : ''} |`);
    }
    return [
      '# Roadmap',
      '',
      '## Milestone v1.0',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|---------------|--------|-----------|',
      ...rows,
    ].join('\n') + '\n';
  }

  test('mid-milestone with stale total_phases + unchecked roadmap phases is NOT complete', () => {
    // The core bug: STATE.md says current_phase=7 >= total_phases=4 (stale,
    // from a milestone switch when only 4 phases existed). Status contains
    // "shipped" from a per-phase message. ROADMAP has 7 phases, only 4 done.
    // MUST classify as something OTHER than "complete".
    const dir = track(makeProject({
      state: state({ status: 'Phase 7 shipped — PR #42', total_phases: 4, current_phase: 7 }),
      roadmap: roadmapWithProgress(7, 4),
    }));
    const result = classifyProject(dir);
    assert.notEqual(result.situation, 'complete',
      `mid-milestone (7 phases, 4 done) must NOT be "complete" even with stale total_phases=4 + current_phase=7. Got: ${result.situation}`);
  });

  test('all roadmap phases complete classifies as complete even with stale cached total_phases', () => {
    // ROADMAP says all 5 phases are done. STATE.md has stale total_phases=3
    // (from an earlier milestone switch). The roadmap-derived check should
    // win and classify as complete. Status uses ADR-2207's actual terminal
    // written form "<version> milestone complete" (state-transition.cts:1303).
    const dir = track(makeProject({
      state: state({ status: 'v1.0 milestone complete', total_phases: 3, current_phase: 5 }),
      roadmap: roadmapWithProgress(5, 5),
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'complete',
      `all roadmap phases complete must classify as "complete" regardless of stale cached total_phases. Got: ${result.situation}`);
  });

  test('per-phase "shipped" status alone does NOT satisfy the completion regex', () => {
    // The pre-fix regex matched "shipped" as a standalone alternation branch.
    // Tightened regex requires milestone-level language. With some phases
    // unchecked AND status="shipped", must NOT be complete.
    const dir = track(makeProject({
      state: state({ status: 'shipped', total_phases: 5, current_phase: 5 }),
      roadmap: roadmapWithProgress(5, 3),
    }));
    const result = classifyProject(dir);
    assert.notEqual(result.situation, 'complete',
      `status "shipped" alone (per-phase language) must NOT satisfy completion when roadmap has unchecked phases. Got: ${result.situation}`);
  });

  test('per-phase "done" status alone does NOT satisfy the completion regex', () => {
    // Same as above but with "done" — the other over-broad branch the pre-fix
    // regex matched.
    const dir = track(makeProject({
      state: state({ status: 'done', total_phases: 5, current_phase: 5 }),
      roadmap: roadmapWithProgress(5, 3),
    }));
    const result = classifyProject(dir);
    assert.notEqual(result.situation, 'complete',
      `status "done" alone must NOT satisfy completion when roadmap has unchecked phases. Got: ${result.situation}`);
  });

  test('legacy fallback: empty roadmap still classifies via STATE.md comparison', () => {
    // When ROADMAP.md has no Progress table (fresh project, non-standard
    // layout), isComplete falls back to the legacy current_phase >= total_phases
    // check. This preserves backward compat for projects that haven't adopted
    // the Progress-table convention.
    const dir = track(makeProject({
      state: state({ status: 'complete', total_phases: 5, current_phase: 5 }),
      roadmap: true, // empty roadmap — no Progress table
    }));
    const result = classifyProject(dir);
    assert.equal(result.situation, 'complete',
      `legacy fallback (no roadmap Progress table) must still classify complete via STATE.md. Got: ${result.situation}`);
  });

  test('legacy fallback: empty roadmap with current_phase < total_phases is NOT complete', () => {
    const dir = track(makeProject({
      state: state({ status: 'complete', total_phases: 5, current_phase: 3 }),
      roadmap: true,
    }));
    const result = classifyProject(dir);
    assert.notEqual(result.situation, 'complete',
      `legacy fallback must still reject completion when current_phase < total_phases. Got: ${result.situation}`);
  });
});

describe('smart-entry: stale_activity honors the template\'s "date — description" shape (#2570)', () => {
  afterEach(removeAll);

  // A fixed "now" far enough past 2026-06-08 that any real date there is well
  // beyond IDLE_STALE_MS (72h). Injected so the test is deterministic and does
  // not depend on the wall clock.
  const FIXED_NOW = () => Date.parse('2026-08-01T00:00:00Z');

  // gsd-core's own STATE.md carries last_activity as "YYYY-MM-DD — <description>"
  // (templates/state.md prescribes `Last activity: [YYYY-MM-DD] — [What happened]`
  // for the body; the frontmatter mirrors it). Before the fix, parseActivityTimestamp
  // ran Date.parse on the whole string → NaN → staleActivity failed OPEN to false,
  // so the ONLY idle/staleness detector never fired on any project whose
  // last_activity retained its description.

  test('frontmatter last_activity with " — description" suffix is detected stale', () => {
    const stateMd = [
      '---',
      'gsd_state_version: 1.0',
      'status: executing',
      'last_activity: 2026-06-08 — Milestone 2 executed autonomously (all passed)',
      'progress:',
      '  total_phases: 5',
      '  percent: 40',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 3',
      '',
      '**Status:** executing',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(
      signals.stale_activity,
      true,
      'a 54-day-old last_activity carrying a description must read stale, not fail open to false',
    );
  });

  test('body "Last activity: <date> — <desc>" fallback is detected stale', () => {
    const stateMd = [
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 1 of 1 (X)',
      'Status: In progress',
      'Last activity: 2026-06-08 — started the widget',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(signals.stale_activity, true, 'body-field fallback must also parse the leading date');
  });

  test('bare ISO date (control) still reads stale', () => {
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2026-06-08',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(signals.stale_activity, true, 'bare-date parsing must be unchanged');
  });

  test('recent activity with a description is NOT stale (no false positive)', () => {
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2026-07-31 — shipped a thing',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(
      signals.stale_activity,
      false,
      'a next-day activity with a description must NOT be flagged stale',
    );
  });

  // Boundary coverage for the fallback branch. NOTE: these are NOT fail-first
  // regressions — a malformed or empty value returned null before the fix too.
  // They pin the degrade-safely contract so a future change to the leading-date
  // regex cannot start throwing, or start guessing, on unparseable input.
  for (const [label, value] of [
    ['a malformed leading date', '2026-13-45 — nonsense month and day'],
    ['a non-date prefix', 'yesterday — did some work'],
    ['an empty value', ''],
    ['a whitespace-only value', '   '],
  ]) {
    test(`${label} degrades to not-stale without throwing`, () => {
      const stateMd = [
        '---',
        'status: executing',
        `last_activity: ${value}`,
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n');
      const dir = track(makeProject({ state: stateMd, roadmap: true }));
      let signals;
      assert.doesNotThrow(() => {
        signals = detectSignals(dir, FIXED_NOW);
      }, `${label} must not throw`);
      // Unparseable reads as not-stale because staleActivity treats null as
      // "not stale". That fail-open is pre-existing and out of scope for #2570
      // (which is fenced to the description-suffix parse); asserted here so the
      // behavior is recorded rather than silently assumed.
      assert.equal(
        signals.stale_activity,
        false,
        `${label} must degrade to not-stale, not throw or guess`,
      );
    });
  }

  // ADR-227: shape validation alone is not enough. Date.parse rolls an
  // out-of-range DAY forward instead of rejecting it, so a shape-only guard
  // propagates a different, wrong instant rather than failing safe. The
  // pre-existing '2026-13-45' case above only exercises an invalid MONTH,
  // which Date.parse happens to reject outright — it cannot catch this class.
  //
  // Only the two BARE cases are fail-first. On pre-fix code '2026-02-30'
  // parses to 2026-03-02 and '2026-06-31' to 2026-07-01 — both read
  // stale=true where the fix now reads false.
  //
  // The two suffixed cases are NOT fail-first: the trailing description
  // already makes the pre-fix whole-string Date.parse return NaN, so
  // stale_activity is false both before and after. They are kept because
  // they pin the new calendar-validity behaviour for the suffix-carrying
  // shape templates/state.md prescribes — but they do not demonstrate the
  // regression, and should not be cited as if they did.
  for (const [label, value] of [
    ['Feb 30 with a description', '2026-02-30 — fat-fingered the day'],
    ['Feb 30 bare', '2026-02-30'],
    ['Apr 31 with a description', '2026-04-31 — thirty days hath September'],
    ['Jun 31 bare', '2026-06-31'],
  ]) {
    test(`an impossible calendar date (${label}) fails safe instead of rolling forward`, () => {
      const stateMd = [
        '---',
        'status: executing',
        `last_activity: ${value}`,
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n');
      const dir = track(makeProject({ state: stateMd, roadmap: true }));
      const signals = detectSignals(dir, FIXED_NOW);
      assert.equal(
        signals.stale_activity,
        false,
        `${label} must coerce to the safe default, not a rolled-forward instant`,
      );
    });
  }

  test('a real leap day still parses (the guard must not over-reject)', () => {
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2024-02-29 — leap day is a real date',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(
      signals.stale_activity,
      true,
      'a valid Feb 29 in a leap year must parse and read stale, not be rejected',
    );
  });

  // RULESET.TESTS.boundary-coverage on IDLE_STALE_MS (72h). The comparison is a
  // strict `now() - lastActivityMs > IDLE_STALE_MS`, so exactly-72h is NOT
  // stale. Full ISO instants (not bare dates) are used deliberately: a bare
  // date truncates to UTC midnight, which cannot express limit±1.
  //
  // NOT fail-first — these pass pre-fix too. They close the [24,95]h band the
  // property tests skip, so an off-by-one in the threshold cannot land green.
  for (const [label, value, expected] of [
    ['71h — one hour inside the window', '2026-07-29T01:00:00Z — 71h ago', false],
    ['72h — exactly at the limit (strict >)', '2026-07-29T00:00:00Z — 72h ago', false],
    ['73h — one hour past the limit', '2026-07-28T23:00:00Z — 73h ago', true],
  ]) {
    test(`staleness boundary: ${label} -> stale=${expected}`, () => {
      const stateMd = [
        '---',
        'status: executing',
        `last_activity: ${value}`,
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n');
      const dir = track(makeProject({ state: stateMd, roadmap: true }));
      const signals = detectSignals(dir, FIXED_NOW);
      assert.equal(
        signals.stale_activity,
        expected,
        `${label} must read stale=${expected} against the 72h threshold`,
      );
    });
  }

  // Leniency guard. The calendar check must not narrow what already parsed:
  // reading the leading token in preference to the whole string would DROP a
  // trailing zone name and re-read the time as local, shifting the instant by
  // the host's UTC offset. Pinned with a value whose verdict flips if that
  // happens on a host east of UTC.
  test('a trailing zone name is still honored, not dropped for the leading token', () => {
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2026-07-28 23:30:00 GMT',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    // 2026-07-28T23:30:00Z is 72.5h before FIXED_NOW -> stale.
    assert.equal(
      signals.stale_activity,
      true,
      'GMT must be read as UTC; dropping it re-reads the time as local and moves the instant',
    );
  });

  // CONTRIBUTING.md QA Matrix: "Mixed CRLF/LF newlines" for frontmatter parsing
  // changes. No live defect — the fallback branch trims before matching — but
  // the standard asks for the fixture, and this pins it.
  test('a CRLF-terminated STATE.md parses the suffixed date identically', () => {
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2026-06-08 — started the widget',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\r\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(
      signals.stale_activity,
      true,
      'CRLF line endings must not change the parsed instant',
    );
  });

  // #2570 × #3099 composition: a suffixed value whose LEADING DATE parses must
  // take the stale path AND must NOT emit LAST_ACTIVITY_UNPARSEABLE. Guards
  // against two independent staleness signals firing on one field — #3099's
  // diagnostic is for genuinely unusable values, and #2570 makes this shape
  // usable, so the diagnostic must stay silent here.
  test('suffixed-but-parseable last_activity is stale and emits NO diagnostic (composes with #3099)', () => {
    const {
      _resetUnusableInputWarningsForTests,
      _unusableInputEmissionCountForTests,
    } = require('../gsd-core/bin/lib/unusable-input.cjs');
    _resetUnusableInputWarningsForTests();
    const stateMd = [
      '---',
      'status: executing',
      'last_activity: 2026-06-08 — Milestone 2 executed autonomously',
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
    const dir = track(makeProject({ state: stateMd, roadmap: true }));
    const signals = detectSignals(dir, FIXED_NOW);
    assert.equal(signals.stale_activity, true,
      'a suffixed value whose leading date parses must read stale');
    assert.equal(_unusableInputEmissionCountForTests(), 0,
      'a now-parseable value must NOT emit LAST_ACTIVITY_UNPARSEABLE (no double staleness signal)');
  });
});

// ---------------------------------------------------------------------------
// #3099: unusable last_activity emits a diagnostic (ADR-1411 amendment:
// corrupt is not absent — the fallback stays, the silence is the defect)
// ---------------------------------------------------------------------------

describe('#3099: unusable last_activity emits a diagnostic', () => {
  const {
    _resetUnusableInputWarningsForTests,
    _unusableInputEmissionCountForTests,
  } = require('../gsd-core/bin/lib/unusable-input.cjs');

  function makeStateWithActivity(activity) {
    return [
      '---',
      'status: executing',
      `last_activity: ${activity}`,
      '---',
      '',
      '# Project State',
      '',
      'Phase: 1',
      '',
    ].join('\n');
  }

  test('unusable last_activity still resolves stale_activity: false (fallback unchanged)', () => {
    _resetUnusableInputWarningsForTests();
    const dir = track(makeProject({
      state: makeStateWithActivity('yesterday - did some work'),
    }));
    const signals = detectSignals(dir);
    assert.equal(signals.stale_activity, false,
      'unusable last_activity must still resolve stale_activity: false (continuity is correct)');
  });

  test('unusable last_activity emits LAST_ACTIVITY_UNPARSEABLE diagnostic', () => {
    _resetUnusableInputWarningsForTests();
    const dir = track(makeProject({
      state: makeStateWithActivity('not-a-date-at-all'),
    }));
    detectSignals(dir);
    assert.equal(_unusableInputEmissionCountForTests(), 1,
      'unusable last_activity must emit exactly one diagnostic');
  });

  test('absent last_activity emits nothing (distinguishable from unusable)', () => {
    _resetUnusableInputWarningsForTests();
    const dir = track(makeProject({
      state: [
        '---',
        'status: executing',
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n'),
    }));
    detectSignals(dir);
    assert.equal(_unusableInputEmissionCountForTests(), 0,
      'absent last_activity must NOT emit a diagnostic (it is genuinely absent, not corrupt)');
  });

  test('well-formed last_activity emits nothing', () => {
    _resetUnusableInputWarningsForTests();
    const dir = track(makeProject({
      state: makeStateWithActivity('2026-06-13T12:00:00Z'),
    }));
    detectSignals(dir);
    assert.equal(_unusableInputEmissionCountForTests(), 0,
      'well-formed last_activity must NOT emit a diagnostic');
  });

  test('unusable last_activity does not re-emit on second call (dedup)', () => {
    _resetUnusableInputWarningsForTests();
    const dir = track(makeProject({
      state: makeStateWithActivity('gibberish'),
    }));
    detectSignals(dir);
    detectSignals(dir);
    assert.equal(_unusableInputEmissionCountForTests(), 1,
      'dedup: second call on the same source must not re-emit');
  });
});

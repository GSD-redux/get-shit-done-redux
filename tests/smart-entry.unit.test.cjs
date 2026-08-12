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

// ─── #2573: STATE.md commit-age freshness signal ─────────────────────────────

describe('detectSignals — state_head commit-age freshness (#2573)', () => {
  const { runGit } = require('./helpers/process-seam.cjs');

  const dirs = [];
  const track = (d) => { dirs.push(d); return d; };
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

  function gitProject(stateHead) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-se-'));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    runGit(['init', '-q'], { cwd: dir });
    runGit(['config', 'user.email', 't@t.com'], { cwd: dir });
    runGit(['config', 'user.name', 'T'], { cwd: dir });
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-q', '-m', 'seed'], { cwd: dir });
    const base = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      [
        '---',
        'status: executing',
        ...(stateHead === null ? [] : [`state_head: ${stateHead === 'BASE' ? base : stateHead}`]),
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n'),
    );
    return { dir: track(dir), base };
  }

  function advance(dir, n) {
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(dir, `c${i}.txt`), `${i}\n`);
      runGit(['add', '-A'], { cwd: dir });
      runGit(['commit', '-q', '-m', `c${i}`], { cwd: dir });
    }
  }

  test('state_head at HEAD → commits_behind 0, commit_stale false (known fresh)', () => {
    const { dir } = gitProject('BASE');
    const s = detectSignals(dir);
    assert.strictEqual(s.state_commits_behind, 0);
    assert.strictEqual(s.state_commit_stale, false);
  });

  test('state_head N commits back → commits_behind N', () => {
    const { dir } = gitProject('BASE');
    advance(dir, 3);
    const s = detectSignals(dir);
    assert.strictEqual(s.state_commits_behind, 3,
      'commits_behind must count commits between state_head and HEAD');
    assert.strictEqual(s.state_commit_stale, true);
  });

  test('missing state_head → tri-state null ("we don\'t know"), NOT false', () => {
    // Mirrors graphify's shipped commit_stale contract (src/graphify.cts:446):
    // null = unknown, distinct from false = known fresh. Collapsing unknown to
    // false would assert freshness the engine cannot actually vouch for.
    const { dir } = gitProject(null);
    const s = detectSignals(dir);
    assert.strictEqual(s.state_commits_behind, null);
    assert.strictEqual(s.state_commit_stale, null);
  });

  test('malformed / unreachable state_head → null, never throws', () => {
    for (const bad of ['not-a-sha', 'zzzz', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']) {
      const { dir } = gitProject(bad);
      let s;
      assert.doesNotThrow(() => { s = detectSignals(dir); }, `${bad} must not throw`);
      assert.strictEqual(s.state_commits_behind, null, `${bad} → null`);
      assert.strictEqual(s.state_commit_stale, null, `${bad} → null`);
    }
  });

  test('non-git project → null (no signal), never throws', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-nogit-')));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      ['---', 'status: executing', 'state_head: abc1234', '---', '', '# Project State', ''].join('\n'),
    );
    let s;
    assert.doesNotThrow(() => { s = detectSignals(dir); });
    assert.strictEqual(s.state_commit_stale, null);
  });

  // #2573 × #3099 composition: the commit-age freshness signal reads `state_head`
  // while the LAST_ACTIVITY_UNPARSEABLE diagnostic reads `last_activity` — two
  // DIFFERENT fields. A STATE.md carrying both an unparseable last_activity AND a
  // valid state_head must resolve each independently: the diagnostic fires for
  // last_activity, and the freshness signal still reads state_head. Neither
  // shadows the other (they are not "two staleness signals on one field").
  test('unparseable last_activity + valid state_head compose: diagnostic fires AND freshness reads independently (#3099)', () => {
    const {
      _resetUnusableInputWarningsForTests,
      _unusableInputEmissionCountForTests,
    } = require('../gsd-core/bin/lib/unusable-input.cjs');
    _resetUnusableInputWarningsForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-compose-'));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    runGit(['init', '-q'], { cwd: dir });
    runGit(['config', 'user.email', 't@t.com'], { cwd: dir });
    runGit(['config', 'user.name', 'T'], { cwd: dir });
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    runGit(['add', '-A'], { cwd: dir });
    runGit(['commit', '-q', '-m', 'seed'], { cwd: dir });
    const base = runGit(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
    track(dir);
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      [
        '---',
        'status: executing',
        'last_activity: not-a-real-date at all',
        `state_head: ${base}`,
        '---',
        '',
        '# Project State',
        '',
        'Phase: 1',
        '',
      ].join('\n'),
    );
    const s = detectSignals(dir);
    // last_activity is unusable → its diagnostic fires (its own field), exactly once.
    assert.strictEqual(_unusableInputEmissionCountForTests(), 1,
      'unparseable last_activity must emit exactly one LAST_ACTIVITY_UNPARSEABLE — the freshness path adds none');
    // state_head still resolves independently → fresh (0 commits behind HEAD).
    assert.strictEqual(s.state_commits_behind, 0,
      'state_head freshness must resolve independently of the last_activity diagnostic');
    assert.strictEqual(s.state_commit_stale, false);
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

'use strict';

/**
 * Tests for `src/health-diagnostic-rules/worktree-health.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — group "Worktree health": W020 (×3
 * internal conditions), W017 (orphan), W027 (NEW — split-off stale-worktree
 * subject).
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"): every
 * fixture here is built via the REAL `buildPlanningSnapshot(cwd)` against a
 * REAL temp directory. The `git worktree list` seam is mocked at
 * `child_process.spawnSync` — REUSED, not re-derived, from
 * `tests/planning-snapshot.test.cjs`'s `mockGitWorktreeListOk` /
 * `mockGitWorktreeListTimeout` helpers (that file's own comment cites this as
 * "the repo's convention for driving the real execGit rather than a hand-set
 * deps.execGit stub", since `buildWorktreeHealthField`
 * (`src/planning-snapshot.cts`) accepts no `deps` parameter to inject
 * `execGit` directly — mirrors `tests/worktree-safety.test.cjs`'s
 * "execGitDefault (real spawn seam)" section). Orphan/stale findings use REAL
 * `fs.existsSync`/`fs.statSync` against real temp-dir paths (no mocking
 * needed: a genuinely-absent path is naturally an orphan; a real directory
 * with an old mtime, set via `fs.utimesSync`, is naturally stale). Only the
 * 'unverified' finding (statSync throws on an existing path) needs a
 * `fs.statSync` passthrough mock, scoped to one target path.
 *
 * TDD RED: `src/health-diagnostic-rules/worktree-health.cts` does not exist
 * yet at the start of this batch — this file's
 * `require('../../gsd-core/bin/lib/health-diagnostic-rules/worktree-health.cjs')`
 * throws MODULE_NOT_FOUND until this batch's implementation lands.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { createTempDir, cleanup } = require('../helpers.cjs');

const worktreeHealth = require('../../gsd-core/bin/lib/health-diagnostic-rules/worktree-health.cjs');
const { RULES } = worktreeHealth;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');
const { inspectWorktreeHealth } = require('../../gsd-core/bin/lib/worktree-safety.cjs');

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── Reused git-porcelain mocking (tests/planning-snapshot.test.cjs) ───────

function mockGitWorktreeListOk(t, porcelain) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: 0,
    stdout: porcelain,
    stderr: '',
    signal: null,
    error: null,
  }));
}

function mockGitWorktreeListTimeout(t) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: null,
    stdout: '',
    stderr: '',
    signal: null,
    error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  }));
}

// New: outright failure (non-zero exit, NOT a timeout) — the second of
// W020's two scan-level conditions.
function mockGitWorktreeListFailed(t) {
  t.mock.method(childProcess, 'spawnSync', () => ({
    status: 1,
    stdout: '',
    stderr: 'fatal: some git error',
    signal: null,
    error: null,
  }));
}

// Builds `git worktree list --porcelain` output for the given paths, in
// order. Entry 0 is always treated as "the main worktree" by
// `listLinkedWorktreePaths`'s own `.slice(1)` and dropped before any
// finding is computed — mirrors the exact block shape used by
// tests/worktree-safety.test.cjs's inspectWorktreeHealth fixtures.
function buildPorcelain(paths) {
  const lines = [];
  paths.forEach((p, i) => {
    lines.push(`worktree ${p}`);
    lines.push(`HEAD ${'a'.repeat(40)}`);
    lines.push(`branch refs/heads/${i === 0 ? 'main' : `feat-${i}`}`);
    lines.push('');
  });
  return lines.join('\n');
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (worktree-health group)', () => {
  test('exports exactly 3 rules: W020, W017, W027', () => {
    assert.deepEqual(RULES.map((r) => r.code).sort(), ['W017', 'W020', 'W027']);
  });

  test('all three are severity WARNING', () => {
    assert.equal(ruleFor('W020').severity, SEVERITY.WARNING);
    assert.equal(ruleFor('W017').severity, SEVERITY.WARNING);
    assert.equal(ruleFor('W027').severity, SEVERITY.WARNING);
  });
});

// ─── W020 — worktree health scan itself is degraded ────────────────────────

describe('W020 — worktree health scan degraded', () => {
  test('fires the git_timed_out-specific scan-degraded message when git worktree list times out', (t) => {
    const cwd = createTempDir('gsd-3309-w020-timeout-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    mockGitWorktreeListTimeout(t);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W020').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W020',
      severity: SEVERITY.WARNING,
      message:
        'Worktree health check degraded: git worktree list timed out after 10s — orphan/stale worktrees could not be inspected',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: {
          command:
            'Run: git worktree list --porcelain to diagnose; check for .git/index.lock or a hung git process',
        },
      },
    });
  });

  // `inspectWorktreeHealth`'s `reason` field ('git_timed_out' vs
  // 'git_list_failed') is carried straight through on
  // `PlanningSnapshot.worktreeHealth` (`planning-snapshot.cts`'s
  // `buildWorktreeHealthField`), so `checkW020` distinguishes the two scan
  // failures with distinct messages/remedies (verify.cts:2204-2219) — this
  // asserts the git_list_failed-specific one.
  test('fires the git_list_failed-specific message when git worktree list fails outright (not a timeout)', (t) => {
    const cwd = createTempDir('gsd-3309-w020-failed-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    mockGitWorktreeListFailed(t);

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W020').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W020',
      severity: SEVERITY.WARNING,
      message:
        'Worktree health check degraded: git worktree list failed — orphan/stale worktrees could not be inspected',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: {
          command:
            'Run: git worktree list --porcelain to diagnose; check git repository state and permissions',
        },
      },
    });
  });

  test('fires once per unverified finding — exact port of verify.cts:2256-2263', (t) => {
    const cwd = createTempDir('gsd-3309-w020-unverified-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const unverifiedPath = path.join(cwd, 'wt-unverified');
    fs.mkdirSync(unverifiedPath, { recursive: true }); // existsSync must be true

    const originalStatSync = fs.statSync;
    t.mock.method(fs, 'statSync', function mockedStatSync(p, ...rest) {
      if (p === unverifiedPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return originalStatSync.call(fs, p, ...rest);
    });

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', unverifiedPath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W020').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W020',
      severity: SEVERITY.WARNING,
      message: `Worktree health check degraded: could not stat ${unverifiedPath} — presence/staleness could not be verified`,
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Check filesystem permissions on the worktree path, or investigate why statSync failed for it' },
      },
    });
  });

  test('does not fire when the scan succeeds and no finding is unverified', (t) => {
    const cwd = createTempDir('gsd-3309-w020-clean-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo']));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W020').check(snapshot), []);
  });
});

// ─── W017 — orphan git worktree ─────────────────────────────────────────────

describe('W017 — orphan git worktree', () => {
  test('fires once per orphan finding (path no longer exists on disk)', (t) => {
    const cwd = createTempDir('gsd-3309-w017-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const orphanPath = path.join(cwd, 'wt-orphan-does-not-exist');
    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', orphanPath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W017').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W017',
      severity: SEVERITY.WARNING,
      message: `Orphan git worktree: ${orphanPath} (path no longer exists on disk)`,
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'git worktree prune' },
      },
    });
  });

  test('does not fire for stale or unverified findings — isolates from W020/W027', (t) => {
    const cwd = createTempDir('gsd-3309-w017-2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const stalePath = path.join(cwd, 'wt-stale');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.utimesSync(stalePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', stalePath]));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W017').check(snapshot), []);
  });
});

// ─── W027 — stale git worktree (NEW, split off pre-migration 'W017') ──────

describe('W027 — stale git worktree', () => {
  test('fires once per stale finding; message/remedy check for uncommitted work BEFORE any removal and present --force only as an explicit opt-in (#3280)', (t) => {
    const cwd = createTempDir('gsd-3309-w027-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const stalePath = path.join(cwd, 'wt-stale');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.utimesSync(stalePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', stalePath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W027').check(snapshot);

    assert.equal(diagnostics.length, 1);
    const d = diagnostics[0];
    assert.equal(d.code, 'W027');
    assert.equal(d.severity, SEVERITY.WARNING);
    assert.ok(
      d.message.startsWith(`Stale git worktree: ${stalePath} (last modified `),
      `message must start with the stale-worktree prefix and path: ${d.message}`,
    );
    // #3280: staleness is a pure mtime heuristic and carries no information
    // about whether the tree is clean, so the remediation must establish a
    // cleanliness check FIRST and keep --force an explicit opt-in — never an
    // unconditional `Run: git worktree remove <path> --force` instruction an
    // agent can execute verbatim over uncommitted work.
    const cleanlinessIdx = d.message.indexOf(`git -C ${stalePath} status --porcelain`);
    const removeIdx = d.message.indexOf('git worktree remove');
    const forceIdx = d.message.indexOf('--force');
    assert.ok(cleanlinessIdx !== -1, `message must include the cleanliness check: ${d.message}`);
    assert.ok(removeIdx !== -1, `message must include the removal command: ${d.message}`);
    assert.ok(
      cleanlinessIdx < removeIdx,
      `cleanliness check must come BEFORE the removal command: ${d.message}`,
    );
    assert.ok(
      forceIdx > removeIdx,
      `--force must not be part of the base removal instruction: ${d.message}`,
    );
    assert.ok(
      d.message.includes('if clean run:') && d.message.includes('only add --force to discard changes'),
      `removal must be conditional and --force an explicit discard opt-in: ${d.message}`,
    );
    assert.ok(
      !d.message.endsWith(`Run: git worktree remove ${stalePath} --force`),
      `message must not end with the old unconditional forced-removal instruction: ${d.message}`,
    );
    assert.deepEqual(d.remedy, {
      action: REMEDY_ACTION.ADVISE,
      risk: REMEDY_RISK.NONE,
      args: {
        command:
          'git -C <path> status --porcelain; if clean: git worktree remove <path>; add --force only to discard changes',
      },
    });
  });

  test('#3280: neither message nor remedy reads as an unconditional forced removal', (t) => {
    const cwd = createTempDir('gsd-3280-w027-unconditional-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const stalePath = path.join(cwd, 'wt-stale');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.utimesSync(stalePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', stalePath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W027').check(snapshot);
    assert.equal(diagnostics.length, 1);

    const unconditionalRe = /(?:^|[.;:]\s*)Run:\s*git worktree remove\s+\S+\s+--force\s*$/;
    assert.match(diagnostics[0].message, /git -C \S+ status --porcelain/);
    assert.ok(!unconditionalRe.test(diagnostics[0].message), `message must not be an unconditional forced removal: ${diagnostics[0].message}`);
    assert.ok(
      !/^git worktree remove <path> --force$/.test(diagnostics[0].remedy.args.command),
      `remedy must not be the bare forced-removal command: ${diagnostics[0].remedy.args.command}`,
    );
    assert.ok(
      diagnostics[0].remedy.args.command.startsWith('git -C <path> status --porcelain'),
      `remedy must lead with the cleanliness check: ${diagnostics[0].remedy.args.command}`,
    );
  });

  test('does not fire for orphan or unverified findings — isolates from W017/W020', (t) => {
    const cwd = createTempDir('gsd-3309-w027-2-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const orphanPath = path.join(cwd, 'wt-orphan-does-not-exist');
    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', orphanPath]));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W027').check(snapshot), []);
  });

  // Regression proof (restores `verify.cts:2233-2242`'s pre-migration
  // behavior via `PlanningSnapshot.cwd`, see the rule module's own header
  // comment): the active session's cwd is a LINKED (non-first) `git worktree
  // list` entry, not the main repo root — `buildPlanningSnapshot(cwd)` is
  // called with `cwd` itself listed as entry index 1 (not the dropped
  // index-0 "main" entry) and made stale. W027 must NOT fire for it.
  test('excludes the active session\'s own (stale) worktree — matches snapshot.cwd exactly', (t) => {
    const cwd = createTempDir('gsd-3309-w027-3-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });
    fs.utimesSync(cwd, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    // Entry 0 is a fake "main repo" (dropped by listLinkedWorktreePaths's own
    // .slice(1)); entry 1 is cwd itself — the active session's worktree.
    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', cwd]));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.cwd, path.resolve(cwd), 'snapshot.cwd must be the resolved active cwd');

    const diagnostics = ruleFor('W027').check(snapshot);
    assert.deepEqual(
      diagnostics,
      [],
      'the active worktree must be excluded from stale-worktree diagnostics, matching pre-migration behavior',
    );
  });

  test('excludes the active session\'s own (stale) worktree when cwd is NESTED under the worktree path — mirrors verify.cts:2239-2241\'s startsWith check', (t) => {
    const cwd = createTempDir('gsd-3309-w027-4-');
    t.after(() => cleanup(cwd));
    const worktreePath = path.join(cwd, 'wt-active');
    const nestedCwd = path.join(worktreePath, 'sub', 'dir');
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.mkdirSync(planningDirOf(nestedCwd), { recursive: true });
    fs.utimesSync(worktreePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', worktreePath]));

    const snapshot = buildPlanningSnapshot(nestedCwd);
    const diagnostics = ruleFor('W027').check(snapshot);

    assert.deepEqual(
      diagnostics,
      [],
      'a worktree that is an ancestor of the active cwd must also be excluded',
    );
  });

  test('a DIFFERENT stale worktree (not the active cwd, not an ancestor of it) still fires', (t) => {
    const cwd = createTempDir('gsd-3309-w027-5-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const otherStalePath = path.join(cwd, 'wt-other-stale');
    fs.mkdirSync(otherStalePath, { recursive: true });
    fs.utimesSync(otherStalePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));

    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', otherStalePath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W027').check(snapshot);

    assert.equal(diagnostics.length, 1, 'a stale worktree distinct from the active cwd must still be flagged');
    assert.equal(diagnostics[0].code, 'W027');
  });

  // ─── #3280 AC7 — staleness-threshold boundary, through the clock seam ────
  //
  // The classification W027 consumes is `ageMs > staleAfterMs` (STRICTLY
  // greater) in `snapshotWorktreeInventory` (`src/worktree-safety.cts`). These
  // drive the REAL `inspectWorktreeHealth` (the owner of that comparison and
  // of the `nowMs` clock-injection seam, #1191) with BOTH clocks fixed — a
  // pinned `nowMs` and an mtime set via `fs.utimesSync` — so no wall-clock is
  // ever read, and assert the classification at the boundary and just either
  // side of it. The git seam is exercised through `deps.execGit` (a real
  // parameter of `inspectWorktreeHealth`, unlike `buildPlanningSnapshot`'s
  // hardcoded `execGit`).
  describe('#3280 AC7 — staleness threshold boundary (fixed clock seam)', () => {
    const STALE_AFTER_MS = 60 * 60 * 1000;
    const FIXED_NOW_MS = 2 * 60 * 60 * 1000; // arbitrary pinned "now" (epoch + 2h)

    function probeAtAge(t, ageMs) {
      const cwd = createTempDir('gsd-3280-w027-boundary-');
      t.after(() => cleanup(cwd));
      const wtPath = path.join(cwd, 'wt-boundary');
      fs.mkdirSync(wtPath, { recursive: true });
      const fixedMtime = new Date(FIXED_NOW_MS - ageMs);
      fs.utimesSync(wtPath, fixedMtime, fixedMtime);

      const result = inspectWorktreeHealth(
        cwd,
        { staleAfterMs: STALE_AFTER_MS, nowMs: FIXED_NOW_MS },
        {
          execGit: () => ({
            exitCode: 0,
            stdout: buildPorcelain(['/fake/main-repo', wtPath]),
            stderr: '',
            signal: null,
            error: null,
            timedOut: false,
          }),
        },
      );
      return { result, wtPath };
    }

    test('age exactly at the threshold is NOT stale (comparison is strictly greater)', (t) => {
      const { result } = probeAtAge(t, STALE_AFTER_MS);
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.findings,
        [],
        'a worktree exactly at the staleness threshold must not be classified stale',
      );
    });

    test('age 1ms past the threshold IS stale (the finding kind that drives W027)', (t) => {
      const { result, wtPath } = probeAtAge(t, STALE_AFTER_MS + 1);
      assert.equal(result.ok, true);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].kind, 'stale');
      assert.equal(result.findings[0].path, wtPath);
      assert.equal(result.findings[0].ageMinutes, 60);
    });

    test('age 1ms inside the threshold is NOT stale', (t) => {
      const { result } = probeAtAge(t, STALE_AFTER_MS - 1);
      assert.equal(result.ok, true);
      assert.deepEqual(result.findings, [], 'a worktree just inside the staleness threshold must not be classified stale');
    });
  });
});

// ─── W027 — #3663: path-casing provenance mismatch (win32 fold, posix strict) ──
//
// snapshot.cwd is raw process-cwd-derived (no casing normalization) while
// finding.path is git-worktree-list-derived (canonical on-disk casing, forward
// slashes). On win32 the two can spell the same directory differently, which
// made checkW027 flag the ACTIVE worktree as stale. The fold happens ONLY on
// win32 — POSIX comparison stays case-sensitive (criterion 2 in the issue's
// triage brief: differently-cased paths are genuinely different directories
// on case-sensitive filesystems).

describe('W027 — #3663 isActiveWorktreePath casing/separator normalization', () => {
  test('isActiveWorktreePath folds casing on win32', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('C:\\Repos\\P\\.claude\\worktrees\\Wt', 'c:/repos/p/.claude/worktrees/Wt', 'win32'),
      true,
      'the same directory spelled with different casing must match on win32',
    );
  });

  test('isActiveWorktreePath folds casing for nested cwd on win32', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('c:/REPOS/p/.claude/worktrees/wt/sub/dir', 'C:\\Repos\\p\\.claude\\worktrees\\WT', 'win32'),
      true,
      'a cwd nested under the worktree (differently cased) must match on win32',
    );
  });

  test('isActiveWorktreePath stays case-sensitive on posix', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('/tmp/A/wt', '/tmp/a/wt', 'linux'),
      false,
      'differently-cased paths are different directories on case-sensitive filesystems',
    );
  });

  test('isActiveWorktreePath matches exact paths on posix', () => {
    assert.equal(worktreeHealth.isActiveWorktreePath('/tmp/a/wt', '/tmp/a/wt', 'linux'), true);
    assert.equal(worktreeHealth.isActiveWorktreePath('/tmp/a/wt/sub', '/tmp/a/wt', 'linux'), true);
    assert.equal(worktreeHealth.isActiveWorktreePath('/tmp/a/wtx', '/tmp/a/wt', 'linux'), false, 'boundary segment wtx must not prefix-match wt');
  });

  test('isActiveWorktreePath does not fold distinct worktrees together on win32', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('C:\\Repos\\p\\.claude\\worktrees\\alpha', 'C:\\Repos\\p\\.claude\\worktrees\\beta', 'win32'),
      false,
    );
  });

  test('isActiveWorktreePath normalizes separators and trailing slashes', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('C:/Repos/p/wt/', 'C:\\Repos\\p\\wt', 'win32'),
      true,
      'mixed separators and a trailing slash must not break the comparison',
    );
  });

  test('isActiveWorktreePath keeps the segment boundary under win32 folding', () => {
    assert.equal(
      worktreeHealth.isActiveWorktreePath('C:\\Repos\\p\\wt-alphabeta', 'C:\\Repos\\p\\wt-alpha', 'win32'),
      false,
      'a sibling worktree whose name extends another (wt-alphabeta vs wt-alpha) must not prefix-match',
    );
  });

  test('isActiveWorktreePath treats a drive root as the ancestor it is', () => {
    // 'C:/' strips to 'c:'; the + '/' guard makes the comparison
    // startsWith('c:/') — the drive root contains everything on it, which is
    // correct ancestor semantics (and unreachable via git worktree list).
    assert.equal(worktreeHealth.isActiveWorktreePath('C:\\Repos\\p\\wt', 'C:/', 'win32'), true);
    assert.equal(worktreeHealth.isActiveWorktreePath('/srv/app', '/', 'linux'), true);
  });

  test('W027 still fires for differently-cased paths on posix (case-sensitive pin)', (t) => {
    const cwd = createTempDir('gsd-3663-w027-posix-case-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    // A stale finding whose path differs from snapshot.cwd ONLY by casing.
    // The variant flips a letter of the FIXED fixture prefix — deriving it
    // from the random mkdtemp suffix would flake (1/62 the suffix is already
    // 'X') or pass vacuously (60/62 it differs by a different character, not
    // case). On POSIX the two spellings are different directories, so the
    // stale finding MUST still be reported — folding here would be a
    // criterion-2 regression.
    const stalePath = cwd.replace('gsd-3663-w027-posix-case-', 'gsd-3663-w027-posix-Case-');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.utimesSync(stalePath, new Date(), new Date(Date.now() - 2 * 60 * 60 * 1000));
    mockGitWorktreeListOk(t, buildPorcelain(['/fake/main-repo', stalePath]));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W027').check(snapshot);
    assert.equal(diagnostics.length, 1, 'differently-cased path is a distinct worktree on posix and must still be flagged');
    assert.equal(diagnostics[0].code, 'W027');
  });
});

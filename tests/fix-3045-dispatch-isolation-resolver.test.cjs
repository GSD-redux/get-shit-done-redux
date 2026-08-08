'use strict';

/**
 * #3045 follow-up (two-review convergence: "the guard is fail-open in the
 * default install") — CORE REDESIGN coverage for the sentinel WRITE side.
 *
 * Seam: `gsd-tools.cjs query dispatch-isolation` (routeDispatchIsolation) is
 * now the SOLE, unconditional write path — it persists the resolved
 * isolation decision (mode + harnessFlag + phase/plan identifiers) as a side
 * effect of resolving it, so the workflow cannot learn ISOLATION without also
 * recording it. `record-dispatch-isolation` (routeRecordDispatchIsolation)
 * remains as an explicit fallback/testable primitive and shares the exact
 * same atomic-write implementation.
 *
 * Every test here drives the REAL gsd-tools.cjs CLI (via runGsdTools) and
 * asserts on the sentinel file it actually wrote, parsed as JSON — no
 * fixture-text/source-string assertions.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { SENTINEL_RELATIVE_PATH, readSentinel } = require('../hooks/lib/isolation-sentinel.js');
const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

function sentinelFile(dir) {
  return path.join(dir, SENTINEL_RELATIVE_PATH);
}

function readSentinelRaw(dir) {
  return JSON.parse(fs.readFileSync(sentinelFile(dir), 'utf-8'));
}

describe('#3045 CORE REDESIGN — dispatch-isolation records as an unconditional side effect', () => {
  test('a plain --raw query with no explicit isolation-record verb still writes the sentinel', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      assert.equal(fs.existsSync(sentinelFile(dir)), false, 'precondition: no sentinel yet');
      const result = runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--phase', '7'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      assert.equal(result.output.trim(), 'harness-worktree');

      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.isolation, 'harness-worktree');
      assert.equal(sentinel.harness_flag, 'isolation="worktree"');
      assert.equal(sentinel.phase, '7');
      assert.equal(sentinel.plan, null);
      assert.equal(typeof sentinel.written_at, 'number');
    } finally {
      cleanup(dir);
    }
  });

  test('--json output and the recorded sentinel agree on isolation + harnessFlag', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'dispatch-isolation', '--json', '--phase', '3', '--plan', 'plan-b'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      const parsed = JSON.parse(result.output);
      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.isolation, parsed.isolation);
      assert.equal(sentinel.harness_flag, parsed.harnessFlag);
      assert.equal(sentinel.phase, '3');
      assert.equal(sentinel.plan, 'plan-b');
    } finally {
      cleanup(dir);
    }
  });

  test('--force-isolation none overrides a naturally-resolved harness-worktree host and clears harnessFlag', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--phase', '4', '--force-isolation', 'none'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      // routeDispatchIsolation's own stdout still reflects the FORCED value.
      assert.equal(result.output.trim(), 'none');

      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.isolation, 'none');
      assert.equal(sentinel.harness_flag, null);
    } finally {
      cleanup(dir);
    }
  });

  test('an invalid --force-isolation value is ignored, not applied', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--force-isolation', 'bogus-mode'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      assert.equal(result.output.trim(), 'harness-worktree');
      assert.equal(readSentinelRaw(dir).isolation, 'harness-worktree');
    } finally {
      cleanup(dir);
    }
  });

  test('#3045 BLOCKER 1 — a later, plan-scoped call overwrites an earlier phase-only sentinel atomically', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      // Phase-level resolve (as the "Resolve ISOLATION" step performs it).
      runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '9'], dir, { GSD_RUNTIME: 'claude', HOME: dir });
      assert.equal(readSentinelRaw(dir).plan, null);

      // Per-plan gate degrades THIS plan to sequential (submodule intersection).
      const r = runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--phase', '9', '--plan', 'plan-sub', '--force-isolation', 'none'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(r.success, true, r.error);

      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.isolation, 'none', 'the plan-scoped degrade must win over the stale phase-level record');
      assert.equal(sentinel.plan, 'plan-sub');
      assert.equal(sentinel.phase, '9');
    } finally {
      cleanup(dir);
    }
  });

  test('the sentinel round-trips through the real reader (hooks/lib/isolation-sentinel.js)', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--phase', '2', '--plan', 'p1'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      const read = readSentinel(dir);
      assert.equal(read.present, true);
      assert.equal(read.stale, false);
      assert.equal(read.malformed, false);
      assert.equal(read.isolation, 'harness-worktree');
      assert.equal(read.harnessFlag, 'isolation="worktree"');
      assert.equal(read.phase, '2');
      assert.equal(read.plan, 'p1');
    } finally {
      cleanup(dir);
    }
  });
});

describe('#3045 MAJOR — --harness-flag can now accept a bare CLI-flag value (Cursor real registry value + generalized parsing)', () => {
  test('record-dispatch-isolation --harness-flag=--worktree persists the REAL cursor registry value verbatim', () => {
    const cursorFlag = runtimes.cursor.runtime.harnessIsolationFlag;
    assert.equal(cursorFlag, '--worktree', 'precondition: registry shape assumed by this test');

    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', `--harness-flag=${cursorFlag}`, '--phase', '1'],
        dir,
        { HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.harness_flag, cursorFlag);
    } finally {
      cleanup(dir);
    }
  });

  test('record-dispatch-isolation --harness-flag=<bare-flag> persists ANY bare-CLI-flag-shaped value verbatim (parser is not Cursor-specific)', () => {
    // A prior draft of this test asserted `runtimes.windsurf.runtime.harnessIsolationFlag
    // === '--worktree'`, assuming Windsurf's registry entry mirrors Cursor's.
    // It does not: Windsurf's `hostIntegration.dispatch.isolation` is 'none'
    // and it declares NO `harnessIsolationFlag` at all — per ADR-1239
    // (docs/adr/1239-gsd-embeddable-orchestration-engine.md:247,250),
    // `pi`/`zcode`/`windsurf` "genuinely cannot benefit and correctly stay
    // none" because they lack named/concurrent subagent dispatch, so there is
    // no per-dispatch isolation flag for Windsurf to record. That was a wrong
    // test expectation (a fabricated registry precondition), not a production
    // defect — corrected here to prove the `--harness-flag=<value>` parser
    // generalizes to any bare-CLI-flag-shaped value, not merely Cursor's
    // specific '--worktree' string (which the sub-test above already pins).
    assert.equal(
      runtimes.windsurf.runtime.harnessIsolationFlag,
      undefined,
      'precondition: windsurf declares no harnessIsolationFlag (isolation: "none", ADR-1239)',
    );

    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag=--isolated', '--phase', '1'],
        dir,
        { HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      assert.equal(readSentinelRaw(dir).harness_flag, '--isolated');
    } finally {
      cleanup(dir);
    }
  });

  test('the legacy space-separated form still rejects a value that looks like another flag (unchanged, regression pin)', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag', '--worktree', '--phase', '1'],
        dir,
        { HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      assert.equal(readSentinelRaw(dir).harness_flag, null, 'space form must not swallow a value shaped like a flag');
    } finally {
      cleanup(dir);
    }
  });

  test('record-dispatch-isolation still errors with usage text when --isolation is missing', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(['query', 'record-dispatch-isolation'], dir, { HOME: dir });
      assert.equal(result.success, false);
      assert.match(result.error, /Usage: record-dispatch-isolation/);
    } finally {
      cleanup(dir);
    }
  });

  test('record-dispatch-isolation accepts --plan and records it', () => {
    const dir = createTempProject('gsd-3045-resolver-');
    try {
      const result = runGsdTools(
        ['query', 'record-dispatch-isolation', '--isolation', 'none', '--phase', '5', '--plan', 'plan-x'],
        dir,
        { HOME: dir },
      );
      assert.equal(result.success, true, result.error);
      const sentinel = readSentinelRaw(dir);
      assert.equal(sentinel.isolation, 'none');
      assert.equal(sentinel.phase, '5');
      assert.equal(sentinel.plan, 'plan-x');
    } finally {
      cleanup(dir);
    }
  });
});

describe('#3045 MINOR — writer/reader sentinel path derivation now agrees for a linked worktree without its own .planning/', () => {
  function git(args, cwd) {
    gitOrThrow(args, { cwd });
  }

  test('a sentinel written from a linked worktree (via --cwd) is found by readSentinel() called with that SAME worktree path', () => {
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3045-minor-main-'));
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3045-minor-wtparent-'));
    try {
      git(['init'], mainRepo);
      git(['config', 'user.email', 'test@test.com'], mainRepo);
      git(['config', 'user.name', 'Test'], mainRepo);
      git(['config', 'commit.gpgsign', 'false'], mainRepo);
      fs.writeFileSync(path.join(mainRepo, 'README.md'), 'placeholder\n');
      git(['add', '-A'], mainRepo);
      git(['commit', '-m', 'initial commit'], mainRepo);

      // .planning/ is created AFTER the commit — uncommitted/untracked, the
      // documented shape where a linked worktree does NOT get its own copy
      // (git worktree only checks out tracked files).
      fs.mkdirSync(path.join(mainRepo, '.planning'));
      fs.writeFileSync(path.join(mainRepo, '.planning', 'config.json'), JSON.stringify({}));

      const linked = path.join(wtParent, 'linked');
      git(['worktree', 'add', linked, '-b', 'gsd-3045-minor-branch'], mainRepo);
      assert.equal(fs.existsSync(path.join(linked, '.planning')), false, 'precondition: linked worktree has no own .planning/');

      // Write FROM the linked worktree path — mirrors an orchestrator
      // running in a linked worktree calling `dispatch-isolation`.
      const result = runGsdTools(
        ['query', 'dispatch-isolation', '--raw', '--cwd', linked, '--phase', '1'],
        mainRepo,
        { GSD_RUNTIME: 'claude', HOME: mainRepo },
      );
      assert.equal(result.success, true, result.error);

      // The writer resolved up to the MAIN worktree (findProjectRoot(resolveMainWorktreeCwd(...))) —
      // the sentinel must NOT exist at the linked worktree's own (nonexistent) .gsd/.
      assert.equal(fs.existsSync(sentinelFile(linked)), false, 'writer must not have written under the linked worktree itself');
      assert.equal(fs.existsSync(sentinelFile(mainRepo)), true, 'writer must have resolved up to the main worktree');

      // The READER, given the raw linked-worktree cwd (exactly what a guard
      // hook receives as data.cwd / workspace_roots[i]), must derive the SAME
      // root the writer did and find the sentinel — this is the MINOR fix.
      const read = readSentinel(linked);
      assert.equal(read.present, true, 'reader must resolve the linked worktree up to the main worktree, same as the writer');
      assert.equal(read.stale, false);
      assert.equal(read.isolation, 'harness-worktree');
    } finally {
      cleanup(mainRepo);
      cleanup(wtParent);
    }
  });
});

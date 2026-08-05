'use strict';

/**
 * Phase 2 test matrix for issue #3056 (fault-injection adapter) and #3071
 * (execGit normalization, folded in). See
 * .gsd/phase/test-3056-fault-injection-adapter/50-test-matrix.md.
 *
 * Section D (row 24 — injection through the process seam is unsupported) has
 * no runtime assertion: it is documented in tests/helpers/faulty-deps.cjs's
 * module JSDoc and in CONTRIBUTING.md, per the matrix's own note that this
 * row is "asserted by review + absence, not a runtime test." Likewise row 23
 * (no chmod anywhere in the helper) is asserted by review of
 * tests/helpers/faulty-deps.cjs, not by a runtime test.
 */

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');

const {
  execGit,
  execNpm,
  execTool,
  isSpawnTimeout,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));

const worktreeSafety = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'));
const { trySymbolicRef } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'git-base-branch.cjs'));
const { evaluateWorktreeBaseDegrade } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'));
const { defaultPhaseCleanCommitTimesMs } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verification.cjs'));

const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { makeFaultyGit, withFaultyFs } = require('./helpers/faulty-deps.cjs');

// ─── A. execGit normalization (#3071) ──────────────────────────────────────

describe('A. execGit normalization (#3071)', () => {
  let tmpDir;

  test('1. execGit result carries timedOut', (t) => {
    tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const result = execGit(['status', '--porcelain'], { cwd: tmpDir });
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(typeof result.exitCode, 'number');
  });

  test('2. every exec* result carries timedOut', () => {
    const npmResult = execNpm(['--version']);
    const toolResult = execTool(process.execPath, ['--version']);
    assert.strictEqual(typeof npmResult.timedOut, 'boolean');
    assert.strictEqual(npmResult.timedOut, false);
    assert.strictEqual(typeof toolResult.timedOut, 'boolean');
    assert.strictEqual(toolResult.timedOut, false);
  });

  test('3. ENOENT path still sets timedOut:false', () => {
    // Reached via a real execTool call to a nonexistent binary — the early
    // ENOENT return in _spawnResult (shell-command-projection.cts) must not
    // omit the field the rest of the shape now always carries.
    const result = execTool('definitely-not-a-real-program-fault-3056', []);
    assert.strictEqual(result.exitCode, 127);
    assert.strictEqual(result.timedOut, false);
  });

  test('4. a timed-out git reports timedOut', (t) => {
    tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    // timeout:1 is real (no mocking) — process creation alone cannot
    // complete inside 1ms, so the kill path is deterministic, matching the
    // existing "wall-clock timeout" pattern used for dispatchGsdCommand in
    // shell-command-projection-dispatch.test.cjs.
    const result = execGit(['status', '--porcelain'], { cwd: tmpDir, timeout: 1 });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.error && result.error.code, 'ETIMEDOUT');
  });

  test('5. an external SIGTERM is not reported as a timeout', (t) => {
    // Direct predicate check: a SIGTERM with no accompanying ETIMEDOUT error
    // (the shape an externally-delivered kill produces) must not trip
    // isSpawnTimeout — proves dropping the SIGTERM conjunct (#3050) did not
    // widen the predicate into a false positive.
    assert.strictEqual(isSpawnTimeout({ error: null }), false);

    // End-to-end: mock spawnSync to return the externally-killed shape and
    // confirm the real execGit seam reports timedOut:false. Same
    // mock.method(childProcess, 'spawnSync', ...) technique already
    // established in shell-command-projection-dispatch.test.cjs for the
    // Windows-shaped-timeout case, exercising the same non-destructured
    // childProcess import for the opposite direction.
    mock.method(childProcess, 'spawnSync', () => ({
      status: null,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      error: null,
    }));
    t.after(() => mock.restoreAll());

    const result = execGit(['status', '--porcelain']);
    assert.strictEqual(result.signal, 'SIGTERM');
    assert.strictEqual(result.timedOut, false);
  });

  test('6. execGit env opt actually reaches the child process', (t) => {
    tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    // worktree-safety.cts's execGitDefault is now a thin passthrough to this
    // exact seam (see worktree-safety.cts:38 docstring), and its widened opts
    // type ({cwd, env, timeout} together) is proven at build time by the
    // strict tsc build, not here. This test instead proves the runtime
    // behavior the type describes: `git var GIT_EDITOR` reflects the
    // GIT_EDITOR env var, so a sentinel value passed via opts.env must come
    // back verbatim on stdout — a real proof env reaches the child, not a
    // liveness check that passes regardless of whether env is wired through.
    const result = execGit(['var', 'GIT_EDITOR'], {
      cwd: tmpDir,
      env: { GIT_EDITOR: 'fault-3056-sentinel-editor' },
      timeout: 5000,
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'fault-3056-sentinel-editor');
  });

  test('7. exitCode is always a number', (t) => {
    tmpDir = createTempGitProject();
    t.after(() => cleanup(tmpDir));
    const success = execGit(['status', '--porcelain'], { cwd: tmpDir });
    const enoent = execTool('definitely-not-a-real-program-fault-3056', []);
    const timeout = execGit(['status', '--porcelain'], { cwd: tmpDir, timeout: 1 });
    assert.strictEqual(typeof success.exitCode, 'number');
    assert.strictEqual(typeof enoent.exitCode, 'number');
    assert.strictEqual(typeof timeout.exitCode, 'number');
  });

  test('8. one git stub satisfies every ExecGitFn seam', (t) => {
    tmpDir = createTempDir();
    t.after(() => cleanup(tmpDir));

    // Single shared stub, deliberately configured with only the default
    // benign passthrough — the point of this row is that ONE value is
    // accepted everywhere, not what any one fault produces.
    const sharedStub = makeFaultyGit();

    // worktree-safety.cts:33 — via resolveWorktreeContext, the exported
    // entry point that threads deps.execGit.
    const wsResult = worktreeSafety.resolveWorktreeContext(tmpDir, {
      execGit: sharedStub,
      existsSync: () => false,
    });
    assert.strictEqual(typeof wsResult.effectiveRoot, 'string');
    assert.strictEqual(typeof wsResult.mode, 'string');
    assert.strictEqual(typeof wsResult.reason, 'string');

    // git-base-branch.cts:32 — trySymbolicRef takes execGit directly as its
    // second positional argument (no deps wrapper).
    assert.doesNotThrow(() => trySymbolicRef(tmpDir, sharedStub));

    // worktree-base-ref.cts:88 — evaluateWorktreeBaseDegrade threads
    // deps.execGit.
    const wbrResult = evaluateWorktreeBaseDegrade({ execGit: sharedStub, cwd: tmpDir });
    assert.strictEqual(typeof wbrResult.shouldDegrade, 'boolean');
    assert.strictEqual(typeof wbrResult.reason, 'string');

    // verification.cts:226 — defaultPhaseCleanCommitTimesMs takes execGitFn
    // directly as its third positional argument, typed `= typeof execGit`.
    assert.doesNotThrow(() => {
      const map = defaultPhaseCleanCommitTimesMs(tmpDir, ['a.md', 'b.md'], sharedStub);
      assert.ok(map instanceof Map);
    });
  });
});

// ─── B. FaultyGit ───────────────────────────────────────────────────────────

describe('B. FaultyGit', () => {
  test('9. FaultyGit timeout trips isSpawnTimeout', () => {
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'timeout' }] });
    const result = faultyGit(['status']);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.error && result.error.code, 'ETIMEDOUT');
    assert.strictEqual(isSpawnTimeout(result), true);
  });

  test('10. FaultyGit non-zero exit', () => {
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 3, stderr: 'boom' }] });
    const result = faultyGit(['status']);
    assert.strictEqual(result.exitCode, 3);
    assert.strictEqual(result.stderr, 'boom');
    assert.strictEqual(result.timedOut, false);
  });

  test('11. FaultyGit spawn failure', () => {
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'spawnFail' }] });
    const result = faultyGit(['status']);
    assert.strictEqual(result.exitCode, 127);
    assert.strictEqual(result.error && result.error.code, 'ENOENT');
    assert.strictEqual(result.timedOut, false);
  });

  test('12. FaultyGit faults only what it was told to', () => {
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'timeout', when: ['worktree', 'list'] }],
    });
    const unmatched = faultyGit(['status', '--porcelain']);
    assert.strictEqual(unmatched.timedOut, false);
    assert.strictEqual(unmatched.exitCode, 0);
  });

  test('13. FaultyGit scopes a fault to one argv', () => {
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 9, when: ['worktree', 'list'] }],
    });
    const matched = faultyGit(['worktree', 'list', '--porcelain']);
    const unmatched = faultyGit(['status', '--porcelain']);
    assert.strictEqual(matched.exitCode, 9);
    assert.strictEqual(unmatched.exitCode, 0);
  });

  test('14. FaultyGit faults the Nth call only', () => {
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 5, onCall: 2 }],
    });
    const first = faultyGit(['rev-parse', 'HEAD']);
    const second = faultyGit(['rev-parse', 'HEAD']);
    const third = faultyGit(['rev-parse', 'HEAD']);
    assert.strictEqual(first.exitCode, 0);
    assert.strictEqual(second.exitCode, 5);
    assert.strictEqual(third.exitCode, 0);
  });

  test('15. FaultyGit records its calls', () => {
    const faultyGit = makeFaultyGit();
    faultyGit(['rev-parse', 'HEAD'], { cwd: '/a' });
    faultyGit(['status'], { cwd: '/b' });
    assert.strictEqual(faultyGit.calls.length, 2);
    assert.deepStrictEqual(faultyGit.calls[0].args, ['rev-parse', 'HEAD']);
    assert.strictEqual(faultyGit.calls[0].opts.cwd, '/a');
    assert.deepStrictEqual(faultyGit.calls[1].args, ['status']);
    assert.strictEqual(faultyGit.calls[1].opts.cwd, '/b');
  });

  test('16. FaultyGit result is a valid execGit result', () => {
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'timeout' }] });
    const result = faultyGit(['status']);
    for (const key of ['exitCode', 'stdout', 'stderr', 'signal', 'error', 'timedOut']) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing ${key}`);
    }
    assert.strictEqual(typeof result.exitCode, 'number');
    assert.strictEqual(typeof result.stdout, 'string');
    assert.strictEqual(typeof result.stderr, 'string');
    assert.strictEqual(typeof result.timedOut, 'boolean');
  });
});

// ─── C. FaultyFs ────────────────────────────────────────────────────────────

describe('C. FaultyFs', () => {
  test('17. FaultyFs read throws', () => {
    const fs = require('node:fs');
    const injected = new Error('injected read failure');
    withFaultyFs({ readFileSync: () => { throw injected; } }, () => {
      assert.throws(() => fs.readFileSync('/whatever'), /injected read failure/);
    });
  });

  test('18. FaultyFs write throws', () => {
    const fs = require('node:fs');
    const injected = new Error('injected write failure');
    withFaultyFs({ writeFileSync: () => { throw injected; } }, () => {
      assert.throws(() => fs.writeFileSync('/whatever', 'x'), /injected write failure/);
    });
  });

  test('19. FaultyFs restores on success', () => {
    const fs = require('node:fs');
    const original = fs.readFileSync;
    withFaultyFs({ readFileSync: () => { throw new Error('injected'); } }, () => {
      assert.notStrictEqual(fs.readFileSync, original);
    });
    assert.strictEqual(fs.readFileSync, original);
  });

  test('20. FaultyFs restores when the body throws', () => {
    const fs = require('node:fs');
    const original = fs.readFileSync;
    assert.throws(() => {
      withFaultyFs({ readFileSync: () => { throw new Error('injected'); } }, () => {
        throw new Error('body exploded');
      });
    }, /body exploded/);
    assert.strictEqual(fs.readFileSync, original);
  });

  test('21. nested FaultyFs restore in order', () => {
    const fs = require('node:fs');
    const original = fs.readFileSync;
    const outerPatch = () => { throw new Error('outer'); };
    const innerPatch = () => { throw new Error('inner'); };

    withFaultyFs({ readFileSync: outerPatch }, () => {
      assert.strictEqual(fs.readFileSync, outerPatch);
      withFaultyFs({ readFileSync: innerPatch }, () => {
        assert.strictEqual(fs.readFileSync, innerPatch);
      });
      // Inner restored WITHOUT clobbering the outer's still-active patch.
      assert.strictEqual(fs.readFileSync, outerPatch);
    });
    assert.strictEqual(fs.readFileSync, original);
  });

  test('22. FaultyFs patches only the named method', () => {
    const fs = require('node:fs');
    const originalWrite = fs.writeFileSync;
    withFaultyFs({ readFileSync: () => { throw new Error('injected'); } }, () => {
      assert.strictEqual(fs.writeFileSync, originalWrite);
    });
    assert.strictEqual(fs.writeFileSync, originalWrite);
  });
});

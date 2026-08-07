'use strict';

/**
 * git-fixture.test.cjs
 *
 * Behavioral tests for tests/helpers/git-fixture.cjs's `gitOrThrow`, driving
 * the real seam against real `git` in a temp fixture repo. Covers matrix
 * section E of .gsd/phase/chore-3143-no-unbounded-spawn-guard/50-test-matrix.md.
 *
 * E10 needs to observe the exact `timeoutMs` value `gitOrThrow` forwards to
 * the seam without any wall-clock measurement (both the documented default
 * and the seam's own bare default would let a normal git command succeed,
 * so a black-box timing test cannot distinguish them). This file installs a
 * pass-through call-recording spy on `process-seam.cjs`'s `runGit` *before*
 * `helpers/git-fixture.cjs` is required for the first time in this process,
 * so `gitOrThrow`'s own `const { runGit } = require('./process-seam.cjs')`
 * destructures the spy. With no custom implementation, `mock.method()`
 * calls straight through to the real `runGit` — every test below still
 * exercises real git — while additionally recording each call's arguments.
 */

const { describe, test, mock, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const processSeam = require('./helpers/process-seam.cjs');
const { OUTCOME } = processSeam;

const runGitSpy = mock.method(processSeam, 'runGit');
after(() => mock.restoreAll());

const { gitOrThrow, throwIfFailed, toLegacyResult, DEFAULT_GIT_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

/**
 * Runs `fn`, returning the error it throws. Fails the calling test with a
 * clear assertion if `fn` does not throw. A standalone helper (not inline
 * in a test body) is the CONTRIBUTING.md-compliant place for a try/catch of
 * this shape — "try/finally is only permitted inside standalone utility or
 * helper functions".
 */
function captureThrown(fn) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected fn to throw');
  return caught;
}

/** Initialize a fresh repo with a known branch name and one commit. */
function initRepo(prefix = 'git-fixture-test-') {
  const dir = createTempDir(prefix);
  gitOrThrow(['init', '--quiet', '-b', 'mainline'], { cwd: dir });
  gitOrThrow(['config', 'user.email', 'git-fixture-test@example.com'], { cwd: dir });
  gitOrThrow(['config', 'user.name', 'git-fixture-test'], { cwd: dir });
  gitOrThrow(['commit', '--allow-empty', '-m', 'initial commit'], { cwd: dir });
  return dir;
}

describe('git-fixture: E — gitOrThrow', () => {
  let dir;

  beforeEach(() => {
    dir = initRepo();
  });

  afterEach(() => {
    cleanup(dir);
  });

  test('E1: returns stdout as a string on success', () => {
    const r = gitOrThrow(['--version'], { cwd: dir });
    assert.equal(typeof r, 'string');
  });

  test('E2: returns real command output', () => {
    const r = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    assert.equal(r.trim(), 'mainline');
  });

  test('E3: throws on non-zero exit', () => {
    assert.throws(() => gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir }));
  });

  test('E4: thrown error exposes .status (legacy execSync idiom)', () => {
    const raw = processSeam.runGit(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir });
    assert.notEqual(raw.exitCode, 0);
    const caught = captureThrown(() =>
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir })
    );
    assert.equal(caught.status, raw.exitCode);
  });

  test('E5: thrown error exposes .exitCode (seam idiom), aliasing .status', () => {
    const caught = captureThrown(() =>
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir })
    );
    assert.equal(caught.exitCode, caught.status);
  });

  test('E6: thrown error carries both streams as strings', () => {
    const caught = captureThrown(() =>
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir })
    );
    assert.equal(typeof caught.stdout, 'string');
    assert.equal(typeof caught.stderr, 'string');
    assert.ok(caught.stderr.length > 0, 'expected git to write a fatal message to stderr');
  });

  test('E7: non-zero exit is EXITED, not a failure outcome', () => {
    const caught = captureThrown(() =>
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir })
    );
    assert.equal(caught.outcome, OUTCOME.EXITED);
    assert.equal(caught.timedOut, false);
  });

  test('E8: spawn failure throws with SPAWN_FAILED', () => {
    const caught = captureThrown(() =>
      gitOrThrow(['--version'], { cwd: path.join(dir, 'no-such-subdirectory') })
    );
    assert.equal(caught.outcome, OUTCOME.SPAWN_FAILED);
  });

  test('E9: gitOrThrow propagates a TIMED_OUT seam result as a throw', () => {
    // Not an integration timeout test: a real `git rev-parse HEAD` racing a
    // 1ms bound is a real-race test (on a warm/unloaded container the
    // command can finish first, spawnSync then reports a clean EXITED with
    // no error, and gitOrThrow correctly does not throw — see #3148). This
    // drives `gitOrThrow` with a synthetic TIMED_OUT result from the
    // `runGit` spy installed at module scope (line 30), so it exercises the
    // exact propagation behavior with zero timing dependence. Deterministic
    // coverage of `throwIfFailed`'s TIMED_OUT branch itself already lives in
    // the `throwIfFailed` describe block below (the `for (const outcome of
    // [OUTCOME.TIMED_OUT, ...])` case).
    runGitSpy.mock.mockImplementationOnce(() => ({
      outcome: OUTCOME.TIMED_OUT,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      signal: 'SIGTERM',
      code: 'ETIMEDOUT',
    }));
    const caught = captureThrown(() => gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }));
    assert.equal(caught.timedOut, true);
    assert.equal(caught.outcome, OUTCOME.TIMED_OUT);
  });

  test('E10: omitted timeout uses the documented default, not silence', () => {
    runGitSpy.mock.resetCalls();
    gitOrThrow(['--version'], { cwd: dir });
    assert.equal(runGitSpy.mock.calls.length, 1);
    assert.equal(runGitSpy.mock.calls[0].arguments[1].timeoutMs, DEFAULT_GIT_TIMEOUT_MS);
    assert.equal(DEFAULT_GIT_TIMEOUT_MS, 15000);
  });

  test('E11: explicit timeoutMs overrides the default', () => {
    runGitSpy.mock.resetCalls();
    gitOrThrow(['--version'], { cwd: dir, timeoutMs: 12345 });
    assert.equal(runGitSpy.mock.calls.length, 1);
    assert.equal(runGitSpy.mock.calls[0].arguments[1].timeoutMs, 12345);
    assert.notEqual(12345, DEFAULT_GIT_TIMEOUT_MS);
  });

  test('E12: shell-string args are rejected', () => {
    assert.throws(() => gitOrThrow('status', { cwd: dir }), TypeError);
  });

  test('E13: argv is never shell-interpreted', () => {
    const marker = path.join(dir, 'PWNED_MARKER');
    // A ref name containing shell metacharacters. spawnSync never invokes a
    // shell, so this whole string reaches git as ONE literal argv element
    // (the candidate ref name) — never tokenized or command-substituted.
    const hostileRef = ';touch ' + marker + ';`id`;$(id)';

    let threw = false;
    try {
      gitOrThrow(['rev-parse', '--verify', hostileRef], { cwd: dir });
    } catch (_e) {
      threw = true;
    }
    assert.ok(threw, 'expected the hostile string to fail resolution as a literal (bad) ref');
    assert.equal(fs.existsSync(marker), false, 'a shell-interpreted argv would have created this file');
  });

  test('E14: string return is toString-compatible', () => {
    const r = gitOrThrow(['--version'], { cwd: dir });
    assert.equal(r.toString(), r);
  });

  test('E15: string return is trim-compatible', () => {
    const r = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    assert.equal(typeof r.trim(), 'string');
    assert.equal(r.trim(), 'mainline');
  });

  test('E16: cwd is forwarded to the seam', () => {
    const otherDir = initRepo('git-fixture-test-other-');
    gitOrThrow(['checkout', '-b', 'other-branch'], { cwd: otherDir });

    const branchInDir = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim();
    const branchInOtherDir = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: otherDir }).trim();

    assert.equal(branchInDir, 'mainline');
    assert.equal(branchInOtherDir, 'other-branch');

    cleanup(otherDir);
  });

  test('E17: env is forwarded to the seam', () => {
    gitOrThrow(
      ['commit', '--allow-empty', '-m', 'env-authored commit'],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Env Author',
          GIT_AUTHOR_EMAIL: 'env-author@example.com',
          GIT_COMMITTER_NAME: 'Env Author',
          GIT_COMMITTER_EMAIL: 'env-author@example.com',
        },
      }
    );
    const author = gitOrThrow(['log', '-1', '--format=%an'], { cwd: dir }).trim();
    assert.equal(author, 'Env Author');
  });
});

/**
 * `throwIfFailed` is exercised only indirectly above (via `gitOrThrow`) and by
 * six other per-suite wrappers elsewhere in the tree. It takes a plain
 * process-seam result object, so it is tested directly here with literal
 * result objects — no subprocess needed.
 */
describe('throwIfFailed', () => {
  /** A minimal clean-exit result, spread over in each test below. */
  const BASE = { stdout: '', stderr: '', signal: null, timedOut: false };

  test('does not throw for outcome=EXITED, exitCode=0', () => {
    assert.doesNotThrow(() => throwIfFailed({ ...BASE, outcome: OUTCOME.EXITED, exitCode: 0 }, 'ok'));
  });

  test('throws when outcome=EXITED but exitCode=1', () => {
    assert.throws(() => throwIfFailed({ ...BASE, outcome: OUTCOME.EXITED, exitCode: 1 }, 'bad'));
  });

  test('throws when outcome=EXITED but exitCode=128', () => {
    assert.throws(() => throwIfFailed({ ...BASE, outcome: OUTCOME.EXITED, exitCode: 128 }, 'bad'));
  });

  for (const outcome of [OUTCOME.TIMED_OUT, OUTCOME.KILLED, OUTCOME.BUFFER_OVERFLOW, OUTCOME.SPAWN_FAILED]) {
    test(`throws for non-EXITED outcome: ${outcome}`, () => {
      assert.throws(() => throwIfFailed({ ...BASE, outcome, exitCode: null }, 'bad'));
    });
  }

  test('boundary: exitCode=0 with a non-EXITED outcome still throws (0 alone is not success)', () => {
    assert.throws(() => throwIfFailed({ ...BASE, outcome: OUTCOME.KILLED, exitCode: 0 }, 'bad'));
  });

  test('thrown error carries .status and .exitCode as equal aliases of the same value', () => {
    const caught = captureThrown(() => throwIfFailed({ ...BASE, outcome: OUTCOME.EXITED, exitCode: 42 }, 'bad'));
    assert.equal(caught.status, 42);
    assert.equal(caught.exitCode, 42);
    assert.equal(caught.status, caught.exitCode);
  });

  test('thrown error carries stdout, stderr, signal, timedOut, outcome from the input result', () => {
    const input = {
      outcome: OUTCOME.KILLED,
      exitCode: null,
      stdout: 'input stdout',
      stderr: 'input stderr',
      signal: 'SIGTERM',
      timedOut: false,
    };
    const caught = captureThrown(() => throwIfFailed(input, 'bad'));
    assert.equal(caught.stdout, input.stdout);
    assert.equal(caught.stderr, input.stderr);
    assert.equal(caught.signal, input.signal);
    assert.equal(caught.timedOut, input.timedOut);
    assert.equal(caught.outcome, input.outcome);
  });

  test('exitCode: null propagates to .status as null, not coerced', () => {
    const caught = captureThrown(() =>
      throwIfFailed({ ...BASE, outcome: OUTCOME.TIMED_OUT, exitCode: null, timedOut: true }, 'bad')
    );
    assert.equal(caught.status, null);
    assert.notEqual(caught.status, undefined);
  });

  test('displayName appears in the thrown error message', () => {
    const caught = captureThrown(() =>
      throwIfFailed({ ...BASE, outcome: OUTCOME.EXITED, exitCode: 1 }, 'my distinctive display name')
    );
    assert.ok(caught.message.includes('my distinctive display name'));
  });
});

/**
 * `toLegacyResult` is the non-throwing sibling of `throwIfFailed` (#3147):
 * a bare mapping onto `{ status, stdout, stderr }`, never throwing. Tested
 * directly with literal result objects — no subprocess needed.
 */
describe('toLegacyResult', () => {
  test('never throws, unlike throwIfFailed, for a non-zero exit', () => {
    assert.doesNotThrow(() =>
      toLegacyResult({ outcome: OUTCOME.EXITED, exitCode: 1, stdout: '', stderr: 'boom' })
    );
  });

  test('maps exitCode to .status (the legacy field name)', () => {
    const r = toLegacyResult({ outcome: OUTCOME.EXITED, exitCode: 1, stdout: 'out', stderr: 'err' });
    assert.equal(r.status, 1);
  });

  test('exitCode: 0 maps to .status: 0, not falsy-coerced', () => {
    const r = toLegacyResult({ outcome: OUTCOME.EXITED, exitCode: 0, stdout: '', stderr: '' });
    assert.equal(r.status, 0);
    assert.notEqual(r.status, undefined);
  });

  test('exitCode: null (non-EXITED outcome) propagates to .status as null, not coerced', () => {
    const r = toLegacyResult({ outcome: OUTCOME.TIMED_OUT, exitCode: null, stdout: '', stderr: '' });
    assert.equal(r.status, null);
    assert.notEqual(r.status, undefined);
  });

  test('stdout and stderr pass through unchanged', () => {
    const r = toLegacyResult({ outcome: OUTCOME.EXITED, exitCode: 0, stdout: 'the stdout', stderr: 'the stderr' });
    assert.equal(r.stdout, 'the stdout');
    assert.equal(r.stderr, 'the stderr');
  });

  test('returns exactly the three legacy fields, nothing extra from the seam result', () => {
    const r = toLegacyResult({
      outcome: OUTCOME.EXITED,
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      timedOut: false,
      killed: false,
      code: null,
    });
    assert.deepEqual(Object.keys(r).sort(), ['status', 'stderr', 'stdout']);
  });
});

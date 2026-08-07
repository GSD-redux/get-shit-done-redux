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

const { gitOrThrow, DEFAULT_GIT_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

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
    let caught;
    try {
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw');
    assert.equal(caught.status, raw.exitCode);
  });

  test('E5: thrown error exposes .exitCode (seam idiom), aliasing .status', () => {
    let caught;
    try {
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw');
    assert.equal(caught.exitCode, caught.status);
  });

  test('E6: thrown error carries both streams as strings', () => {
    let caught;
    try {
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw');
    assert.equal(typeof caught.stdout, 'string');
    assert.equal(typeof caught.stderr, 'string');
    assert.ok(caught.stderr.length > 0, 'expected git to write a fatal message to stderr');
  });

  test('E7: non-zero exit is EXITED, not a failure outcome', () => {
    let caught;
    try {
      gitOrThrow(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw');
    assert.equal(caught.outcome, OUTCOME.EXITED);
    assert.equal(caught.timedOut, false);
  });

  test('E8: spawn failure throws with SPAWN_FAILED', () => {
    let caught;
    try {
      gitOrThrow(['--version'], { cwd: path.join(dir, 'no-such-subdirectory') });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw');
    assert.equal(caught.outcome, OUTCOME.SPAWN_FAILED);
  });

  test('E9: timeout throws and reports timedOut', () => {
    let caught;
    try {
      gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 1 });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected gitOrThrow to throw on a 1ms timeout');
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

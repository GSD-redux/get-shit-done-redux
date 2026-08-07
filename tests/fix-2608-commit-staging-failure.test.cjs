/**
 * Regression tests for #2608 — `query commit --files` ignored `git add` failures
 * and misreported them.
 *
 * A `git add` that fails (unwritable index in a linked worktree whose git dir is
 * outside the managed writable root, permissions, timeout) was not surfaced.
 * #2523 had already stopped a failed path entering the commit pathspec, but
 * skipping it silently left two bad outcomes, both reproduced by this suite
 * against the pre-fix build:
 *
 *   - SOME paths fail  -> `{"committed":true}`. `git commit` still ran and
 *                         PARTIALLY committed the subset that happened to stage,
 *                         under a message describing the full requested scope.
 *   - EVERY path fails -> `{"reason":"nothing_to_commit"}`, which is not what
 *                         happened and points the operator nowhere.
 *
 * In both cases the original `git add` stderr was discarded, so the user saw a
 * downstream `commit_failed` / pathspec error naming an innocent file.
 *
 * The fix collects staging failures and fails closed BEFORE `git commit` runs,
 * returning `staging_failed` (or `staging_timeout`) with the offending file and
 * the original stderr preserved.
 *
 * ── INJECTION SEAM ────────────────────────────────────────────────────────────
 * `execGit` is monkeypatched on the shell-command-projection module object. The
 * compiled call site is `(0, mod.execGit)(...)` — a property lookup at call time
 * — so the override takes effect. Per CLAUDE.md this is required over
 * `chmod 0o000` permission tricks, which do not fault under root (root
 * Docker/CI) and would make these tests silently vacuous.
 *
 * The patched call runs in a short-lived `node -e` CHILD rather than in-process,
 * for two reasons: `output()` writes with `fs.writeSync(1, …)`, which neither
 * `process.stdout.write` nor `console.log` interception can capture; and a child
 * keeps the patch from leaking into sibling suites. It is a plain
 * `process.execPath` spawn — no PATH stub and no exec bit, so it is not subject
 * to DEFECT.WINDOWS-TEST-PORTABILITY and runs on every platform.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

// 5000ms: git plumbing (add/commit/status/rev-parse/rev-list/diff) on a small
// mkdtemp fixture repo — well over any observed duration for that class of call.
const GIT_TIMEOUT_MS = 5000;

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

/**
 * Run cmdCommit with `git add <file>` forced to fail for the paths in `failFor`,
 * returning the parsed JSON result and the git argv list that was actually
 * executed (so "git commit never ran" is asserted directly, not inferred).
 */
function commitWithFailingAdd({ cwd, files, failFor = [], stderr = 'fatal: injected staging failure', timeout = false, amend = false, gitVerb = 'add' }) {
  const callsOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2608-')), 'calls.json');
  // `timeout` is `false` | `true` (alias for `'posix'`) | `'posix'` | `'windows'` —
  // #3050: the shared isSpawnTimeout predicate only requires `error.code ===
  // 'ETIMEDOUT'`, NOT `signal === 'SIGTERM'` (Windows does not reliably report
  // SIGTERM), so both shapes must be proven to still read as a timeout.
  const timeoutShape = timeout === true ? 'posix' : timeout;
  const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommit } = require(path.join(LIB, 'commands.cjs'));
const failFor = ${JSON.stringify(failFor)};
const stderrText = ${JSON.stringify(stderr)};
const timeoutShape = ${JSON.stringify(timeoutShape)};
const gitVerb = ${JSON.stringify(gitVerb)};
const real = projection.execGit;
const calls = [];
projection.execGit = (args, opts) => {
  calls.push(args);
  if (args[0] === gitVerb && failFor.includes(args[args.length - 1])) {
    if (timeoutShape === 'posix') {
      // The exact shape spawnSync produces on a POSIX timeout, which
      // shell-command-projection surfaces as signal + error.code.
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: stderrText, signal: 'SIGTERM', error: e };
    }
    if (timeoutShape === 'windows') {
      // Windows shape: spawnSync's timeout kill does not reliably report
      // signal:'SIGTERM' — only error.code:'ETIMEDOUT' is guaranteed (#3050).
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: stderrText, signal: null, error: e };
    }
    return { exitCode: 128, stdout: '', stderr: stderrText, signal: null, error: null };
  }
  return real(args, opts);
};
process.on('exit', () => {
  require('fs').writeFileSync(${JSON.stringify(callsOut)}, JSON.stringify(calls));
});
cmdCommit(${JSON.stringify(cwd)}, 'docs: map existing codebase', ${JSON.stringify(files)}, false, ${JSON.stringify(amend)}, false);
`;

  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });

  assert.ok(
    run.stdout && run.stdout.trim(),
    `cmdCommit child produced no stdout (status=${run.status}): ${run.stderr}`,
  );
  return {
    result: JSON.parse(run.stdout),
    gitCalls: JSON.parse(fs.readFileSync(callsOut, 'utf8')),
  };
}

function headCount(cwd) {
  return Number(gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).trim());
}

function committedFiles(cwd) {
  return gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    .trim().split('\n').filter(Boolean).sort();
}

/**
 * Same harness for `cmdCommitToSubrepo` — the sub-repo twin of the staging loop,
 * which carried the identical defect (failed `git add` dropped, commit proceeds
 * with the subset that staged).
 */
function subrepoCommitWithFailingAdd({ cwd, files, failFor = [], timeout = false }) {
  // See commitWithFailingAdd above for the timeoutShape rationale (#3050).
  const timeoutShape = timeout === true ? 'posix' : timeout;
  const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommitToSubrepo } = require(path.join(LIB, 'commands.cjs'));
const failFor = ${JSON.stringify(failFor)};
const timeoutShape = ${JSON.stringify(timeoutShape)};
const real = projection.execGit;
projection.execGit = (args, opts) => {
  if (args[0] === 'add' && failFor.includes(args[args.length - 1])) {
    if (timeoutShape === 'posix') {
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: 'SIGTERM', error: e };
    }
    if (timeoutShape === 'windows') {
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      return { exitCode: 1, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: null, error: e };
    }
    return { exitCode: 128, stdout: '', stderr: 'fatal: injected subrepo staging failure', signal: null, error: null };
  }
  return real(args, opts);
};
cmdCommitToSubrepo(${JSON.stringify(cwd)}, 'feat: subrepo change', ${JSON.stringify(files)}, false);
`;
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GSD_TEST_MODE: '1' },
  });
  assert.ok(run.stdout && run.stdout.trim(),
    `cmdCommitToSubrepo child produced no stdout (status=${run.status}): ${run.stderr}`);
  return JSON.parse(run.stdout);
}

describe('#2608: commit-to-subrepo fails closed when git add fails', () => {
  let rootDir;
  let subDir;

  beforeEach(() => {
    rootDir = createTempGitProject();
    fs.writeFileSync(
      path.join(rootDir, '.planning', 'config.json'),
      JSON.stringify({ planning: { sub_repos: ['backend'] } }, null, 2),
    );
    subDir = path.join(rootDir, 'backend');
    fs.mkdirSync(subDir, { recursive: true });
    for (const [cmd, args] of [['init', []], ['config', ['user.email', 'test@example.com']], ['config', ['user.name', 'Test']]]) {
      gitOrThrow([cmd, ...args], { cwd: subDir, timeoutMs: GIT_TIMEOUT_MS });
    }
    fs.writeFileSync(path.join(subDir, 'seed.js'), '// seed\n');
    gitOrThrow(['add', 'seed.js'], { cwd: subDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: subDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(subDir, 'a.js'), '// a\n');
    fs.writeFileSync(path.join(subDir, 'b.js'), '// b\n');
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  test('a failed sub-repo git add reports staging_failed and commits nothing', () => {
    const before = headCount(subDir);
    const result = subrepoCommitWithFailingAdd({
      cwd: rootDir,
      files: ['backend/a.js', 'backend/b.js'],
      failFor: ['b.js'],
    });

    assert.equal(result.repos.backend.reason, 'staging_failed',
      `expected staging_failed for the sub-repo, got ${JSON.stringify(result)}`);
    assert.equal(result.repos.backend.committed, false);
    assert.match(result.repos.backend.error, /injected subrepo staging failure/,
      "git's original stderr must be preserved");
    assert.equal(headCount(subDir), before, 'no partial sub-repo commit may be created');

    const status = gitOrThrow(['status', '--porcelain'], { cwd: subDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.deepEqual(status.split('\n').filter((l) => /^A[ \t]/.test(l)), [],
      `the sub-repo index must be rolled back, status:\n${status}`);
  });

  test('successful sub-repo staging still commits', () => {
    const before = headCount(subDir);
    const result = subrepoCommitWithFailingAdd({
      cwd: rootDir,
      files: ['backend/a.js', 'backend/b.js'],
      failFor: [],
    });

    assert.equal(result.repos.backend.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.equal(headCount(subDir), before + 1);
  });
});

describe('#2608: commit --files fails closed when git add fails', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    for (const name of ['ARCHITECTURE', 'CONCERNS', 'CONVENTIONS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', `${name}.md`), `# ${name}\n`);
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── AC1 + AC3: the failure is reported, with its original stderr ──────────

  test('a failed git add returns staging_failed with the file and original stderr', () => {
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: 'fatal: Unable to create index.lock: Permission denied',
    });

    assert.equal(result.committed, false);
    assert.equal(result.hash, null);
    assert.equal(result.reason, 'staging_failed',
      'the staging cause must be reported, not a downstream commit_failed/pathspec error');
    assert.equal(result.file, '.planning/ARCHITECTURE.md', 'the offending file must be named');
    assert.match(result.error, /Unable to create index\.lock/,
      'the original git add stderr must be preserved');

    // AC2: git commit must never have been invoked.
    assert.ok(
      !gitCalls.some((a) => a[0] === 'commit'),
      `git commit must not run after a staging failure, calls: ${JSON.stringify(gitCalls)}`,
    );
    assert.equal(headCount(tmpDir), before, 'no commit may be created');
  });

  // ── AC4: no partial commit of a multi-file explicit scope ─────────────────

  test('when the second of three paths fails to stage, nothing is committed', () => {
    // Pre-fix this returned {"committed":true} — the two paths that DID stage
    // were committed under a message describing all three.
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.equal(result.file, '.planning/CONCERNS.md');
    assert.ok(
      !gitCalls.some((a) => a[0] === 'commit'),
      'a partial commit of the paths that DID stage must not happen',
    );
    assert.equal(headCount(tmpDir), before, 'no partial commit may be created');
  });

  test('every failing path is reported, not just the first', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/ARCHITECTURE.md', '.planning/CONVENTIONS.md'],
    });

    assert.equal(result.failures.length, 2);
    assert.deepEqual(
      result.failures.map((f) => f.file).sort(),
      ['.planning/ARCHITECTURE.md', '.planning/CONVENTIONS.md'],
    );
  });

  // ── An all-paths-fail run must not masquerade as nothing_to_commit ────────

  test('when every path fails to stage, the reason is staging_failed not nothing_to_commit', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
    });

    assert.notEqual(result.reason, 'nothing_to_commit',
      'every path failing to stage is a staging failure, not an empty changeset');
    assert.equal(result.reason, 'staging_failed');
  });

  // ── AC5: a staging timeout is distinguishable from an ordinary failure ────

  test('a staging timeout is reported as staging_timeout, not staging_failed', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: '',
      timeout: true,
    });

    assert.equal(result.reason, 'staging_timeout',
      'the projection exposes SIGTERM+ETIMEDOUT; a timeout must not read as an ordinary failure');
    assert.equal(result.failures[0].timed_out, true);
  });

  // #3050 item 4: this site (commands.cts's `git add` staging loop) now routes
  // through the shared isSpawnTimeout predicate, which drops the `signal ===
  // 'SIGTERM'` requirement — a Windows-shaped timeout (no signal, only
  // error.code === 'ETIMEDOUT') must still be detected.
  test('a staging timeout is reported as staging_timeout even without SIGTERM (Windows shape, #3050)', () => {
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
      stderr: '',
      timeout: 'windows',
    });

    assert.equal(result.reason, 'staging_timeout');
    assert.equal(result.failures[0].timed_out, true);
  });

  // #3050 item 4: the `git rm --cached` branch of the same staging loop (the
  // default-mode "stage the deletion" path, distinct from `git add` above)
  // carries its own inline copy of the timeout check pre-fix. Drive it
  // directly: default mode (no explicit --files) stages '.planning/', and
  // when that path is absent on disk the loop takes the `git rm --cached`
  // branch instead of `git add`.
  test('a `git rm --cached` timeout in default mode is reported as staging_timeout, POSIX and Windows shapes (#3050)', () => {
    // Mid-test fixture mutation (simulating an absent '.planning/' on disk),
    // not teardown; the outer afterEach still runs helpers.cleanup(tmpDir) on
    // the whole tmpDir.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- see comment above
    fs.rmSync(path.join(tmpDir, '.planning'), { recursive: true, force: true });

    for (const shape of ['posix', 'windows']) {
      const { result } = commitWithFailingAdd({
        cwd: tmpDir,
        files: undefined,
        failFor: ['.planning/'],
        gitVerb: 'rm',
        stderr: '',
        timeout: shape,
      });

      assert.equal(result.reason, 'staging_timeout', `shape=${shape}`);
      assert.equal(result.failures[0].timed_out, true, `shape=${shape}`);
    }
  });

  test('an ordinary non-zero git add is NOT reported as a timeout', () => {
    // Boundary: the timeout carve-out must not swallow the ordinary case.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md'],
      failFor: ['.planning/ARCHITECTURE.md'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.equal(result.failures[0].timed_out, false);
  });

  // ── Successful staging preserves the current scoped-commit behaviour ──────

  test('successful staging still commits exactly the declared scope', () => {
    const before = headCount(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'unrelated-wip.txt'), 'wip\n');
    gitOrThrow(['add', 'unrelated-wip.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: [],
    });

    assert.equal(result.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.equal(result.reason, 'committed');
    assert.equal(headCount(tmpDir), before + 1);
    assert.deepEqual(
      committedFiles(tmpDir),
      ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      'the declared scope must still be honoured, and the unrelated staged file left alone',
    );
  });

  // ── Missing explicit files keep their existing documented handling ────────

  test('a missing explicit file is still skipped, not reported as a staging failure', () => {
    // #2014/#2523 behaviour: an explicitly-named file that does not exist is
    // skipped rather than staged as a deletion. It never reaches `git add`, so
    // it is not a staging failure and must not become one.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/DOES-NOT-EXIST.md'],
      failFor: [],
    });

    assert.equal(result.committed, true, `expected a commit, got ${JSON.stringify(result)}`);
    assert.deepEqual(committedFiles(tmpDir), ['.planning/ARCHITECTURE.md']);
  });

  // ── The index must be left clean, not partially staged ───────────────────

  test('a staging failure rolls back the paths this call had already staged', () => {
    // Without the rollback the paths that DID stage stay in the index with no
    // commit made, so the next bare `git commit` sweeps them up — the same
    // silent partial commit this fix exists to prevent, just deferred a step.
    commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md', '.planning/CONVENTIONS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    const stagedAdds = status.split('\n').filter((l) => /^A[ \t]/.test(l));
    assert.deepEqual(stagedAdds, [],
      `no path may remain staged after a staging failure, status:\n${status}`);
  });

  test('the rollback does not unstage work the caller had staged before the call', () => {
    // Boundary: the reset must touch only what THIS call staged. Unstaging a
    // path the caller staged themselves would destroy their work.
    fs.writeFileSync(path.join(tmpDir, 'caller-staged.txt'), 'mine\n');
    gitOrThrow(['add', 'caller-staged.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.match(status, /^A[ \t]+caller-staged\.txt$/m,
      `the caller's own staged file must survive the rollback, status:\n${status}`);
  });

  // ── The default (non---files) staging path is guarded too ─────────────────

  test('a failed default-mode git add fails closed instead of committing the index', () => {
    // Default mode stages `.planning/`. Pre-fix a failure there also fell
    // through to an unguarded `git commit`.
    const before = headCount(tmpDir);
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: undefined,
      failFor: ['.planning/'],
    });

    assert.equal(result.reason, 'staging_failed');
    assert.ok(!gitCalls.some((a) => a[0] === 'commit'), 'git commit must not run');
    assert.equal(headCount(tmpDir), before);
  });

  test('a failed default-mode git add blocks --amend too', () => {
    // --amend has no carve-out: amending on top of a failed staging would
    // rewrite the tip without the changes the caller asked for.
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: undefined,
      failFor: ['.planning/'],
      amend: true,
    });

    assert.equal(result.reason, 'staging_failed');
    assert.ok(!gitCalls.some((a) => a[0] === 'commit'), 'git commit --amend must not run');
    assert.equal(
      gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(),
      before,
      'HEAD must not be rewritten when staging failed',
    );
  });

  test('when all explicit files are missing the reason is still nothing_to_commit', () => {
    // The nothing_to_commit path must survive: no `git add` ran, so there is no
    // staging failure to report.
    const { result } = commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/GONE-A.md', '.planning/GONE-B.md'],
      failFor: [],
    });

    assert.equal(result.reason, 'nothing_to_commit');
  });
});

/**
 * Regression test for #2112: gsd-tools commit --files commits the entire
 * index, not the declared paths.
 *
 * `cmdCommit` staged exactly the files named in --files but then ran a bare
 * `git commit` with no pathspec, absorbing anything else that happened to be
 * staged into a commit whose message described only the named files.
 *
 * The fix adds `'--', ...stagedPaths` to the commit args **only when** the
 * caller declared a scope (explicitFiles), and only for paths that were
 * actually staged (skipped missing files are excluded to avoid #2014).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

describe('commit --files: pathspec honors declared scope (#2112)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('commit --files does not absorb unrelated staged files', () => {
    // Developer stages a WIP file via git add (not via --files).
    fs.writeFileSync(path.join(tmpDir, 'src-wip.txt'), 'work in progress\n');
    gitOrThrow(['add', 'src-wip.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    // GSD writes and commits a planning artifact, naming ONLY that file.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    runGsdTools(
      ['commit', 'docs(01): add PLAN.md', '--files', '.planning/PLAN.md'],
      tmpDir,
    );

    // The commit must contain ONLY .planning/PLAN.md.
    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.strictEqual(
      diffOutput,
      '.planning/PLAN.md',
      'commit --files must contain only the named files, got:\n' + diffOutput,
    );

    // The WIP file must still be staged, not committed.
    const statusOutput = gitOrThrow(['status', '--porcelain'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.ok(
      statusOutput.includes('A  src-wip.txt') || statusOutput.includes('A\tsrc-wip.txt'),
      'src-wip.txt should remain staged, not committed. Status:\n' + statusOutput,
    );
  });

  test('commit --files with two files commits exactly those two', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'RESEARCH.md'), '# Research\n');

    runGsdTools(
      ['commit', 'docs: artifacts', '--files', '.planning/PLAN.md', '.planning/RESEARCH.md'],
      tmpDir,
    );

    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.deepEqual(
      files,
      ['.planning/PLAN.md', '.planning/RESEARCH.md'],
      'commit should contain exactly the two named files',
    );
  });

  test('commit without --files still commits the entire .planning/ index (default path)', () => {
    // Write a planning artifact and stage it.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');
    gitOrThrow(['add', '.planning/PLAN.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    // Also stage an unrelated file.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    gitOrThrow(['add', 'extra.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    runGsdTools(['commit', 'docs: default commit'], tmpDir);

    // Default path (no --files) commits everything staged.
    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const files = diffOutput.trim().split('\n').sort();
    assert.ok(
      files.includes('.planning/PLAN.md') && files.includes('extra.txt'),
      'default commit (no --files) should commit everything staged, got:\n' + files,
    );
  });

  test('missing tracked file in --files is still not committed as deletion (#2014 guard)', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Also create a valid file to commit.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PLAN.md'), '# Plan\n');

    runGsdTools(
      ['commit', 'docs: add plan', '--files', '.planning/PLAN.md', '.planning/STATE.md'],
      tmpDir,
    );

    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-status'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    assert.ok(
      !diffOutput.includes('D\t.planning/STATE.md'),
      'missing tracked file must not appear as a deletion, diff was:\n' + diffOutput,
    );
    assert.ok(
      diffOutput.includes('.planning/PLAN.md'),
      'PLAN.md should be committed',
    );
  });

  test('commit --files with only missing files returns nothing_to_commit', () => {
    // Create and commit STATE.md, then remove it from disk.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Stage an unrelated file so the index is non-empty.
    fs.writeFileSync(path.join(tmpDir, 'extra.txt'), 'extra\n');
    gitOrThrow(['add', 'extra.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });

    const result = runGsdTools(
      ['commit', 'docs: try', '--files', '.planning/STATE.md'],
      tmpDir,
    );

    const parsed = JSON.parse(result.output);
    assert.strictEqual(
      parsed.committed, false,
      'should not commit when all --files are missing',
    );
    assert.strictEqual(
      parsed.reason, 'nothing_to_commit',
      'should report nothing_to_commit, not absorb the index',
    );

    // The unrelated staged file must still be staged, not committed.
    const statusOutput = gitOrThrow(['status', '--porcelain'], {
      cwd: tmpDir,
      timeoutMs: GIT_TIMEOUT_MS,
    }).trim();
    assert.ok(
      statusOutput.includes('extra.txt'),
      'extra.txt should remain staged, not absorbed into a commit',
    );
  });

  test('#2523: absolute --files path inside the repo is committed, not silently dropped', () => {
    // init phase-op emits phase_dir as an ABSOLUTE path (#2428); cmdCommit must
    // accept it. The bug was path.join(cwd, absPath) → cwd+absPath (non-existent)
    // → silently skipped as nothing_to_commit (#2523).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'A.md'), 'a\n');
    const absPath = path.join(tmpDir, '.planning', 'A.md');
    const res = runGsdTools(['commit', 'docs: abs path', '--files', absPath], tmpDir);
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, true, `absolute path must commit, not nothing_to_commit: ${res.output}`);

    // The absolute path must land in the commit, normalized to repo-relative.
    const diff = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(diff, '.planning/A.md', `absolute --files path must be committed (normalized to relative); got: ${diff}`);
  });

  test('#2523: mixed relative+absolute --files list commits BOTH (no silent partial commit)', () => {
    // The sharpest symptom: a mixed list committed the relative entry, dropped the
    // absolute one, and reported committed:true (#2523). Both must land.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REL.md'), 'r\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ABS.md'), 'a\n');
    const absPath = path.join(tmpDir, '.planning', 'ABS.md');
    const res = runGsdTools(
      ['commit', 'docs: mixed', '--files', '.planning/REL.md', absPath],
      tmpDir,
    );
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, true, `mixed list must commit: ${res.output}`);

    const diff = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS })
      .trim().split('\n').sort();
    assert.deepStrictEqual(
      diff,
      ['.planning/ABS.md', '.planning/REL.md'],
      `mixed relative+absolute list must commit BOTH entries (the bug dropped the absolute one); got: ${diff.join(',')}`,
    );
  });

  test('#2523: out-of-repo --files path is rejected by git (staging_failed), no index pollution', (t) => {
    // An absolute path resolving OUTSIDE the project root: git add rejects it. No
    // index pollution (#2523). Not "path_outside_repo" (that guard was removed for
    // macOS symlink compatibility — git's own rejection suffices).
    //
    // #2608 changed the REASON this reports, deliberately. It used to be
    // `nothing_to_commit`, because a failed `git add` was skipped and the empty
    // stagedPaths list fell through to the empty-changeset branch. But "nothing to
    // commit" is not what happened — the caller named a file and git refused it —
    // and that misreport is the very class of defect #2608 closes. The result now
    // carries `staging_failed` plus the offending path and git's own message
    // ("… is outside repository at …"), which is strictly more actionable.
    //
    // #2523's two substantive invariants are unchanged and still asserted below:
    // no commit is created, and the index is left clean.
    const outsideDir = path.join(tmpDir, '..', `gsd-2523-outside-${process.pid}-${Date.now()}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    t.after(() => cleanup(outsideDir));
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 's\n');

    const res = runGsdTools(
      ['commit', 'docs: outside', '--files', path.resolve(outsideFile)],
      tmpDir,
    );
    const parsed = JSON.parse(res.output);
    assert.strictEqual(parsed.committed, false, 'out-of-repo path must not commit');
    assert.strictEqual(parsed.reason, 'staging_failed', `out-of-repo: git rejects → staging_failed (#2608): ${res.output}`);
    assert.strictEqual(parsed.file, path.resolve(outsideFile), 'the rejected path must be named');
    assert.match(parsed.error, /outside repository/, "git's own rejection message must be preserved (#2608)");

    // No new commit created (still at the single initial commit).
    const logCount = gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(logCount, '1', 'no new commit must be created for an out-of-repo path');
    // Index stays clean (git add failed → nothing staged).
    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(status, '', `index must be clean (no pollution): ${status}`);
  });
});

/**
 * ── #2608: commit --files / commit-to-subrepo fail closed when `git add`
 * fails ──────────────────────────────────────────────────────────────────
 *
 * A `git add` that fails (unwritable index in a linked worktree whose git
 * dir is outside the managed writable root, permissions, timeout) was not
 * surfaced. #2523 above had already stopped a failed path entering the
 * commit pathspec, but skipping it silently left two bad outcomes, both
 * reproduced by this suite against the pre-fix build:
 *
 *   - SOME paths fail  -> `{"committed":true}`. `git commit` still ran and
 *                         PARTIALLY committed the subset that happened to
 *                         stage, under a message describing the full
 *                         requested scope.
 *   - EVERY path fails -> `{"reason":"nothing_to_commit"}`, which is not
 *                         what happened and points the operator nowhere.
 *
 * In both cases the original `git add` stderr was discarded, so the user
 * saw a downstream `commit_failed` / pathspec error naming an innocent
 * file.
 *
 * The fix collects staging failures and fails closed BEFORE `git commit`
 * runs, returning `staging_failed` (or `staging_timeout`) with the
 * offending file and the original stderr preserved.
 *
 * ── INJECTION SEAM ──────────────────────────────────────────────────────
 * `execGit` is monkeypatched on the shell-command-projection module object.
 * The compiled call site is `(0, mod.execGit)(...)` — a property lookup at
 * call time — so the override takes effect. Per CLAUDE.md this is required
 * over `chmod 0o000` permission tricks, which do not fault under root (root
 * Docker/CI) and would make these tests silently vacuous.
 *
 * The patched call runs in a short-lived `node -e` CHILD rather than
 * in-process, for two reasons: `output()` writes with `fs.writeSync(1, …)`,
 * which neither `process.stdout.write` nor `console.log` interception can
 * capture; and a child keeps the patch from leaking into sibling suites. It
 * is a plain `process.execPath` spawn — no PATH stub and no exec bit, so it
 * is not subject to DEFECT.WINDOWS-TEST-PORTABILITY and runs on every
 * platform.
 */

// Git plumbing (add/commit/status/rev-parse/rev-list/diff) on a small
// mkdtemp fixture repo, for the #2608 suite below only. Kept as its own
// local constant (distinct from the shared GIT_TIMEOUT_MS imported above)
// per helpers/timeouts.cjs's own guidance: a call site whose class
// genuinely differs keeps its own justified value rather than forcing a
// shared norm that doesn't describe it — 5000ms here vs. 15000ms for the
// shared DEFAULT_GIT_TIMEOUT_MS norm.
const STAGING_GIT_TIMEOUT_MS = 5000;

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
  return Number(gitOrThrow(['rev-list', '--count', 'HEAD'], { cwd, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim());
}

function committedFiles(cwd) {
  return gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd, timeoutMs: STAGING_GIT_TIMEOUT_MS })
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
      gitOrThrow([cmd, ...args], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    }
    fs.writeFileSync(path.join(subDir, 'seed.js'), '// seed\n');
    gitOrThrow(['add', 'seed.js'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
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

    const status = gitOrThrow(['status', '--porcelain'], { cwd: subDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
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
    gitOrThrow(['add', 'unrelated-wip.txt'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

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

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    const stagedAdds = status.split('\n').filter((l) => /^A[ \t]/.test(l));
    assert.deepEqual(stagedAdds, [],
      `no path may remain staged after a staging failure, status:\n${status}`);
  });

  test('the rollback does not unstage work the caller had staged before the call', () => {
    // Boundary: the reset must touch only what THIS call staged. Unstaging a
    // path the caller staged themselves would destroy their work.
    fs.writeFileSync(path.join(tmpDir, 'caller-staged.txt'), 'mine\n');
    gitOrThrow(['add', 'caller-staged.txt'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    commitWithFailingAdd({
      cwd: tmpDir,
      files: ['.planning/ARCHITECTURE.md', '.planning/CONCERNS.md'],
      failFor: ['.planning/CONCERNS.md'],
    });

    const status = gitOrThrow(['status', '--porcelain'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
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
    const before = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim();
    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: undefined,
      failFor: ['.planning/'],
      amend: true,
    });

    assert.equal(result.reason, 'staging_failed');
    assert.ok(!gitCalls.some((a) => a[0] === 'commit'), 'git commit --amend must not run');
    assert.equal(
      gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim(),
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

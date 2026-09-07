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
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { execFileSync } = require('node:child_process');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  bareCommandName, tokenize, shellDashCPayloads, commentPortion,
  ISSUE_REF_RE, declarationReason, isDeclared, isUntrackedDeclaration,
} = require('./helpers/shipped-command-scan.cjs');

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
function commitWithFailingAdd({ cwd, files, failFor = [], stderr = 'fatal: injected staging failure', timeout = false, amend = false, gitVerb = 'add', matchArg = null }) {
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
const matchArg = ${JSON.stringify(matchArg)};
const real = projection.execGit;
const calls = [];
projection.execGit = (args, opts) => {
  calls.push(args);
  if (args[0] === gitVerb && (matchArg === null || args.includes(matchArg)) && failFor.includes(args[args.length - 1])) {
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

describe('#3859: an unanswered sequencer probe must not open the empty-diff guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // `execGit` reports a spawn timeout as `exitCode: 1` (`_spawnResult`:
  // `result.status ?? 1`) — byte-identical to the code `rev-parse --verify`
  // returns for a ref that does not exist. So "the probe says no merge" and
  // "the probe never answered" are the same value, and the #3776 guard read
  // both as "no merge". These arms pin the conservative reading.
  //
  // The seam is `commitWithFailingAdd`'s injected `execGit` with
  // `gitVerb: 'rev-parse'`: `args[0]` is `rev-parse` and `args[args.length-1]`
  // is the ref, so `failFor: ['MERGE_HEAD']` selects exactly that one probe and
  // leaves every other git call real.

  // Leaves a conflicted merge or cherry-pick in progress with `bystander`
  // committed and unmodified — the empty-diff shape that reaches the guard.
  const BYSTANDER = path.posix.join('.planning', 'bystander.md');
  function conflictedSequence(kind) {
    const shared = path.posix.join('.planning', 'shared.md');
    fs.writeFileSync(path.join(tmpDir, shared), 'base\n');
    fs.writeFileSync(path.join(tmpDir, BYSTANDER), 'bystander\n');
    gitOrThrow(['add', '--', shared, BYSTANDER], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'shared base'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    const trunk = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim();
    gitOrThrow(['checkout', '-b', 'side'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(tmpDir, shared), 'side\n');
    gitOrThrow(['commit', '-am', 'side edit'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['checkout', trunk], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(tmpDir, shared), 'trunk\n');
    gitOrThrow(['commit', '-am', 'trunk edit'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    // Deliberately conflicting — that is what leaves the sequencer ref behind.
    spawnSync('git', [kind === 'merge' ? 'merge' : 'cherry-pick', 'side'], {
      cwd: tmpDir, encoding: 'utf8', timeout: STAGING_GIT_TIMEOUT_MS,
    });
    fs.writeFileSync(path.join(tmpDir, shared), 'resolved\n');
    gitOrThrow(['add', '--', shared], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
  }

  for (const shape of ['posix', 'windows']) {
    test(`a timed-out MERGE_HEAD probe (${shape}) reaches git instead of silently abandoning the merge`, () => {
      conflictedSequence('merge');
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'MERGE_HEAD')),
        'fixture must leave a merge in progress');

      const { result, gitCalls } = commitWithFailingAdd({
        cwd: tmpDir,
        files: [BYSTANDER],
        failFor: ['MERGE_HEAD'],
        gitVerb: 'rev-parse',
        timeout: shape,
      });

      assert.notEqual(result.reason, 'nothing_to_commit',
        'an unanswered merge probe must not be read as "no merge in progress" — doing so decides '
        + 'nothing_to_commit from a pathspec git will not honour and leaves the merge unconcluded');
      assert.equal(result.reason, 'commit_failed',
        'git must be the one to refuse the partial commit, loudly, as it did before #3776');
      assert.ok(gitCalls.some((a) => a[0] === 'commit'),
        'the guard must fall through to git commit rather than returning early');
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'MERGE_HEAD')),
        'the merge must still be in progress — silently abandoning it is the defect');
    });
  }

  test('a timed-out CHERRY_PICK_HEAD probe reaches git too', () => {
    conflictedSequence('cherry-pick');
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'CHERRY_PICK_HEAD')),
      'fixture must leave a cherry-pick in progress');

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [BYSTANDER],
      failFor: ['CHERRY_PICK_HEAD'],
      gitVerb: 'rev-parse',
      timeout: true,
    });

    assert.notEqual(result.reason, 'nothing_to_commit',
      'the cherry-pick probe carries the identical conflation — #3776 added it, so it is in scope here');
    assert.equal(result.reason, 'commit_failed');
    assert.ok(gitCalls.some((a) => a[0] === 'commit'));
    assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'CHERRY_PICK_HEAD')),
      'the cherry-pick must still be in progress');
  });

  // THE ADAPTATION, PINNED. The obvious implementation — treat the timeout as
  // `isMergeInProgress` — also flips `canScope`, which is PRE-EXISTING and
  // gates the pathspec. A spurious timeout would then turn a scoped commit into
  // a bare one and record whatever else happened to be staged, under a message
  // describing only the named file: #2112, reintroduced by the fix for a
  // misreport. The timeout must reach `partialCommitRefused` and nothing else.
  test('a timed-out MERGE_HEAD probe outside a merge still commits ONLY the named paths', () => {
    const named = path.posix.join('.planning', 'named.md');
    const unrelated = path.posix.join('.planning', 'unrelated.md');
    fs.writeFileSync(path.join(tmpDir, named), 'seed\n');
    fs.writeFileSync(path.join(tmpDir, unrelated), 'seed\n');
    gitOrThrow(['add', '--', named, unrelated], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    // A real change to the named file, and an UNRELATED file sitting staged in
    // the index — the #2112 shape a bare commit would sweep up.
    fs.writeFileSync(path.join(tmpDir, named), 'named edit\n');
    fs.writeFileSync(path.join(tmpDir, unrelated), 'unrelated edit\n');
    gitOrThrow(['add', '--', unrelated], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [named],
      failFor: ['MERGE_HEAD'],
      gitVerb: 'rev-parse',
      timeout: true,
    });

    assert.equal(result.committed, true, 'the commit must still happen — there is a real diff');
    const commitCall = gitCalls.find((a) => a[0] === 'commit');
    assert.ok(commitCall, 'git commit must have run');
    assert.ok(commitCall.includes('--') && commitCall.includes(named),
      'the pathspec must survive the timeout: routing it through isMergeInProgress would drop it');
    assert.deepEqual(committedFiles(tmpDir), [named],
      'only the named path may land — the staged unrelated file must not be swept in (#2112)');
  });

  // NEGATIVE CONTROL for the conservative reading: outside a merge, treating an
  // unanswered probe as "refused" must not manufacture a DIFFERENT answer. It
  // falls through to git, git says there is nothing to commit, and the caller
  // sees the same reason it would have seen anyway.
  test('a timed-out MERGE_HEAD probe on a genuinely empty diff still reports nothing_to_commit', () => {
    const rel = path.posix.join('.planning', 'quiet.md');
    fs.writeFileSync(path.join(tmpDir, rel), 'unchanged\n');
    gitOrThrow(['add', '--', rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'quiet'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [rel],
      failFor: ['MERGE_HEAD'],
      gitVerb: 'rev-parse',
      timeout: true,
    });

    assert.equal(result.reason, 'nothing_to_commit',
      'the conservative reading defers to git, which reports the same thing the guard would have');
    assert.ok(gitCalls.some((a) => a[0] === 'commit'),
      'and it gets there by asking git, not by short-circuiting on an unanswered probe');
  });

  // Round 4, review finding 1 + its coverage half. The `stagedPaths.length === 0`
  // disjunct is NOT gated on `partialCommitRefused`, so an all-missing `--files`
  // list during a merge or cherry-pick returns `nothing_to_commit` while the
  // sequencer ref is still live and the resolved content sits staged.
  //
  // These arms pin that as the DELIBERATE answer, not an oversight. Gating the
  // disjunct sends this case to a BARE `git commit` (stagedPaths is empty, so
  // `canScope` is false), which git permits during a merge and which CONCLUDES
  // it — recording the whole index under a message naming a path that does not
  // exist, and reporting `committed: true`. Trading a report that writes nothing
  // for one that silently writes everything is the trade the timeout routing
  // above already refuses.
  //
  // The behaviour is also pre-existing: before this fix the identical
  // short-circuit ran ABOVE the MERGE_HEAD probe, so it never consulted the
  // sequencer either. Nothing here is a regression pin; these are behaviour
  // pins, and they red on the gated implementation rather than at base.
  for (const kind of ['merge', 'cherry-pick']) {
    const ref = kind === 'merge' ? 'MERGE_HEAD' : 'CHERRY_PICK_HEAD';
    test(`all named --files paths missing during a ${kind} reports nothing_to_commit and leaves the ${kind} open`, () => {
      conflictedSequence(kind);
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', ref)),
        `fixture must leave a ${kind} in progress`);
      const before = headCount(tmpDir);
      const missing = path.posix.join('.planning', 'never-produced.md');
      assert.ok(!fs.existsSync(path.join(tmpDir, missing)),
        'the named path must genuinely be absent from disk');

      const { result, gitCalls } = commitWithFailingAdd({
        cwd: tmpDir,
        files: [missing],
        failFor: [],
      });

      assert.equal(result.reason, 'nothing_to_commit',
        'every named path was skipped before git add (#2014), so there is nothing declared to commit');
      assert.equal(result.committed, false);
      assert.ok(!gitCalls.some((a) => a[0] === 'commit'),
        'git commit must NOT run — a bare commit here would conclude the sequencer with the whole index');
      assert.equal(headCount(tmpDir), before,
        'and no commit may be recorded');
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', ref)),
        `the ${kind} must still be in progress — the caller's own resolution is untouched`);
      assert.equal(
        gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }).trim(),
        path.posix.join('.planning', 'shared.md'),
        'and the staged resolution is still staged, not swallowed');
    });
  }
});


describe('#3859: an unanswered dry-run probe must not close the assume-unchanged path', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Round 3. The `git commit --dry-run --porcelain` probe is the ONE probe in
  // the guard whose rc 0 is the reassuring answer ("git would record
  // something, stand aside"). `execGit` reports a spawn timeout as
  // `exitCode: 1` (`_spawnResult`: `result.status ?? 1`) — byte-identical to
  // git's own "nothing to record" — so an unanswered probe read as a
  // confirmed one, the guard returned `nothing_to_commit`, and content the
  // caller named in `--files` was never committed. The diff probe is safe by
  // construction (rc 0 is the DANGEROUS answer there, and a timeout can only
  // produce non-zero); the two sequencer probes carry an explicit
  // `isSpawnTimeout` disjunct. This probe now stands aside on anything but a
  // CONFIRMED rc 1 with no spawn error — the same "only a confirmed answer
  // decides" rule the diff probe already follows, from the other direction.
  //
  // Seam: `commitWithFailingAdd`'s injected `execGit` with `gitVerb: 'commit'`
  // AND `matchArg: '--dry-run'` — the real `git commit … -- <path>` shares
  // both `args[0]` and its last argument with the probe, so the verb alone
  // would intercept the commit this arm exists to prove still happens.
  function assumeUnchangedModified() {
    const rel = path.posix.join('.planning', 'assumed.md');
    fs.writeFileSync(path.join(tmpDir, rel), 'seed\n');
    gitOrThrow(['add', '--', rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed assumed'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    fs.writeFileSync(path.join(tmpDir, rel), 'modified under assume-unchanged\n');
    return rel;
  }

  for (const shape of ['posix', 'windows']) {
    test(`a timed-out dry-run probe (${shape}) still commits the modified assume-unchanged path`, () => {
      const rel = assumeUnchangedModified();

      const { result, gitCalls } = commitWithFailingAdd({
        cwd: tmpDir,
        files: [rel],
        failFor: [rel],
        gitVerb: 'commit',
        matchArg: '--dry-run',
        timeout: shape,
      });

      assert.notEqual(result.reason, 'nothing_to_commit',
        'an unanswered dry run must not be read as "nothing would be recorded" — that drops content '
        + 'the caller named in --files and reports there was nothing to write');
      assert.equal(result.committed, true, 'the commit must still happen — git would have recorded it');
      assert.ok(gitCalls.some((a) => a[0] === 'commit' && a.includes('--dry-run')),
        'the probe must have been the call that timed out');
      assert.ok(gitCalls.some((a) => a[0] === 'commit' && !a.includes('--dry-run')),
        'and the guard must fall through to the real git commit');
      assert.equal(
        gitOrThrow(['show', 'HEAD:' + rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }),
        'modified under assume-unchanged\n',
        'and the content it records must be the working-tree content');
    });
  }

  // A genuine git error from the dry run (rc 128, no spawn error) is not a
  // "nothing to record" answer either. It falls through to git, which fails
  // the same way it would have — loudly — rather than manufacturing a no-op.
  test('a dry-run probe that errors (rc 128) still reaches git instead of reporting nothing_to_commit', () => {
    const rel = assumeUnchangedModified();

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [rel],
      failFor: [rel],
      gitVerb: 'commit',
      matchArg: '--dry-run',
      timeout: false,
    });

    assert.notEqual(result.reason, 'nothing_to_commit',
      'rc 128 is a failed probe, not a confirmed empty one');
    assert.equal(result.committed, true);
    assert.ok(gitCalls.some((a) => a[0] === 'commit' && !a.includes('--dry-run')));
  });

  // The `ls-files -v` read is an optimisation, never a gate: when it cannot
  // answer, the dry run runs anyway. Pinned, because the reviewer named it
  // as untested and a later "tidy-up" that returns false on a failed read
  // would drop the content by a different door.
  test('a timed-out ls-files probe falls through to the dry run, and the path is still committed', () => {
    const rel = assumeUnchangedModified();

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [rel],
      failFor: [rel],
      gitVerb: 'ls-files',
      timeout: true,
    });

    assert.equal(result.committed, true,
      'an unreadable tag list must not decide anything — the dry run answers instead');
    assert.ok(gitCalls.some((a) => a[0] === 'commit' && a.includes('--dry-run')),
      'the dry run must have run despite the unanswered ls-files read');
    assert.equal(
      gitOrThrow(['show', 'HEAD:' + rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS }),
      'modified under assume-unchanged\n');
  });

  // NEGATIVE CONTROL for the conservative reading, mirroring the sequencer
  // arms': an UNMODIFIED assume-unchanged path in a clean tree, dry run timed
  // out. Standing aside must not manufacture a DIFFERENT answer — it falls
  // through to git, git says there is nothing to commit, and the caller sees
  // the same reason the guard would have given.
  test('a timed-out dry-run probe on an unmodified assume-unchanged path still reports nothing_to_commit', () => {
    const rel = path.posix.join('.planning', 'assumed.md');
    fs.writeFileSync(path.join(tmpDir, rel), 'seed\n');
    gitOrThrow(['add', '--', rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed assumed'], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });
    gitOrThrow(['update-index', '--assume-unchanged', '--', rel], { cwd: tmpDir, timeoutMs: STAGING_GIT_TIMEOUT_MS });

    const { result, gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [rel],
      failFor: [rel],
      gitVerb: 'commit',
      matchArg: '--dry-run',
      timeout: true,
    });

    assert.equal(result.reason, 'nothing_to_commit',
      'the conservative reading defers to git, which reports the same thing the probe would have');
    assert.ok(gitCalls.some((a) => a[0] === 'commit' && !a.includes('--dry-run')),
      'and it gets there by asking git, not by short-circuiting on an unanswered probe');
  });

  // Round 4, review finding 3. The probe's safety rests on `git commit
  // --dry-run` not running `pre-commit`, which git 2.54 satisfies on its own —
  // so this arm pins the FLAG, not an outcome, and that is deliberate: the
  // outcome it protects is unobservable on a git that already declines to run
  // the hook. On a git that DID run it, a rejecting hook exits 1, the closure
  // reads that as a confirmed "nothing to record", and the caller's content is
  // dropped under a `nothing_to_commit` report — #3776 re-entered through the
  // probe. `--no-verify` removes the dependency on the version rather than
  // documenting it.
  //
  // It is a seam assertion over the argv the guard actually issued, not a
  // source grep: the flag is read off the executed call, so deleting it from
  // the probe reds this arm.
  test('the dry-run probe carries --no-verify so a hook-firing git cannot close the guard', () => {
    const rel = assumeUnchangedModified();

    const { gitCalls } = commitWithFailingAdd({
      cwd: tmpDir,
      files: [rel],
      failFor: [],
    });

    const dryRuns = gitCalls.filter((a) => a[0] === 'commit' && a.includes('--dry-run'));
    assert.equal(dryRuns.length, 1,
      'the assume-unchanged branch must have reached the dry-run probe exactly once');
    assert.ok(dryRuns[0].includes('--no-verify'),
      'the probe must not be able to execute a pre-commit hook, whatever the git version does by default');
    // And the REAL commit must not inherit it — #3776 is a bug about a hook
    // whose message reached the caller wrongly, never a licence to skip hooks.
    const realCommits = gitCalls.filter((a) => a[0] === 'commit' && !a.includes('--dry-run'));
    assert.ok(realCommits.length > 0, 'the guard must have fallen through to a real commit');
    assert.ok(realCommits.every((a) => !a.includes('--no-verify')),
      'the real commit still runs the caller\'s hooks — only the probe is exempt');
  });
});

describe('workflow call sites declare --files (#2269)', () => {
  // WHAT COUNTS AS AN INVOCATION — the question this scan kept answering by
  // proxy, and kept getting wrong in both directions at once.
  //
  // The scan used to run two regex tiers: one anchoring the command at line
  // start, one requiring a quoted commit message mid-line. Both were guesses
  // at "is this text executable", and both failed. The anchor flagged a fenced
  // block that deliberately SHOWS the unscoped form — a false positive against
  // content correct as written. The quoted-message tier could not see an
  // UNQUOTED invocation (`gsd_run query commit fixup` reaches the identical
  // cmdCommit), so trimming its --files clause reintroduced #2269 with nothing
  // to fail. Widening either proxy only moved the disagreement, which is the
  // same lesson hasScopedFiles already learned when it stopped approximating
  // the shell and started tokenizing it.
  //
  // Markdown context was the obvious replacement and is REFUSED, on
  // measurement. Keying on fences means parsing them: fence character, opening
  // run length, nesting, tilde fences, four-space indented blocks, unclosed
  // markers. Every bug in that parser is a SILENT FALSE NEGATIVE — a live
  // invocation that stops being scanned with no signal at all — which is the
  // one failure this file cannot afford. (Exempting fenced content outright is
  // refused for a blunter reason: 96 of the 99 live invocations sit inside
  // fences, so the scan would go blind to every site #2269 was filed about.
  // Against the pre-fix tree it flags 3 offenders, and 0 with fences exempt.)
  //
  // So the discriminator is the COMMAND SHAPE, not the markup around it:
  //
  //     <binary> [ query | -flag [value] ]* <commit-token> <at least one arg>
  //
  // That middle clause is what separates a command from a SENTENCE containing
  // the same two words. `Update STATE.md using gsd-tools.cjs query (or legacy
  // gsd-tools) commit mutations:` carries the binary and a commit token, and
  // `(or` is neither the query meta-prefix nor a flag — so it is prose, and no
  // markup had to be parsed to know that. The trailing-argument clause is what
  // separates an invocation from a bare MENTION (`the `gsd_run query commit`
  // step`), which carries no argument at all.
  //
  // Each line is scanned WHOLE, and each of its inline code spans is scanned
  // too, and the results are UNIONED. Scanning the whole line reaches every
  // executable shape regardless of markup — line-start, `cd … && gsd_run …`,
  // `if …; then gsd_run …; fi`, four-space indented, fenced, prompt-prefixed.
  // Scanning spans separately reaches the one case the whole-line pass cannot,
  // because a backtick glues to the token and stops the binary from matching:
  // an invocation written inline in prose. The union is additive by
  // construction, so a mis-parsed span can only ever ADD a false positive an
  // author can see and declare — it can never hide an invocation.

  // The scan's verdict must agree with the RUNTIME, and the runtime never sees
  // the line — it sees argv, after the shell has already tokenized it
  // (routeCommit, gsd-core/bin/gsd-tools.cjs):
  //
  //   const filesIndex = args.indexOf('--files');
  //   const files = filesIndex !== -1
  //     ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--'))
  //     : [];
  //
  // files.length === 0 lands on the unscoped default branch that IS #2269.
  //
  // Every predicate that approximates that over raw line text has a reachable
  // disagreement, and each one found so far was fixed by widening the
  // approximation, which only moved the disagreement. So the scan stops
  // approximating: it tokenizes the line the way a shell would and then runs
  // the runtime's own predicate over the tokens. Two prior special cases fall
  // out for free rather than being encoded — `--files=x` is UNSCOPED (indexOf
  // needs the exact token) and `--files -weird.md` is SCOPED (the runtime
  // filters on '--', not '-').
  const GSD_BINARY_RE = /^(?:.*\/)?gsd(?:_run|-tools(?:\.cjs)?)$/;
  const COMMIT_TOKENS = new Set(['commit', 'commit-to-subrepo']);

  // A SUBSHELL OPENER GLUES TO THE BINARY. `(` is not a tokenizer
  // metacharacter here — subshell grouping changes no argv, so it was never
  // modelled — which leaves `(gsd_run` as one token that the anchor could not
  // match. `(gsd_run query commit "docs: x")` is executable and scored zero
  // candidates: a silent false negative, the one class this file cannot afford.
  //
  // BACKTICKS ARE DELIBERATELY NOT STRIPPED HERE, and the reason is the same
  // runtime fidelity the rest of the file is built on: to a SHELL a backtick is
  // never part of a binary name, so `` `gsd_run `` is not a command — a
  // backticked invocation is reached by the code-span pass, which extracts the
  // command from inside the delimiters, and that is the correct route. Stripping
  // them in the anchor made the whole-line pass find the same invocation a
  // second time, absorbing the surrounding sentence as arguments, and doubled
  // the census for every backticked site in the tree.
  //
  // TRAILING punctuation is not stripped either: a sentence ending
  // `… gsd_run query commit.` would then read as a command whose arguments are
  // the rest of the paragraph — a false POSITIVE against ordinary prose, and
  // exactly the hostility the declaration marker exists to undo.
  // Applied to EVERY command-name test, not just the gsd one: `(` glues to
  // whatever binary follows it, so `(sh -c "gsd_run commit a"` hid the invoker
  // from the -c pass exactly as `(gsd_run …` hid the binary from the anchor.
  // One strip, one helper — a second copy is how the two drift apart.
  //
  // A COMMAND SUBSTITUTION GLUES THE SAME WAY, and it is the shape the tree
  // actually uses: `$(gsd_run …)` is the dominant invocation idiom repo-wide —
  // 443 live occurrences across the six roots against 2287 backticked ones —
  // and `$(` left `$(gsd_run` as one token that no command-name test could
  // match, so `$(gsd_run query commit "docs: x")` scored ZERO candidates in
  // both directions. Same silent false negative `(` produced, on the shape a
  // contributor is most likely to reach for.
  //
  // WHAT PRECEDES THE OPENER IS NOT ENUMERABLE, so it is not enumerated. The
  // first cut of this rule keyed on an assignment prefix, because 437 of the
  const isGsdBinary = (t) => GSD_BINARY_RE.test(bareCommandName(t));

  // routeCommit's predicate, verbatim, over one invocation's tokens. Stops at
  // the first control operator so that a later command's --files can never
  // vouch for this one even when the caller passes an unsegmented line, and
  // drops redirection tokens — they are consumed by the shell, so a `--files`
  // whose only successors are redirections has no value at runtime.
  const hasScopedFiles = (line) => {
    const all = tokenize(line);
    const cut = all.findIndex((t) => t.op);
    const tokens = (cut === -1 ? all : all.slice(0, cut)).filter((t) => !t.redir).map((t) => t.value);
    const filesIndex = tokens.indexOf('--files');
    if (filesIndex === -1) return false;
    return tokens.slice(filesIndex + 1).some((t) => !t.startsWith('--'));
  };

  // Usage-synopsis notation is documentation OF the CLI, never a call TO it:
  // `<message>` is a metavariable and `[--files f1 f2]` an optional group, and
  // neither is a shell word — the runtime's exact-token `indexOf('--files')`
  // can never match a bracketed `[--files`. A bracketed optional FLAG is the
  // notation's unambiguous marker, and the discrimination is measured rather
  // than assumed: across the six scan roots, 24 real invocations carry
  // brackets inside their quoted MESSAGE ("docs: capture todo - [title]") —
  // one of them as its --files VALUE (`--files [handoff-path]`) — and not one
  // brackets a flag, while all 5 synopsis lines (docs/*/CLI-TOOLS.md and its
  // localized mirrors) do. Keying on "contains a bracket" would drop all 24.
  const SYNOPSIS_TOKEN_RE = /^\[--/;
  // An unquoted `<message>` metavariable, as the TOKENIZER leaves it. `<` is a
  // redirection character, so the shell — and therefore tokenize() — reads
  // `commit <message> [--files f1 f2]` as a redirection whose target is
  // `message`, not as a word. That mangling is not a defect to work around: it
  // is precisely why a synopsis is not a call, and it makes the notation
  // identifiable without a second parse. A metavariable inside a QUOTED message
  // (`commit "docs: add <Widget> support"`) stays one ordinary token and is
  // untouched by this — which is the false negative a raw-text match would have
  // introduced.
  const METAVAR_REDIR_RE = /^<[A-Za-z]/;

  // The command shape from the header, over one operator-delimited segment.
  const isCommitInvocation = (tokens) => {
    // The binary may sit anywhere in the segment: an env-var prefix
    // (`FOO=1 gsd_run …`), a `then`/`else` keyword, a shell prompt (`$ `), or
    // an interpreter (`node gsd-tools.cjs …`, live in docs/CLI-TOOLS.md) all
    // precede it, and all are still the command being run.
    const bi = tokens.findIndex((t) => !t.redir && isGsdBinary(t));
    if (bi === -1) return false;
    // Between the binary and the command, only the optional `query` meta-prefix
    // and flags-with-values may intervene. `gsd_run --cwd "$ROOT" query commit`
    // is live in onboard.md; a bare word here means this is a sentence.
    let i = bi + 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.op || t.redir) return false;
      if (COMMIT_TOKENS.has(t.value)) break;
      if (t.value === 'query') { i += 1; continue; }
      if (t.value.startsWith('-')) {
        i += 1;
        const v = tokens[i];
        if (v && !v.op && !v.redir && !v.value.startsWith('-') && !COMMIT_TOKENS.has(v.value)) i += 1;
        continue;
      }
      return false;
    }
    if (i >= tokens.length) return false;
    // NOTATION IS DECIDED BY THE FIRST ARGUMENT, and this is the position where
    // that question is answerable — `i` is the command token, so the next token
    // is where a call puts its MESSAGE and a synopsis puts its metavariable.
    //
    // Testing "does any token on the line look like notation" instead was wrong
    // in both directions, and both were reachable:
    //
    //   See [--files](#anchor) then run gsd_run query commit "docs: x"
    //       ^ notation belonging to no command at all — an ordinary markdown
    //         link, and docs/ is a scan root — silently disqualified the real
    //         invocation after it.
    //   gsd_run query commit "docs: x" [--amend]
    //                                  ^ a real, executable, unscoped call.
    //         `[--amend]` is a literal word to the shell, so this line RUNS and
    //         sweeps the index, and the guard was silent on exactly the defect
    //         it exists to catch.
    //
    // Positionally there is no ambiguity: a synopsis documents a call it does
    // not make, so its first argument is always a placeholder — `<message>`
    // (which reaches us as a redirection; see METAVAR_REDIR_RE) or a bracketed
    // optional group. A real call's first argument is its commit message.
    const firstArg = tokens.slice(i + 1).find((t) => !t.op);
    if (firstArg && ((firstArg.redir && METAVAR_REDIR_RE.test(firstArg.value))
      || SYNOPSIS_TOKEN_RE.test(firstArg.value))) return false;
    // At least one argument. A mention carries none, and this is the whole of
    // the mention/invocation distinction the line-start anchor used to guess at.
    return tokens.slice(i + 1).some((t) => !t.op && !t.redir);
  };

  const segmentInvocations = (str) => {
    const groups = [];
    let cur = [];
    for (const t of tokenize(str)) {
      if (t.op) { groups.push(cur); cur = []; } else { cur.push(t); }
    }
    groups.push(cur);
    // Every segment is ruled by the same predicate, and the two `[str]`
    // fallbacks this function used to carry are gone with the tokens[0] test
    // that made them necessary. `[str]` was the same "one hit vouches for the
    // whole line" shape the earlier rounds spent three passes removing: it
    // re-fused a foreign command's arguments onto the invocation.
    return groups
      .filter(isCommitInvocation)
      .map((g) => str.slice(g[0].start, g[g.length - 1].end));
  };

  // Inline code spans, CommonMark-style: a run of N backticks opens and the
  // next run of exactly N closes. A BACKSLASH-ESCAPED backtick is literal text
  // and must not delimit — treating it as a delimiter invents a span that is
  // not there. This pass exists only to reach invocations whose backticks glue
  // to the binary token; because the results are unioned with the whole-line
  // pass, an error here can only add a candidate, never drop one.
  const codeSpans = (line) => {
    const spans = [];
    const runs = [];
    const re = /(\\*)(`+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      // An ODD backslash count escapes exactly ONE backtick — the first. The
      // rest of the run is still a delimiter, and skipping the whole run drops
      // it: ``text \`` + `` `cmd`` `` + ` end` lost its opening run entirely.
      // The comment above claimed this rule; the code implemented "skip the
      // run". Harmless in practice, since the span pass is additive — but a
      // comment that overstates its code is how the next reader is misled.
      const escaped = m[1].length % 2 === 1;
      const len = escaped ? m[2].length - 1 : m[2].length;
      if (len === 0) continue;
      runs.push({ at: m.index + m[1].length + (escaped ? 1 : 0), len });
    }
    for (let a = 0; a < runs.length; a += 1) {
      for (let b = a + 1; b < runs.length; b += 1) {
        if (runs[b].len === runs[a].len) {
          spans.push(line.slice(runs[a].at + runs[a].len, runs[b].at));
          a = b;
          break;
        }
      }
    }
    return spans;
  };

  // Candidates for one logical line: the whole line, unioned with each of its
  // inline code spans and each shell -c payload. See the header for why the
  // union rather than a choice.
  // A MARKDOWN BLOCKQUOTE MARKER IS THE ONE PIECE OF MARKUP THE TOKENIZER
  // CANNOT IGNORE, because `>` is also a redirection: `> gsd_run query commit
  // "docs: x"` reads as a redirection whose target is the binary, so the binary
  // sits inside a redir token and the command is never found. Every other
  // markup form the header promises immunity to survives tokenization as
  // ordinary text; this one is consumed by it.
  //
  // Whitespace after the marker is required. `>out.md` with no space is a
  // redirection, and treating it as a quote would strip a real one; all 34
  // blockquoted lines in the six roots that invoke this binary today use the
  // spaced form. Nested markers (`> > x`) are stripped together.
  //
  // Additive, like the other passes: the raw line is still scanned, so this can
  // only ever ADD a candidate. Found by the recognition property below on its
  // first run — no live commit invocation sits in a blockquote today, which is
  // the point, since a guard's value is the shape nobody has written yet.
  const BLOCKQUOTE_RE = /^\s*(?:>\s+)+/;
  // THE PASSES COMPOSE, so they are applied to every VIEW of the line rather
  // than bolted on beside each other. The first cut ran the blockquote strip
  // through segmentInvocations only, which left `> sh -c "gsd_run commit a"`
  // invisible: the raw view hides the invoker inside the redirection the `>`
  // opens, and the stripped view never reached the -c pass. Found by the
  // recognition property once the wrapper axis was added — a composition of two
  // shapes, neither of which fails alone, which is the class hand-written
  // examples are worst at.
  const invocationCandidates = (line) => {
    if (isDeclared(line)) return [];
    const candidates = [];
    const add = (c) => { if (!candidates.includes(c)) candidates.push(c); };
    const views = [line];
    if (BLOCKQUOTE_RE.test(line)) views.push(line.replace(BLOCKQUOTE_RE, ''));
    for (const view of views) {
      segmentInvocations(view).forEach(add);
      for (const span of codeSpans(view)) segmentInvocations(span).forEach(add);
      for (const payload of shellDashCPayloads(view)) segmentInvocations(payload).forEach(add);
    }
    return candidates;
  };

  // The whole-document walk, defined HERE beside the other primitives for the
  // reason stripHtmlComments is: the scan below and the tests both call this
  // exact symbol, so an assertion cannot pass against a private copy while the
  // scan does something else. Backslash-continued lines are joined first —
  // several invocations pass --files on a continuation line (docs-update.md,
  // code-review.md, gsd-code-fixer.md) and a per-physical-line walk would
  // false-flag them.
  const documentCandidates = (text) => {
    const logical = stripHtmlComments(text).replace(/\\\r?\n/g, ' ');
    const found = [];
    for (const line of logical.split(/\r?\n/)) found.push(...invocationCandidates(line));
    return found;
  };

  // The offender message, hoisted OUT of the assertion so it can be pinned. A
  // failure message only exists on the failing path, so nothing would notice a
  // remedy being dropped from it — and the remedies are the whole point: this
  // guard has three distinct causes and only one of them is the bug. A
  // contributor whose ordinary English sentence reddens CI, told only that a
  // commit is unscoped, will mangle the sentence until the guard shuts up,
  // which is exactly what the declaration marker was invented to prevent. The
  // repo states this standard for its sibling gate one section over in
  // CONTRIBUTING.md: "The failure output names its own remedy".
  const OFFENDER_HELP = 'query commit invocations that reach the runtime without a --files '
    + 'scope (an unscoped commit sweeps the whole .planning/ index — #2269).\n\n'
    + 'Three causes, three remedies — check which one you have:\n'
    + '  1. A real invocation missing its scope -> add --files <artifact>.\n'
    + '  2. A prose MENTION of the command      -> wrap it in backticks; a\n'
    + '     backticked mention carrying no arguments is not scanned.\n'
    + '  3. A deliberate wrong-example          -> declare it on the\n'
    + '     invocation\'s own line, in shell-comment position:\n'
    + '       # gsd-scan-ignore: #NNN <why this example shows the bad form>\n'
    + '     The reason must name a tracking issue or an http(s):// URL.\n'
    + 'See CONTRIBUTING.md -> "Every commit invocation in shipped content must '
    + 'declare --files".';

  // ONE DOCUMENT, CLASSIFIED — the exact function the repo walk below applies
  // to every file, defined here for the same reason the other primitives are:
  // an assertion that re-implements the classification passes against its own
  // copy while the scan does something else. Factored out after a reversion
  // control caught the gap: neutering the WIRING between the walkers and the
  // scan's result lists was SILENT, because every test drove the walkers
  // directly and nothing exercised the assembly. A synthetic corpus drives
  // this symbol below, so that path is now covered.
  const scanDocument = (label, text) => {
    const scanned = [];
    const offenders = [];
    const untracked = [];
    for (const inv of documentCandidates(text)) {
      scanned.push(label);
      if (!hasScopedFiles(inv)) offenders.push(`${label}: ${inv.trim()}`);
    }
    for (const decl of documentUntrackedDeclarations(text)) untracked.push(`${label}: ${decl}`);
    return { scanned, offenders, untracked };
  };

  // Which tracked files carry a live invocation that NO scan root covers.
  // Also factored out for the reversion-control reason above: the repo is
  // clean, so the real assertion can only ever observe an empty list, and
  // emptying it deliberately was silent. Driving this symbol with a synthetic
  // file list is the only way the check can fail on demand.
  const uncoveredFiles = (files, roots, excluded, read) => files
    .filter((f) => !roots.some((root) => f === root || f.startsWith(`${root}/`)))
    .filter((f) => !excluded.has(f))
    .filter((f) => documentCandidates(read(f)).length > 0);

  // The same walk, for declarations that tried and failed to carry a tracking
  // reference. Separate from documentCandidates because such a line is NOT an
  // offender — its author already explained it — and reporting it as one is the
  // failure mode SCAN_IGNORE_RE's comment describes.
  const documentUntrackedDeclarations = (text) => {
    const logical = stripHtmlComments(text).replace(/\\\r?\n/g, ' ');
    const found = [];
    for (const line of logical.split(/\r?\n/)) {
      if (isUntrackedDeclaration(line)) found.push(line.trim());
    }
    return found;
  };

  // An invocation inside an HTML comment is not executable, and a guard that
  // flags it is hostile to documenting the very bug it protects against —
  // `<!-- WRONG: gsd_run query commit "docs: x" (missing --files!) -->` is a
  // plausible thing to write precisely BECAUSE this issue exists. Comment
  // spans are stripped before scanning, preserving newlines so the surrounding
  // lines keep their identity and a multi-line comment cannot fuse the text on
  // either side of it into one logical line.
  //
  // Defined HERE, beside the other scan primitives, rather than inside the
  // scan test: the test below asserts on this exact symbol, so the assertion
  // and the scan cannot drift apart. A private copy in each place passes its
  // own test while the scan does something else.
  const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

  test('scanner quote-parity handles synthetic edge-case lines', () => {
    // The scan's correctness rests on hasScopedFiles's quote-parity walk,
    // which live workflow content happens not to stress. Pin the claimed
    // edge cases with literal lines so a regex regression fails loudly.
    const bare = [
      // A prose --files inside the quoted commit message must NOT count as
      // a scope — this line is still an unscoped invocation.
      'gsd_run query commit "docs: explain --files usage"',
      // A trailing bare flag carries no value and still selects the
      // unscoped default path.
      'gsd_run query commit "docs: plan" --files',
      // --files followed by ANOTHER FLAG is the same unscoped default, because
      // routeCommit filters `--`-prefixed tokens out of the scope list:
      // args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) === [].
      // Two live sites are one token-deletion from this shape —
      // gsd-core/references/git-planning-commit.md and
      // gsd-core/workflows/execute-plan.md both run
      // `... commit "" --files .planning/codebase/*.md --amend`, so dropping
      // the glob (exactly the #2269 forgot-the-scope class) lands here.
      'gsd_run query commit "docs: plan" --files --amend',
      'gsd_run query commit "docs: plan" --files --no-verify',
      // The shell consumes redirections before argv exists, so a --files whose
      // only successors are redirections reaches routeCommit with files=[].
      // The first row is one token-deletion from a live site
      // (execute-phase-requirement-revert.md ends `--files
      // .planning/REQUIREMENTS.md >/dev/null 2>&1 || true`) — dropping the
      // value lands exactly here, and the scanner must not let `>/dev/null`
      // vouch as a value.
      'gsd_run query commit "docs: revert" --files >/dev/null 2>&1 || true',
      'gsd_run query commit "docs: plan" --files > out.md',
      // #4276 NEGATIVE CONTROL. Here the 2 is genuinely an IO number: the
      // shell consumes `2>&1` whole and --files reaches argv with no value.
      // This row is what stops the quoted-digit fix below from over-
      // correcting into "stop consuming IO numbers" — an implementation that
      // simply dropped the redirection branch would satisfy the scoped rows
      // and fail here.
      'gsd_run query commit "docs: plan" --files 2>&1',
      // An unquoted # begins a comment: everything after it, --files included,
      // never reaches argv.
      'gsd_run query commit "docs: plan" # --files a.md',
      // A single & is a control operator (&& with one character deleted): the
      // --files on its far side belongs to echo, not to the commit.
      'gsd_run query commit "docs: plan" & echo --files a.md',
    ];
    for (const line of bare) {
      assert.ok(invocationCandidates(line).length > 0, `should be an invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), false,
        `must be flagged as unscoped: ${line}`,
      );
    }

    const scoped = [
      // The ordinary scoped shape.
      'gsd_run query commit "docs: plan" --files .planning/PLAN.md',
      // A quoted --files mention BEFORE the real flag must not blind the
      // scanner to the genuine scope that follows (quote parity is even
      // again after the closing quote).
      'gsd_run query commit "docs: explain --files usage" --files .planning/PLAN.md',
      // The negative control for the two --amend rows above: a real value
      // FOLLOWED by a flag is still scoped, and both live sites have this
      // shape today. Without this row the fix could over-correct to "any
      // --files near a flag is unscoped" and nothing would fail.
      'gsd_run query commit "" --files .planning/codebase/*.md --amend',
      // The runtime filters on '--', not '-', so a single-dash token IS a
      // value and the scanner must agree.
      'gsd_run query commit "docs: plan" --files -weird-name.md',
      // The live redirect-tail shape, value present: the redirections after
      // the value are consumed by the shell and must not hide the real scope.
      'gsd_run query commit "docs(phase-{X}): revert premature Complete requirements after gaps found" --files .planning/REQUIREMENTS.md >/dev/null 2>&1 || true',
      // A # INSIDE a quoted message is literal text, not a comment — ship.md
      // commits with `PR #${PR_NUMBER}` in the message today.
      'gsd_run query commit "docs: ship phase 4 — PR #42 [ci skip]" --files .planning/STATE.md',
      // Mid-word # is literal too, as in the shell.
      'gsd_run query commit docs:PR#42 --files .planning/STATE.md',
      // #4276: a QUOTED digit run is not an IO number. POSIX recognizes one
      // only when the digits are bare, so the shell passes `"2"` as an
      // ordinary argument and this invocation IS scoped — on a file named
      // `2`, which is legal. Before the fix the tokenizer read the token's
      // characters without its quoting, ate the value as an IO number, and
      // reported a correct line as unscoped.
      'gsd_run query commit "docs: plan" --files "2">out',
      // Detached from the operator, and single-quoted, so neither the gluing
      // nor the quote style is what carries the fix.
      'gsd_run query commit "docs: plan" --files \'2\' > out',
      // Partially quoted: `2"3"` is not a bare digit run either, and a mask
      // test that asked "any character unquoted?" instead of "every
      // character unquoted?" would get this one wrong.
      'gsd_run query commit "docs: plan" --files 2"3">out',
    ];
    for (const line of scoped) {
      assert.ok(invocationCandidates(line).length > 0, `should be an invocation: ${line}`);
      assert.strictEqual(
        hasScopedFiles(line), true,
        `must be recognized as scoped: ${line}`,
      );
    }

    // The query-less spelling reaches the same cmdCommit and must be in
    // scope, scoped or not. ingest-docs.md uses this form live.
    assert.ok(
      invocationCandidates('gsd_run commit "docs: ingest" --files .planning/PROJECT.md').length === 1,
      'query-less invocation must be scanned (query is an optional meta-prefix)',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run commit "docs: ingest"'), false,
      'a bare query-less invocation must be flagged as unscoped',
    );
    assert.ok(
      invocationCandidates('gsd_run commit "docs: ingest"').length === 1,
      'a bare query-less invocation must still be scanned',
    );

    // Flags may precede the command. onboard.md is a live instance; a regex
    // that anchors `commit` directly after the binary drops it silently.
    assert.ok(
      invocationCandidates('gsd_run --cwd "$ROOT" query commit "docs: x" --files .planning/S.md').length === 1,
      'invocation with a flag before the command must stay in scope',
    );

    // Prose mention mid-sentence: the line-start anchor keeps it out of
    // the scan entirely.
    assert.deepEqual(
      invocationCandidates('the `gsd_run query commit` step then records the artifact'),
      [],
      'a prose mention bears no argument and is not an invocation',
    );

    // Widening `query` to optional must not pull in unrelated commands that
    // merely mention the word: `commit_docs` is a JSON key in new-project.md's
    // config-new-project payload, and the \b...\b anchors must exclude it.
    assert.deepEqual(
      invocationCandidates('gsd_run query config-new-project \'{"commit_docs":true}\''),
      [],
      'a config payload mentioning commit_docs is not a commit invocation',
    );
  });

  test('the scanner agrees with the runtime on every quoting dialect', () => {
    // These three shapes were each scored WRONG by the line-text heuristic
    // that preceded tokenization, and each was reachable in live content.
    // They are pinned as literals because they are the exact inputs that
    // proved the approximation could not be patched into correctness.
    const unscoped = [
      // 1. An unrelated command's --files vouched for the commit. At runtime
      //    `--files` never reaches gsd-tools argv at all — it is echo's
      //    argument — so cmdCommit takes the blanket-.planning/ default. This
      //    is #2269 verbatim, and the old separator lookahead could not see
      //    it because the far side of `&&` is not a gsd binary.
      'gsd_run query commit "docs: update ROADMAP.md" && echo done --files unused.md',
      // 2. Same root cause with no shell chaining at all: the message is
      //    SINGLE-quoted, so a parity walk that counts only `"` reads the
      //    --files inside it as a real argument. The double-quoted twin was
      //    always caught, which is what made the hole so easy to miss.
      "gsd_run query commit 'docs: explain --files usage'",
    ];
    for (const line of unscoped) {
      assert.ok(invocationCandidates(line).length > 0, `should be an invocation: ${line}`);
      const cands = invocationCandidates(line);
      assert.ok(
        cands.some((c) => !hasScopedFiles(c)),
        `must surface as unscoped: ${line}`,
      );
    }

    // 3. The mirror-image failure, and the reason a `'`-aware parity COUNTER
    //    would have been the wrong fix: a double quote living inside a
    //    single-quoted message is ordinary text, but it flips a parity walk
    //    and takes a genuinely scoped invocation out of scope — a false
    //    NEGATIVE introduced by the fix for a false negative.
    const scopedDespiteQuotes = "gsd_run query commit 'prints a \" sometimes' --files .planning/PLAN.md";
    assert.ok(invocationCandidates(scopedDespiteQuotes).length === 1);
    assert.ok(
      invocationCandidates(scopedDespiteQuotes).every((c) => hasScopedFiles(c)),
      `a " inside a '-quoted message must not take the invocation out of scope: ${scopedDespiteQuotes}`,
    );

    // The single-quoted spellings of the shapes already pinned for `"`, so the
    // two dialects cannot drift apart again.
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files"), false);
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files --amend"), false);
    assert.strictEqual(hasScopedFiles("gsd_run query commit 'docs: plan' --files .planning/PLAN.md"), true);
    // Unquoted messages reach the same cmdCommit and must behave identically.
    assert.strictEqual(hasScopedFiles('gsd_run query commit plan --files'), false);
    assert.strictEqual(hasScopedFiles('gsd_run query commit plan --files .planning/PLAN.md'), true);

    // The tokenizer's two backslash-escape branches, hand-pinned — an escaped
    // quote inside a double-quoted message must not close it (so a --files
    // beyond it is inside or outside the message exactly as the shell says),
    // and an escaped space outside quotes joins the word instead of splitting.
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit "he said \\"hi\\"" --files x.md'), true,
      'an escaped quote must not close the message: the --files after it is real',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit "he said \\"hi --files x.md\\""'), false,
      'an escaped quote must not close the message: the --files after it is still message text',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit docs:\\ plan --files x.md'), true,
      'an escaped space outside quotes joins the word, and the --files after it is real',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit "docs: plan" --files x\\ y.md'), true,
      'an escaped space inside the value keeps it one token — still a value',
    );
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit docs:\\ plan --files'), false,
      'an escaped space outside quotes must not manufacture a scope: the bare --files is still valueless',
    );

    // --files=x stays UNSCOPED without a special case: routeCommit does
    // args.indexOf('--files'), which the fused token cannot satisfy.
    assert.strictEqual(hasScopedFiles('gsd_run query commit "docs: plan" --files=.planning/PLAN.md'), false);
    // And a flag BEFORE a real value is still scoped, because the runtime
    // filters the whole tail rather than inspecting only the next token.
    assert.strictEqual(hasScopedFiles('gsd_run query commit "docs: plan" --files --amend .planning/PLAN.md'), true);

    // An operator glued to its neighbour still separates.
    assert.ok(
      invocationCandidates('gsd_run query commit "a"&&gsd_run query commit "b" --files x.md')
        .some((c) => !hasScopedFiles(c)),
      'an unspaced && must still split the invocation',
    );

    // A QUOTED operator is message text, not structure. Both the candidate
    // split and the scope predicate must key on how the token was PARSED, not
    // on what it spells — re-deriving "is this an operator" from the token's
    // value reintroduces the identify-structure-by-text mistake one layer up,
    // and turns each of these scoped invocations into a false offender.
    // The message is EXACTLY an operator in the first four: that is the case a
    // value-based check actually mis-reads, and it is the shape fast-check
    // shrank to on this predicate's first run. A message that merely CONTAINS
    // an operator (the last three) tokenizes to one token whose value is the
    // whole string, so it never matches the operator set by equality and is
    // not a control for this — keep both, but do not mistake the second group
    // for coverage of the first.
    for (const line of [
      'gsd_run query commit "|" --files .planning/PLAN.md',
      "gsd_run query commit '|' --files .planning/PLAN.md",
      'gsd_run query commit "&&" --files .planning/PLAN.md',
      'gsd_run query commit ";" --files .planning/PLAN.md',
      'gsd_run query commit "docs: a | b" --files .planning/PLAN.md',
      "gsd_run query commit 'docs: a | b' --files .planning/PLAN.md",
      'gsd_run query commit "docs: x && y" --files .planning/PLAN.md',
    ]) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `a quoted operator must not split the invocation: ${line}`);
      assert.ok(hasScopedFiles(cands[0]), `a quoted operator must not defeat the scope: ${line}`);
    }
  });

  test('an invocation inside an HTML comment is not executable content', () => {
    // The scan must not be hostile to documenting the bug it guards. This is
    // the shape the scan's own strip step exists for; asserted on the helper
    // so it holds independently of which roots are scanned.
    const strip = stripHtmlComments;
    const commented = '<!-- WRONG: gsd_run query commit "docs: message" (missing --files!) -->';
    assert.strictEqual(strip(commented).trim(), '', 'the commented invocation must be stripped');

    // A multi-line comment must not fuse the lines on either side of it.
    const around = 'before\n<!-- gsd_run query commit "x"\nstill inside -->\nafter';
    const lines = strip(around).split('\n');
    assert.strictEqual(lines.length, 4, 'newlines must survive the strip');
    assert.strictEqual(lines[0], 'before');
    assert.strictEqual(lines[3], 'after');

    // A real invocation on the same line as a comment still scans.
    const mixed = '<!-- note --> gsd_run query commit "docs: x"';
    const cands = invocationCandidates(strip(mixed).trim());
    assert.ok(cands.length === 1 && !hasScopedFiles(cands[0]), 'a live invocation beside a comment must still be scanned');
  });

  test('a deliberate wrong-example is declared, not inferred from its fence', () => {
    // The HTML-comment escape above only covers examples written as comments.
    // The same teaching example inside a fenced block — the natural place to
    // put it — scored as an offender, and the "fix" a contributor would then
    // apply is to mangle the example until the linter stops complaining.
    //
    // The fence itself cannot be the signal, and that is the whole argument:
    // 96 of the 99 live invocations sit INSIDE fences, so exempting fenced
    // content blinds the scan to every site #2269 was actually filed about.
    // Measured against the pre-fix tree (200daa456^), the scan flags exactly
    // the 3 known offenders — and 0 of them with fences exempted. So intent
    // is DECLARED instead, with a reason, on the invocation's own line.
    const declared = 'gsd_run query commit "docs: message"   # gsd-scan-ignore: #2269 counter-example';
    assert.deepEqual(
      invocationCandidates(declared), [],
      'a declared counter-example must not be scored',
    );

    // Undeclared, the identical line stays an offender — it is byte-for-byte
    // what a real regression looks like, so silence here would be the false
    // confidence the guard exists to prevent.
    const undeclared = 'gsd_run query commit "docs: message"';
    const cands = invocationCandidates(undeclared);
    assert.strictEqual(cands.length, 1, 'an undeclared wrong-example is indistinguishable from a regression');
    assert.strictEqual(hasScopedFiles(cands[0]), false, 'and must be flagged');

    // The marker requires a REASON. A bare token is not a declaration, and
    // accepting one would make the escape a silent opt-out for any line.
    assert.strictEqual(
      invocationCandidates('gsd_run query commit "docs: x"   # gsd-scan-ignore:').length, 1,
      'a marker with no reason must not exempt the line',
    );

    // AND THE REASON MUST NAME A TRACKING ISSUE. Free text gives the exemption
    // no expiry and no ledger, which is the permanent-allow-test-rule shape;
    // ADR-456 already settled this for the sibling `allow-test-rule` marker.
    const untracked = 'gsd_run query commit "docs: message"   # gsd-scan-ignore: just a note';
    assert.strictEqual(
      invocationCandidates(untracked).length, 1,
      'a declaration with no #NNN must not exempt the line',
    );
    // …and it is reported AS a malformed declaration, not as a mystery
    // unscoped commit. The author already explained this line; telling them it
    // is unscoped sends them to re-read a flag that was never the problem.
    assert.deepEqual(
      documentUntrackedDeclarations(untracked), [untracked],
      'an untracked declaration must be reported on its own terms',
    );
    assert.deepEqual(
      documentUntrackedDeclarations(declared), [],
      'a compliant declaration is not a defect',
    );
    // A URL is the other form, and the predicate MIRRORS the repo's own
    // ISSUE_REF_RE rather than approximating it — `http://` counts there, so it
    // counts here. A near-copy that accepted only https would hand a
    // contributor two conventions wearing one name.
    for (const ref of ['https://example.invalid/adr', 'http://example.invalid/adr']) {
      assert.deepEqual(
        invocationCandidates(`gsd_run query commit "docs: message"   # gsd-scan-ignore: ${ref}`),
        [],
        `a URL reference is a tracking reference: ${ref}`,
      );
    }

    // A marker with NO reason at all is the likeliest way to get this wrong, so
    // it is the case that most needs the specific diagnosis. It still does not
    // exempt — but it is reported as a malformed declaration, not as a mystery
    // unscoped commit.
    const bare = 'gsd_run query commit "docs: x"   # gsd-scan-ignore:';
    assert.strictEqual(invocationCandidates(bare).length, 1, 'a bare marker exempts nothing');
    assert.deepEqual(
      documentUntrackedDeclarations(bare), [bare],
      'and an empty reason is an ATTEMPT, which is what earns the specific message',
    );
    // The bypass class the token cross-check covers applies here too: a
    // reference living in an ARGUMENT reached argv, so it declares nothing.
    assert.strictEqual(
      invocationCandidates('gsd_run query commit "docs: gsd-scan-ignore: #2269"').length, 1,
      'a tracking reference inside the message must not exempt the line',
    );

    // AND IT IS ONLY A MARKER IN COMMENT POSITION. An exemption that fires on
    // the token appearing ANYWHERE on the line is a false-negative escape
    // hatch: the commit MESSAGE is ordinary text an author controls, so a line
    // that merely writes about this marker would silently stop being scanned.
    // That is strictly worse than the false positive the marker exists to fix
    // — a guard that can be talked out of firing by its own documentation.
    const inMessage = 'gsd_run query commit "docs: explain gsd-scan-ignore: semantics"';
    const imCands = invocationCandidates(inMessage);
    assert.strictEqual(imCands.length, 1, 'marker text inside the message must not exempt the line');
    assert.strictEqual(hasScopedFiles(imCands[0]), false, 'and the real offender is still flagged');

    // Same for a quoted --files value that happens to contain the token.
    assert.strictEqual(
      invocationCandidates('gsd_run query commit "docs: x" --files "notes/gsd-scan-ignore: draft.md"').length,
      1,
      'marker text inside an argument must not exempt the line',
    );

    // commentPortion is the seam, and it agrees with tokenize about where the
    // command ends — a `#` inside quotes or mid-word is literal (ship.md
    // commits with `PR #${PR_NUMBER}` in the message today).
    assert.strictEqual(commentPortion('gsd_run query commit "PR #42" # real'), '# real');
    assert.strictEqual(commentPortion('gsd_run query commit "PR #42 [ci skip]"'), '');
    assert.strictEqual(commentPortion('gsd_run query commit docs:PR#42 --files a.md'), '');

    // THE ESCAPED-SEPARATOR BYPASS. A backslash escapes the space, so the shell
    // keeps `docs: #` as ONE word and the `#` is literal — the command runs,
    // unscoped. A "preceded by whitespace" test reads the same bytes as a
    // comment and exempts the line, which is the guard being disarmed by text
    // the author controls. Word-start tracking is what closes it, and the
    // token cross-check below is what makes the closure structural.
    const escaped = 'gsd_run query commit docs:\\ # gsd-scan-ignore: reason';
    assert.strictEqual(
      commentPortion(escaped), '',
      'an escaped separator leaves the # mid-word, so there is no comment',
    );
    const escCands = invocationCandidates(escaped);
    assert.strictEqual(escCands.length, 1, 'the escaped-separator line must still be scanned');
    assert.strictEqual(hasScopedFiles(escCands[0]), false, 'and is still flagged as unscoped');

    // The structural half, stated as its own assertion: a marker that survives
    // tokenization is an ARGUMENT, which means it reached argv and the runtime
    // executed it. Such a line is never a declaration, whatever commentPortion
    // makes of it.
    assert.ok(
      tokenize(escaped).some((t) => /gsd-scan-ignore:/.test(t.value)),
      'the bypass attempt leaves the marker in an argv token, which is what disqualifies it',
    );
    assert.ok(
      !tokenize('gsd_run query commit "docs: x" # gsd-scan-ignore: demo')
        .some((t) => /gsd-scan-ignore:/.test(t.value)),
      'a genuine declaration is dropped by tokenize with the rest of the comment',
    );

    // The case the token cross-check exists for on its own: a REDIRECTION
    // swallows the `#` and its text into a redir token, so the shell passes it
    // to the redirect target and never treats it as a comment — while
    // commentPortion, reading raw text, does see one. Only the cross-check
    // separates them, so the line stays scanned.
    // The reason carries a tracking reference so the precondition below tests
    // the CROSS-CHECK rather than the reference requirement — otherwise this
    // fixture would fail for the uninteresting reason and stop covering the
    // redirection case at all.
    const redirected = 'gsd_run query commit x > #gsd-scan-ignore: #2269 y';
    const redirectedReason = declarationReason(commentPortion(redirected));
    assert.ok(
      redirectedReason !== null && ISSUE_REF_RE.test(redirectedReason),
      'precondition: raw-text reading of this line does look like a declaration',
    );
    assert.strictEqual(
      invocationCandidates(redirected).length, 1,
      'a marker consumed by a redirection is not a declaration — the line stays scanned',
    );

    // The marker never reaches argv: tokenize() ends the command at an
    // unquoted `#`, so a declared line is inert at runtime as well as here.
    assert.strictEqual(
      hasScopedFiles('gsd_run query commit "docs: x" --files a.md   # gsd-scan-ignore: demo'), true,
      'the marker is a shell comment and must not disturb scope detection',
    );
  });

  test('the scan assembles its verdicts from the walkers it claims to use', () => {
    // WRITTEN IN RESPONSE TO A SILENT REVERSION CONTROL. Every other test here
    // drives the walkers directly, so the WIRING between them and the scan's
    // result lists was covered by nothing: replacing the untracked-declaration
    // source with an empty list, and emptying the uncovered-file list, both
    // left the suite green. The real corpus cannot catch either — it is clean,
    // so the assertions can only ever observe an empty result — which is
    // exactly why a synthetic corpus is the only thing that can fail on demand.
    const doc = [
      'A scoped call: `gsd_run query commit "docs: a" --files .planning/A.md`',
      'gsd_run query commit "docs: b"',
      'gsd_run query commit "docs: c"   # gsd-scan-ignore: no issue here',
    ].join('\n');
    const result = scanDocument('fixtures/demo.md', doc);
    assert.strictEqual(result.scanned.length, 3, 'every invocation is counted as scanned');
    assert.deepEqual(
      result.offenders,
      ['fixtures/demo.md: gsd_run query commit "docs: b"',
        // The excerpt stops at the `#`: tokenize ends the command there, so the
        // reported slice is the part that actually reaches argv.
        'fixtures/demo.md: gsd_run query commit "docs: c"'],
      'the unscoped invocations reach the offender list, with their label',
    );
    assert.deepEqual(
      result.untracked,
      ['fixtures/demo.md: gsd_run query commit "docs: c"   # gsd-scan-ignore: no issue here'],
      'and the untracked declaration reaches its own list',
    );

    // The uncovered-file walk, likewise driven with a synthetic file list.
    const corpus = {
      'gsd-core/workflows/a.md': 'gsd_run query commit "docs: a" --files x.md',
      'docs/b.md': 'gsd_run query commit "docs: b" --files x.md',
      'sdk/c.md': 'gsd_run query commit "docs: c" --files x.md',
      'sdk/prose.md': 'no invocation here at all',
      'CHANGELOG.md': 'gsd_run query commit "docs: shipped" --files x.md',
    };
    assert.deepEqual(
      uncoveredFiles(Object.keys(corpus), ['gsd-core/workflows', 'docs'],
        new Map([['CHANGELOG.md', 'generated']]), (f) => corpus[f]),
      ['sdk/c.md'],
      'a candidate-bearing file under no scan root is uncovered; an excluded or '
        + 'invocation-free one is not',
    );
  });

  test('the failure message names every remedy, and the convention is documented', () => {
    // A guard whose message names only the bug teaches the wrong fix for its
    // other two causes. These assertions exist because a failure message is
    // unreachable on the passing path — nothing else would notice a remedy
    // being edited out of it.
    // Matched on the REMEDY, not on its vocabulary. `/backtick/i` looked like a
    // check and was not one: the word also appears in the clause explaining why
    // a backticked mention is skipped, so deleting the instruction left the
    // assertion satisfied. A reversion control caught it — the shape of an
    // assertion that passes for a reason unrelated to the thing it names.
    assert.match(OFFENDER_HELP, /add --files/, 'the real regression needs its own remedy named');
    assert.match(OFFENDER_HELP, /wrap it in backticks/, 'a prose mention needs the backtick remedy named');
    assert.match(OFFENDER_HELP, /gsd-scan-ignore:/, 'a wrong-example needs the declaration named');
    assert.match(OFFENDER_HELP, /#NNN|https:\/\//, 'and the tracking-reference requirement');
    assert.match(OFFENDER_HELP, /CONTRIBUTING\.md/, 'and where the convention is written down');

    // The marker lives in .md files across six roots, so it cannot be
    // documented only in this test's comments — a contributor hitting it is
    // not reading tests/. Pinned so the section cannot be dropped silently
    // while the message keeps pointing at it.
    const contributing = fs.readFileSync(path.join(__dirname, '..', 'CONTRIBUTING.md'), 'utf-8');
    assert.match(
      contributing, /gsd-scan-ignore:/,
      'CONTRIBUTING.md must document the declaration marker — the failure message points there',
    );
  });

  test('a later --files on the same line cannot vouch for an earlier invocation', () => {
    // Whole-line scoring is satisfied by ONE match anywhere on the line, so a
    // second, scoped invocation masked an earlier unscoped one. No live line
    // has this shape today; it is the same "one hit vouches for the whole
    // candidate" class as the --files-value bug, so it is pinned rather than
    // left to be rediscovered.
    const masked = [
      'gsd_run query commit "a" && gsd_run query commit "b" --files x.md',
      'gsd_run query commit "a" ; gsd-tools query phase-list --files y.md',
    ];
    for (const line of masked) {
      const cands = invocationCandidates(line);
      assert.ok(
        cands.some((c) => !hasScopedFiles(c)),
        `the unscoped invocation must surface as its own candidate: ${line}`,
      );
    }

    // Both invocations scoped => nothing to flag.
    assert.strictEqual(
      invocationCandidates('gsd_run query commit "a" --files a.md && gsd_run query commit "b" --files x.md')
        .every((c) => hasScopedFiles(c)),
      true,
      'two scoped invocations on one line must both read as scoped',
    );

    // A binary inside a command substitution is NOT a second invocation: the
    // separator requirement is what keeps this from becoming a false offender.
    const substitution = 'gsd_run query commit "$(gsd-tools query phase-list)" --files a.md';
    assert.deepEqual(
      invocationCandidates(substitution), [substitution],
      'a command substitution must not split the invocation',
    );
    assert.ok(hasScopedFiles(invocationCandidates(substitution)[0]));

    // The inverse false-offender class: a line whose `commit` belongs to
    // ANOTHER command entirely. The anchor's loose `.*` matches these lines
    // (deliberately — see its comment), and the old no-hit fallback then
    // scored the whole line, flagging a legitimate chain as an unscoped
    // commit. Neither command below invokes cmdCommit, so the line must
    // contribute NO candidates rather than a red with the wrong message.
    assert.deepEqual(
      invocationCandidates('gsd_run query state && git commit -m "x"'), [],
      'a git commit on the far side of && is not a gsd invocation',
    );
    assert.deepEqual(
      invocationCandidates('gsd_run query state | grep commit'), [],
      'a grep for the word commit is not a gsd invocation',
    );
  });

  test('mid-prose argument-bearing invocations enter the candidate set', () => {
    // Literal shapes of the three live sites the anchored tier is blind to:
    // new-milestone.md / new-project.md (identical instruction) and
    // plan-phase.md. All three are scoped today — the point is that they are
    // SCANNED, so trimming their --files clause fails the sweep instead of
    // silently reintroducing #2269.
    const live = [
      'then commit ALL research artifacts the synthesizer owns with `gsd-tools query commit "docs: complete project research" --files .planning/research/` unless they are already committed.',
      '6. Commit with `gsd-tools.cjs query commit "docs(${padded_phase}): generate context from ADR ingest" --files "${phase_dir}/${padded_phase}-CONTEXT.md"` and set `context_content`; continue to step 5.',
    ];
    for (const line of live) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `must yield one candidate: ${line}`);
      assert.ok(hasScopedFiles(cands[0]), `live site is scoped today: ${line}`);
    }

    // Trimming the --files clause off the embedded invocation must surface
    // it as unscoped — the regression class the anchored tier cannot see.
    const trimmed =
      'then commit the artifacts with `gsd-tools query commit "docs: complete project research"` unless already committed.';
    const trimmedCands = invocationCandidates(trimmed);
    assert.strictEqual(trimmedCands.length, 1, 'trimmed invocation must stay in the candidate set');
    assert.strictEqual(
      hasScopedFiles(trimmedCands[0]), false,
      'trimmed invocation must be flagged as unscoped',
    );

    // Bare mentions stay out of scope: no quoted message, not an executable
    // shape — the anchored tier's deliberate exclusion survives the widening.
    assert.deepEqual(
      invocationCandidates('the `gsd_run query commit` step then records the artifact'),
      [],
      'a bare prose mention must yield no candidates',
    );

    // Prose quotes BEFORE the invocation must not blind the parity walk —
    // the candidate substring starts at the invocation token, not column 0.
    const quotedProse =
      'the "research summary" is committed via `gsd_run query commit "docs: x" --files .planning/S.md` at the end.';
    const quotedCands = invocationCandidates(quotedProse);
    assert.strictEqual(quotedCands.length, 1);
    assert.ok(
      hasScopedFiles(quotedCands[0]),
      'scoped mid-line invocation must not be false-flagged by prose quotes before it',
    );

    // The config-payload negative from the anchored tier holds mid-line too:
    // commit_docs is a JSON key, not a commit invocation.
    assert.deepEqual(
      invocationCandidates('set via `gsd_run query config-new-project \'{"commit_docs":true}\'` in step 2'),
      [],
      'a config payload mentioning commit_docs must yield no candidates',
    );

    // A SINGLE-quoted mid-prose invocation is the same executable shape. The
    // mid-line tier keyed on `commit "` only, so this one was invisible to the
    // scan entirely — not merely mis-scored — and trimming its --files clause
    // reintroduced #2269 with nothing to fail.
    const singleQuoted =
      "commit the artifacts with `gsd-tools query commit 'docs: complete research' --files .planning/research/` at the end.";
    const sqCands = invocationCandidates(singleQuoted);
    assert.strictEqual(sqCands.length, 1, `single-quoted mid-prose invocation must be scanned: ${singleQuoted}`);
    assert.ok(hasScopedFiles(sqCands[0]), 'and must read as scoped');

    const sqTrimmed =
      "commit the artifacts with `gsd-tools query commit 'docs: complete research'` at the end.";
    const sqTrimmedCands = invocationCandidates(sqTrimmed);
    assert.strictEqual(sqTrimmedCands.length, 1, 'the trimmed single-quoted form must stay in the candidate set');
    assert.strictEqual(
      hasScopedFiles(sqTrimmedCands[0]), false,
      'the trimmed single-quoted form must be flagged as unscoped',
    );
  });

  test('the command shape, not the quoting, is what makes an invocation', () => {
    // The quoted-message discriminator failed in the direction that matters:
    // an UNQUOTED invocation reaches the identical cmdCommit (a single-word
    // message needs no quotes) and entered no candidate set at all. Not
    // mis-scored — invisible. Both spellings are now scanned identically.
    for (const [line, want] of [
      ['Then run `gsd_run query commit fixup --files .planning/STATE.md` to record it.', true],
      ['Then run `gsd_run query commit fixup` to record it.', false],
      ['Then run gsd_run query commit fixup to record it.', false],
      ['gsd_run query commit fixup --files .planning/STATE.md', true],
    ]) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `must be scanned: ${line}`);
      assert.strictEqual(hasScopedFiles(cands[0]), want, `scope verdict must be ${want}: ${line}`);
    }

    // The complement, and the reason the middle clause of the command shape
    // exists: a SENTENCE can carry the binary and a commit token and still be
    // prose. Both lines below are real bare-prose shapes from the scan roots
    // with one word swapped to `commit`. What rejects them is not markup — it
    // is that `(or` is neither the `query` meta-prefix nor a flag, so the
    // command never reaches its command token.
    for (const prose of [
      'Update STATE.md using gsd-tools.cjs query (or legacy gsd-tools) commit mutations:',
      '- [ ] Artifacts generated sequentially via gsd-tools.cjs query (or gsd-tools.cjs) commit steps',
    ]) {
      assert.deepEqual(
        invocationCandidates(prose), [],
        `a sentence carrying both words is not an invocation: ${prose}`,
      );
    }

    // And a mention delimited by backticks is rejected by the trailing-argument
    // clause: the span ends at the closing backtick, so the sentence after it
    // can never supply arguments.
    assert.deepEqual(
      invocationCandidates('the `gsd_run query commit` step then records the artifact'), [],
      'a delimited mention bears no argument',
    );

    // A SUBSHELL OPENER glues to the binary — `(` changes no argv, so it is not
    // a tokenizer metacharacter, which left `(gsd_run` as one unmatchable token.
    const subshell = invocationCandidates('(gsd_run query commit "docs: x")');
    assert.strictEqual(subshell.length, 1, 'a subshell-wrapped invocation is still an invocation');
    assert.strictEqual(hasScopedFiles(subshell[0]), false, 'and it is unscoped');

    // A COMMAND SUBSTITUTION glues to the binary exactly as `(` does, and it is
    // the dominant live idiom (443 occurrences across the six roots). Pinned in
    // BOTH directions, because a guard that only proves it can flag is silent
    // about whether it can clear.
    const cmdSubUnscoped = invocationCandidates('$(gsd_run query commit "docs: x")');
    assert.strictEqual(cmdSubUnscoped.length, 1, 'a command substitution is still an invocation');
    assert.strictEqual(hasScopedFiles(cmdSubUnscoped[0]), false, 'and unscoped, it is an offender');
    const cmdSubScoped = invocationCandidates('$(gsd_run query commit "docs: x" --files a.md)');
    assert.strictEqual(cmdSubScoped.length, 1, 'the scoped direction is scanned too');
    assert.strictEqual(hasScopedFiles(cmdSubScoped[0]), true, 'and it passes');

    // THE ASSIGNMENT-CAPTURE FORM is the shape the tree actually writes —
    // `VAR=$(gsd_run …)` — so a fix pinned only on the bare form above would
    // pass while missing every live site.
    const captured = invocationCandidates('RESULT=$(gsd_run query commit "docs: x")');
    assert.strictEqual(captured.length, 1, 'an assignment-captured invocation is an invocation');
    assert.strictEqual(hasScopedFiles(captured[0]), false, 'and it is unscoped');
    assert.strictEqual(
      hasScopedFiles(invocationCandidates('OUT=$(gsd_run query commit "docs: x" --files a.md)')[0]),
      true,
      'and its scoped direction passes',
    );

    // The same glue in the INVOKER position — `V=$(bash -c "…")` IS the command
    // rather than a prefix to one, so the -c pass must not skip it as an
    // ordinary assignment.
    const capturedInvoker = invocationCandidates('V=$(bash -c "gsd_run query commit fixup")');
    assert.strictEqual(capturedInvoker.length, 1, 'an assignment-captured shell -c payload is reached');
    assert.strictEqual(hasScopedFiles(capturedInvoker[0]), false, 'and it is unscoped');

    // THE TWO LIVE PREFIXES THAT ARE NOT ASSIGNMENTS. Keying the strip on an
    // assignment covers 437 of the 443 live substitution sites and misses these
    // six, which is why the rule is positional instead of an enumeration.
    for (const live of [
      'for REVIEW_FLAG in $(gsd_run query commit "docs: x"); do :; done',
      'PLAN_PRE_HOOKS_JSON=${PLAN_PRE_HOOKS_JSON:-$(gsd_run query commit "docs: x")}',
    ]) {
      const cands = invocationCandidates(live);
      assert.strictEqual(cands.length, 1, `a non-assignment substitution prefix is still reached: ${live}`);
      assert.strictEqual(hasScopedFiles(cands[0]), false, `and it is unscoped: ${live}`);
    }
    assert.strictEqual(
      hasScopedFiles(invocationCandidates(
        'X=${Y:-$(gsd_run query commit "docs: x" --files a.md)}',
      )[0]),
      true,
      'and the scoped direction of the same shape passes',
    );

    // GLUED AFTER ORDINARY TEXT, and after an INDEXED assignment. Both are
    // executable and both were invisible while the strip was anchored to a
    // leading opener.
    for (const glued of [
      'echo pre$(gsd_run query commit "docs: x")',
      'RESULT[0]=$(gsd_run query commit "docs: x")',
    ]) {
      assert.strictEqual(
        invocationCandidates(glued).length, 1,
        `a substitution glued to preceding text is still a command: ${glued}`,
      );
    }

    // ARITHMETIC EXPANSION IS NOT A COMMAND CONTEXT. `$((…))` evaluates an
    // expression; nothing in it runs. The strip leaves a `(` in front of the
    // name, which no binary carries — the same reason the shell itself needs
    // `$( (` spaced before it will read a nested subshell here.
    assert.deepEqual(
      invocationCandidates('$((gsd_run query commit "docs: x"))'), [],
      'arithmetic expansion is not an invocation',
    );

    // A QUOTED OPENER IS DATA, NOT SYNTAX. The strip must not run on a token
    // that carried a quote: in `printf %s '$(gsd_run' query commit fixup` the
    // opener is single-quoted literal text and no gsd command executes, but
    // quote removal leaves the token `$(gsd_run` and an unconditional strip
    // would fabricate an invocation out of a string argument. Both directions
    // of quoting reach it.
    for (const quoted of [
      "printf %s '$(gsd_run' query commit fixup",
      'echo "--files=x$(gsd_run" query commit fixup',
      "printf %s '(gsd_run' query commit fixup",
    ]) {
      assert.deepEqual(
        invocationCandidates(quoted), [],
        `a quoted opener is data, not a command: ${quoted}`,
      );
    }

    // AND THE OTHER DIRECTION, which is the one that matters more. A quote
    // elsewhere in the word protects only itself: `echo "pre"$(gsd_run …)` runs,
    // and so does an invocation with an empty quote wedged into the binary name.
    // A per-TOKEN "was anything quoted" flag suppresses the strip on both and
    // turns this file's tolerable failure (a visible false positive) into its
    // intolerable one (a silent miss) — so the mask is per-character.
    for (const executable of [
      'echo "pre"$(gsd_run query commit fixup)',
      '$(gsd_""run query commit fixup)',
    ]) {
      assert.strictEqual(
        invocationCandidates(executable).length, 1,
        `a quote elsewhere in the word does not protect the opener: ${executable}`,
      );
    }

    // THE NEGATIVE THAT KEEPS THE WIDENING HONEST: `V=(a b c)` is an array
    // literal, not a substitution — it runs nothing, so it must stay invisible.
    // It carries no `$(` at all, so the positional strip cannot reach it; this
    // is pinned because that is a property of the regex, not of the grammar.
    assert.deepEqual(
      invocationCandidates('arr=(gsd_run query commit "docs: x")'), [],
      'an array literal is not a command',
    );

    // A SHELL INVOKED WITH -c runs its next argument as a command, so the
    // invocation lives inside a quoted token that no markup rule reaches.
    const dashC = invocationCandidates('bash -c "gsd_run query commit fixup"');
    assert.strictEqual(dashC.length, 1, 'a shell -c payload is a command, not a string');
    assert.strictEqual(hasScopedFiles(dashC[0]), false, 'and it is unscoped');
    for (const invoker of ['sh', 'ash', 'dash', 'ksh', 'zsh', 'csh', 'tcsh', 'fish', 'yash']) {
      assert.strictEqual(
        invocationCandidates(`${invoker} -c "gsd_run query commit fixup --files a.md"`).length, 1,
        `the invoker set must not be a guess at four spellings: ${invoker}`,
      );
    }

    // THE INVOKER MUST BE THE COMMAND. Searching the segment for a shell name
    // anywhere made a line that merely PRINTS a command line a candidate.
    assert.deepEqual(
      invocationCandidates('echo bash -c "gsd_run query commit fixup"'), [],
      'echo prints the string, it does not run it',
    );
    // …while the things that may legitimately precede a command still may.
    for (const prefixed of [
      'then sh -c "gsd_run query commit fixup"',
      '$ bash -c "gsd_run query commit fixup"',
      'FOO=1 bash -c "gsd_run query commit fixup"',
      '(sh -c "gsd_run query commit fixup")',
      // Command modifiers pass straight through to what follows them.
      'time bash -c "gsd_run query commit fixup"',
      'exec sh -c "gsd_run query commit fixup"',
      'nohup bash -c "gsd_run query commit fixup"',
      'env FOO=1 bash -c "gsd_run query commit fixup"',
    ]) {
      assert.strictEqual(
        invocationCandidates(prefixed).length, 1,
        `a keyword, prompt, env assignment, modifier or subshell may precede the invoker: ${prefixed}`,
      );
    }

    // The invoker set is EXACT, not a guess — enumerated rather than sampled.
    // `ssh` is the near-miss worth pinning: admitting it would treat a remote
    // command as a local shell running the payload.
    for (const notAShell of ['ssh', 'cash', 'josh', 'publish', 'wish', 'rsh']) {
      assert.deepEqual(
        invocationCandidates(`${notAShell} -c "gsd_run query commit fixup"`), [],
        `not a shell, must not recurse into its argument: ${notAShell}`,
      );
    }

    // The recursion is keyed on the INVOKER, never on "a quoted token that
    // parses as a command". The wider rule would flag a commit MESSAGE that
    // quotes an invocation — ordinary documentation, and a false positive.
    const quotingMessage = 'gsd_run query commit "docs: run gsd_run query commit fixup first" --files a.md';
    const qmCands = invocationCandidates(quotingMessage);
    assert.strictEqual(qmCands.length, 1, 'a message quoting a command is one invocation, not two');
    assert.ok(hasScopedFiles(qmCands[0]), 'and the real one is scoped');

    // A BACKSLASH-ESCAPED backtick is literal text, not a delimiter. Treating
    // it as one invents a code span that the rendered document does not have,
    // and the invented span then reads as an unscoped invocation — a false
    // offender against prose that merely displays a backtick.
    assert.deepEqual(
      invocationCandidates('text \\`gsd_run query commit fixup\\` more'), [],
      'escaped backticks are literal and must not open a span',
    );

    // AN ODD BACKSLASH ESCAPES EXACTLY ONE BACKTICK — the first of the run.
    // The code used to skip the WHOLE run, which is a stricter rule than the
    // one its comment states, and it dropped the remaining delimiter: below,
    // the escape consumes one of the two backticks and the survivor opens a
    // real span that pairs with the closing one. Previously: no span at all.
    assert.deepEqual(
      codeSpans('text \\``gsd_run query commit fixup --files a.md` end'),
      ['gsd_run query commit fixup --files a.md'],
      'an escaped first backtick leaves the rest of the run as a delimiter',
    );

    // The reviewer's shape for the same defect stays at zero candidates, and
    // that is now CORRECT rather than incidental: the surviving opener is a
    // 1-run and the closer is a 2-run, and CommonMark pairs a run only with a
    // run of equal length. Pinned so the distinction is not re-litigated.
    assert.deepEqual(
      codeSpans('text \\``gsd_run query commit fixup`` end'), [],
      'a 1-run opener does not pair with a 2-run closer',
    );
    // The unescaped twin is a real span and is scanned, so the assertion above
    // pins the escape rather than the absence of span handling.
    assert.strictEqual(
      invocationCandidates('text `gsd_run query commit fixup` more').length, 1,
      'the unescaped form is a real code span and is scanned',
    );

    // NAMED RESIDUAL, pinned so it is visible rather than discovered. An
    // UNDELIMITED prose mention that runs straight from the command into the
    // sentence does read as argument-bearing, and is flagged:
    assert.strictEqual(
      invocationCandidates('see gsd_run query commit for the scoping rules').length, 1,
      'an undelimited prose mention is indistinguishable from an invocation with arguments',
    );
    // Nothing distinguishes those two without guessing at English, so the scan
    // does not try. The exposure is bounded and measured: the six roots carry
    // 93 bare-prose mentions of the binary today and 0 of them carry a commit
    // token, the repo's own convention is to write a command reference in
    // backticks (which this scan then handles correctly), and the failure is a
    // visible red an author resolves by adding those backticks or declaring
    // the line. That is the safe polarity — the alternative is guessing, and a
    // wrong guess here is a silent false negative.
  });

  test('an invocation is found by its command shape, whatever markup surrounds it', () => {
    // These are the shapes a markup-context model kept losing, each of them
    // executable and each of them #2269 when unscoped. None starts the line
    // with the binary, so a line-start anchor rejects all of them; none carries
    // backticks, so an inline-code-span rule finds nothing. They are pinned
    // together because they failed together, for one reason: the scan was
    // asking about the markup instead of the command.
    const scoped = 'if [ -f x ]; then gsd_run query commit "docs: m" --files a.md; fi';
    const scopedCands = invocationCandidates(scoped);
    assert.strictEqual(scopedCands.length, 1, `a conditional invocation must be scanned: ${scoped}`);
    assert.ok(hasScopedFiles(scopedCands[0]), 'and reads as scoped');

    for (const line of [
      'if [ -f x ]; then gsd_run query commit "docs: m"; fi',
      'cd "$ROOT" && gsd_run query commit "docs: m"',
      '  && gsd_run query commit "docs: m"',
      '    $ gsd_run query commit "docs: m"',
      '    cd /x && gsd_run query commit "docs: m"',
    ]) {
      const cands = invocationCandidates(line);
      assert.strictEqual(cands.length, 1, `must yield one candidate: ${line}`);
      assert.strictEqual(hasScopedFiles(cands[0]), false, `must be flagged as unscoped: ${line}`);
    }

    // Nested fences of differing widths, over a whole document. A walk that
    // toggled on every fence marker without tracking the opening run length
    // inverted its own state here and stopped scanning the rest of the file —
    // silently. Scanning by command shape has no state to invert, and this
    // pins that it does not regress into having one.
    const nested = ['````markdown', '```bash', 'cd "$ROOT" && gsd_run query commit "docs: m"', '```', '````'].join('\n');
    const nestedCands = documentCandidates(nested);
    assert.strictEqual(nestedCands.length, 1, 'an invocation inside nested fences of differing widths must be scanned');
    assert.strictEqual(hasScopedFiles(nestedCands[0]), false, 'and flagged as unscoped');
  });

  test('an interpreter prefix is still the line being the command', () => {
    // `node gsd-tools.cjs commit …` executes exactly as `gsd-tools.cjs
    // commit …` does, but it was invisible to BOTH tiers: tier 1 required the
    // binary to be the first word, and tier 2 requires backticks it does not
    // carry inside a fence. An unscoped one was therefore uncatchable.
    const scoped = 'node gsd-tools.cjs commit "docs: x" --files .planning/STATE.md';
    assert.ok(invocationCandidates(scoped).length === 1, 'an interpreter-prefixed invocation must be scanned');
    const scopedCands = invocationCandidates(scoped);
    assert.strictEqual(scopedCands.length, 1);
    assert.ok(hasScopedFiles(scopedCands[0]), 'and must read as scoped');

    const bare = 'node gsd-tools.cjs commit "docs: x"';
    const bareCands = invocationCandidates(bare);
    assert.strictEqual(bareCands.length, 1, 'the unscoped interpreter-prefixed form must be a candidate');
    assert.strictEqual(hasScopedFiles(bareCands[0]), false, 'and must be flagged — this is #2269');
  });

  test('usage-synopsis notation documents the CLI and is not a call to it', () => {
    // Live in docs/CLI-TOOLS.md and its four localized mirrors. Widening tier
    // 1 to admit the interpreter prefix brought these into the candidate set,
    // where they scored as UNSCOPED offenders — `[--files` is not the exact
    // token routeCommit's indexOf looks for, and `<message>` is eaten as a
    // redirection. Both readings are right about the text and wrong about
    // what it IS: a synopsis is documentation, and flagging it would redden
    // CI on content that is correct as written.
    const synopsis = 'node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]';
    assert.deepEqual(
      invocationCandidates(synopsis), [],
      'a usage synopsis must not enter the candidate set',
    );

    // The discrimination is the bracketed FLAG, never "contains a bracket":
    // 24 live invocations carry brackets inside their quoted message, and a
    // bracket-anywhere rule would drop every one of them from the scan.
    const bracketedMessage = 'gsd_run query commit "docs: capture todo - [title]" --files .planning/todos/x.md';
    const bmCands = invocationCandidates(bracketedMessage);
    assert.strictEqual(bmCands.length, 1, 'brackets inside the MESSAGE must not exempt a real invocation');
    assert.ok(hasScopedFiles(bmCands[0]), 'and it is scoped');

    // A bracketed metavariable as the --files VALUE is a real invocation too
    // (pause-work.md carries `--files [handoff-path]` live) — only a bracketed
    // FLAG marks synopsis notation.
    const metavarValue = 'gsd_run query commit "wip: [context-name] paused" --files [handoff-path]';
    const mvCands = invocationCandidates(metavarValue);
    assert.strictEqual(mvCands.length, 1, 'a metavariable VALUE must not exempt a real invocation');
    assert.ok(hasScopedFiles(mvCands[0]), 'a bracketed value is still a value');

    // AND THE TEST IS POSITIONAL — the FIRST argument, not "anywhere on the
    // line". Scanning every token for notation was wrong in both directions.
    //
    // Direction 1: notation belonging to no command at all disqualified the
    // real invocation that followed it. An ordinary markdown link does this,
    // and docs/ is a scan root.
    const linkThenCall = 'See [--files](#anchor) then run gsd_run query commit "docs: x"';
    const ltCands = invocationCandidates(linkThenCall);
    assert.strictEqual(ltCands.length, 1, 'notation before the binary belongs to no command');
    assert.strictEqual(hasScopedFiles(ltCands[0]), false, 'and the real invocation is still flagged');

    // Direction 2 — the dangerous one. `[--amend]` is a literal word to the
    // shell, so this line RUNS, reaches routeCommit with files=[], and sweeps
    // the index: #2269 verbatim. It scored 0 candidates.
    const callWithBracketedFlag = 'gsd_run query commit "docs: x" [--amend]';
    const cbCands = invocationCandidates(callWithBracketedFlag);
    assert.strictEqual(cbCands.length, 1, 'a real call carrying a bracketed token is still a call');
    assert.strictEqual(hasScopedFiles(cbCands[0]), false, 'and it is unscoped — this is the #2269 shape');

    // A synopsis whose placeholder is a bracketed GROUP rather than an angle
    // metavariable is still notation: its first argument is the group.
    assert.deepEqual(
      invocationCandidates('gsd-tools.cjs commit [--files f1 f2] [--amend]'), [],
      'a leading bracketed optional group is notation, not a call',
    );

    // The false negative the raw-text reading of a metavariable would have
    // introduced: inside a QUOTED message, `<Widget>` is ordinary text — one
    // token, no redirection — and the invocation is real.
    const quotedMetavar = 'gsd_run query commit "docs: add <Widget> support"';
    const qmCands = invocationCandidates(quotedMetavar);
    assert.strictEqual(qmCands.length, 1, 'a metavariable inside the message is message text');
    assert.strictEqual(hasScopedFiles(qmCands[0]), false, 'and the invocation is still flagged');
  });

  // The scan's verdict rests entirely on hasScopedFiles's quote-parity walk,
  // which is parser-shaped logic over adversarial text. Live workflow content
  // exercises only a handful of shapes, so pin the invariant by property:
  // a `--files` occurring ONLY inside the quoted commit message never counts,
  // and appending a real one outside the quotes always does.
  describe('property: tokenization is what decides scope', () => {
    // THE DELIMITER IS PART OF THE DOMAIN. Every property here used to build
    // its line from a hardcoded `"` template, so no number of runs could ever
    // generate a single-quoted or unquoted invocation — the properties pinned
    // one quoting dialect while reading as though they pinned the predicate,
    // and that is precisely what let a single-quoted false negative through.
    // Draw the delimiter, and the shape that got through is inside the
    // generator's domain rather than outside it.
    const delimiter = fc.constantFrom('"', "'");
    // The unquoted spelling too — `commit msg --files x` reaches the same
    // cmdCommit, and it was outside every generator's domain before.
    const anyDelimiter = fc.constantFrom('"', "'", '');
    // A token the shell passes through VERBATIM — no quote, no whitespace, and
    // no control operator. The operator exclusion is load-bearing rather than
    // tidiness: an unconstrained generator can draw `&&` or `|` as a "path",
    // and the scanner is then RIGHT to read it as a separator while a
    // token-list oracle reads it as a value. That disagreement is a defect in
    // the generator's domain, not in the predicate, and it would surface as a
    // rare seed-dependent red — the same flake class the `--` exclusion below
    // was added for.
    const SAFE = 'abcXYZ019._/@:,+=~*-';
    const safeToken = fc
      .string({ minLength: 1, maxLength: 24 })
      .map((s) => s.replace(/[^A-Za-z0-9._/@:,+=~*-]/g, () => SAFE[0]))
      .filter((s) => s.length > 0);
    // A message body compatible with the delimiter wrapping it. Inside quotes
    // it may now contain the OTHER quote character — `commit "docs: don't
    // break"` is a legitimate line the old parity walk mis-scored.
    //
    // Double-quoted messages may also contain `"` and `\` themselves: embedFor
    // escapes them on the way into the LINE while the property keeps the RAW
    // string as the argv the shell would deliver, so the tokenizer's
    // backslash-escape branch sits inside the generator's domain instead of
    // being stripped out of it (round-10 finding: both escape branches were
    // untested because every generator dropped every backslash). Single-quoted
    // messages still exclude their own delimiter and backslashes — the shell
    // has NO escape inside '…', so there is no escaped spelling to generate —
    // and newlines are stripped everywhere because the scan is line-based.
    const embedFor = (d, s) => (d === '"' ? s.replace(/[\\"]/g, (c) => `\\${c}`) : s);
    const messageFor = (d) => {
      if (d === '') return fc.oneof(fc.constant(''), safeToken);
      if (d === '"') return fc.string({ maxLength: 60 }).map((s) => s.replace(/[\r\n]/g, ''));
      return fc.string({ maxLength: 60 }).map((s) => s.replace(/[\r\n]/g, '').split(d).join('').split('\\').join(''));
    };
    // A path the shell passes through as a VALUE. The `--` exclusion is not
    // cosmetic: routeCommit drops every `--`-prefixed token after --files, so
    // such a token is not a path at all and the invocation is unscoped — which
    // is the flag property below, not this one. Without the exclusion this
    // generator reaches that input space roughly once per 7,700 draws
    // (measured: 26 hits in 200,000), i.e. ~1 CI run in 77 at fast-check's
    // default 100 runs — a property that fails rarely and looks like a flake.
    const arg = safeToken.filter((s) => !s.startsWith('--'));
    // The complement: a `--`-prefixed token, which the runtime discards.
    const flagArg = safeToken.map((s) => `--${s}`);

    test('a --files mentioned only inside the quoted message is never a scope', () => {
      // Only the quoted delimiters appear here: an unquoted message cannot
      // contain a space, so "--files inside the message" is not a shape a bare
      // invocation can express. It is covered by the two properties below.
      fc.assert(
        fc.property(
          delimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), messageFor(d))),
          ([d, a, b]) => {
            const line = `gsd_run query commit ${d}${embedFor(d, `${a} --files ${b}`)}${d}`;
            assert.strictEqual(
              hasScopedFiles(line), false,
              `a --files inside the message must not count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('a real --files outside the message always counts, whatever the message says', () => {
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), arg)),
          ([d, message, filePath]) => {
            const line = `gsd_run query commit ${d}${embedFor(d, message)}${d} --files ${filePath}`;
            assert.strictEqual(
              hasScopedFiles(line), true,
              `a --files outside the message must count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('a --files with no non-flag token after it is never a scope', () => {
      // The scanner must agree with routeCommit for EVERY flag spelling, not
      // just the --amend instance found in review: args.slice(i+1).filter(a =>
      // !a.startsWith('--')) discards them all, leaving files=[] and the
      // unscoped default.
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(fc.constant(d), messageFor(d), flagArg)),
          ([d, message, flag]) => {
            const line = `gsd_run query commit ${d}${embedFor(d, message)}${d} --files ${flag}`;
            assert.strictEqual(
              hasScopedFiles(line), false,
              `--files followed only by a flag must not count as scope: ${line}`,
            );
          },
        ),
      );
    });

    test('the scanner agrees with routeCommit on the tokens, for any delimiter', () => {
      // The properties above assert against hand-derived expectations. This
      // one asserts against the RUNTIME's own predicate, re-implemented from
      // routeCommit over the same tokens — so a future divergence fails here
      // even if nobody thought to write a case for its shape.
      const runtimeScoped = (tokens) => {
        const i = tokens.indexOf('--files');
        return i !== -1 && tokens.slice(i + 1).some((t) => !t.startsWith('--'));
      };
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => fc.tuple(
            fc.constant(d),
            messageFor(d),
            fc.array(fc.oneof(arg, flagArg, fc.constant('--files')), { maxLength: 4 }),
          )),
          ([d, message, tail]) => {
            const line = `gsd_run query commit ${d}${embedFor(d, message)}${d} ${tail.join(' ')}`;
            // The argv the shell would hand routeCommit for that same line.
            const argv = ['commit', message, ...tail];
            assert.strictEqual(
              hasScopedFiles(line), runtimeScoped(argv),
              `scanner and routeCommit must agree: ${line}`,
            );
          },
        ),
      );
    });

    test('never throws, whatever the input line looks like', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (line) => {
          assert.strictEqual(typeof hasScopedFiles(line), 'boolean');
        }),
      );
    });

    // EVERY PROPERTY ABOVE AIMS AT hasScopedFiles — the half backed by a
    // runtime oracle, and the half that has been stable for rounds. Every
    // defect found since is in the OTHER half: whether a line is an invocation
    // at all (isCommitInvocation, segmentInvocations, codeSpans, the synopsis
    // and binary-anchor rules), which was pinned only by hand-written examples.
    // That asymmetry is the problem, because a miss there is a SILENT FALSE
    // NEGATIVE — an invocation that stops being scanned with no signal — where
    // a miss in the scope predicate at least has an oracle watching it.
    //
    // So generate the CONTEXT instead of the arguments. The recognition rule is
    // "an invocation is found by its command shape, whatever markup surrounds
    // it", and that is a statement about a domain the generator can cover:
    // subshells, interpreters, env prefixes, shell keywords, prompts,
    // indentation, chaining, and code spans. Each of these was a hand-pinned
    // example, several of them added only after a reviewer found the gap.
    const context = fc.constantFrom(
      '', '    ', '$ ', 'then ', 'FOO=1 ', 'node ', '(',
      'cd "$ROOT" && ', 'if [ -f x ]; then ', '- ', '> ',
    );
    const binary = fc.constantFrom('gsd_run', 'gsd-tools', 'gsd-tools.cjs', './bin/gsd-tools.cjs');
    const preCommand = fc.constantFrom('', 'query ', '--cwd "$ROOT" ', '--cwd "$ROOT" query ');
    const commandToken = fc.constantFrom('commit', 'commit-to-subrepo');
    // A message that always produces a token: with no delimiter an empty body
    // emits no word at all, and the argv the oracle is built from would then
    // disagree with the line for a reason that is not about recognition.
    const bodyFor = (d) => (d === '' ? safeToken : messageFor(d));

    // A second axis: the command may be WRAPPED rather than prefixed. Drawn
    // only with the unquoted body — a `-c` payload is itself quoted, so
    // generating a quoted message inside it would need a nested-quoting domain,
    // and a wrong generator domain is this file's most repeated own-goal (it
    // has produced a seed-dependent red twice). Constraining the body is what
    // makes the axis safe to add rather than a third instance of that.
    const wrapper = fc.constantFrom('', 'bash -c', 'sh -c');
    // `node ` is an interpreter prefix for the BINARY, and `node bash -c "…"`
    // is not an executable line at all — node takes a script path and `bash`
    // is not one, so nothing runs the payload. Excluding the combination is a
    // generator-domain correction, not a narrowing of the property: an
    // unexecutable line is outside what "a real invocation" means, and leaving
    // it in would have the property demand recognition of a non-command.
    const contextFor = (wrap) => (wrap
      ? context.filter((c) => c !== 'node ')
      : context);
    test('a real invocation is recognized whatever surrounds it', () => {
      fc.assert(
        fc.property(
          anyDelimiter.chain((d) => (d === '' ? wrapper : fc.constant('')).chain((wrap) => fc.tuple(
            fc.constant(d), contextFor(wrap), binary, preCommand, commandToken, bodyFor(d),
            fc.array(fc.oneof(arg, flagArg, fc.constant('--files')), { maxLength: 3 }),
            fc.constant(wrap),
          ))),
          ([d, ctx, bin, pre, cmd, body, tail, wrap]) => {
            const command = `${bin} ${pre}${cmd} ${d}${embedFor(d, body)}${d}`
              + (tail.length ? ` ${tail.join(' ')}` : '');
            const line = wrap ? `${ctx}${wrap} "${command}"` : `${ctx}${command}`;
            const cands = invocationCandidates(line);
            assert.ok(
              cands.length > 0,
              `an executable invocation must be recognized: ${line}`,
            );
            // …and recognizing it is only useful if the verdict survives the
            // slicing. The candidate the scan will score must agree with the
            // argv the shell would have delivered.
            const runtimeScoped = (tokens) => {
              const i = tokens.indexOf('--files');
              return i !== -1 && tokens.slice(i + 1).some((t) => !t.startsWith('--'));
            };
            const argv = [cmd, body, ...tail];
            assert.ok(
              cands.some((c) => hasScopedFiles(c) === runtimeScoped(argv)),
              `no candidate agrees with routeCommit: ${line}`,
            );
          },
        ),
      );
    });

    test('a mention carrying no argument is never an invocation', () => {
      // The complement, and the reason the trailing-argument clause exists. If
      // recognition widens far enough to swallow this, the guard becomes
      // hostile to ordinary prose — the failure mode the declaration marker was
      // invented to undo — so the property is pinned in this direction too.
      fc.assert(
        fc.property(
          fc.tuple(context, binary, preCommand, commandToken),
          ([ctx, bin, pre, cmd]) => {
            const line = `${ctx}\`${bin} ${pre}${cmd}\` in prose`;
            assert.deepEqual(
              invocationCandidates(line), [],
              `a delimited mention bears no argument: ${line}`,
            );
          },
        ),
      );
    });
  });

  test('every query commit invocation passes --files', () => {
    // #2269: three workflow call sites omitted --files, landing on the
    // default branch that blanket-stages .planning/ and commits the entire
    // index. The #2112 pathspec fix is gated on explicitFiles, so it cannot
    // reach a caller that never declares a scope. This scan keeps every
    // invocation on the scoped path (and catches future bare sites) —
    // across every directory that carries live invocations, not just
    // gsd-core/workflows/: agents/, commands/, skills/, and
    // gsd-core/references/ invoke the same seam.
    //
    // docs/ is in the list because the claim above has to be TRUE, not
    // aspirational. It was not: docs/zh-CN/references/ carries 7 live
    // invocations — the Chinese mirrors of three gsd-core/references/ files
    // that ARE scanned. Those mirrors are exactly where an unscoped example
    // survives unnoticed, since the locales already drift per-locale
    // (ja-JP/ko-KR/pt-BR have no references/ subtree at all). New files under
    // an existing root are picked up automatically by the recursive walk, so
    // the gap was only ever at the ROOT level — which is why it needed a root
    // rather than a rule.
    const scanRoots = [
      'gsd-core/workflows',
      'gsd-core/references',
      'agents',
      'commands',
      'skills',
      'docs',
    ];
    const offenders = [];
    const scanned = [];
    const untracked = [];
    for (const root of scanRoots) {
      const rootDir = path.join(__dirname, '..', root);
      const mdFiles = fs
        .readdirSync(rootDir, { recursive: true })
        .filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        // readdirSync returns platform-separated relative paths; normalize
        // unconditionally (repo convention) so the diagnostic strings — and
        // the startsWith() reach assertions below — read identically on
        // Windows. Join with the RAW entry; report with the normalized one.
        const normalized = String(file).split(path.sep).join('/');
        const text = fs.readFileSync(path.join(rootDir, file), 'utf-8');
        const result = scanDocument(`${root}/${normalized}`, text);
        scanned.push(...result.scanned);
        offenders.push(...result.offenders);
        untracked.push(...result.untracked);
      }
    }
    // ASSERTED FIRST, deliberately. An untracked declaration is also an
    // offender (it does not exempt), so leaving it to the assertion below
    // would report "your commit is unscoped" to an author who had already
    // explained the line — sending them to look for a flag that was never the
    // problem. The specific diagnosis must win the race.
    assert.deepEqual(
      untracked,
      [],
      'gsd-scan-ignore: declarations without a tracking reference. Add a #NNN issue '
        + 'number or an http(s):// URL to the reason, per ADR-456:\n'
        + untracked.join('\n'),
    );
    // THE MESSAGE NAMES ITS OWN REMEDIES — all three of them, because this
    // guard has three distinct failure causes and only one of them is the bug.
    // A contributor whose ordinary English sentence reddens CI, told only that
    // a commit is unscoped, will mangle the sentence until the guard shuts up:
    // exactly the outcome the declaration marker was invented to prevent. The
    // repo already states this standard for its sibling gate one section over
    // in CONTRIBUTING.md — "the failure output names its own remedy".
    assert.deepEqual(
      offenders,
      [],
      OFFENDER_HELP + '\n\n' + offenders.join('\n'),
    );

    // A zero is only evidence if the scan reached the content — but the
    // question "did it reach everything?" is about the REPO, not about each
    // root, and asking it per-root was both too weak and too strong.
    //
    // Too strong: `commands/` contributes exactly one invocation and `skills/`
    // one, so an unrelated PR retiring review-backlog or re-syncing the Chinese
    // mirrors turned this red with a failure that had nothing to do with #2269.
    // A root is allowed to legitimately go to zero.
    //
    // Too weak: it could only ever confirm the roots already listed. The gap it
    // was standing in for — a directory that acquires invocations and is not a
    // root — is invisible to it, and that is the gap this file has actually
    // been bitten by twice (agents/ in one round, docs/zh-CN/ in the next).
    //
    // So assert the property directly, over every tracked .md in the repo: if
    // it carries a live invocation, the scan must have covered it. Dropping any
    // root now fails here, which is the coverage guarantee the per-root check
    // was approximating; and a NEW directory acquiring one fails here too,
    // which nothing previously caught.
    const repoRoot = path.join(__dirname, '..');
    // FAIL CLOSED, via the seam. gitOrThrow throws on any non-clean exit, which
    // is the polarity this check needs: an unreadable file list is an UNKNOWN
    // coverage set, not an empty one, and treating a failed enumeration as "no
    // strays" is the shape that reports clean because the check never ran.
    // Routed through tests/helpers/git-fixture.cjs rather than a bare spawn per
    // #3144 — local/no-unbounded-spawn fails an unbounded spawnSync in tests,
    // and this file's allowlist entry was retired when that migration landed.
    // -c safe.directory=* is scoped to THIS invocation only (never a global
    // `git config` write): unlike every other gitOrThrow call in this file,
    // which targets a createTempGitProject() fixture it owns, this one runs
    // against the real checked-out repoRoot, whose ownership can legitimately
    // differ from the running UID inside a container-provisioned test runner
    // (git's CVE-2022-24765 dubious-ownership guard would otherwise fire).
    const trackedMd = gitOrThrow(['-c', 'safe.directory=*', 'ls-files', '-z', '--', '*.md'], {
      cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS,
    }).split('\0').filter(Boolean);
    assert.ok(trackedMd.length > 0, 'git ls-files reported no .md files at all — the walk is broken');

    // Generated files are excluded WITH THEIR REASON, and the reason is that a
    // contributor cannot act on the failure: CHANGELOG.md is rebuilt from
    // .changeset/ fragments, so a marker added to it would not survive the next
    // release. Its single live invocation is scoped today, and it is a record of
    // commands that shipped rather than an instruction to run one.
    const NOT_INSTRUCTION = new Map([
      ['CHANGELOG.md', 'generated from .changeset/ fragments; a historical record, not instruction'],
    ]);
    const strays = uncoveredFiles(
      trackedMd, scanRoots, NOT_INSTRUCTION,
      (f) => fs.readFileSync(path.join(repoRoot, f), 'utf-8'),
    );
    assert.deepEqual(
      strays, [],
      'these tracked .md files carry live commit invocations that NO scan root covers, so #2269 '
        + 'could regress in them undetected. Add the directory to scanRoots, or add the file to '
        + 'NOT_INSTRUCTION with the reason it is not executable instruction:\n' + strays.join('\n'),
    );
  });

  describe('behavioral', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempGitProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('the workflow commit shape excludes unrelated staged files (secure-phase step 7)', () => {
      // Mirrors gsd-core/workflows/secure-phase.md step 7 after #2269. The
      // --files scope is DERIVED from the workflow's own commit line rather
      // than hardcoded, so a revert of that line's --files (the #2269
      // regression) fails this behavioral test too, not only the scan above.
      const workflowRaw = fs.readFileSync(
        path.join(__dirname, '..', 'gsd-core', 'workflows', 'secure-phase.md'),
        'utf-8',
      );
      // Join backslash-continued lines first, exactly as the scan above does:
      // the workflow wraps --files onto a continuation line, so the invocation
      // token and the SECURITY.md scope live on two different physical lines
      // and a raw per-line find would miss the invocation entirely.
      const commitLine = workflowRaw
        .replace(/\\\r?\n/g, ' ')
        .split(/\r?\n/)
        .find((l) => invocationCandidates(l).length > 0 && l.includes('SECURITY.md'));
      assert.ok(
        commitLine,
        'secure-phase.md step 7 commit invocation not found — did the workflow drop or rename its SECURITY.md commit?',
      );
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses a single line from maintainer-authored secure-phase.md, bounded, not adversarial input
      const filesArg = /--files\s+"([^"]+)"/.exec(commitLine);
      // Two different failures, two different messages. This test derives the
      // scope from the workflow's own quoted --files value, so an UNQUOTED
      // value breaks the derivation without being the #2269 regression — and
      // reporting it as "no longer declares --files" sends the reader to look
      // for a missing flag that is right there.
      assert.ok(
        // The scan's predicate, not a second copy of it. A duplicated
        // approximation here would drift out of agreement with the scanner
        // silently — this line carried the old `\S` heuristic and would have
        // kept scoring `--files --amend` as scoped after the scanner stopped.
        hasScopedFiles(commitLine),
        'secure-phase.md step 7 no longer declares --files — the #2269 regression this test guards:\n' + commitLine,
      );
      assert.ok(
        filesArg,
        'secure-phase.md step 7 declares --files with an UNQUOTED value; this test derives its scope '
          + 'from the quoted form. Not a #2269 regression — update the derivation below:\n' + commitLine,
      );
      // Instantiate the workflow line's shell variables with concrete values.
      const artifact = filesArg[1]
        .replace('${PHASE_DIR}', '.planning/phases/01-hardening')
        .replace('${PADDED_PHASE}', '01');
      assert.ok(
        !artifact.includes('${'),
        'unresolved shell variable in the derived artifact path — update the substitutions: ' + artifact,
      );

      const phaseDir = path.join(tmpDir, path.dirname(artifact));
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, artifact), '# Security\n');

      // Unrelated staged work a parallel agent / editor left behind.
      fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'in flight\n');
      gitOrThrow(['add', 'unrelated.txt'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
      // And an unstaged .planning/ stray the blanket `git add .planning/`
      // used to pull in (the vector a caller cannot defend against).
      fs.writeFileSync(path.join(tmpDir, '.planning', 'scratch.md'), 'stray\n');

      runGsdTools(
        [
          'commit',
          'docs(phase-1): add/update security threat verification',
          '--files',
          artifact,
        ],
        tmpDir,
      );

      const files = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-only'], {
        cwd: tmpDir,
        timeoutMs: GIT_TIMEOUT_MS,
      })
        .trim()
        .split('\n');
      assert.deepEqual(
        files,
        [artifact],
        'the scoped workflow commit must contain only its own artifact, got:\n' + files.join('\n'),
      );

      const statusOutput = gitOrThrow(['status', '--porcelain'], {
        cwd: tmpDir,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      assert.ok(
        statusOutput.includes('unrelated.txt'),
        'unrelated.txt should remain staged, not committed. Status:\n' + statusOutput,
      );
      assert.ok(
        statusOutput.includes('.planning/scratch.md'),
        'the unstaged .planning/ stray must not be swept in. Status:\n' + statusOutput,
      );
    });
  });
});

// ─── #3886: git commit timeout is a commit_timeout, not a commit_failed ─────

describe('commit timeout reporting (#3886)', () => {
  // Same in-process execGit interception family as #2608's staging harness
  // above, verb-swapped to `commit`: the killed `git commit` surfaces the
  // SIGTERM+ETIMEDOUT shape (posix) or the ETIMEDOUT-only shape (Windows —
  // #3050: signal is not reliably reported there).
  function commitWithTimedOutCommit({ cwd, files, stderr = "warning: LF will be replaced by CRLF", timeoutShape = 'posix' }) {
    const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommit } = require(path.join(LIB, 'commands.cjs'));
const timeoutShape = ${JSON.stringify(timeoutShape)};
const stderrText = ${JSON.stringify(stderr)};
const real = projection.execGit;
projection.execGit = (args, opts) => {
  if (args[0] === 'commit') {
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    return { exitCode: 1, stdout: '', stderr: stderrText, signal: timeoutShape === 'posix' ? 'SIGTERM' : null, error: e };
  }
  return real(args, opts);
};
cmdCommit(${JSON.stringify(cwd)}, 'docs: probe', ${JSON.stringify(files)}, false, false, false);
`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 15_000 });
    if (run.status !== 0 && !run.stdout) {
      throw new Error(`probe crashed: ${run.stderr}`);
    }
    return { result: JSON.parse(run.stdout) };
  }

  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3886-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir, timeout: 15_000 });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: tmpDir, timeout: 15_000 });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir, timeout: 15_000 });
  });
  afterEach(() => cleanup(tmpDir));

  for (const shape of ['posix', 'windows']) {
    test(`a timed-out git commit reports commit_timeout (${shape} shape), naming the stale lock`, () => {
      const { result } = commitWithTimedOutCommit({ cwd: tmpDir, files: ['.planning/STATE.md'], timeoutShape: shape });
      assert.equal(result.committed, false);
      assert.equal(result.reason, 'commit_timeout', `a timeout must not read as commit_failed (${shape})`);
      assert.equal(result.timed_out, true);
      assert.ok(
        (result.error || '').includes('index.lock'),
        'the error must surface the stale .git/index.lock a killed git commit can leave behind'
      );
    });
  }

  test('a timeout whose partial output contains "nothing to commit" is still a timeout (precedence pin)', () => {
    // #3886 review: the isSpawnTimeout gate runs BEFORE the nothing-to-commit
    // branch — a killed commit can have flushed anything, including the
    // nothing-to-commit text, and must still read as a timeout. Reordering
    // the branches would silently revert to the misroute this fix retires.
    const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommit } = require(path.join(LIB, 'commands.cjs'));
const real = projection.execGit;
projection.execGit = (args, opts) => {
  if (args[0] === 'commit') {
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    return { exitCode: 1, stdout: 'nothing to commit, working tree clean', stderr: '', signal: 'SIGTERM', error: e };
  }
  return real(args, opts);
};
cmdCommit(${JSON.stringify(tmpDir)}, 'docs: probe', ['.planning/STATE.md'], false, false, false);
`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 15_000 });
    const result = JSON.parse(run.stdout);
    assert.equal(result.reason, 'commit_timeout', 'the timeout gate must win over the nothing-to-commit text in partial output');
    assert.equal(result.timed_out, true);
  });

  test('an ordinary commit failure still reports commit_failed (no regression)', () => {
    const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const { cmdCommit } = require(path.join(LIB, 'commands.cjs'));
const real = projection.execGit;
projection.execGit = (args, opts) => {
  if (args[0] === 'commit') {
    return { exitCode: 128, stdout: '', stderr: 'fatal: injected commit failure', signal: null, error: null };
  }
  return real(args, opts);
};
cmdCommit(${JSON.stringify(tmpDir)}, 'docs: probe', ['.planning/STATE.md'], false, false, false);
`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 15_000 });
    const result = JSON.parse(run.stdout);
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'commit_failed');
    assert.equal(result.timed_out, undefined);
  });
});

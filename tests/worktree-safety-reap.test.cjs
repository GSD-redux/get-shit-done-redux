'use strict';

/**
 * `reapOrphanWorktrees` — fault-injected verdict coverage (#3057, wave 3).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: reapOrphanWorktrees, cmdWorktreeReapOrphans, pruneOrphanedWorktrees
 *
 * WHY A SECOND FILE FOR THIS MODULE
 * `tests/worktree-safety.test.cjs` is ~6.4k lines and its `reapOrphanWorktrees`
 * suites live inside a folded block with their own local fixture helpers. The
 * negative-space work below needs a different fixture shape (an injected
 * `execGit` that delegates to real git, plus per-test mutation of the
 * `.git/worktrees/<name>/` admin directory), so it gets its own module-bucketed
 * file rather than a third set of helpers wedged into the folded block.
 *
 * WHAT THIS FILE PINS THAT NOTHING ELSE DID
 * Every pre-existing test drove the DEFAULT `execGit` against real git and
 * injected only `mtimeSafe` / `nowMs` / `isPidAlive`. `reapOrphanWorktrees`
 * accepts `execGit`, `readDirSafe` and `readFileSafe` in the same `deps` bag,
 * and nothing used them — so every fail-closed `return` inside the function was
 * unreachable from the suite. Each test here injects exactly the one fault that
 * selects one branch and asserts the SPECIFIC `{status, reason}` verdict that
 * branch produces, never merely that the call returned an array.
 *
 * Determinism: no wall clock is read (`mtimeSafe`/`nowMs` are injected), and no
 * live PID is probed (`isPidAlive` is injected), so the only real-world
 * dependency is git itself.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { makeFaultyGit, withFaultyFs } = require('./helpers/faulty-deps.cjs');

const {
  reapOrphanWorktrees,
  cmdWorktreeReapOrphans,
  pruneOrphanedWorktrees,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Fixed clock values (ADR-456 clock seam) ─────────────────────────────────

/** Older than any staleness threshold, at any real point in time. */
const STALE_MTIME = new Date(0);

/** The lock-owner PID written into every fixture; liveness is always injected. */
const LOCK_OWNER_PID = '4242';

const GIT_TIMEOUT_MS = 30000;

// ─── Path + git helpers ──────────────────────────────────────────────────────

function canonicalPath(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

/**
 * Long-form os.tmpdir(). Windows CI reports 8.3 short names that git does not
 * echo back, so every fixture path is built from the resolved form.
 */
function resolvedTmpDir() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}

/** Run git for FIXTURE SETUP; throws on anything but a clean exit. */
function git(args, cwd) {
  const r = runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.outcome}/${r.exitCode}): ${r.stderr}`);
  }
  return r.stdout;
}

/**
 * An `execGit`-shaped delegate that runs REAL git. Used as `makeFaultyGit`'s
 * `passthrough` so a test can fault one argv and leave every other call intact.
 */
function realExecGit(args, opts = {}) {
  const r = runGit(args, { cwd: opts.cwd, timeoutMs: GIT_TIMEOUT_MS });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    signal: r.signal,
    error: r.code === null ? null : Object.assign(new Error(r.code), { code: r.code }),
    timedOut: r.timedOut,
  };
}

/** A benign zero-exit result carrying `stdout`. */
function okResult(stdout) {
  return { exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false };
}

function argvOf(faultyGit) {
  return faultyGit.calls.map((c) => c.args.join(' '));
}

function calledWith(faultyGit, prefix) {
  return faultyGit.calls.some((c) => prefix.every((token, i) => c.args[i] === token));
}

// ─── Fixture construction ────────────────────────────────────────────────────

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  // Exit code deliberately unchecked: the rename fails harmlessly when the
  // repo was already initialised on `main`.
  runGit(['branch', '-m', 'master', 'main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
}

/** Locate `.git/worktrees/<name>/` for a linked worktree. */
function adminDirFor(repoDir, wtDir) {
  const commonDir = path.resolve(repoDir, git(['rev-parse', '--git-common-dir'], repoDir).trim());
  const worktreesDir = path.join(commonDir, 'worktrees');
  const wanted = canonicalPath(wtDir);
  for (const entry of fs.readdirSync(worktreesDir)) {
    const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
    if (!fs.existsSync(gitdirFile)) continue;
    const pointer = fs.readFileSync(gitdirFile, 'utf8').trim();
    const root = path.resolve(worktreesDir, entry, pointer).replace(/[/\\]\.git$/, '');
    if (canonicalPath(root) === wanted) return path.join(worktreesDir, entry);
  }
  throw new Error(`no .git/worktrees/<name> admin dir for ${wtDir}`);
}

/**
 * Build a repo with one linked, locked worktree whose branch is merged into
 * `main` unless `merge:false`. The lock owner is a fixed PID string; liveness is
 * always supplied through `deps.isPidAlive`, never probed against the OS.
 */
function makeFixture(tmpBase, name, options = {}) {
  const repoDir = path.join(tmpBase, `repo-${name}`);
  const wtDir = path.join(tmpBase, `wt-${name}`);
  const branch = `worktree-agent-${name}`;

  initRepo(repoDir);
  git(['worktree', 'add', wtDir, '-b', branch], repoDir);
  fs.writeFileSync(path.join(wtDir, 'work.txt'), 'content\n');
  git(['add', '-A'], wtDir);
  git(['commit', '-m', `work in ${name}`], wtDir);
  if (options.merge !== false) {
    git(['merge', branch, '--no-ff', '-m', `merge ${branch}`], repoDir);
  }

  const adminDir = adminDirFor(repoDir, wtDir);
  if (options.lock !== false) {
    fs.writeFileSync(path.join(adminDir, 'locked'), LOCK_OWNER_PID);
  }
  return { repoDir, wtDir, branch, adminDir };
}

/** Deps every "owner is dead, lock is stale" test shares. */
function deadOwnerDeps(extra = {}) {
  return { isPidAlive: () => false, mtimeSafe: () => STALE_MTIME, ...extra };
}

/** Assert exactly one result row, and return it. */
function onlyRow(result) {
  assert.strictEqual(result.length, 1, `expected exactly one result row, got ${JSON.stringify(result)}`);
  return result[0];
}

// ─── Suite: default-branch discovery — fail-closed verdicts ──────────────────

describe('#3057 reapOrphanWorktrees: default-branch discovery verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-disc-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('returns no rows and never reads the admin directory when git cannot resolve --git-dir', () => {
    const f = makeFixture(tmpBase, 'nogitdir');
    const probed = [];
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--git-dir'] }],
      passthrough: realExecGit,
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      execGit: faultyGit,
      readDirSafe: (dir) => { probed.push(dir); return fs.readdirSync(dir); },
    }));

    assert.deepStrictEqual(result, []);
    assert.deepStrictEqual(probed, [], 'admin directory must not be read once --git-dir failed');
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --git-dir']);
    assert.ok(fs.existsSync(f.wtDir), 'the worktree must survive a fail-closed bail-out');
  });

  test('returns no rows when the worktrees admin directory cannot be listed', () => {
    const f = makeFixture(tmpBase, 'nodir');
    const probed = [];
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      execGit: faultyGit,
      readDirSafe: (dir) => { probed.push(dir); return null; },
    }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(probed.length, 1, 'the admin directory must be probed exactly once');
    assert.strictEqual(path.basename(probed[0]), 'worktrees');
    // Distinguishes this bail-out from the --git-dir one above: --git-dir DID
    // run and succeed, and nothing after the admin listing was attempted.
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --git-dir']);
  });

  test('returns no rows for a repo that has no linked worktrees at all', () => {
    // Exercises the real `defaultReadDirSafe` catch: `.git/worktrees/` does not
    // exist, so readdirSync throws and the helper returns null.
    const repoDir = path.join(tmpBase, 'repo-bare-of-worktrees');
    initRepo(repoDir);

    assert.deepStrictEqual(reapOrphanWorktrees(repoDir), []);
  });

  test('reaps from origin/HEAD alone and never consults local branch candidates', () => {
    const f = makeFixture(tmpBase, 'remotehead');
    const mainTip = git(['rev-parse', 'main'], f.repoDir).trim();
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => {
        if (args[0] === 'symbolic-ref' && args[args.length - 1] === 'refs/remotes/origin/HEAD') {
          return okResult('origin/main\n');
        }
        if (args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/main') {
          return okResult(`${mainTip}\n`);
        }
        return realExecGit(args, opts);
      },
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    // The remote-exclusive arm is what makes this distinguishable from the
    // local-candidate arm that every other fixture in the tree takes.
    assert.strictEqual(calledWith(faultyGit, ['remote']), false, 'must not fall back to remote enumeration');
    assert.strictEqual(
      calledWith(faultyGit, ['config', '--get', 'init.defaultBranch']),
      false,
      'must not build a local candidate list when origin/HEAD resolved'
    );
  });

  test('returns no rows when origin/HEAD names a remote ref that will not resolve', () => {
    const f = makeFixture(tmpBase, 'badremoteref');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', 'refs/remotes/origin/main'] }],
      passthrough: (args, opts) => (
        args[0] === 'symbolic-ref' && args[args.length - 1] === 'refs/remotes/origin/HEAD'
          ? okResult('origin/main\n')
          : realExecGit(args, opts)
      ),
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(
      calledWith(faultyGit, ['worktree', 'list']),
      false,
      'must fail closed before building the canonical index'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('returns no rows when a remote exists but origin/HEAD is unset', () => {
    const f = makeFixture(tmpBase, 'ambiguousremote');
    const originSrc = path.join(tmpBase, 'origin-src');
    initRepo(originSrc);
    git(['remote', 'add', 'origin', originSrc], f.repoDir);
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, [], 'an ambiguous default branch must not be guessed');
    assert.strictEqual(calledWith(faultyGit, ['remote']), true);
    assert.strictEqual(
      calledWith(faultyGit, ['config', '--get', 'init.defaultBranch']),
      false,
      'the candidate list must not be built once a remote is known to exist'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('returns no rows when not one default-branch candidate resolves', () => {
    const f = makeFixture(tmpBase, 'nocandidate');
    const faultyGit = makeFaultyGit({
      faults: [{
        kind: 'exit',
        exitCode: 128,
        when: (args) => args[0] === 'rev-parse' && args[1] !== '--git-dir',
      }],
      passthrough: realExecGit,
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'main']), true);
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'master']), true);
    assert.strictEqual(
      calledWith(faultyGit, ['worktree', 'list']),
      false,
      'must fail closed before building the canonical index'
    );
  });
});

// ─── Suite: canonical-index construction ─────────────────────────────────────

describe('#3057 reapOrphanWorktrees: canonical-index degradation verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-idx-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('still reaps when git worktree list fails and the canonical index stays empty', () => {
    const f = makeFixture(tmpBase, 'listfails');
    const wtCanonical = canonicalPath(f.wtDir);
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'timeout', when: ['worktree', 'list'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    // A failed listing must degrade to the gitdir-derived path, NOT abort the
    // sweep — an empty index is not "there is nothing to reap".
    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    assert.strictEqual(canonicalPath(row.path), wtCanonical);
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'list']), true);
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('still reaps when a porcelain block carries no worktree line', () => {
    const f = makeFixture(tmpBase, 'headlessblock');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => (
        args[0] === 'worktree' && args[1] === 'list'
          ? okResult(`bare\n\n${realPorcelain}`)
          : realExecGit(args, opts)
      ),
    });

    // Without the `continue`, `wtLine.slice(...)` would throw on the leading
    // block and the whole sweep would die.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });

  test('still reaps when the porcelain lists a path that no longer exists on disk', () => {
    const f = makeFixture(tmpBase, 'ghostpath');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const ghost = path.join(tmpBase, 'ghost-worktree');
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => (
        args[0] === 'worktree' && args[1] === 'list'
          ? okResult(`worktree ${ghost}\nHEAD 0000000000000000000000000000000000000000\n\n${realPorcelain}`)
          : realExecGit(args, opts)
      ),
    });

    // realpathSync.native throws for the ghost block; the catch must skip that
    // one entry and keep indexing the rest.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });
});

// ─── Suite: admin-directory shape ────────────────────────────────────────────

describe('#3057 reapOrphanWorktrees: admin-entry verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-admin-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('reports no row at all for a linked worktree that carries no lock file', () => {
    const f = makeFixture(tmpBase, 'locked');
    const unlockedDir = path.join(tmpBase, 'wt-unlocked');
    git(['worktree', 'add', unlockedDir, '-b', 'worktree-agent-unlocked'], f.repoDir);

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps());

    const row = onlyRow(result);
    assert.strictEqual(canonicalPath(row.path), canonicalPath(f.wtDir));
    assert.strictEqual(row.status, 'reaped');
    assert.ok(fs.existsSync(unlockedDir), 'an unlocked worktree is not the reaper concern');
  });

  test('reports no row for a locked admin entry whose gitdir pointer is missing', () => {
    const f = makeFixture(tmpBase, 'nopointer');
    fs.unlinkSync(path.join(f.adminDir, 'gitdir'));

    // The lock file is present and stale and the owner is dead, so a row WOULD
    // be emitted if the missing pointer were not a hard skip.
    assert.deepStrictEqual(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()), []);
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports no row when an injected readFileSafe reports the gitdir pointer as empty', () => {
    const f = makeFixture(tmpBase, 'blankpointer');
    const gitdirFile = path.join(f.adminDir, 'gitdir');

    // Covers the `deps.readFileSafe` seam arm AND the empty-string half of the
    // falsy-pointer guard (the missing-file half returns null, not '').
    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      readFileSafe: (file) => {
        if (path.resolve(file) === path.resolve(gitdirFile)) return '';
        try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
      },
    }));

    assert.deepStrictEqual(result, []);
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_age_unknown when the real mtime helper cannot stat the lock file', () => {
    const f = makeFixture(tmpBase, 'statfails');

    // No `mtimeSafe` injection: this drives the module's own default helper and
    // pins its catch arm. nowMs is the far future, so a readable mtime would
    // read as stale and reap.
    const result = withFaultyFs(
      { statSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } },
      () => reapOrphanWorktrees(f.repoDir, { isPidAlive: () => false, nowMs: 8640000000000000 })
    );

    const row = onlyRow(result);
    // NOT `lock_too_fresh` (#3057): an unreadable mtime is not an age at all.
    // Freshness tells an operator to wait; waiting never clears an EIO.
    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_age_unknown' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports remove_failed against the raw gitdir pointer when its basename is not .git', () => {
    const f = makeFixture(tmpBase, 'oddpointer');
    const pointerTarget = path.join(f.wtDir, 'notgit');
    fs.writeFileSync(path.join(f.adminDir, 'gitdir'), `${pointerTarget}\n`);
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'remove'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    // `path` is the load-bearing assertion: a pointer that does not end in
    // `/.git` is used verbatim (no dirname()), and because it does not exist,
    // the canonical lookup throws and the raw path is what reaches git.
    assert.strictEqual(row.path, pointerTarget);
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'remove_failed');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_age_unknown, not lock_too_fresh, when mtimeSafe returns null', () => {
    const f = makeFixture(tmpBase, 'nomtime');

    // nowMs is the far future, so a REAL mtime would read as stale and the
    // entry would be reaped. Only the null-mtime arm can produce this verdict.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => null,
      nowMs: 8640000000000000,
    }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_age_unknown' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_too_fresh, not lock_age_unknown, for a readable zero-age lock under the default guard', () => {
    const f = makeFixture(tmpBase, 'defaultguard');
    const now = 1000000;

    // The other half of the split: the mtime IS readable, the lock genuinely is
    // recent, and waiting out the guard genuinely would change the outcome.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => new Date(now),
      nowMs: now,
    }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_too_fresh' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reaps the same zero-age lock when an injected reapMtimeGuardMs of 0 retires the guard', () => {
    const f = makeFixture(tmpBase, 'zeroguard');
    const now = 1000000;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => new Date(now),
      nowMs: now,
      reapMtimeGuardMs: 0,
    }));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });
});

// ─── Suite: liveness and ancestry verdicts ───────────────────────────────────

describe('#3057 reapOrphanWorktrees: liveness and ancestry verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-live-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('reports pid_alive when the lock owner is alive', () => {
    const f = makeFixture(tmpBase, 'alive');

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => true,
      mtimeSafe: () => STALE_MTIME,
    }));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'pid_alive');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_alive when the liveness probe throws', () => {
    const f = makeFixture(tmpBase, 'probethrows');

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      mtimeSafe: () => STALE_MTIME,
    }));

    // An undeterminable owner is treated as alive — same verdict as a genuinely
    // live owner, which is the intended fail-closed conflation.
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'pid_alive');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_alive from the default isPidAlive helper when process.kill throws EPERM', (t) => {
    // No `isPidAlive` injection: this drives the module's OWN default helper
    // (`defaultIsPidAlive`), whose EPERM arm every other test in this tree
    // bypasses by injecting `isPidAlive` directly. `process.kill` is
    // monkeypatched per CONTRIBUTING's cross-platform IO-fault-injection rule
    // rather than run against a real cross-user PID.
    const f = makeFixture(tmpBase, 'defaultkill-eperm');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_dead_and_merged from the default isPidAlive helper when process.kill throws ESRCH', (t) => {
    // Same default helper as above, but its dead-owner arm: ESRCH means "no
    // such process", so `defaultIsPidAlive` returns false and the sweep falls
    // through to the (merged, by fixture default) ancestry check and reaps.
    const f = makeFixture(tmpBase, 'defaultkill-esrch');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'reaped', reason: 'pid_dead_and_merged' }
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports pid_alive from the default isPidAlive helper when process.kill returns without throwing', (t) => {
    // The non-throwing arm of `defaultIsPidAlive`: a live owner's `kill(pid,
    // 0)` returns normally, so the helper returns true directly, with no
    // catch block involved at all.
    const f = makeFixture(tmpBase, 'defaultkill-alive');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => true;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports cannot_resolve_branch_tip when the admin HEAD file is absent', () => {
    const f = makeFixture(tmpBase, 'noheadfile');
    fs.unlinkSync(path.join(f.adminDir, 'HEAD'));
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    assert.strictEqual(
      calledWith(faultyGit, ['merge-base']),
      false,
      'ancestry must not be probed once the tip is unknown'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports cannot_resolve_branch_tip when the admin HEAD names an unresolvable branch', () => {
    const f = makeFixture(tmpBase, 'deadsymref');
    fs.writeFileSync(path.join(f.adminDir, 'HEAD'), 'ref: refs/heads/does-not-exist\n');
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    // Distinguishes the symbolic-ref arm from the missing-file and
    // unrecognised-content arms, which all share this one reason string.
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'refs/heads/does-not-exist']), true);
  });

  test('reports cannot_resolve_branch_tip for an admin HEAD that is neither a symref nor a sha', () => {
    const f = makeFixture(tmpBase, 'garbagehead');
    const headFile = path.join(f.adminDir, 'HEAD');
    fs.writeFileSync(headFile, 'not-a-ref\n');
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    assert.ok(fs.existsSync(headFile), 'the HEAD file is present — this is not the missing-file arm');
    assert.strictEqual(
      faultyGit.calls.some((c) => c.args[0] === 'rev-parse' && String(c.args[1]).startsWith('refs/heads/')),
      false,
      'unrecognised HEAD content must not be handed to rev-parse'
    );
  });

  test('reaps a detached admin HEAD without resolving any branch ref', () => {
    const f = makeFixture(tmpBase, 'detached');
    const branchTip = git(['rev-parse', f.branch], f.repoDir).trim();
    fs.writeFileSync(path.join(f.adminDir, 'HEAD'), `${branchTip}\n`);
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    assert.strictEqual(
      faultyGit.calls.some((c) => c.args[0] === 'rev-parse' && String(c.args[1]).startsWith('refs/heads/')),
      false,
      'a bare 40-hex HEAD is the tip; no ref resolution is needed'
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports branch_not_merged for an unmerged branch whose lock owner is dead', () => {
    const f = makeFixture(tmpBase, 'unmerged', { merge: false });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'branch_not_merged');
    assert.ok(fs.existsSync(f.wtDir), 'unmerged work must survive the sweep');
  });

  // ── The Number.isFinite PARSE gate ────────────────────────────────────────
  // This gate is NOT the process.kill range limit (pinned in the next block).
  // It fires far later, where `parseInt('9'.repeat(N), 10)` stops being
  // representable: finite through N=308, Infinity from N=309 (measured).
  // Reaching it means the reaper never learned a usable PID at all, so the
  // verdict is `lock_owner_unknown`, not a liveness claim.

  test('reports lock_owner_unknown for a 400-digit lock PID (parse overflows past the Number.isFinite gate)', () => {
    const f = makeFixture(tmpBase, 'giantpid', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(400));

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'lock_owner_unknown' });
    assert.ok(fs.existsSync(f.wtDir), 'a lock PID that overflows to Infinity must never be reaped');
  });

  test('passes a 308-digit lock PID through the Number.isFinite gate (last representable length)', () => {
    const f = makeFixture(tmpBase, 'cliffminus1', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(308));
    let seenPid;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      isPidAlive: (pid) => { seenPid = pid; return false; },
    })));

    assert.strictEqual(seenPid, Number('9'.repeat(308)), 'a finite 308-digit PID must reach isPidAlive unchanged');
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'reaped', reason: 'pid_dead_and_merged' });
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('stops a 309-digit lock PID at the Number.isFinite gate (first unrepresentable length)', () => {
    const f = makeFixture(tmpBase, 'cliffexact', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(309));

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'lock_owner_unknown' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  // ── The process.kill RANGE cliff — the one that actually decides a reap ───
  // Measured with the real `process.kill(pid, 0)` on this platform:
  //   2147483647 → Error, code ESRCH          (accepted; asks the OS)
  //   2147483648 → TypeError ERR_INVALID_ARG_TYPE (rejected before the OS)
  // Both tests drive the module's OWN `defaultIsPidAlive` (no `isPidAlive`
  // injection) so the verdict is produced by the real errno classification.
  // Each asserts the throw shape first: if a future Node moved the cliff, the
  // probe fails loudly instead of the verdict flipping silently.

  const PID_KILL_MAX = 2147483647;

  test('treats the largest PID process.kill accepts as dead when the OS answers ESRCH', () => {
    const f = makeFixture(tmpBase, 'killmax', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), String(PID_KILL_MAX));

    // Measured cliff, lower side: this value reaches the OS, which has no such
    // process (every platform's max PID is orders of magnitude below it).
    assert.throws(
      () => process.kill(PID_KILL_MAX, 0),
      (err) => err.code === 'ESRCH',
      `process.kill(${PID_KILL_MAX}, 0) must reach the OS and report ESRCH`
    );

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'reaped', reason: 'pid_dead_and_merged' }
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('treats the first PID process.kill rejects as ALIVE and leaves the worktree on disk', () => {
    const f = makeFixture(tmpBase, 'killmaxplus1', { lock: false });
    const overRange = PID_KILL_MAX + 1;
    fs.writeFileSync(path.join(f.adminDir, 'locked'), String(overRange));

    // Measured cliff, upper side: one past the accepted range, `process.kill`
    // throws a TypeError with NO errno. That is "could not determine", not
    // "dead" — the old errno-only catch read it as dead and REAPED here.
    assert.throws(
      () => process.kill(overRange, 0),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE',
      `process.kill(${overRange}, 0) must throw TypeError ERR_INVALID_ARG_TYPE`
    );

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir), 'an unclassifiable liveness probe must never reap');
  });

  test('treats an unrecognised errno from process.kill as ALIVE (only ESRCH means dead)', (t) => {
    // EPERM has its own test above; this pins the GENERAL rule for a code the
    // helper has never heard of, which an `=== EPERM ? true : false` catch
    // would classify as dead.
    const f = makeFixture(tmpBase, 'defaultkill-einval');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('treats a codeless throw from process.kill as ALIVE', (t) => {
    // A thrown value with no `.code` at all (the TypeError case in the
    // abstract): `undefined !== 'ESRCH'`, so it must still read as alive.
    const f = makeFixture(tmpBase, 'defaultkill-bare');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw new Error('no errno on this one'); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reaches the liveness check for an ordinary small lock PID', () => {
    const f = makeFixture(tmpBase, 'ordinarypid', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '4242');
    let seenPid;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      isPidAlive: (pid) => { seenPid = pid; return false; },
    })));

    assert.strictEqual(seenPid, 4242, 'an ordinary PID must reach isPidAlive unchanged');
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'reaped', reason: 'pid_dead_and_merged' });
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports remove_failed and leaves the worktree on disk when git worktree remove fails', () => {
    const f = makeFixture(tmpBase, 'removefails');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'remove'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(canonicalPath(row.path), canonicalPath(f.wtDir));
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'remove_failed');
    assert.ok(fs.existsSync(f.wtDir));
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'unlock']), true, 'unlock precedes remove');
  });
});

// ─── Suite: CLI wrappers ─────────────────────────────────────────────────────

describe('#3057 cmdWorktreeReapOrphans / pruneOrphanedWorktrees output verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-cli-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('cmdWorktreeReapOrphans reports ok with zero entries after the reaper throws', () => {
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(tmpBase, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      execGit: () => { throw new Error('boom'); },
    });

    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans failed: boom\n']);
    assert.deepStrictEqual(JSON.parse(out.join('')), { ok: true, reaped: 0, entries: [] });
  });

  test('cmdWorktreeReapOrphans warns with the skipped count and emits the skipped row as JSON', () => {
    const f = makeFixture(tmpBase, 'cliskip', { merge: false });
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(f.repoDir, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      ...deadOwnerDeps(),
    });

    assert.deepStrictEqual(err, [
      '[gsd] worktree.reap-orphans: 1 orphan(s) skipped (run with DEBUG=1 for details)\n',
    ]);
    const payload = JSON.parse(out.join(''));
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.reaped, 0);
    assert.strictEqual(payload.entries.length, 1);
    assert.strictEqual(payload.entries[0].status, 'skipped');
    assert.strictEqual(payload.entries[0].reason, 'branch_not_merged');
  });

  test('cmdWorktreeReapOrphans stays silent on stderr when nothing is skipped', () => {
    const f = makeFixture(tmpBase, 'cliclean');
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(f.repoDir, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      ...deadOwnerDeps(),
    });

    assert.deepStrictEqual(err, []);
    const payload = JSON.parse(out.join(''));
    assert.strictEqual(payload.reaped, 1);
    assert.strictEqual(payload.entries[0].reason, 'pid_dead_and_merged');
  });

  test('pruneOrphanedWorktrees warns that the health check degraded when git worktree prune times out', () => {
    const f = makeFixture(tmpBase, 'prunetimeout');
    const err = [];
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'timeout', when: ['worktree', 'prune'] }],
      passthrough: realExecGit,
    });

    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: faultyGit,
      writeErr: (s) => err.push(s),
    });

    assert.deepStrictEqual(removed, []);
    assert.deepStrictEqual(err, [
      '[gsd-tools] WARNING: worktree health check degraded' +
      ' — git worktree prune timed out after 10s.' +
      ' Orphaned worktree metadata may remain until the next successful run.\n',
    ]);
  });

  test('pruneOrphanedWorktrees hands the porcelain to a caller-supplied parseWorktreePorcelain', () => {
    const f = makeFixture(tmpBase, 'pruneparser');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const seen = [];
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    // `parseWorktreePorcelain` is a declared member of the deps bag and
    // `planWorktreePrune` reads `deps.parseWorktreePorcelain` first, defaulting
    // to the module function only when absent. pruneOrphanedWorktrees therefore
    // spreads `...deps` AFTER its own hard-coded default so the caller's parser
    // wins. Ordering the two the other way round is invisible to every other
    // test in the tree; this one fails if the spread moves.
    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: faultyGit,
      parseWorktreePorcelain: (porcelain) => { seen.push(porcelain); return []; },
      writeErr: () => { throw new Error('no degradation warning expected'); },
    });

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(seen.length, 1, 'the injected parser must be the one that ran, exactly once');
    assert.strictEqual(seen[0], realPorcelain, 'it must receive the porcelain readWorktreeList obtained');
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'prune']), true, 'the metadata prune still runs');
  });

  test('pruneOrphanedWorktrees returns an empty list and warns nothing when git throws', () => {
    const f = makeFixture(tmpBase, 'prunethrows');
    const err = [];

    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: () => { throw new Error('boom'); },
      writeErr: (s) => err.push(s),
    });

    assert.deepStrictEqual(removed, [], 'a throwing git must never crash the caller');
    assert.deepStrictEqual(err, [], 'the degraded-health warning belongs to the timeout arm only');
  });
});

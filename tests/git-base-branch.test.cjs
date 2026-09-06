'use strict';
/**
 * #1146: git.base-branch resolver — single source of truth for default-branch detection.
 *
 * Tests:
 *   A. Config override wins (git.base_branch set → returned as-is, no git calls needed)
 *   B. origin/HEAD symref resolves → used
 *   C. origin/HEAD unset but git remote show origin knows HEAD → AUTHORITATIVE fallback
 *      (key regression: master repo with no origin/HEAD → must return "master", NOT "main")
 *   D. No origin/HEAD, no remote show, local branch "master" present → returns "master"
 *   E. No origin/HEAD, no remote show, local branch "main" present → returns "main"
 *   F. No origin/HEAD, no remote show, no local branches → returns "main" (last resort)
 *   G. Anti-regression guard: five affected workflows must NOT contain the
 *      duplicated bare `:-main` / `:-master` fallback pattern that was the root cause.
 *      They must call `gsd_run query git.base-branch` instead.
 *      (see the source-text-is-the-product exemption declared below this docblock —
 *       the workflow .md content IS the runtime surface; the absence of the bad
 *       pattern is what ships to agents.)
 */

// allow-test-rule: source-text-is-the-product
// Justification: the workflow .md files ARE the product surface — agents read and
// execute them directly. Guard G asserts that the resolved command appears in all five
// workflows, which requires reading those workflow files. Per TESTING-STANDARDS.md §6.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup, readFileNormalized } = require('./helpers.cjs');
const { ExitError } = require('../gsd-core/bin/lib/cli-exit.cjs');
const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');
const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
const { runHook } = require('./helpers/process-seam.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repo in a temp dir, optionally setting up a remote
 * and local branches.
 */
function createGitRepo(opts = {}) {
  const { prefix = 'gsd-1146-', defaultBranch = 'master' } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitOrThrow(['init', '-b', defaultBranch], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  // Need at least one commit so branches exist
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitOrThrow(['add', 'README.md'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  gitOrThrow(['commit', '-m', 'init'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  return dir;
}

/**
 * Create a .planning dir so gsd-tools resolveProjectRoot doesn't bail.
 */
function addPlanning(dir) {
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
}

/** Snapshot every file below .planning, including bytes and relative paths. */
function snapshotPlanningTree(dir) {
  const root = path.join(dir, '.planning');
  const snapshot = new Map();
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else snapshot.set(path.relative(root, absolute), fs.readFileSync(absolute));
    }
  }
  visit(root);
  return snapshot;
}

/**
 * Write a gsd config.json with git.base_branch set.
 */
function setGsdConfig(dir, key, value) {
  const cfgDir = path.join(dir, '.planning');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* new file */ }
  // Set nested key (dot notation). Guard every segment against prototype
  // pollution with inline literal checks at each write site — mirrors the
  // production guard in src/config.cts. A Set/pre-loop guard is NOT recognised
  // by CodeQL's js/prototype-pollution-utility query (see PR #752 / alert #40).
  const parts = key.split('.');
  let obj = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') {
      throw new Error(`setGsdConfig: unsafe config key segment '${k}'`);
    }
    if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
    obj = obj[k];
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey === '__proto__' || lastKey === 'prototype' || lastKey === 'constructor') {
    throw new Error(`setGsdConfig: unsafe config key segment '${lastKey}'`);
  }
  obj[lastKey] = value;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

// Paths to the five affected workflow files
const WORKFLOW_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const AFFECTED_WORKFLOWS = [
  path.join(WORKFLOW_DIR, 'execute-phase.md'),
  path.join(WORKFLOW_DIR, 'quick.md'),
  path.join(WORKFLOW_DIR, 'ship.md'),
  path.join(WORKFLOW_DIR, 'complete-milestone.md'),
  path.join(WORKFLOW_DIR, 'pr-branch.md'),
];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('#1146: git.base-branch resolver', () => {

  test('A. config override git.base_branch → returned immediately', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-a-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    setGsdConfig(dir, 'git.base_branch', 'develop');

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch with config override failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'develop',
      `Expected config override 'develop', got: '${branch}'`);
  });

  test('B. origin/HEAD symref resolves → returned', (t) => {
    // Create an "origin" bare repo with main branch
    const originDir = createGitRepo({ prefix: 'gsd-1146-b-origin-', defaultBranch: 'main' });
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1146-b-wt-'));
    t.after(() => { cleanup(originDir); cleanup(worktreeDir); });

    // Clone from origin — this sets origin/HEAD
    gitOrThrow(['clone', originDir, worktreeDir], { timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS });
    addPlanning(worktreeDir);

    // Verify origin/HEAD is set (it should be after clone)
    const symref = gitOrThrow(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: worktreeDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.ok(symref.includes('origin/main'), `Expected origin/HEAD→origin/main, got: ${symref}`);

    const result = runGsdTools(['query', 'git.base-branch'], worktreeDir);
    assert.ok(result.success, `git.base-branch symref test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' from origin/HEAD, got: '${branch}'`);
  });

  test('C. KEY REGRESSION — master repo, origin/HEAD unset → returns "master" not "main"', (t) => {
    // This is the bug: git init + remote add without git remote set-head → no origin/HEAD
    // Current code falls back to :-main → wrong. Fixed code uses `git remote show origin`.
    const originDir = createGitRepo({ prefix: 'gsd-1146-c-origin-', defaultBranch: 'master' });
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1146-c-clone-'));
    t.after(() => { cleanup(originDir); cleanup(cloneDir); });

    // Manually add remote WITHOUT cloning (so origin/HEAD is never set)
    gitOrThrow(['init'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['remote', 'add', 'origin', originDir], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['fetch', 'origin'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    // Explicitly delete origin/HEAD in case git fetch auto-set it (newer git versions may do this)
    try {
      gitOrThrow(['remote', 'set-head', 'origin', '--delete'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    } catch (_) { /* ignore — may not exist */ }
    addPlanning(cloneDir);

    // Confirm origin/HEAD is unset
    let hasSymref = true;
    try {
      gitOrThrow(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cloneDir, timeoutMs: GIT_TIMEOUT_MS });
    } catch (_) {
      hasSymref = false;
    }
    assert.strictEqual(hasSymref, false, 'Test setup: origin/HEAD must be unset for this test case');

    const result = runGsdTools(['query', 'git.base-branch'], cloneDir);
    assert.ok(result.success, `git.base-branch regression test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'master',
      `BUG REGRESSION: master repo with origin/HEAD unset must return 'master', got: '${branch}'`);
  });

  test('D. No remote, local branch "master" present, "main" absent → returns "master"', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-d-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // No remote configured — falls through to local branch detection

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch local branch test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'master',
      `Expected 'master' from local branch detection, got: '${branch}'`);
  });

  test('E. No remote, local branch "main" present → returns "main"', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-e-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch main branch test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' from local branch detection, got: '${branch}'`);
  });

  test('F. No remote, no main/master local branch → returns "main" (last resort default)', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-f-', defaultBranch: 'develop' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Branch named "develop" — neither main nor master

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch default fallback test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' as last resort default, got: '${branch}'`);
  });

  test('A2. config override with flat base_branch key (legacy form) → returned immediately', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-a2-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Write flat base_branch directly to config root (legacy form, not nested under "git")
    const cfgPath = require('node:path').join(dir, '.planning', 'config.json');
    require('node:fs').writeFileSync(cfgPath, JSON.stringify({ base_branch: 'release' }, null, 2) + '\n');

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch with flat config key failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'release',
      `Expected flat config override 'release', got: '${branch}'`);
  });

  test('A3. #3648 precedence: both flat base_branch and nested git.base_branch set → nested (canonical) wins', (t) => {
    // Regression for #3648 review Blocker 1: production config resolution
    // (config-loader's `get()`) is flat-first, so a project that migrated to
    // the namespaced `git.base_branch` but still carries a stale flat
    // `base_branch` from before migration would silently get the old flat
    // value back. `normalizeLegacyKeys` must hoist/resolve `base_branch` the
    // same way it already does `branching_strategy` — canonical nested wins,
    // stale flat top-level is dropped.
    const dir = createGitRepo({ prefix: 'gsd-3648-a3-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    const cfgPath = require('node:path').join(dir, '.planning', 'config.json');
    require('node:fs').writeFileSync(
      cfgPath,
      JSON.stringify({ base_branch: 'stale-flat', git: { base_branch: 'canonical-nested' } }, null, 2) + '\n',
    );

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch with both config keys failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'canonical-nested',
      `Expected namespaced 'git.base_branch' to win over stale flat 'base_branch', got: '${branch}'`);
  });

  test('H. No remote, both "main" and "master" local branches exist → returns "main" (main wins tie-break)', (t) => {
    // Tier-4 tie-break: when both main and master exist locally and no remote info is available,
    // "main" wins (documented in tryLocalBranch JSDoc — modern default).
    const dir = createGitRepo({ prefix: 'gsd-1146-h-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Create a "main" branch alongside the existing "master"
    gitOrThrow(['branch', 'main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    // No remote configured — falls to tier-4 (local branch existence)

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch both-branches test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' to win when both main and master exist locally, got: '${branch}'`);
  });

  test('G. Anti-regression: all five affected workflows use gsd_run query git.base-branch, not bare :-main / :-master', () => {
    // The root-cause pattern: DEFAULT_BRANCH=${DEFAULT_BRANCH:-main} or BASE_BRANCH="${BASE_BRANCH:-main}"
    // After fix: workflows call gsd_run query git.base-branch and remove the bare fallback.
    const BAD_PATTERN = /\$\{(?:DEFAULT_BRANCH|BASE_BRANCH):-(?:main|master)\}/;
    const RESOLVER_CALL = /gsd_run query git\.base-branch/;

    for (const wfPath of AFFECTED_WORKFLOWS) {
      const name = path.basename(wfPath);
      const content = fs.readFileSync(wfPath, 'utf8');

      assert.ok(
        !BAD_PATTERN.test(content),
        `${name} still contains the bare :-main/:-master fallback pattern. ` +
        'Must be replaced with gsd_run query git.base-branch (Issue #1146).',
      );

      assert.ok(
        RESOLVER_CALL.test(content),
        `${name} does not call \`gsd_run query git.base-branch\`. ` +
        'All five affected workflows must delegate to the single resolver (Issue #1146).',
      );
    }
  });
});

// ─── gitWorktreeInfoInternal: behaviour (#1268 T0, T1 #1277) ─────────────────

const gitBaseBranch = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'git-base-branch.cjs'));
const { createTempGitProject, createTempDir } = require('./helpers.cjs');

describe('#1268 gitWorktreeInfoInternal: relocation to git-base-branch', () => {
  test('gitWorktreeInfoInternal(createTempGitProject()) returns {inside:true, worktreeRoot:<non-empty string>}', (t) => {
    const dir = createTempGitProject('gsd-wt-info-');
    t.after(() => cleanup(dir));
    const result = gitBaseBranch.gitWorktreeInfoInternal(dir);
    // `git rev-parse --show-toplevel` reports the resolved (symlink-free) path,
    // which on macOS differs from the mkdtemp path (/var → /private/var). Pin the
    // exact value rather than "a non-empty string": a resolver that returned the
    // .git dir, the cwd, or any other plausible-looking path would pass the weaker
    // shape check while being wrong.
    //
    // git always reports POSIX forward slashes, on every platform including
    // Windows, while `fs.realpathSync.native` returns the platform's native
    // form (backslashes on Windows). The expected side must therefore be
    // normalized to git's convention rather than compared to the raw native
    // realpath, or the assertion just encodes the separator convention of
    // whatever platform it was written on. This is separators only — POSIX's
    // `replace` is a no-op there, so the assertion keeps its full strength on
    // POSIX. The remote gsd-test matrix is Linux-only and cannot exercise this
    // path; it only surfaced on the Windows GitHub Actions shard.
    assert.strictEqual(result.inside, true, 'inside must be true for a git project dir');
    assert.strictEqual(result.worktreeRoot, fs.realpathSync.native(dir).replace(/\\/g, '/'),
      'worktreeRoot must be the resolved worktree root path');
  });

  test('gitWorktreeInfoInternal(createTempDir()) returns {inside:false, worktreeRoot:null} for a non-git dir', (t) => {
    const dir = createTempDir('gsd-wt-info-nongit-');
    t.after(() => cleanup(dir));
    const result = gitBaseBranch.gitWorktreeInfoInternal(dir);
    assert.strictEqual(result.inside, false, 'inside must be false for a non-git dir');
    assert.strictEqual(result.worktreeRoot, null, 'worktreeRoot must be null for a non-git dir');
  });

  // NOTE: the former "never throws" liveness test that sat here was replaced
  // (#3057 W3). "It did not throw" is satisfied by a function that returns
  // undefined, the wrong branch, or nothing useful at all. The
  // `execGit throws → {inside:false, worktreeRoot:null}` test below asserts the
  // exact value the catch arm is contracted to produce, which is what the old
  // test was gesturing at.
});

// ─── #3057 B4: last-resort "main" — verified vs unverified ───────────────────
//
// `resolveBaseBranch` alone collapses two very different situations into the
// same `'main'` string: a repository that genuinely has no candidate branch
// (every git query on tiers 2-4 completed and cleanly answered "nothing"),
// and a total resolution failure (every query timed out). `resolveBaseBranchDiagnostics`
// exposes `verified` so a caller can tell them apart; `cmdGitBaseBranch`
// surfaces the unverified case as a stderr diagnostic without touching its
// stdout contract (five workflows parse that stdout literally).

describe('#3057 B4: resolveBaseBranchDiagnostics — verified vs unverified last-resort default', () => {
  test('every tier-2/3/4 git query TIMES OUT → last-resort "main" is UNVERIFIED', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b4-fault-'));
    t.after(() => cleanup(dir));
    // No .planning/config.json in this dir → the config-override tier is
    // skipped naturally (loadConfig's real-fs read misses cleanly).
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'timeout' }] });

    const result = gitBaseBranch.resolveBaseBranchDiagnostics(dir, { execGit: faultyGit });

    assert.strictEqual(result.branch, 'main');
    assert.strictEqual(result.verified, false);
  });

  test('every tier-2/3/4 git query cleanly reports no candidate → last-resort "main" is VERIFIED', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b4-clean-'));
    t.after(() => cleanup(dir));
    // Default passthrough: exitCode 0, empty stdout for every call — a real,
    // completed "no answer" from git, not a failure (timedOut:false, error:null).
    const faultyGit = makeFaultyGit();

    const result = gitBaseBranch.resolveBaseBranchDiagnostics(dir, { execGit: faultyGit });

    assert.strictEqual(result.branch, 'main');
    assert.strictEqual(result.verified, true);
  });

  test('resolveBaseBranch (string-returning) is unaffected — both cases still return "main"', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b4-compat-'));
    t.after(() => cleanup(dir));
    assert.strictEqual(
      gitBaseBranch.resolveBaseBranch(dir, { execGit: makeFaultyGit({ faults: [{ kind: 'timeout' }] }) }),
      'main',
    );
    assert.strictEqual(
      gitBaseBranch.resolveBaseBranch(dir, { execGit: makeFaultyGit() }),
      'main',
    );
  });

  test('cmdGitBaseBranch writes an unverified-fallback diagnostic to stderr ONLY when unverified', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b4-cmd-'));
    t.after(() => cleanup(dir));

    let stdoutText = '';
    let stderrText = '';
    gitBaseBranch.cmdGitBaseBranch(dir, [], {
      execGit: makeFaultyGit({ faults: [{ kind: 'timeout' }] }),
      write: (s) => { stdoutText += s; },
      writeDiagnostic: (s) => { stderrText += s; },
    });
    assert.strictEqual(stdoutText, 'main\n');
    assert.strictEqual(
      stderrText,
      `⚠ git-base-branch: defaulted to 'main' WITHOUT verifying against this repository — ` +
      `a git query timed out or could not run. See #3057.\n`,
    );

    stdoutText = '';
    stderrText = '';
    gitBaseBranch.cmdGitBaseBranch(dir, [], {
      execGit: makeFaultyGit(),
      write: (s) => { stdoutText += s; },
      writeDiagnostic: (s) => { stderrText += s; },
    });
    assert.strictEqual(stdoutText, 'main\n');
    assert.strictEqual(stderrText, '', 'a verified fallback must not write any diagnostic');
  });

  test('#3648 Major: --is-protected fails CLOSED (reports protected) when the base branch is unverified', (t) => {
    // Regression for #3648 review's Major finding: `--is-protected` used to
    // discard `verified` entirely, so a degraded git (timeout / spawn
    // failure) silently answered `false` — the wrong failure direction for a
    // protection guard. An unverified guess must not let a caller conclude
    // "definitely not protected".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3648-major-'));
    t.after(() => cleanup(dir));

    let stdoutText = '';
    let stderrText = '';
    gitBaseBranch.cmdGitBaseBranch(dir, ['--is-protected', 'some-topic-branch'], {
      execGit: makeFaultyGit({ faults: [{ kind: 'timeout' }] }),
      write: (s) => { stdoutText += s; },
      writeDiagnostic: (s) => { stderrText += s; },
    });
    assert.strictEqual(stdoutText, 'true\n',
      'an unverified answer must fail closed (report protected), not silently false');
    assert.match(stderrText, /could not verify repository branch metadata/);

    // Negative control: a verified resolution for the same non-matching
    // branch must still cleanly report false — the fail-closed path must
    // trigger on non-verification, not on every "not protected" answer.
    stdoutText = '';
    stderrText = '';
    gitBaseBranch.cmdGitBaseBranch(dir, ['--is-protected', 'some-topic-branch'], {
      execGit: makeFaultyGit(),
      write: (s) => { stdoutText += s; },
      writeDiagnostic: (s) => { stderrText += s; },
    });
    assert.strictEqual(stdoutText, 'false\n');
    assert.strictEqual(stderrText, '', 'a verified non-match must not write any diagnostic');
  });
});

// ─── #3552: protected-branch policy and execute-phase warning ────────────────

function extractProtectedBranchWarningBash(workflowFile, stepName) {
  const content = readFileNormalized(path.join(WORKFLOW_DIR, workflowFile));
  const lines = content.split('\n');
  const blocks = [];
  let inStep = false;
  let inBash = false;
  let buffer = [];

  for (const line of lines) {
    if (!inStep && line === `<step name="${stepName}">`) {
      inStep = true;
      continue;
    }
    if (inStep && /^<\/step>\s*$/.test(line)) break;
    if (inStep && !inBash && /^\s*```bash\s*$/.test(line)) {
      inBash = true;
      buffer = [];
      continue;
    }
    if (inBash && /^\s*```\s*$/.test(line)) {
      blocks.push(buffer.join('\n'));
      inBash = false;
      continue;
    }
    if (inBash) buffer.push(line);
  }

  let block = blocks.find((candidate) => candidate.includes('--is-protected'));
  if (!block) {
    // #3648: the step may point at an extracted step file (e.g. execute-phase.md's
    // ADR-857 byte-ceiling extraction) instead of carrying the bash block inline.
    const stepBody = lines.slice(lines.indexOf(`<step name="${stepName}">`) + 1);
    const ref = stepBody.find((l) => /`execute-phase\/steps\/[\w-]+\.md`/.test(l));
    const refMatch = ref && ref.match(/`(execute-phase\/steps\/[\w-]+\.md)`/);
    if (refMatch) {
      const refLines = readFileNormalized(path.join(WORKFLOW_DIR, refMatch[1])).split('\n');
      const refBlocks = [];
      let refInBash = false;
      let refBuffer = [];
      for (const line of refLines) {
        if (!refInBash && /^\s*```bash\s*$/.test(line)) {
          refInBash = true;
          refBuffer = [];
          continue;
        }
        if (refInBash && /^\s*```\s*$/.test(line)) {
          refBlocks.push(refBuffer.join('\n'));
          refInBash = false;
          continue;
        }
        if (refInBash) refBuffer.push(line);
      }
      block = refBlocks.find((candidate) => candidate.includes('--is-protected'));
      // #3648: sync-runtime-launcher.cjs adds the canonical gsd_run resolver
      // preamble to this standalone step file (runtime-launcher-parity's
      // one-preamble-per-file rule). That preamble defines its own gsd_run(),
      // which would shadow this harness's injected mock and reach the real
      // gsd-tools.cjs on the machine running the test. The preamble's own
      // correctness is covered by tests/runtime-launcher-parity.test.cjs; this
      // harness only needs the #3552 warning logic, so strip it here.
      if (block) {
        block = block.split('\n').filter((l) => !l.trimStart().startsWith('_GSD_SHIM_NAME=')).join('\n');
      }
    }
  }
  if (!block) {
    throw new Error(`${workflowFile} ${stepName} has no protected-branch warning bash block`);
  }
  return block;
}

function writeProtectedBranchWarningScript(prefix, bash) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const scriptPath = path.join(scriptDir, 'warning.sh');
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    'set -eu',
    'git() {',
    '  if [ "$#" -ne 2 ] || [ "$1" != branch ] || [ "$2" != --show-current ]; then',
    '    printf "unexpected git invocation\\n" >&2',
    '    return 97',
    '  fi',
    '  printf "%s\\n" "$CURRENT_BRANCH_VALUE"',
    '}',
    'gsd_run() {',
    '  if [ "$#" -ne 4 ] || [ "$1" != query ] || [ "$2" != git.base-branch ] ||',
    '     [ "$3" != --is-protected ] || [ "$4" != "$CURRENT_BRANCH_VALUE" ]; then',
    '    printf "unexpected protected-branch query\\n"',
    '    return 0',
    '  fi',
    // The real command writes its fail-closed and rejected-entry
    // explanations to stderr. Emitting one here is what makes a swallowed
    // `2>/dev/null` at the call site visible to a test.
    '  if [ -n "${DIAGNOSTIC_TEXT:-}" ]; then printf "%s\\n" "$DIAGNOSTIC_TEXT" >&2; fi',
    // QUERY_EXIT lets a test make the query FAIL (gsd-tools missing, a crash, a
    // non-zero exit). Defaults to 0, so every pre-existing caller of this
    // harness is unaffected. Nothing is printed on stdout in that case —
    // matching a real failed command substitution.
    '  if [ "${QUERY_EXIT:-0}" != 0 ]; then return "${QUERY_EXIT}"; fi',
    '  printf "%s\\n" "$PROTECTED_RESULT"',
    '}',
    bash,
    'printf "IS_PROTECTED=%s\\n" "${IS_PROTECTED:-unbound}"',
    'printf "continued\\n"',
  ].join('\n'), { mode: 0o755 });
  return { scriptDir, scriptPath };
}

describe('#3552: configured protected branches', () => {
  const configuredLoad = (requestedCwd) => {
    assert.strictEqual(requestedCwd, '/repo');
    return {
      base_branch: 'main',
      protected_branches: ['develop', 'next', 'develop'],
    };
  };

  test('#3552 configured match and unrelated branch produce opposite results', () => {
    const match = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', {
      loadConfig: configuredLoad,
    });
    const control = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'topic/3552', {
      loadConfig: configuredLoad,
    });

    assert.deepStrictEqual(match, {
      baseBranch: 'main',
      protectedBranches: ['main', 'develop', 'next'],
      rejectedProtectedBranches: [],
      isProtected: true,
      verified: true,
      allowDefaultBranchCommits: false,
    });
    assert.strictEqual(control.isProtected, false);
    assert.notStrictEqual(match.isProtected, control.isProtected,
      'negative control must disagree with the configured protected-branch match');
  });

  test('#3552 absent list retains resolved-base protection and unrelated control', () => {
    const deps = { loadConfig: () => ({ base_branch: 'main' }) };
    const base = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', deps);
    const control = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'topic/3552', deps);

    assert.deepStrictEqual(base.protectedBranches, ['main']);
    assert.strictEqual(base.isProtected, true);
    assert.strictEqual(control.isProtected, false);
    assert.notStrictEqual(base.isProtected, control.isProtected,
      'negative control must disagree with the resolved-base match');
  });

  test('#3552 a bad element drops only itself — valid names still protect', () => {
    // A protection predicate must not fail OPEN. config-set validation is
    // bypassable by a direct edit of .planning/config.json, so one bad element
    // discarding the whole list is the exact failure #3552 exists to close,
    // reintroduced through a different door (#3648 review Blocker 3).
    for (const protectedBranches of [['develop', 42], ['develop', '   '], ['develop', null]]) {
      const loadConfig = () => ({ base_branch: 'main', protected_branches: protectedBranches });
      const configuredName = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', { loadConfig });

      assert.strictEqual(configuredName.isProtected, true,
        `'develop' must stay protected alongside a bad sibling: ${JSON.stringify(protectedBranches)}`);
      assert.deepStrictEqual(configuredName.protectedBranches, ['main', 'develop']);
      assert.strictEqual(configuredName.rejectedProtectedBranches.length, 1,
        'the bad element must be reported, not silently swallowed');
    }
  });

  test('#3552 a non-array value contributes no names and is reported', () => {
    const loadConfig = () => ({ base_branch: 'main', protected_branches: 'develop' });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', { loadConfig });

    assert.strictEqual(status.isProtected, false,
      'a bare string is not a list of branch names — it must not protect');
    assert.deepStrictEqual(status.protectedBranches, ['main']);
    assert.deepStrictEqual(status.rejectedProtectedBranches, ['"develop"']);
  });

  test('#3552 negative control: a well-formed list reports nothing rejected', () => {
    // Must disagree with every case above — otherwise the reject channel is
    // reporting unconditionally and proves nothing.
    const loadConfig = () => ({ base_branch: 'main', protected_branches: ['develop'] });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', { loadConfig });

    assert.strictEqual(status.isProtected, true);
    assert.deepStrictEqual(status.rejectedProtectedBranches, []);
  });

  test('#3552 an empty list is well-formed, not malformed', () => {
    const loadConfig = () => ({ base_branch: 'main', protected_branches: [] });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', { loadConfig });

    assert.deepStrictEqual(status.protectedBranches, ['main']);
    assert.deepStrictEqual(status.rejectedProtectedBranches, [],
      'declaring no extra protected branches is a valid choice, not an error');
  });

  test('#3552 --is-protected writes a diagnostic naming the rejected elements', () => {
    const diagnostics = [];
    const out = [];
    gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', 'develop'], {
      loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop', 42] }),
      write: (chunk) => out.push(chunk),
      writeDiagnostic: (chunk) => diagnostics.push(chunk),
    });

    assert.strictEqual(out.join('').trim(), 'true');
    assert.strictEqual(diagnostics.length, 1, 'the rejection must be surfaced, not swallowed');
    assert.match(diagnostics.join(''), /protected_branches/);
    assert.match(diagnostics.join(''), /42/);
  });

  test('#3552 negative control: a clean list writes no diagnostic', () => {
    const diagnostics = [];
    gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', 'develop'], {
      loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop'] }),
      write: () => {},
      writeDiagnostic: (chunk) => diagnostics.push(chunk),
    });

    assert.deepStrictEqual(diagnostics, [],
      'a well-formed list must be silent — otherwise the diagnostic carries no signal');
  });

  test('#3648 Nit F-7: renderRejected sanitizes control and ANSI characters in diagnostics', () => {
    const diagnostics = [];
    gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', 'develop'], {
      loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop', { malicious: 'bad\x1b[31m\nbranch' }] }),
      write: () => {},
      writeDiagnostic: (chunk) => diagnostics.push(chunk),
    });

    assert.strictEqual(diagnostics.length, 1);
    const diag = diagnostics.join('');
    assert.match(diag, /bad\\u001b\[31m/);
    assert.strictEqual(diag.includes('\x1b'), false, 'diagnostic must not contain raw ESC control bytes');
  });

  test('#3552 execute-phase handle_branching wires protected-branch step with Read and execute (not Skip.)', () => {
    const content = readFileNormalized(path.join(WORKFLOW_DIR, 'execute-phase.md'));
    const stepMatch = content.match(/<step name="handle_branching">([\s\S]*?)<\/step>/);
    assert.ok(stepMatch, 'handle_branching step must exist in execute-phase.md');
    const stepBody = stepMatch[1];

    assert.match(
      stepBody,
      /\*\*"none":\*\*\s+Read and execute `execute-phase\/steps\/protected-branch\.md`\./,
      'execute-phase handle_branching "none" arm must instruct executor to Read and execute the step file',
    );
    assert.doesNotMatch(
      stepBody,
      /\*\*"none":\*\*\s*Skip\./,
      'execute-phase handle_branching "none" arm must not say "Skip."',
    );

    // Negative control: verify the assertion rejects an advisory "Skip." pointer
    const fakeAdvisoryBody = stepBody.replace(
      /\*\*"none":\*\*\s+Read and execute `execute-phase\/steps\/protected-branch\.md`\./,
      '**"none":** Skip. See `execute-phase/steps/protected-branch.md`.',
    );
    assert.doesNotMatch(
      fakeAdvisoryBody,
      /\*\*"none":\*\*\s+Read and execute `execute-phase\/steps\/protected-branch\.md`\./,
      'negative control: fake advisory pointer must fail the wiring assertion',
    );
  });

  test('#3552 active workstream CLI uses configured list and excludes root-only names', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3552-cli-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    setGsdConfig(dir, 'git.protected_branches', ['root-only']);
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    // Both HOME and USERPROFILE must be redirected — Node's os.homedir() (and
    // anything relying on it) consults USERPROFILE first on Windows, where
    // setting HOME alone leaves the real home directory in effect and makes
    // this isolation silently vacuous on that platform.
    const workstreamEnv = { GSD_WORKSTREAM: 'alpha', HOME: dir, USERPROFILE: dir };

    const setResult = runGsdTools(
      ['config-set', 'git.protected_branches', '["develop","next"]'],
      dir,
      workstreamEnv,
    );
    assert.ok(setResult.success, setResult.error);
    const workstreamConfig = JSON.parse(fs.readFileSync(
      path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'),
      'utf8',
    ));
    assert.deepStrictEqual(workstreamConfig.git.protected_branches, ['develop', 'next']);

    const match = runGsdTools(
      ['query', 'git.base-branch', '--is-protected', 'develop'], dir, workstreamEnv,
    );
    const control = runGsdTools(
      ['query', 'git.base-branch', '--is-protected', 'topic/3552'], dir, workstreamEnv,
    );
    const rootOnly = runGsdTools(
      ['query', 'git.base-branch', '--is-protected', 'root-only'], dir, workstreamEnv,
    );

    assert.ok(match.success, match.error);
    assert.ok(control.success, control.error);
    assert.ok(rootOnly.success, rootOnly.error);
    assert.strictEqual(match.output, 'true');
    assert.strictEqual(control.output, 'false');
    assert.strictEqual(rootOnly.output, 'false');
    assert.notStrictEqual(match.output, control.output,
      'CLI negative control must disagree with the configured protected-branch match');
    assert.notStrictEqual(match.output, rootOnly.output,
      'workstream override must replace the root-only configured name');

    let written = '';
    const returned = gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', 'develop'], {
      loadConfig: configuredLoad,
      write: (text) => { written += text; },
    });
    assert.strictEqual(returned, 'true');
    assert.strictEqual(written, 'true\n', 'direct command contract must remain newline-terminated');
  });

  test('#3552 execute-phase warns on true, stays silent on false, and continues both', (t) => {
    const bash = extractProtectedBranchWarningBash('execute-phase.md', 'handle_branching');
    const { scriptDir, scriptPath } = writeProtectedBranchWarningScript(
      'gsd-3552-execute-',
      bash,
    );
    t.after(() => cleanup(scriptDir));

    const baseEnv = { ...process.env, CURRENT_BRANCH_VALUE: 'develop' };
    const match = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'true' },
    });
    const control = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'false' },
    });

    assert.strictEqual(match.exitCode, 0, match.stderr);
    assert.strictEqual(control.exitCode, 0, control.stderr);
    assert.match(match.stdout, /continued\n$/);
    assert.match(control.stdout, /continued\n$/);
    assert.match(match.stderr, /protected branch/i);
    assert.doesNotMatch(control.stderr, /protected branch/i);
    assert.notStrictEqual(match.stderr, control.stderr,
      'warning negative control must disagree with the protected-branch match');
  });

  test('#3552 ship warns on true, stays silent on false, and keeps the none-strategy offer', (t) => {
    const bash = extractProtectedBranchWarningBash('ship.md', 'preflight_checks');
    const { scriptDir, scriptPath } = writeProtectedBranchWarningScript(
      'gsd-3552-ship-',
      bash,
    );
    t.after(() => cleanup(scriptDir));

    const baseEnv = { ...process.env, CURRENT_BRANCH_VALUE: 'develop' };
    const match = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'true' },
    });
    const control = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'false' },
    });

    assert.strictEqual(match.exitCode, 0, match.stderr);
    assert.strictEqual(control.exitCode, 0, control.stderr);
    assert.match(match.stdout, /continued\n$/);
    assert.match(control.stdout, /continued\n$/);
    assert.match(match.stderr, /protected branch/i);
    assert.doesNotMatch(control.stderr, /protected branch/i);
    assert.notStrictEqual(match.stderr, control.stderr,
      'ship warning negative control must disagree with the protected-branch match');

    const ship = readFileNormalized(path.join(WORKFLOW_DIR, 'ship.md'));
    const preflight = ship.slice(
      ship.indexOf('<step name="preflight_checks">'),
      ship.indexOf('</step>', ship.indexOf('<step name="preflight_checks">')),
    );
    assert.match(preflight, /branching_strategy is `none`: offer to create a branch now/i,
      'protected-branch warning must retain the none-strategy feature-branch offer');
  });

  test('#3648 Nit: detached HEAD answers false; a missing argument is reported', () => {
    // `git branch --show-current` prints nothing on a detached HEAD, so the
    // call sites pass an explicit empty string. That must answer false — no
    // protected branch is named '' — and must stay SILENT, because a detached
    // HEAD is a normal state, not a misconfiguration.
    const detachedDiagnostics = [];
    const detachedOut = [];
    gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', ''], {
      loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop'] }),
      write: (chunk) => detachedOut.push(chunk),
      writeDiagnostic: (chunk) => detachedDiagnostics.push(chunk),
    });
    assert.strictEqual(detachedOut.join('').trim(), 'false');
    assert.deepStrictEqual(detachedDiagnostics, [],
      'a detached HEAD is not an error and must not warn');

    // The flag with NO argument at all is a caller bug that `args[1] ?? ''`
    // silently collapsed into the detached-HEAD case. Same answer, but said
    // out loud so the two are distinguishable.
    const missingDiagnostics = [];
    const missingOut = [];
    gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected'], {
      loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop'] }),
      write: (chunk) => missingOut.push(chunk),
      writeDiagnostic: (chunk) => missingDiagnostics.push(chunk),
    });
    assert.strictEqual(missingOut.join('').trim(), 'false');
    assert.strictEqual(missingDiagnostics.length, 1,
      'a missing branch argument must be reported, not read as a detached HEAD');
    assert.match(missingDiagnostics.join(''), /--is-protected/);

    assert.notDeepStrictEqual(detachedDiagnostics, missingDiagnostics,
      'the two paths must be distinguishable — that is the whole point of the arm');

    assert.throws(
      () => gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protectd', 'develop'], {
        loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop'] }),
      }),
      (err) => err instanceof ExitError && err.code === 1,
      'a misspelled predicate flag must be rejected with exit 1 via error()',
    );

    assert.throws(
      () => gitBaseBranch.cmdGitBaseBranch('/repo', ['--is-protected', 'develop', 'extra'], {
        loadConfig: () => ({ base_branch: 'main', protected_branches: ['develop'] }),
      }),
      (err) => err instanceof ExitError && err.code === 1,
      'surplus predicate arguments must be rejected with exit 1 via error()',
    );
  });

  test('#3648 cmdGitBaseBranch usage errors emit structured ERROR_REASON.USAGE and do not print stack trace', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3648-usage-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);

    const unknownFlag = runGsdTools(['query', 'git.base-branch', '--unknown-flag', '--json-errors'], dir);
    assert.strictEqual(unknownFlag.success, false);
    assert.strictEqual(unknownFlag.exitCode, 1);
    assert.doesNotMatch(unknownFlag.error, /^\s*at\s+/m, 'usage errors must not print stack traces');
    let parsed = null;
    try { parsed = JSON.parse(unknownFlag.error); } catch {}
    assert.strictEqual(parsed?.reason, 'usage');

    const surplusPositional = runGsdTools(['query', 'git.base-branch', '--is-protected', 'main', 'extra', '--json-errors'], dir);
    assert.strictEqual(surplusPositional.success, false);
    assert.strictEqual(surplusPositional.exitCode, 1);
    assert.doesNotMatch(surplusPositional.error, /^\s*at\s+/m);
    let parsedSurplus = null;
    try { parsedSurplus = JSON.parse(surplusPositional.error); } catch {}
    assert.strictEqual(parsedSurplus?.reason, 'usage');
  });

  test('#3648 Minor F-1: nested and flat predicate reads stay aligned with the loader', () => {
    const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
    const cases = [
      { git: { base_branch: 'nested', protected_branches: ['develop'] }, base_branch: 'flat', protected_branches: ['bogus'] },
      { git: { base_branch: 'nested' }, base_branch: 'flat' },
      { git: 'not-an-object', base_branch: 'flat', protected_branches: ['bogus'] },
    ];
    for (const fixture of cases) {
      const seam = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', {
        readFile: () => JSON.stringify(fixture),
      });
      assert.strictEqual(
        gitBaseBranch._readGitKey(fixture, 'base_branch'),
        configLoader._getConfigValue(fixture, 'base_branch', { section: 'git', field: 'base_branch' }),
      );
      assert.strictEqual(
        gitBaseBranch._readGitNested(fixture, 'protected_branches'),
        configLoader._getConfigNested(fixture, 'git', 'protected_branches'),
      );
      assert.ok(seam);
    }
  });

  test('#3648 Blocker 4: the predicate diagnostic reaches the user at both call sites', (t) => {
    // Both call sites piped the query's stderr to /dev/null, so the
    // fail-closed explanation ("could not verify the base branch ... defaulting
    // to protected") was discarded and the user saw a bare protected-branch
    // warning on a branch that is not protected. The diagnostic was exercised
    // only by its unit test — dead in production.
    const cases = [
      ['execute-phase.md', 'handle_branching', 'gsd-3648-b4-execute-'],
      ['ship.md', 'preflight_checks', 'gsd-3648-b4-ship-'],
    ];

    for (const [workflow, step, prefix] of cases) {
      const bash = extractProtectedBranchWarningBash(workflow, step);
      const { scriptDir, scriptPath } = writeProtectedBranchWarningScript(prefix, bash);
      t.after(() => cleanup(scriptDir));

      const baseEnv = {
        ...process.env,
        CURRENT_BRANCH_VALUE: 'develop',
        PROTECTED_RESULT: 'true',
      };
      const surfaced = runHook(scriptPath, [], {
        interpreter: 'bash',
        env: { ...baseEnv, DIAGNOSTIC_TEXT: 'could not verify the base branch' },
      });
      const control = runHook(scriptPath, [], {
        interpreter: 'bash',
        env: { ...baseEnv, DIAGNOSTIC_TEXT: '' },
      });

      assert.strictEqual(surfaced.exitCode, 0, surfaced.stderr);
      assert.match(surfaced.stderr, /could not verify the base branch/,
        workflow + " must not discard the predicate's explanation");
      // Negative control: with nothing emitted that text must be absent,
      // otherwise the assertion above could pass on unrelated output.
      assert.doesNotMatch(control.stderr, /could not verify the base branch/);
      assert.notStrictEqual(surfaced.stderr, control.stderr);
      // The warning itself still fires in both, so the diagnostic is additive.
      assert.match(surfaced.stderr, /protected branch/i);
      assert.match(control.stderr, /protected branch/i);
    }
  });

  test('#3648 round-4: a FAILED query degrades visibly, and does not abort under set -e', (t) => {
    // Found by the round-4 external review. `IS_PROTECTED=$(gsd_run ...)` had
    // two problems when the query itself failed (gsd-tools absent, a crash, any
    // non-zero exit): the substitution yielded an empty string, so `[ "$X" = true ]`
    // was simply false and the workflow continued with NO warning and no trace —
    // a silent fail-open in the guard whose whole purpose is to warn; and the
    // bare assignment is the last command in its own right, so a non-zero exit
    // aborted the step under `set -e` before any branch ran.
    //
    // The contract is neither fail-open nor fail-closed: it degrades VISIBLY.
    // Claiming "protected" on no evidence would warn on every branch whenever
    // gsd-tools is unavailable; claiming "not protected" is the silent hole.
    const cases = [
      ['execute-phase.md', 'handle_branching', 'gsd-3648-r4-execute-'],
      ['ship.md', 'preflight_checks', 'gsd-3648-r4-ship-'],
    ];

    for (const [workflow, step, prefix] of cases) {
      const bash = extractProtectedBranchWarningBash(workflow, step);
      const { scriptDir, scriptPath } = writeProtectedBranchWarningScript(prefix, bash);
      t.after(() => cleanup(scriptDir));

      const baseEnv = {
        ...process.env,
        CURRENT_BRANCH_VALUE: 'topic/3648',
        PROTECTED_RESULT: 'false',
      };
      const failed = runHook(scriptPath, [], {
        interpreter: 'bash',
        env: { ...baseEnv, QUERY_EXIT: '3' },
      });
      // Control: the SAME script with a working query must stay silent on a
      // non-protected branch. Without it, an assertion that the failure warns
      // could pass against a script that warns unconditionally.
      const working = runHook(scriptPath, [], {
        interpreter: 'bash',
        env: { ...baseEnv, QUERY_EXIT: '0' },
      });

      // The harness runs under `set -eu`, so this also pins the set -e half.
      assert.strictEqual(failed.exitCode, 0,
        workflow + ' must survive a failed query under set -e: ' + failed.stderr);
      assert.match(failed.stdout, /continued/,
        workflow + ' must reach the end of the step');
      assert.match(failed.stderr, /Could not determine whether/,
        workflow + ' must say the check did not run, rather than pass silently');
      assert.doesNotMatch(failed.stderr, /is a protected branch/,
        'and must NOT assert protectedness it never established');

      assert.strictEqual(working.exitCode, 0, working.stderr);
      assert.doesNotMatch(working.stderr, /Could not determine whether/,
        'a working query must not emit the degradation notice');
      assert.doesNotMatch(working.stderr, /is a protected branch/,
        'and must not warn about a branch that is not protected');
      assert.notStrictEqual(failed.stderr, working.stderr,
        'the two paths must be distinguishable');
    }
  });

  test('#3648 Minor 2: ship binds the predicate result instead of discarding it', (t) => {
    // ship.md's prose branches on protectedness twice ("warn - should be on a
    // feature branch", "if branching_strategy is none, offer to create a
    // branch"). Echoing the warning without binding leaves the agent inferring
    // state from warning text in tool output; the comparison it replaced was
    // directly evaluable.
    const bash = extractProtectedBranchWarningBash('ship.md', 'preflight_checks');
    const { scriptDir, scriptPath } = writeProtectedBranchWarningScript('gsd-3648-bind-', bash);
    t.after(() => cleanup(scriptDir));

    const baseEnv = { ...process.env, CURRENT_BRANCH_VALUE: 'develop' };
    const match = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'true' },
    });
    const control = runHook(scriptPath, [], {
      interpreter: 'bash',
      env: { ...baseEnv, PROTECTED_RESULT: 'false' },
    });

    assert.match(match.stdout, /^IS_PROTECTED=true$/m,
      'ship must bind the predicate result to a variable the following prose can branch on');
    assert.match(control.stdout, /^IS_PROTECTED=false$/m,
      'the binding must track the predicate, not be hardcoded');
    assert.notStrictEqual(match.stdout, control.stdout);
  });
});

// ─── #3819: allow_default_branch_commits escape hatch ────────────────────────

describe('#3819: allow_default_branch_commits escape hatch', () => {
  test('#3819 allow_default_branch_commits:true + currentBranch on base branch → not protected', () => {
    const loadConfig = () => ({ base_branch: 'main', allow_default_branch_commits: true });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', { loadConfig });

    assert.strictEqual(status.isProtected, false,
      'the escape hatch must exempt the base branch from auto-included protection');
    assert.deepStrictEqual(status.protectedBranches, [],
      'the base branch must not appear in protectedBranches when the escape hatch is on');
    assert.strictEqual(status.allowDefaultBranchCommits, true);
  });

  test('#3819 explicit protected_branches still applies with the escape hatch on', () => {
    const loadConfig = () => ({
      base_branch: 'main',
      allow_default_branch_commits: true,
      protected_branches: ['develop'],
    });
    const onBase = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', { loadConfig });
    const onExplicit = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'develop', { loadConfig });

    assert.strictEqual(onBase.isProtected, false,
      'the base branch escapes protection even though an explicit list is also configured');
    assert.strictEqual(onExplicit.isProtected, true,
      'an explicitly configured protected branch must still be enforced despite the escape hatch');
    assert.notStrictEqual(onBase.isProtected, onExplicit.isProtected,
      'the two cases must disagree — otherwise the explicit list is not actually being enforced');
  });

  test('#3819 negative control: allow_default_branch_commits absent → base-branch protection unchanged', () => {
    const loadConfig = () => ({ base_branch: 'main' });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', { loadConfig });

    assert.strictEqual(status.allowDefaultBranchCommits, false,
      'default must be false/off when the key is not set at all');
    assert.strictEqual(status.isProtected, true,
      'without the escape hatch, the base branch must remain protected as before #3819');
  });

  test('#3819 allow_default_branch_commits:false explicitly → same as absent', () => {
    const loadConfig = () => ({ base_branch: 'main', allow_default_branch_commits: false });
    const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'main', { loadConfig });

    assert.strictEqual(status.allowDefaultBranchCommits, false);
    assert.strictEqual(status.isProtected, true,
      'an explicit false must behave identically to leaving the key unset');
  });

  test('#3819 CLI: git.allow_default_branch_commits:true makes --is-protected report false on the base branch', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3819-cli-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    setGsdConfig(dir, 'git.allow_default_branch_commits', true);

    const escaped = runGsdTools(['query', 'git.base-branch', '--is-protected', 'main'], dir);
    assert.ok(escaped.success, escaped.error);
    assert.strictEqual(escaped.output, 'false',
      'the escape hatch must make the CLI report the base branch as not protected');

    // Negative control: a sibling fixture without the config key must still
    // report the base branch as protected — proves the flag, not some other
    // difference between the two fixtures, drives the result above.
    const controlDir = createGitRepo({ prefix: 'gsd-3819-cli-control-', defaultBranch: 'main' });
    t.after(() => cleanup(controlDir));
    addPlanning(controlDir);
    const control = runGsdTools(['query', 'git.base-branch', '--is-protected', 'main'], controlDir);
    assert.ok(control.success, control.error);
    assert.strictEqual(control.output, 'true');
    assert.notStrictEqual(escaped.output, control.output,
      'CLI negative control must disagree with the escape-hatch fixture');
  });
});

// ─── #3819: gsd-executor.md pre-commit protected-branch guard ────────────────

/**
 * Extract the FIRST ```bash fenced block that follows the "Pre-commit
 * protected-branch safety assertion" heading in the canonical worktree-path-safety.md reference.
 * Keyed off the heading text (not a `<step name>` tag — this step has no
 * such wrapper) so a future rewording of the heading fails the test loudly
 * instead of silently extracting nothing.
 */
function extractExecutorPreCommitBash() {
  const executorPath = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
  assert.match(readFileNormalized(executorPath), /worktree-path-safety\.md/, 'executor must load the canonical guards');
  const content = readFileNormalized(path.join(__dirname, '..', 'gsd-core', 'references', 'worktree-path-safety.md'));
  const lines = content.split('\n');
  const headingIndex = lines.findIndex(
    (line) => line.includes('Pre-commit HEAD safety assertion'),
  );
  if (headingIndex === -1) {
    throw new Error(
      'agents/gsd-executor.md: could not find the "Pre-commit HEAD safety ' +
      'assertion" heading — has it been reworded?',
    );
  }
  let inBash = false;
  const buffer = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!inBash && /^\s*```bash\s*$/.test(line)) {
      inBash = true;
      continue;
    }
    if (inBash && /^\s*```\s*$/.test(line)) {
      return buffer.join('\n');
    }
    if (inBash) buffer.push(line);
  }
  throw new Error(
    'agents/gsd-executor.md: no ```bash block found after the pre-commit protected-branch ' +
    'heading — has the step been restructured?',
  );
}

/**
 * Write a standalone script that mocks `git` and `gsd_run`, then runs the
 * extracted pre-commit guard bash verbatim. Deliberately does NOT `set -e`:
 * the guard's fatal paths call `exit 1` explicitly, and this script must run
 * to completion on the non-fatal path to print the GUARD_PASSED sentinel.
 *
 * `isWorktree` controls whether `scriptDir` gets a `.git` FILE (worktree) or
 * a `.git` DIRECTORY (ordinary checkout) — the guard's own `[ -f .git ]`
 * branch reads this from the script's cwd, so the test runs the script with
 * `cwd: scriptDir`.
 */
function writeExecutorGuardScript(prefix, bash, { branch, headRef, isWorktree, queryResult, queryExit = 0 }) {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const gitPath = path.join(scriptDir, '.git');
  if (isWorktree) {
    fs.writeFileSync(gitPath, 'gitdir: /nonexistent\n');
  } else {
    fs.mkdirSync(gitPath);
  }
  const scriptPath = path.join(scriptDir, 'guard.sh');
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    'git() {',
    '  if [ "$1" = symbolic-ref ]; then',
    headRef === 'DETACHED'
      ? '    return 1'
      : `    printf "%s\\n" "${headRef}"\n    return 0`,
    '  elif [ "$1" = rev-parse ] && [ "$2" = --abbrev-ref ]; then',
    `    printf "%s\\n" "${branch}"`,
    '    return 0',
    '  else',
    '    printf "unexpected git invocation: %s\\n" "$*" >&2',
    '    return 97',
    '  fi',
    '}',
    'gsd_run() {',
    `  if [ "$#" -ne 4 ] || [ "$1" != query ] || [ "$2" != git.base-branch ] || ` +
      `[ "$3" != --is-protected ] || [ "$4" != "${branch}" ]; then`,
    '    printf "unexpected gsd_run invocation: %s\\n" "$*" >&2',
    '    return 0',
    '  fi',
    queryExit
      ? `  return ${queryExit}`
      : `  printf "%s\\n" "${queryResult}"`,
    '}',
    bash,
    'printf "GUARD_PASSED\\n"',
  ].join('\n'), { mode: 0o755 });
  return { scriptDir, scriptPath };
}

describe('#3819: gsd-executor.md pre-commit protected-branch guard', () => {
  const bash = extractExecutorPreCommitBash();

  test('#3819 non-worktree, branch is protected (query says true) → HALT with exit 1, no GUARD_PASSED', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-nonwt-protected-', bash, {
      branch: 'main',
      headRef: 'main',
      isWorktree: false,
      queryResult: 'true',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /protected\/default branch/);
    assert.doesNotMatch(result.stdout, /GUARD_PASSED/);
  });

  test('#3819 non-worktree, branch is not protected (query says false) → continues, GUARD_PASSED', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-nonwt-clean-', bash, {
      branch: 'feature-x',
      headRef: 'feature-x',
      isWorktree: false,
      queryResult: 'false',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /GUARD_PASSED/);
  });

  test('#3819 worktree, branch is protected → HALT with exit 1 (protected check fires before the allow-list check)', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-wt-protected-', bash, {
      branch: 'main',
      headRef: 'main',
      isWorktree: true,
      queryResult: 'true',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /protected\/default branch/);
  });

  test('#3819 worktree, branch not protected but outside the agent-*/worktree-agent-*/worktree-wf_* namespace → HALT', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-wt-outside-namespace-', bash, {
      branch: 'some-random-branch',
      headRef: 'some-random-branch',
      isWorktree: true,
      queryResult: 'false',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /not in the agent-\* \/ worktree-agent-\* \/ worktree-wf_\* namespace/);
  });

  test('#3819 worktree, branch not protected AND in the agent-* namespace → continues, GUARD_PASSED', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-wt-clean-', bash, {
      branch: 'agent-42',
      headRef: 'agent-42',
      isWorktree: true,
      queryResult: 'false',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /GUARD_PASSED/);
  });

  test('#3819 detached HEAD (non-worktree) → HALT with exit 1 before any protected-branch query', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-detached-', bash, {
      branch: 'HEAD',
      headRef: 'DETACHED',
      isWorktree: false,
      queryResult: 'false',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /detached/);
  });

  test('#3819 HOSTILE: gsd_run RUNS but reports the branch as protected (resolver-internal fail-closed) → HALT', (t) => {
    // This is the scenario that must stay fail-closed unconditionally:
    // gsd_run itself succeeds (exit 0) — e.g. because cmdGitBaseBranch's own
    // pre-existing #3057 B4 logic already answered "true" when it could not
    // VERIFY the real default branch — and the bash guard must never
    // second-guess that answer. It is deliberately indistinguishable, at
    // this bash layer, from an ordinary "yes this branch is protected"
    // answer (see the "non-worktree, branch is protected" test above) —
    // that IS the fail-closed contract: the guard trusts what gsd_run says
    // when gsd_run actually says something.
    //
    // This is a DIFFERENT failure mode from "gsd_run could not be invoked at
    // all" (nonzero exit / no output), which is covered by the two
    // "gsd_run itself is unavailable" tests below and — per the #3819
    // approval's item 2 ("keep the existing names as a fallback where the
    // default cannot be resolved") — deliberately does NOT fail closed for
    // every branch; it falls back to the pre-#3819 five-name list instead.
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-resolver-unverified-', bash, {
      branch: 'feature-x',
      headRef: 'feature-x',
      isWorktree: false,
      queryResult: 'true',
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /protected\/default branch/);
    assert.doesNotMatch(result.stdout, /GUARD_PASSED/);
  });

  test('#3819 gsd_run itself is unavailable (query cannot run) + branch matches the old five-name list → still HALTs via the fallback', (t) => {
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-unavailable-listed-', bash, {
      branch: 'develop',
      headRef: 'develop',
      isWorktree: false,
      queryResult: 'false',
      queryExit: 1,
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /protected\/default branch/);
  });

  test('#3819 gsd_run itself is unavailable (query cannot run) + branch does NOT match the old five-name list → falls back to allowing it', (t) => {
    // Deliberate #3819-approved tradeoff: when gsd-tools itself cannot even be
    // invoked, an unlisted branch is allowed through rather than blocking every
    // branch outright — unlike the "HOSTILE: the protected-branch query itself
    // fails" test above (gsd-tools runs fine but the resolver's own internal
    // verification fails), which stays fail-closed.
    const { scriptDir, scriptPath } = writeExecutorGuardScript('gsd-3819-guard-unavailable-unlisted-', bash, {
      branch: 'my-feature-branch',
      headRef: 'my-feature-branch',
      isWorktree: false,
      queryResult: 'false',
      queryExit: 1,
    });
    t.after(() => cleanup(scriptDir));

    const result = runHook(scriptPath, [], { interpreter: 'bash', cwd: scriptDir, timeoutMs: 10000 });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /GUARD_PASSED/);
  });

  // allow-test-rule: source-text-is-the-product
  // Justification: this test's whole point is asserting on the prose text of the
  // <final_commit> block itself — the workflow .md IS the product surface here,
  // same rationale as Guard G (see the top-of-file exemption above).
  test('#3819 <final_commit> block instructs the executor to re-run the Step 0 guard before the final commit', () => {
    const executorPath = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
    const content = readFileNormalized(executorPath);
    const startIndex = content.indexOf('<final_commit>');
    assert.notStrictEqual(startIndex, -1, 'agents/gsd-executor.md: could not find <final_commit> tag — has it been renamed?');
    const fenceIndex = content.indexOf('```bash', startIndex);
    const excerpt = fenceIndex === -1
      ? content.slice(startIndex, startIndex + 2000)
      : content.slice(startIndex, fenceIndex);

    assert.match(excerpt, /re-run the Step 0/);
    assert.match(excerpt, /#3819/);
  });
});

// ─── #3648 Major 1: negative space for readEffectiveGitConfig's readFile seam ─
//
// The #3057 W3 suite that pinned readConfigBaseBranch's unusable-config arms
// was deleted with the function it targeted, but every arm it covered survives
// verbatim in readEffectiveGitConfig's readFile branch: the JSON.parse catch,
// the non-object guard, the git-section object guard, .trim(), and blank-string
// rejection. Deleting the tests left all of them unexercised — the four
// surviving readFile injections are positive-path only, and protected_branches
// was never driven through this seam at all.
//
// Reaching the seam requires readFile WITHOUT loadConfig. execGit is stubbed to
// answer cleanly-but-emptily so tiers 2-4 fall to a VERIFIED 'main', which
// makes 'main' the unambiguous signal that the config tier contributed nothing.
//
// WHAT THIS SUITE DOES AND DOES NOT PIN. Verified by mutating the built lib and
// re-running:
//
//   .trim() on the resolved value            -> KILLED by the positive controls
//   the non-object guard on JSON.parse output -> SURVIVES
//   the blank-string rejection                -> SURVIVES
//
// The two survivors are unreachable through this entry point, for the same
// reason the deleted #3057 W3 suite recorded against its own equivalents:
//
//   * A JSON-parsed value can never carry a `.git` or `.base_branch` own
//     property unless it is already an object, so `null` / `42` / `"x"` / `[]`
//     read as "no keys" whether or not the guard runs.
//   * A blank base_branch is rejected a second time downstream — the resolver's
//     `if (configured)` treats '' as falsy — so removing the guard here changes
//     no observable output.
//
// Both remain defence-in-depth for a future non-JSON caller. They are recorded
// here as known-unkillable rather than left to look like coverage this suite
// does not provide.

describe('#3648 property: config-set validation and resolver filtering must agree', () => {
  // The two new validating surfaces this PR adds are deliberately different
  // shapes: `config-set` is all-or-nothing (reject the whole write), while the
  // resolver is per-entry (drop the bad names, keep the good ones, report), so
  // that a direct edit of config.json cannot fail the predicate OPEN. Nothing
  // structural keeps the two definitions of "usable branch name" in step —
  // only this property, which asks both about the same values.
  const fc = require('./helpers/fast-check-setup.cjs');
  const { isValidProtectedBranches } = require('../gsd-core/bin/lib/config.cjs');

  /** A value generator weighted towards the boundary cases both surfaces care about. */
  const entry = () => fc.oneof(
    fc.string(),
    fc.constantFrom('', '   ', '\t\n', ' develop ', 'develop'),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
  );

  /**
   * `fc.array` never produces a HOLE, and a hole is exactly where the two
   * surfaces disagreed: `.every()` skips holes, `for...of` yields `undefined`
   * for them. The property passed only because the generator could not reach
   * the case (round-4 external review). Punching holes into a generated array
   * is what makes this axis falsifiable.
   */
  const withHoles = () => fc.tuple(
    fc.array(entry(), { maxLength: 5 }),
    fc.array(fc.nat({ max: 5 }), { maxLength: 3 }),
  ).map(([values, holeIndices]) => {
    const arr = values.slice();
    for (const i of holeIndices) {
      if (i < arr.length) delete arr[i];
    }
    return arr;
  });

  test('accepted by config-set ⟺ the resolver rejects nothing from a non-empty list', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.array(entry(), { maxLength: 6 }), withHoles(), entry()),
        (configured) => {
          const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'topic/x', {
            loadConfig: () => ({ base_branch: 'main', protected_branches: configured }),
          });

          const resolverKeptEverything = Array.isArray(configured)
            && configured.length > 0
            && status.rejectedProtectedBranches.length === 0;

          assert.strictEqual(isValidProtectedBranches(configured), resolverKeptEverything,
            `disagreement on ${JSON.stringify(configured)}`);
        },
      ),
      { numRuns: 400 },
    );
  });

  test('a top-level `protected_branches` is NOT an alias for the canonical nested key', (t) => {
    // Round-4 external review. `get(key, {section, field})` is flat-then-nested,
    // which is back-compat for keys `normalizeLegacyKeys` migrates. Routing a
    // BRAND-NEW key through it invents an undocumented top-level spelling that
    // silently outranks `git.protected_branches`. `protected_branches` has no
    // legacy form, so it resolves nested-only — in production and in the seam.
    const dir = createGitRepo({ prefix: 'gsd-3648-flat-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ protected_branches: ['bogus'], git: { protected_branches: ['develop'] } }),
    );

    const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.deepStrictEqual(
      configLoader.loadConfig(dir, { persist: false })['protected_branches'], ['develop'],
      'the canonical nested key must win outright');

    // Control: `base_branch` DOES keep flat-then-nested, because it has a legacy
    // flat spelling #3760's refusal path can leave behind. Without this, the
    // assertion above could pass against a loader that lost flat support wholesale.
    const seam = gitBaseBranch.resolveProtectedBranchStatus(dir, 'develop', {
      readFile: () => JSON.stringify({
        git: 'not-an-object', base_branch: 'release', protected_branches: ['bogus'],
      }),
    });
    assert.strictEqual(seam.baseBranch, 'release',
      'a refused migration must still let the surviving flat base_branch through');
    assert.deepStrictEqual(seam.protectedBranches, ['release'],
      'while a top-level protected_branches contributes nothing');
  });

  test('every surviving name is trimmed, non-empty, and de-duplicated against the base', () => {
    fc.assert(
      fc.property(
        fc.array(entry(), { maxLength: 6 }),
        (configured) => {
          const status = gitBaseBranch.resolveProtectedBranchStatus('/repo', 'topic/x', {
            loadConfig: () => ({ base_branch: 'main', protected_branches: configured }),
          });

          for (const name of status.protectedBranches) {
            assert.strictEqual(typeof name, 'string');
            assert.strictEqual(name, name.trim(), 'names must be stored trimmed');
            assert.notStrictEqual(name, '', 'a blank name would silently match a detached HEAD');
          }
          assert.deepStrictEqual(
            status.protectedBranches, [...new Set(status.protectedBranches)],
            'duplicates (including one equal to the base branch) must collapse');
          assert.strictEqual(status.protectedBranches[0], 'main',
            'the resolved base branch is always protected and always leads');

          // Nothing is lost silently: each input element is either kept
          // (trimmed) or reported as rejected.
          const kept = configured.filter((b) => typeof b === 'string' && b.trim() !== '');
          assert.strictEqual(
            kept.length + status.rejectedProtectedBranches.length, configured.length);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('#3648 Blocker 1: --is-protected is a QUERY and must not rewrite config.json', () => {
  // The predicate runs on every execute-phase and every ship. It resolves config
  // through config-loader's `loadConfig`, which normalizes legacy keys and then
  // WRITES the migrated shape back to .planning/config.json. A boolean question
  // was therefore silently rewriting the user's checked-in config — and this PR
  // widened the trigger by adding a fifth normalization block (top-level
  // `base_branch` -> `git.base_branch`). The read now passes `persist: false`.
  //
  // Asserted on BYTES, not on parsed shape: the persisted rewrite reorders keys
  // and reflows whitespace even when the resolved values are equivalent.

  /** A config whose ONLY interesting property is that it triggers a normalization. */
  function writeLegacyConfig(dir) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    const cfgPath = path.join(dir, '.planning', 'config.json');
    // Hand-written formatting deliberately unlike JSON.stringify(cfg, null, 2):
    // if anything rewrites this file, the bytes cannot come back identical.
    fs.writeFileSync(cfgPath, '{"base_branch": "develop", "granularity": "standard"}\n');
    return cfgPath;
  }

  test('a legacy-key config survives --is-protected byte-for-byte, and is still honoured', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3648-b1-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    const cfgPath = writeLegacyConfig(dir);
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.planning/\n');
    const before = fs.readFileSync(cfgPath);
    const planningBefore = snapshotPlanningTree(dir);

    const match = runGsdTools(['query', 'git.base-branch', '--is-protected', 'develop'], dir);
    const control = runGsdTools(['query', 'git.base-branch', '--is-protected', 'topic/3648'], dir);

    assert.ok(match.success, match.error);
    assert.ok(control.success, control.error);
    // Positive control: the flat legacy `base_branch` DID reach the predicate.
    // Without this the byte assertion below would also pass for a query that
    // ignored the config entirely.
    assert.strictEqual(match.output, 'true');
    assert.strictEqual(control.output, 'false');

    assert.deepStrictEqual(
      fs.readFileSync(cfgPath), before,
      'a read-only predicate must leave .planning/config.json byte-identical',
    );
    assert.deepStrictEqual(
      snapshotPlanningTree(dir), planningBefore,
      'a read-only predicate must leave the entire .planning tree byte-identical',
    );
    const status = gitOrThrow(['status', '--porcelain'], { cwd: dir });
    assert.strictEqual(status, '', 'read-only predicate must not leave a sibling write');
  });

  test('negative control: an ordinary persisting load DOES rewrite the same fixture', (t) => {
    // Without this the test above cannot fail for the right reason — a fixture
    // that never triggered a normalization would keep its bytes no matter what
    // `persist` did. This proves the fixture is live.
    const dir = createGitRepo({ prefix: 'gsd-3648-b1-neg-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    const cfgPath = writeLegacyConfig(dir);
    const before = fs.readFileSync(cfgPath);

    const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
    const persisted = configLoader.loadConfig(dir);

    assert.notDeepStrictEqual(
      fs.readFileSync(cfgPath), before,
      'the default (omitted) option must keep migrating legacy configs on disk',
    );
    assert.strictEqual(persisted['base_branch'], 'develop',
      'and it must resolve the same value the non-persisting read resolves');
  });

  test('negative control: a planted .planning sibling changes the tree snapshot', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3648-b1-stray-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    const before = snapshotPlanningTree(dir);

    fs.writeFileSync(path.join(dir, '.planning', 'sibling'), 'stray write\n');

    assert.notDeepStrictEqual(
      snapshotPlanningTree(dir), before,
      'the snapshot must detect a newly planted .planning sibling',
    );
  });

  test('persist:false changes only the side effect, not the resolved config', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-3648-b1-parity-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    const cfgPath = writeLegacyConfig(dir);
    const before = fs.readFileSync(cfgPath);

    const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
    const quiet = configLoader.loadConfig(dir, { persist: false });
    assert.deepStrictEqual(fs.readFileSync(cfgPath), before,
      'persist:false must not write');

    const loud = configLoader.loadConfig(dir);
    assert.notDeepStrictEqual(fs.readFileSync(cfgPath), before,
      'the same directory, without the option, must write — proving the two differ');
    assert.deepStrictEqual(quiet, loud,
      'resolution must be identical; only the write is suppressed');
  });

  test('persist survives the workstream fallback recursion', (t) => {
    // `loadConfigResolved` re-enters ITSELF with `{ workstream: null }` when a
    // workstream was requested but has no config.json of its own. That literal
    // dropped every other option, so the recursive pass ran with the DEFAULT
    // persistence and rewrote the root config — the predicate's `persist:false`
    // was silently discarded for exactly the projects that use workstreams.
    // Found by the round-4 external review.
    const dir = createGitRepo({ prefix: 'gsd-3648-b1-ws-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // The workstream directory exists but carries no config.json — the shape
    // that forces the fallback. Without it the recursion never runs and this
    // test degenerates into the non-workstream case above.
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    const cfgPath = writeLegacyConfig(dir);
    const before = fs.readFileSync(cfgPath);

    const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
    const quiet = configLoader.loadConfig(dir, { persist: false, workstream: 'alpha' });

    assert.strictEqual(quiet['base_branch'], 'develop',
      'positive control: the fallback really did resolve the root config');
    assert.deepStrictEqual(fs.readFileSync(cfgPath), before,
      'the recursive fallback pass must inherit persist:false');

    const loud = configLoader.loadConfig(dir, { workstream: 'alpha' });
    assert.notDeepStrictEqual(fs.readFileSync(cfgPath), before,
      'negative control: the same fallback without the option must still write');
    assert.deepStrictEqual(quiet, loud,
      'and suppressing the write must not change what the fallback resolves');
  });
});

describe('#3648 Major 1: readEffectiveGitConfig readFile seam — config present but unusable', () => {
  const CWD = path.join(path.sep, 'gsd-3648-seam');

  /** Drive the seam with raw config text, recording the paths requested. */
  function readWith(raw, seenPaths) {
    return gitBaseBranch.resolveProtectedBranchStatus(CWD, 'some-topic-branch', {
      execGit: makeFaultyGit(),
      readFile: (requested) => { if (seenPaths) seenPaths.push(requested); return raw; },
    });
  }

  test('config.json exists but is not valid JSON → parse failure swallowed, base falls through', () => {
    const seen = [];
    assert.strictEqual(readWith('{ not json', seen).baseBranch, 'main');
    assert.deepStrictEqual(seen, [path.join(CWD, '.planning', 'config.json')],
      'the seam must look for config.json inside the planning dir under the cwd it was given');
  });

  test('config.json parses to a non-object → ignored for null / string / number / array', () => {
    assert.strictEqual(readWith('null').baseBranch, 'main', 'JSON null must not be treated as a config');
    assert.strictEqual(readWith('"master"').baseBranch, 'main', 'a bare JSON string must not be treated as a config');
    assert.strictEqual(readWith('42').baseBranch, 'main', 'a bare JSON number must not be treated as a config');
    assert.strictEqual(readWith('[]').baseBranch, 'main', 'a JSON array must not be treated as a config');
  });

  test('"git" section present but base_branch missing / non-string / blank → no override', () => {
    assert.strictEqual(readWith('{"git":{}}').baseBranch, 'main');
    assert.strictEqual(readWith('{"git":{"base_branch":42}}').baseBranch, 'main');
    assert.strictEqual(readWith('{"git":{"base_branch":null}}').baseBranch, 'main');
    assert.strictEqual(readWith('{"git":{"base_branch":""}}').baseBranch, 'main');
    assert.strictEqual(readWith('{"git":{"base_branch":"   "}}').baseBranch, 'main',
      'a whitespace-only override must not win the precedence ladder');
  });

  test('"git" key present but not a usable object → the flat legacy key is still honoured', () => {
    // These also guard the hoist: a non-object "git" must not be spread into
    // index keys on the way to carrying the flat value across.
    assert.strictEqual(readWith('{"git":"main","base_branch":"release"}').baseBranch, 'release');
    assert.strictEqual(readWith('{"git":[],"base_branch":"release"}').baseBranch, 'release');
    assert.strictEqual(readWith('{"git":null,"base_branch":"release"}').baseBranch, 'release');
  });

  test('flat base_branch present but non-string / blank → no override', () => {
    assert.strictEqual(readWith('{"base_branch":true}').baseBranch, 'main');
    assert.strictEqual(readWith('{"base_branch":["main"]}').baseBranch, 'main');
    assert.strictEqual(readWith('{"base_branch":""}').baseBranch, 'main');
    assert.strictEqual(readWith('{"base_branch":"   "}').baseBranch, 'main');
  });

  test('config parses cleanly but carries neither key → distinct from an absent file', () => {
    // The absent-file path returns before JSON.parse; these parse a real object
    // and fall all the way through both lookups.
    assert.strictEqual(readWith('{"other":1}').baseBranch, 'main');
    assert.strictEqual(readWith('{}').baseBranch, 'main');
    assert.strictEqual(readWith('').baseBranch, 'main', 'absent file (empty read) also yields no override');
    assert.strictEqual(readWith(null).baseBranch, 'main', 'a null read is an absent file');
  });

  test('positive controls: values are trimmed and the nested key outranks the flat one', () => {
    // Without these the whole describe could pass against a seam that ignored
    // config entirely — every assertion above expects the fallback value.
    assert.strictEqual(readWith('{"git":{"base_branch":"  develop  "}}').baseBranch, 'develop');
    assert.strictEqual(readWith('{"base_branch":"  release\\n"}').baseBranch, 'release');
    assert.strictEqual(readWith('{"git":{"base_branch":"nested"},"base_branch":"flat"}').baseBranch, 'nested');
  });

  test('protected_branches is honoured and validated through this seam too', () => {
    const clean = readWith('{"git":{"base_branch":"main","protected_branches":["develop"," next "]}}');
    assert.deepStrictEqual(clean.protectedBranches, ['main', 'develop', 'next']);
    assert.deepStrictEqual(clean.rejectedProtectedBranches, []);

    const partial = readWith('{"git":{"base_branch":"main","protected_branches":["develop",42]}}');
    assert.deepStrictEqual(partial.protectedBranches, ['main', 'develop'],
      'a bad element must drop only itself on this path as well');
    assert.deepStrictEqual(partial.rejectedProtectedBranches, ['42']);

    const notAList = readWith('{"git":{"base_branch":"main","protected_branches":"develop"}}');
    assert.deepStrictEqual(notAList.protectedBranches, ['main']);
    assert.deepStrictEqual(notAList.rejectedProtectedBranches, ['"develop"']);
  });

  test('loadConfig wins when both seams are supplied — readFile is the test-only path', () => {
    const status = gitBaseBranch.resolveProtectedBranchStatus(CWD, 'from-loader', {
      execGit: makeFaultyGit(),
      readFile: () => '{"git":{"base_branch":"from-readfile"}}',
      loadConfig: () => ({ base_branch: 'from-loader' }),
    });

    assert.strictEqual(status.baseBranch, 'from-loader',
      'production resolution must not be displaced by the low-level seam');
    assert.strictEqual(status.isProtected, true);
  });
});

// ─── #3057 W3: negative-space coverage for the resolver's failure arms ───────
//
// Everything below drives the *unhappy* halves of git-base-branch: malformed
// config, git output that parses but says nothing useful, git that cannot run
// at all, and a repository with no work tree. Each test asserts the exact value
// the arm is contracted to produce — never "it did not throw", never a shape
// check — because an arm that silently returns `undefined` instead of `null`
// changes the precedence ladder's behaviour while passing any weaker assertion.

/**
 * Build a result object shaped exactly like `execGit`'s (see `_spawnResult` in
 * shell-command-projection). Defaults are a benign, completed, zero-exit call.
 */
function gitResult(overrides) {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    error: null,
    timedOut: false,
    ...overrides,
  };
}

/** An `execGit` stand-in that always returns the same shaped result. */
function constGit(overrides) {
  return () => gitResult(overrides);
}

/**
 * An `execGit` stand-in that throws. `makeFaultyGit` deliberately never throws
 * (it returns a shaped failure result), so the resolver's `catch` arms need
 * this instead.
 */
function throwingGit(message) {
  return () => { throw new Error(message); };
}

describe('#3057 W3: trySymbolicRef — tier-2 output that resolves to nothing', () => {
  test('stdout is exactly "origin/" → null (prefix strip leaves an empty name)', () => {
    assert.strictEqual(gitBaseBranch.trySymbolicRef('/x', constGit({ stdout: 'origin/' })), null);
    assert.strictEqual(gitBaseBranch.trySymbolicRef('/x', constGit({ stdout: 'origin/\n' })), null);
  });

  test('only ONE leading "origin/" is stripped — slashes inside the name survive', () => {
    assert.strictEqual(
      gitBaseBranch.trySymbolicRef('/x', constGit({ stdout: 'origin/feature/long-name\n' })),
      'feature/long-name');
    assert.strictEqual(
      gitBaseBranch.trySymbolicRef('/x', constGit({ stdout: 'origin/origin/main\n' })),
      'origin/main');
  });

  test('execGit THROWS → null (catch arm; makeFaultyGit cannot reach this)', () => {
    assert.strictEqual(gitBaseBranch.trySymbolicRef('/x', throwingGit('symbolic-ref exploded')), null);
  });

  test('the tier-2 subprocess is bounded (argv + timeout are pinned)', () => {
    const seen = [];
    gitBaseBranch.trySymbolicRef('/some/cwd', (args, opts) => {
      seen.push({ args, opts });
      return gitResult({ stdout: 'origin/main\n' });
    });
    assert.deepStrictEqual(seen, [{
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      opts: { cwd: '/some/cwd', timeout: 5_000 },
    }]);
  });
});

describe('#3057 W3: tryRemoteShow — tier-3 output that is present but not authoritative', () => {
  const REMOTE_SHOW_NO_HEAD = [
    '* remote origin',
    '  Fetch URL: /tmp/origin.git',
    '  Push  URL: /tmp/origin.git',
    '  Remote branch:',
    '    main tracked',
    '',
  ].join('\n');

  test('stdout has no "HEAD branch:" line → null', () => {
    assert.strictEqual(
      gitBaseBranch.tryRemoteShow('/x', constGit({ stdout: REMOTE_SHOW_NO_HEAD })), null);
  });

  test('"HEAD branch:" with no value on the line → null (no capture, no guess)', () => {
    assert.strictEqual(
      gitBaseBranch.tryRemoteShow('/x', constGit({ stdout: '  HEAD branch: \n' })), null);
  });

  test('"HEAD branch: (unknown)" → null — the documented offline-remote case', () => {
    // git prints "(unknown)" when it could not reach the remote. Returning it
    // verbatim would hand a literal branch named "(unknown)" to five workflows;
    // returning null lets tier 4 answer instead.
    assert.strictEqual(
      gitBaseBranch.tryRemoteShow('/x', constGit({ stdout: '  HEAD branch: (unknown)\n' })), null);
  });

  test('execGit THROWS → null (catch arm)', () => {
    assert.strictEqual(gitBaseBranch.tryRemoteShow('/x', throwingGit('remote show exploded')), null);
  });

  test('positive control: the HEAD branch line is found mid-output and returned verbatim', () => {
    const stdout = [
      '* remote origin',
      '  Fetch URL: /tmp/origin.git',
      '  HEAD branch: master',
      '  Remote branch:',
      '    master tracked',
      '',
    ].join('\n');
    assert.strictEqual(gitBaseBranch.tryRemoteShow('/x', constGit({ stdout })), 'master');
  });

  test('the tier-3 subprocess is bounded (argv + timeout are pinned)', () => {
    const seen = [];
    gitBaseBranch.tryRemoteShow('/some/cwd', (args, opts) => {
      seen.push({ args, opts });
      return gitResult({ stdout: '  HEAD branch: main\n' });
    });
    assert.deepStrictEqual(seen, [{
      args: ['remote', 'show', 'origin'],
      opts: { cwd: '/some/cwd', timeout: 15_000 },
    }]);
  });
});

describe('#3057 W3: tryLocalBranch — non-empty stdout that names neither main nor master', () => {
  test('stdout is exactly "\\n" → null, reached PAST the empty-stdout guard', () => {
    // This is the branch that was once deleted as "unreachable". The guard is
    // `if (r.exitCode !== 0 || !r.stdout) return null` — `"\n"` is a truthy
    // string, so the guard does NOT fire; `split('\n')` yields ["", ""], both
    // main/master checks are false, and the FINAL `return null` executes.
    // Deleting that line makes this function return `undefined`, which
    // strictEqual(null) catches.
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '\n' })), null);
  });

  test('stdout is exactly "" → null via the EARLY guard (a different arm)', () => {
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '' })), null);
  });

  // Boundary trio over the number of branch lines `git branch --list main master`
  // can emit: 0 (below the smallest useful listing), 1, and 2 (the maximum this
  // argv can produce).
  test('0 branch lines → null', () => {
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '\n' })), null);
  });

  test('1 branch line → that branch', () => {
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '  main\n' })), 'main');
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '  master\n' })), 'master');
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '* master\n' })), 'master',
      'the checked-out marker "* " must be stripped before matching');
  });

  test('2 branch lines → "main" wins the tie-break', () => {
    assert.strictEqual(
      gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '  main\n  master\n' })), 'main');
    assert.strictEqual(
      gitBaseBranch.tryLocalBranch('/x', constGit({ stdout: '* master\n  main\n' })), 'main');
  });

  test('execGit THROWS → null (catch arm)', () => {
    assert.strictEqual(gitBaseBranch.tryLocalBranch('/x', throwingGit('branch --list exploded')), null);
  });

  test('the tier-4 subprocess is bounded (argv + timeout are pinned)', () => {
    const seen = [];
    gitBaseBranch.tryLocalBranch('/some/cwd', (args, opts) => {
      seen.push({ args, opts });
      return gitResult({ stdout: '  main\n' });
    });
    assert.deepStrictEqual(seen, [{
      args: ['branch', '--list', 'main', 'master'],
      opts: { cwd: '/some/cwd', timeout: 5_000 },
    }]);
  });
});

describe('#3057 W3: resolveBaseBranchDiagnostics — which tier actually answered', () => {
  // Every tier can produce a plausible-looking branch name, so asserting the
  // returned string alone cannot tell a tier-2 answer from a tier-3 or tier-4
  // one. Each test below rigs the LOWER tiers to answer with a DIFFERENT branch
  // than the tier under test, so a resolver that consulted them in the wrong
  // order returns the wrong string, and additionally pins the recorded argv so
  // an early return is provably an early return.

  /** A passthrough answering each tier with a distinct, recognisable branch. */
  function tieredPassthrough({ symref, remote, local }) {
    return (args) => {
      if (args[0] === 'symbolic-ref') {
        return symref === null ? gitResult({ exitCode: 1 }) : gitResult({ stdout: `origin/${symref}\n` });
      }
      if (args[0] === 'remote') {
        return remote === null ? gitResult({ exitCode: 128 }) : gitResult({ stdout: `  HEAD branch: ${remote}\n` });
      }
      if (args[0] === 'branch') {
        return local === null ? gitResult({ stdout: '\n' }) : gitResult({ stdout: `  ${local}\n` });
      }
      return gitResult({});
    };
  }

  const NO_CONFIG = { readFile: () => null };

  test('tier 2 answers → tiers 3 and 4 are never consulted', () => {
    const git = makeFaultyGit({
      passthrough: tieredPassthrough({ symref: 'from-symref', remote: 'from-remote', local: 'master' }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'from-symref', verified: true });
    assert.deepStrictEqual(git.calls.map((c) => c.args[0]), ['symbolic-ref'],
      'a tier-2 hit must stop the ladder before `remote show` and `branch --list`');
  });

  test('tier 3 answers → tier 4 is never consulted, even though it WOULD answer "master"', () => {
    const git = makeFaultyGit({
      passthrough: tieredPassthrough({ symref: null, remote: 'from-remote', local: 'master' }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'from-remote', verified: true });
    assert.deepStrictEqual(git.calls.map((c) => c.args[0]), ['symbolic-ref', 'remote'],
      'a tier-3 hit must stop the ladder before `branch --list`');
  });

  test('tier 4 answers only after tiers 2 and 3 both decline', () => {
    const git = makeFaultyGit({
      passthrough: tieredPassthrough({ symref: null, remote: null, local: 'master' }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'master', verified: true });
    assert.deepStrictEqual(git.calls.map((c) => c.args[0]), ['symbolic-ref', 'remote', 'branch']);
  });

  test('a config override answers before ANY git subprocess runs', () => {
    const git = makeFaultyGit({
      passthrough: tieredPassthrough({ symref: 'from-symref', remote: 'from-remote', local: 'master' }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', {
      readFile: () => '{"git":{"base_branch":"from-config"}}',
      execGit: git,
    });
    assert.deepStrictEqual(result, { branch: 'from-config', verified: true });
    assert.deepStrictEqual(git.calls, [], 'tier 1 must not spawn git at all');
  });

  test('git cannot be SPAWNED at all (exit 127 + error) → "main", verified:false', () => {
    // Distinct from the timeout case already covered by #3057 B4: here every
    // call returns exitCode 127 with `error` set and `timedOut:false`, which is
    // the `r.error` disjunct of the failure detector rather than `r.timedOut`.
    const git = makeFaultyGit({ faults: [{ kind: 'spawnFail' }] });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'main', verified: false });
    assert.deepStrictEqual(git.calls.map((c) => c.args[0]), ['symbolic-ref', 'remote', 'branch'],
      'all three tiers must still be attempted before the unverified default');
  });

  test('a spawn failure on ONE tier alone is enough to mark the default unverified', () => {
    // Tiers 2 and 3 complete cleanly with "no answer"; only tier 4 fails to run.
    const git = makeFaultyGit({
      faults: [{ kind: 'spawnFail', when: ['branch', '--list'] }],
      passthrough: tieredPassthrough({ symref: null, remote: null, local: null }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'main', verified: false });
  });

  test('tier-4 stdout of "\\n" (no branches) is a VERIFIED "no candidate", not a failure', () => {
    // The counterpart to the tryLocalBranch "\n" test, one level up: git ran,
    // answered, and the answer was "neither branch exists". That must still be
    // verified:true — collapsing it into verified:false would re-fail-open the
    // exact distinction #3057 B4 introduced.
    const git = makeFaultyGit({
      passthrough: tieredPassthrough({ symref: null, remote: null, local: null }),
    });
    const result = gitBaseBranch.resolveBaseBranchDiagnostics('/x', { ...NO_CONFIG, execGit: git });
    assert.deepStrictEqual(result, { branch: 'main', verified: true });
  });
});

describe('#3057 W3: gitWorktreeInfoInternal — no work tree, and git failing mid-sequence', () => {
  test('a REAL bare repository reports {inside:false, worktreeRoot:null}', (t) => {
    // `git rev-parse --is-inside-work-tree` exits 0 in a bare repo and prints
    // "false" — the exitCode guard does NOT fire, so this is the stdout check,
    // and it is reachable without any injection.
    const dir = createTempDir('gsd-3057-w3-bare-');
    t.after(() => cleanup(dir));
    gitOrThrow(['init', '--bare'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });

    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal(dir),
      { inside: false, worktreeRoot: null });
  });

  test('is-inside-work-tree prints "false" with exit 0 → no second git call is made', () => {
    const git = makeFaultyGit({ passthrough: () => gitResult({ stdout: 'false\n' }) });
    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal('/x', { execGit: git }),
      { inside: false, worktreeRoot: null });
    assert.deepStrictEqual(git.calls.map((c) => c.args), [['rev-parse', '--is-inside-work-tree']],
      '--show-toplevel must not be queried once we know there is no work tree');
  });

  test('inside a work tree but --show-toplevel FAILS → {inside:true, worktreeRoot:null}', () => {
    // inside is still reported truthfully; only the root is unknown. Reporting
    // inside:false here would be a lie about a repository we just confirmed.
    const git = makeFaultyGit({
      faults: [{
        kind: 'exit',
        exitCode: 128,
        stderr: 'fatal: no work tree',
        when: ['rev-parse', '--show-toplevel'],
      }],
      passthrough: () => gitResult({ stdout: 'true\n' }),
    });
    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal('/x', { execGit: git }),
      { inside: true, worktreeRoot: null });
    assert.deepStrictEqual(git.calls.map((c) => c.args[1]),
      ['--is-inside-work-tree', '--show-toplevel']);
  });

  test('--show-toplevel succeeds with blank stdout → {inside:true, worktreeRoot:null}', () => {
    const git = makeFaultyGit({
      passthrough: (args) => gitResult({ stdout: args[1] === '--show-toplevel' ? '   \n' : 'true\n' }),
    });
    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal('/x', { execGit: git }),
      { inside: true, worktreeRoot: null });
  });

  test('--show-toplevel succeeds → the trimmed path is returned', () => {
    const git = makeFaultyGit({
      passthrough: (args) => gitResult({ stdout: args[1] === '--show-toplevel' ? '  /repo/root  \n' : 'true\n' }),
    });
    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal('/x', { execGit: git }),
      { inside: true, worktreeRoot: '/repo/root' });
  });

  test('execGit THROWS → {inside:false, worktreeRoot:null} (catch arm)', () => {
    assert.deepStrictEqual(
      gitBaseBranch.gitWorktreeInfoInternal('/x', { execGit: throwingGit('git is gone') }),
      { inside: false, worktreeRoot: null });
  });

  test('both worktree probes are bounded and receive the caller cwd', () => {
    const git = makeFaultyGit({
      passthrough: (args) => gitResult({ stdout: args[1] === '--show-toplevel' ? '/repo/root\n' : 'true\n' }),
    });
    gitBaseBranch.gitWorktreeInfoInternal('/some/cwd', { execGit: git });
    assert.deepStrictEqual(git.calls, [
      { args: ['rev-parse', '--is-inside-work-tree'], opts: { cwd: '/some/cwd', timeout: 5000 } },
      { args: ['rev-parse', '--show-toplevel'], opts: { cwd: '/some/cwd', timeout: 5000 } },
    ]);
  });
});

describe('#3057 W3: cmdGitBaseBranch — the DEFAULT diagnostic sink', () => {
  test('with no writeDiagnostic injected, the unverified warning goes to process.stderr', (t) => {
    const written = [];
    t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });

    const stdout = [];
    const branch = gitBaseBranch.cmdGitBaseBranch('/x', [], {
      readFile: () => null,
      execGit: makeFaultyGit({ faults: [{ kind: 'timeout' }] }),
      write: (s) => { stdout.push(s); },
      // writeDiagnostic deliberately omitted → the process.stderr default arm.
    });

    assert.strictEqual(branch, 'main');
    assert.deepStrictEqual(stdout, ['main\n'], 'the stdout contract five workflows parse is unchanged');
    assert.strictEqual(written.length, 1, 'exactly one diagnostic must reach the default stderr sink');
    assert.match(written[0], /WITHOUT verifying/);
  });

  test('with no writeDiagnostic injected and a VERIFIED answer, process.stderr is untouched', (t) => {
    const written = [];
    t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });

    const stdout = [];
    const branch = gitBaseBranch.cmdGitBaseBranch('/x', [], {
      readFile: () => '{"git":{"base_branch":"develop"}}',
      execGit: makeFaultyGit(),
      write: (s) => { stdout.push(s); },
    });

    assert.strictEqual(branch, 'develop');
    assert.deepStrictEqual(stdout, ['develop\n']);
    assert.deepStrictEqual(written, [], 'a verified answer must write nothing to the default stderr sink');
  });
});

// ─── setGsdConfig prototype-pollution guard (#1406) ───────────────────────────

describe('#1406: setGsdConfig prototype-pollution guard', () => {
  test('rejects __proto__ as a key segment', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    assert.throws(() => setGsdConfig(dir, '__proto__', 'x'), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, '__proto__.polluted', true), /unsafe config key segment/);
  });

  test('rejects constructor / prototype chain segments', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    assert.throws(() => setGsdConfig(dir, 'constructor.prototype.polluted', true), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, 'safe.__proto__', true), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, 'a.prototype.b', true), /unsafe config key segment/);
  });

  test('does not pollute Object.prototype after rejected attempts', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    try { setGsdConfig(dir, '__proto__.polluted', true); } catch (_) { /* expected */ }
    try { setGsdConfig(dir, 'constructor.prototype.polluted', true); } catch (_) { /* expected */ }
    try { setGsdConfig(dir, 'a.__proto__.polluted', true); } catch (_) { /* expected */ }
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
  });

  test('still writes a normal nested key', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    setGsdConfig(dir, 'git.base_branch', 'develop');
    const cfgPath = path.join(dir, '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.git.base_branch, 'develop');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2004-pr-branch-milestone.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2004-pr-branch-milestone (consolidation epic #1969 B4 #1973)", () => {
/**
 * Regression tests for bug #2004
 *
 * /gsd-pr-branch must not exclude milestone archive and structural planning
 * commits. The previous implementation filtered ALL .planning/-only commits,
 * including STATE.md, ROADMAP.md, MILESTONES.md, and milestones/** updates
 * that are needed to preserve repository planning state after a merge.
 *
 * Fixed: pr-branch.md now distinguishes:
 *   - Transient planning commits (phase plans, summaries, research, context) → EXCLUDE
 *   - Structural planning commits (STATE.md, ROADMAP.md, MILESTONES.md,
 *     PROJECT.md, milestones/**) → INCLUDE
 *   - Code commits (any non-.planning/ file) → INCLUDE
 *   - Mixed commits (code + planning) → INCLUDE
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(
  __dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md'
);

describe('bug #2004: pr-branch preserves structural planning commits', () => {
  let content;

  test('setup: pr-branch workflow is readable', () => {
    content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.length > 0, 'pr-branch.md must not be empty');
  });

  test('workflow distinguishes structural vs transient planning commits', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    // Must contain language distinguishing structural from transient/phase planning files
    assert.ok(
      /structural|milestone.*archive|STATE\.md.*INCLUDE|preserve.*milestone|milestone.*preserve/i.test(content),
      'pr-branch.md must distinguish structural planning commits from transient ones'
    );
  });

  test('workflow lists STATE.md and ROADMAP.md as structural files to preserve', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      content.includes('STATE.md'),
      'pr-branch.md must reference STATE.md as a structural file to preserve'
    );
    assert.ok(
      content.includes('ROADMAP.md'),
      'pr-branch.md must reference ROADMAP.md as a structural file to preserve'
    );
  });

  test('workflow lists MILESTONES.md or milestones/ as structural files to preserve', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      content.includes('MILESTONES.md') || content.includes('milestones/'),
      'pr-branch.md must reference MILESTONES.md or milestones/ as structural files to preserve'
    );
  });

  test('workflow has four commit categories (code, planning-only, mixed, structural)', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    // Must have at least a "structural" or "milestone" category beyond the original three
    assert.ok(
      /structural.*commit|milestone.*commit|commit.*structural|commit.*milestone/i.test(content) ||
      /INCLUDE.*STATE\.md|STATE\.md.*INCLUDE/i.test(content),
      'pr-branch.md must classify structural planning commits as INCLUDE'
    );
  });

  test('create_pr_branch step does not rm -r --cached all of .planning/', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    // The original bug: `git rm -r --cached .planning/` nuked structural files.
    // The fix must either remove this wholesale rm or scope it to transient dirs.
    // Acceptable: narrowed rm targeting only phase/, quick/, research/, etc.
    // Not acceptable: `git rm -r --cached .planning/` with no scoping.
    const hasUnscoped = /git rm -r --cached \.planning\/(?!\*)?(?!phases|quick|research|threads|todos|debug|seeds|ui-reviews|codebase)/
      .test(content);
    assert.ok(
      !hasUnscoped,
      'create_pr_branch must not use unscoped "git rm -r --cached .planning/" — scope to transient subdirectories only'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2916-handle-branching-default-base.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2916-handle-branching-default-base (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for #2916: execute-phase `handle_branching` step creates the
 * per-phase branch off whatever HEAD is currently checked out (typically the
 * previous phase's unmerged branch) instead of off `origin/HEAD`.
 *
 * The bug compounded phases on top of each other and stranded them unpushed
 * for weeks. The fix:
 *   1. Detect the default branch via `git symbolic-ref refs/remotes/origin/HEAD`.
 *   2. If $BRANCH_NAME exists, switch to it (preserve existing behavior).
 *   3. Otherwise, ff-update the default branch from origin and create the new
 *      phase branch off the default-branch tip.
 *   4. Refuse-or-warn on dirty working tree.
 *   5. Post-creation, assert `git rev-list --count $DEFAULT_BRANCH..HEAD == 0`.
 *
 * This test extracts the bash payload from the <step name="handle_branching">
 * block in execute-phase.md (parsed structurally — no regex on prose), executes
 * it inside a fixture git repo where HEAD sits on a previous-phase branch with
 * extra commits, and asserts that the new phase branch's tip equals
 * `origin/main` (no commits inherited from the previous phase).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const EXECUTE_PHASE_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);

const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
});

function git(cwd, ...args) {
  return gitOrThrow(args, { cwd, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS }).trim();
}

/**
 * Structurally extract the bash code that the handle_branching step instructs
 * the agent to run. We:
 *   1. Locate the <step name="handle_branching"> ... </step> block.
 *   2. Walk its body looking for fenced ```bash blocks.
 *   3. Concatenate every bash block in the step (the fix may use more than one).
 *
 * No `.includes()` content checks — we parse fence-delimited code blocks the
 * same way a markdown parser would.
 */
function extractHandleBranchingBash() {
  const content = readFileNormalized(EXECUTE_PHASE_PATH);
  const lines = content.split('\n');

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === -1 && /^<step\s+name="handle_branching">\s*$/.test(lines[i])) {
      start = i + 1;
    } else if (start !== -1 && /^<\/step>\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error(
      'execute-phase.md does not contain a <step name="handle_branching"> ... </step> block'
    );
  }

  const bashBlocks = [];
  let inBash = false;
  let buffer = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (!inBash && /^```bash\s*$/.test(line)) {
      inBash = true;
      buffer = [];
      continue;
    }
    if (inBash && /^```\s*$/.test(line)) {
      bashBlocks.push(buffer.join('\n'));
      inBash = false;
      continue;
    }
    if (inBash) buffer.push(line);
  }
  if (bashBlocks.length === 0) {
    throw new Error(
      'handle_branching step contains no ```bash code blocks to execute'
    );
  }
  return bashBlocks.join('\n');
}

/**
 * Build a fixture: a bare "origin" repo with the named default branch (one
 * commit), a clone with `origin/HEAD` pointed at it, and a checked-out
 * previous-phase branch carrying its own unmerged commit.
 *
 * `defaultBranch` is parameterized so callers can lock in that the workflow
 * honors `git symbolic-ref refs/remotes/origin/HEAD` rather than silently
 * defaulting to `main` (#2921 CR feedback — quick-branching.test.cjs got the
 * same treatment in 80f14cac; this test deserves the same coverage).
 */
function setupFixture(defaultBranch = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2916-'));
  const seedPath = path.join(root, 'seed');
  const originPath = path.join(root, 'origin.git');
  const clonePath = path.join(root, 'clone');

  fs.mkdirSync(seedPath);
  git(seedPath, 'init', '-b', defaultBranch);
  git(seedPath, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(seedPath, 'README.md'), '# seed\n');
  git(seedPath, 'add', 'README.md');
  git(seedPath, 'commit', '-m', 'initial');

  git(root, 'clone', '--bare', seedPath, originPath);
  git(originPath, 'symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`);

  git(root, 'clone', originPath, clonePath);
  git(clonePath, 'config', 'commit.gpgsign', 'false');
  git(clonePath, 'config', 'user.email', 'test@test.com');
  git(clonePath, 'config', 'user.name', 'Test');

  // Simulate finishing a previous phase: branch off the default branch, add
  // a commit, and *stay* on it (the failure scenario described in the bug).
  git(clonePath, 'checkout', '-b', 'feature/phase-01-foundation');
  fs.writeFileSync(path.join(clonePath, 'phase01.txt'), 'phase 1 work\n');
  git(clonePath, 'add', 'phase01.txt');
  git(clonePath, 'commit', '-m', 'phase 01 work');

  return { root, clonePath, defaultBranch };
}

function runHandleBranchingStep(bash, cwd, branchName) {
  // Write the script to a sibling tempdir, not inside the repo — putting it in
  // `cwd` would create an untracked file that trips `git status --porcelain`
  // and steers the step into its dirty-tree fallback path.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2916-step-'));
  const scriptPath = path.join(scriptDir, 'handle-branching.sh');
  const script = `#!/usr/bin/env bash\nset -uo pipefail\nBRANCH_NAME="${branchName}"\n${bash}\n`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try {
    // Bash FAN-OUT (a sequence of git commands under one `bash` interpreter),
    // not a single git plumbing call — the wrong class for `GIT_TIMEOUT_MS`.
    // Same class as the observed CI failures in tests/quick-branching.test.cjs
    // (PR #3787 run 32668773524) and tests/worktree-safety.test.cjs (`next`
    // run 32608945654). See HOOK_FANOUT_TIMEOUT_MS in ./helpers/timeouts.cjs
    // for the class rationale.
    const r = runHook(scriptPath, [], { interpreter: 'bash', cwd, env: GIT_ENV, timeoutMs: HOOK_FANOUT_TIMEOUT_MS });
    throwIfFailed(r, `runHandleBranchingStep: bash ${scriptPath}`);
    return r.stdout;
  } finally {
    cleanup(scriptDir);
  }
}

describe('handle_branching branches off origin/HEAD, not current HEAD (#2916)', () => {
  // Run against `main` (conventional default) and `trunk` (non-main default
  // exercising the symbolic-ref code path) so a regression that hard-codes
  // `main` instead of consulting origin/HEAD will fail the trunk variant.
  for (const defaultBranch of ['main', 'trunk']) {
    test(`new phase branch branches off origin/${defaultBranch} with 0 inherited commits`, (t) => {
      const bash = extractHandleBranchingBash();
      const { root, clonePath } = setupFixture(defaultBranch);
      // Teardown via t.after, not try/finally — CONTRIBUTING.md "Setup and
      // Cleanup" reserves try/finally for context-free helper functions.
      t.after(() => cleanup(root));

      const upstream = `origin/${defaultBranch}`;

      assert.equal(
        git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
        'feature/phase-01-foundation'
      );
      assert.equal(
        git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`),
        '1',
        `fixture should be 1 commit ahead of ${upstream}`
      );

      runHandleBranchingStep(bash, clonePath, 'feature/phase-02-content-sync');

      assert.equal(
        git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
        'feature/phase-02-content-sync',
        'handle_branching should switch to the new phase branch'
      );

      const inherited = git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`);
      assert.equal(
        inherited,
        '0',
        `new phase branch must branch off ${upstream}, but inherited ${inherited} commit(s) from previous-phase HEAD`
      );
      assert.equal(
        git(clonePath, 'rev-parse', 'HEAD'),
        git(clonePath, 'rev-parse', upstream),
        `new phase branch tip must equal ${upstream} tip`
      );
    });
  }

  test('handle_branching reuses an existing branch instead of forking again', (t) => {
    const bash = extractHandleBranchingBash();
    const { root, clonePath } = setupFixture();
    t.after(() => cleanup(root));

    // Pre-create the target branch off origin/main with its own commit, then
    // walk away to a different branch — the step must switch back to it.
    git(clonePath, 'checkout', '-B', 'feature/phase-02-content-sync', 'origin/main');
    fs.writeFileSync(path.join(clonePath, 'phase02.txt'), 'phase 2 work\n');
    git(clonePath, 'add', 'phase02.txt');
    git(clonePath, 'commit', '-m', 'phase 02 wip');
    const phase02Sha = git(clonePath, 'rev-parse', 'HEAD');
    git(clonePath, 'checkout', 'feature/phase-01-foundation');

    runHandleBranchingStep(bash, clonePath, 'feature/phase-02-content-sync');

    assert.equal(
      git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
      'feature/phase-02-content-sync'
    );
    assert.equal(
      git(clonePath, 'rev-parse', 'HEAD'),
      phase02Sha,
      'existing-branch tip must be preserved (no rebase/reset)'
    );
  });
});
  });
}

// ─── #3679 — pr-branch: pre-existing planning content + verify deletion gate ──
//
// The original deletion class (blanket `git rm -r --cached` of transient dirs
// stripping pre-existing base-branch files) was fixed as a side effect of the
// #2971 strict-mode rewrite (rm -f --ignore-unmatch + `git checkout HEAD --`
// restore). These rows PIN that guarantee behaviorally so it cannot silently
// regress, and add the remaining piece from the #3679 brief: the verify step
// must FAIL when the PR-branch diff deletes planning files the target tracks
// (a deleted allowed/structural path verifies clean today — name-only
// counting cannot see status).

describe('#3679 — pr-branch pre-existing planning content + verify deletion gate', () => {
  const PR_BRANCH_MD = path.join(WORKFLOW_DIR, 'pr-branch.md');

  function extractStepBash(stepName) {
    const content = readFileNormalized(PR_BRANCH_MD);
    const lines = content.split('\n');
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (start === -1 && new RegExp(`^<step\\s+name="${stepName}">\\s*$`).test(lines[i])) {
        start = i + 1;
      } else if (start !== -1 && /^<\/step>\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    assert.ok(start !== -1 && end !== -1, `pr-branch.md must contain the ${stepName} step`);
    const bashBlocks = [];
    let inBash = false;
    let buffer = [];
    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      if (!inBash && /^```bash\s*$/.test(line)) {
        inBash = true;
        buffer = [];
        continue;
      }
      if (inBash && /^```\s*$/.test(line)) {
        bashBlocks.push(buffer.join('\n'));
        inBash = false;
        continue;
      }
      if (inBash) buffer.push(line);
    }
    assert.ok(bashBlocks.length > 0, `${stepName} step contains bash blocks`);
    return bashBlocks.join('\n');
  }

  test('verify step gates on planning-tree deletions', () => {
    const bash = extractStepBash('verify');
    assert.ok(
      /diff-filter=D|--name-status/.test(bash),
      'verify must distinguish deletions (diff-filter=D or --name-status)',
    );
    assert.ok(
      /PLANNING_DELETIONS/.test(bash),
      'verify must compute a planning-deletions count',
    );
    // The must-be-0 gate lives in the step PROSE and the display template,
    // outside every ```bash block — assert it against the full file text so
    // the enforcement half of criterion 4 is pinned, not just the computation.
    const fullText = readFileNormalized(PR_BRANCH_MD);
    assert.ok(
      /PLANNING_DELETIONS[^\n]*must be .?0/.test(fullText),
      'verify prose must gate on a zero PLANNING_DELETIONS count',
    );
    assert.ok(
      /Planning deletions: \{PLANNING_DELETIONS\}/.test(fullText),
      'verify display must surface the deletion count',
    );
  });

  test('verify fails when the PR diff deletes target-tracked planning files', (t) => {
    const repo = createTempDir('gsd-3679-verify-fail-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.planning', 'STATE.md'), 'state\n');
    fs.writeFileSync(path.join(repo, 'code.sh'), 'code\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);
    g(['checkout', '-qb', 'pr']);
    fs.writeFileSync(path.join(repo, 'code.sh'), 'code2\n');
    // The failure class under test: the PR branch deletes a planning file the
    // target tracks (here structural — an allowed category, so the existing
    // name-only forbidden count cannot catch it).
    g(['rm', '-q', '.planning/STATE.md']);
    g(['add', '-A']);
    g(['commit', '-qm', 'changes + planning deletion']);

    const verifyBash = extractStepBash('verify');
    const script = [
      'set -u',
      'TARGET=main',
      'PR_BRANCH=pr',
      'FORBIDDEN_RE="^\\.planning/(phases|quick|research|threads|todos|debug|seeds|codebase|ui-reviews)/"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/"',
      verifyBash,
      'echo "GATE_FORBIDDEN=$FORBIDDEN"',
      'echo "GATE_PLANNING_DELETIONS=${PLANNING_DELETIONS:-unset}"',
    ].join('\n');
    fs.writeFileSync(path.join(repo, 'verify.sh'), script + '\n');
    const r = runHook(path.join(repo, 'verify.sh'), [], {
      interpreter: 'bash',
      cwd: repo,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    const out = r.stdout + r.stderr;
    assert.match(out, /GATE_PLANNING_DELETIONS=1/, `deletion count must be non-zero: ${out.slice(0, 400)}`);
  });

  test('verify passes a clean diff with zero deletions', (t) => {
    const repo = createTempDir('gsd-3679-verify-clean-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.planning', 'STATE.md'), 'state\n');
    fs.writeFileSync(path.join(repo, 'code.sh'), 'code\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);
    g(['checkout', '-qb', 'pr']);
    fs.writeFileSync(path.join(repo, 'code.sh'), 'code2\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'code only']);

    const verifyBash = extractStepBash('verify');
    const script = [
      'set -u',
      'TARGET=main',
      'PR_BRANCH=pr',
      'FORBIDDEN_RE="^\\.planning/(phases|quick|research|threads|todos|debug|seeds|codebase|ui-reviews)/"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/"',
      verifyBash,
      'echo "GATE_FORBIDDEN=$FORBIDDEN"',
      'echo "GATE_PLANNING_DELETIONS=${PLANNING_DELETIONS:-unset}"',
    ].join('\n');
    fs.writeFileSync(path.join(repo, 'verify.sh'), script + '\n');
    const r = runHook(path.join(repo, 'verify.sh'), [], {
      interpreter: 'bash',
      cwd: repo,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    const out = r.stdout + r.stderr;
    assert.match(out, /GATE_PLANNING_DELETIONS=0/, `clean diff must count zero deletions: ${out.slice(0, 400)}`);
  });

  test('create loop preserves pre-existing transient content (#3720 guarantee pinned)', (t) => {
    const repo = createTempDir('gsd-3679-create-mixed-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, '.planning', 'phases'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.planning', 'research'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.planning', 'phases', '1.0-PLAN.md'), 'plan\n');
    fs.writeFileSync(path.join(repo, '.planning', 'research', 'context.md'), 'ctx\n');
    // Structural planning state on the TARGET (criterion 3): must survive the
    // create loop byte-identical alongside the transient content.
    fs.writeFileSync(path.join(repo, '.planning', 'STATE.md'), 'state\n');
    fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), 'roadmap\n');
    fs.writeFileSync(path.join(repo, 'infra', 'script.sh'), 'code\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base: code + pre-existing planning']);
    g(['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(repo, 'infra', 'script2.sh'), 'more\n');
    fs.writeFileSync(path.join(repo, '.planning', 'phases', '2.0-SUMMARY.md'), 'summary\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'mixed: code + new transient']);
    const hash = g(['rev-parse', 'HEAD']).trim();

    // Execute the shipped create_pr_branch loop verbatim (default-mode paths).
    const createBash = extractStepBash('create_pr_branch');
    const script = [
      'set -u',
      `CURRENT_BRANCH=feature`,
      'TARGET=main',
      `INCLUDED_COMMITS="${hash}"`,
      'FILTER_PATHS=".planning/phases/ .planning/quick/ .planning/research/ .planning/threads/ .planning/todos/ .planning/debug/ .planning/seeds/ .planning/codebase/ .planning/ui-reviews/ "',
      createBash,
    ].join('\n');
    fs.writeFileSync(path.join(repo, 'create.sh'), script + '\n');
    const r = runHook(path.join(repo, 'create.sh'), [], {
      interpreter: 'bash',
      cwd: repo,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(r.exitCode, 0, `create loop must succeed: ${r.stderr.slice(0, 400)}`);

    const status = g(['diff', '--name-status', 'main..feature-pr']);
    assert.equal((status.match(/^D/gm) || []).length, 0, `no deletions allowed: ${status}`);
    const diffPaths = g(['diff', '--name-only', 'main..feature-pr']);
    assert.ok(!diffPaths.includes('2.0-SUMMARY.md'), "commit's own transient file must be excluded");
    assert.ok(diffPaths.includes('script2.sh'), 'code change must be present');
    assert.ok(!diffPaths.includes('1.0-PLAN.md'), 'pre-existing plan must be untouched');
    assert.ok(!diffPaths.includes('STATE.md'), 'structural STATE.md must survive (criterion 3)');
    assert.ok(!diffPaths.includes('ROADMAP.md'), 'structural ROADMAP.md must survive (criterion 3)');
  });

  test('create loop preserves planning content on pure-code commits', (t) => {
    const repo = createTempDir('gsd-3679-create-pure-');
    t.after(() => cleanup(repo));
    const g = (args) => gitOrThrow(args, { cwd: repo });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, '.planning', 'phases'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.planning', 'phases', '1.0-PLAN.md'), 'plan\n');
    fs.writeFileSync(path.join(repo, 'infra', 'script.sh'), 'code\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'base']);
    g(['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(repo, 'infra', 'script2.sh'), 'more\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'pure code']);
    const hash = g(['rev-parse', 'HEAD']).trim();

    const createBash = extractStepBash('create_pr_branch');
    const script = [
      'set -u',
      'CURRENT_BRANCH=feature',
      'TARGET=main',
      `INCLUDED_COMMITS="${hash}"`,
      'FILTER_PATHS=".planning/phases/ .planning/quick/ .planning/research/ .planning/threads/ .planning/todos/ .planning/debug/ .planning/seeds/ .planning/codebase/ .planning/ui-reviews/ "',
      createBash,
    ].join('\n');
    fs.writeFileSync(path.join(repo, 'create.sh'), script + '\n');
    const r = runHook(path.join(repo, 'create.sh'), [], {
      interpreter: 'bash',
      cwd: repo,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    });
    assert.equal(r.exitCode, 0, `create loop must succeed: ${r.stderr.slice(0, 400)}`);
    const status = g(['diff', '--name-status', 'main..feature-pr']);
    assert.equal((status.match(/^D/gm) || []).length, 0, `no deletions allowed: ${status}`);
    assert.ok(status.includes('script2.sh'), 'code change must be present');
  });
});

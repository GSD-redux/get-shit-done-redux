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
const { execSync } = require('node:child_process');

const { runGsdTools, cleanup, readFileNormalized } = require('./helpers.cjs');
const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repo in a temp dir, optionally setting up a remote
 * and local branches.
 */
function createGitRepo(opts = {}) {
  const { prefix = 'gsd-1146-', defaultBranch = 'master' } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync(`git init -b ${defaultBranch}`, { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit so branches exist
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Create a .planning dir so gsd-tools resolveProjectRoot doesn't bail.
 */
function addPlanning(dir) {
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
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
    execSync(`git clone "${originDir}" "${worktreeDir}"`, { stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktreeDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktreeDir, stdio: 'pipe' });
    addPlanning(worktreeDir);

    // Verify origin/HEAD is set (it should be after clone)
    const symref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: worktreeDir, encoding: 'utf8' }).trim();
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
    execSync('git init', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: cloneDir, stdio: 'pipe' });
    execSync(`git remote add origin "${originDir}"`, { cwd: cloneDir, stdio: 'pipe' });
    execSync('git fetch origin', { cwd: cloneDir, stdio: 'pipe' });
    // Explicitly delete origin/HEAD in case git fetch auto-set it (newer git versions may do this)
    try {
      execSync('git remote set-head origin --delete', { cwd: cloneDir, stdio: 'pipe' });
    } catch (_) { /* ignore — may not exist */ }
    addPlanning(cloneDir);

    // Confirm origin/HEAD is unset
    let hasSymref = true;
    try {
      execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: cloneDir, stdio: 'pipe' });
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

  test('H. No remote, both "main" and "master" local branches exist → returns "main" (main wins tie-break)', (t) => {
    // Tier-4 tie-break: when both main and master exist locally and no remote info is available,
    // "main" wins (documented in tryLocalBranch JSDoc — modern default).
    const dir = createGitRepo({ prefix: 'gsd-1146-h-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Create a "main" branch alongside the existing "master"
    const { execSync: exec } = require('node:child_process');
    exec('git branch main', { cwd: dir, stdio: 'pipe' });
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
    // skipped naturally (readConfigBaseBranch's real-fs read misses cleanly).
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

describe('#3057 W3: readConfigBaseBranch — config present but unusable', () => {
  const PLANNING_DIR = path.join(path.sep, 'gsd-3057-w3', '.planning');

  /** Read a config whose raw text is `raw`, recording the paths requested. */
  function readWith(raw, seenPaths) {
    return gitBaseBranch.readConfigBaseBranch(PLANNING_DIR, {
      readFile: (p) => { if (seenPaths) seenPaths.push(p); return raw; },
    });
  }

  test('config.json exists but is not valid JSON → null (parse failure swallowed)', () => {
    const seen = [];
    assert.strictEqual(readWith('{ not json', seen), null);
    assert.deepStrictEqual(seen, [path.join(PLANNING_DIR, 'config.json')],
      'the resolver must look for config.json inside the planning dir it was given');
  });

  test('config.json parses to a non-object → null for null / string / number / array', () => {
    // NOTE on the `[]` case: this documents observed behaviour only. It does
    // NOT pin the `Array.isArray(cfg)` guard in readConfigBaseBranch — that
    // guard is unreachable (and therefore unkillable) through this readFile
    // entry point. `cfg` is always the result of `JSON.parse(raw)` on a
    // string, and a JSON array can never carry a `.git` or `.base_branch`
    // own-property the way a hand-built JS array could; with the guard
    // deleted entirely, `top.git`/`top.base_branch` on an array are still
    // `undefined`, so the result is `null` either way. Verified by mutation:
    // deleting `|| Array.isArray(cfg)` from the built lib does not change any
    // output for any JSON-string input. The guard is real defense-in-depth
    // for a future non-JSON-string caller, not something this suite can pin.
    assert.strictEqual(readWith('null'), null, 'JSON null must not be treated as a config');
    assert.strictEqual(readWith('"master"'), null, 'a bare JSON string must not be treated as a config');
    assert.strictEqual(readWith('42'), null, 'a bare JSON number must not be treated as a config');
    assert.strictEqual(readWith('[]'), null, 'a JSON array must not be treated as a config');
  });

  test('"git" section present but base_branch missing / non-string / blank → null', () => {
    assert.strictEqual(readWith('{"git":{}}'), null);
    assert.strictEqual(readWith('{"git":{"base_branch":42}}'), null);
    assert.strictEqual(readWith('{"git":{"base_branch":null}}'), null);
    assert.strictEqual(readWith('{"git":{"base_branch":""}}'), null);
    assert.strictEqual(readWith('{"git":{"base_branch":"   "}}'), null,
      'a whitespace-only override must not win the precedence ladder');
  });

  test('"git" key present but not a usable object (string/array/null) → nested lookup finds nothing, flat legacy key still consulted', () => {
    // NOTE on the `"git":[]` case: like the sibling note above, this does NOT
    // pin `!Array.isArray(gitSection)`. `gitSection` here is a JSON-parsed
    // array with no `.base_branch` own-property, so `gitSection.base_branch`
    // is `undefined` whether or not the guard runs — the flat key is
    // consulted either way. Verified by mutation: deleting
    // `&& !Array.isArray(gitSection)` from the built lib does not change this
    // output for any JSON-string input.
    assert.strictEqual(readWith('{"git":"main","base_branch":"release"}'), 'release');
    assert.strictEqual(readWith('{"git":[],"base_branch":"release"}'), 'release');
    assert.strictEqual(readWith('{"git":null,"base_branch":"release"}'), 'release');
  });

  test('flat base_branch present but non-string / blank → null', () => {
    assert.strictEqual(readWith('{"base_branch":true}'), null);
    assert.strictEqual(readWith('{"base_branch":["main"]}'), null);
    assert.strictEqual(readWith('{"base_branch":""}'), null);
    assert.strictEqual(readWith('{"base_branch":"   "}'), null);
  });

  test('config parses cleanly but carries neither key → null (distinct from an absent file)', () => {
    // The absent-file path returns null after reading an empty string and never
    // reaches JSON.parse. This one parses a real object and falls all the way
    // through both key lookups to the final return.
    assert.strictEqual(readWith('{"other":1}'), null);
    assert.strictEqual(readWith('{}'), null);
    assert.strictEqual(readWith(''), null, 'absent file (empty read) also yields null');
  });

  test('positive controls: values are trimmed, and the nested key outranks the flat one', () => {
    assert.strictEqual(readWith('{"git":{"base_branch":"  develop  "}}'), 'develop');
    assert.strictEqual(readWith('{"base_branch":"  release\\n"}'), 'release');
    assert.strictEqual(readWith('{"git":{"base_branch":"nested"},"base_branch":"flat"}'), 'nested');
  });
});

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
    execSync('git init --bare', { cwd: dir, stdio: 'pipe' });

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
const { execFileSync } = require('node:child_process');
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
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
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
    return execFileSync('bash', [scriptPath], {
      cwd,
      env: GIT_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
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

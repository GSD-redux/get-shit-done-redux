'use strict';

/**
 * gsd-cursor-subagent-start.js — Cursor subagentStart isolation guard (#3045)
 *
 * Seam: hooks/gsd-cursor-subagent-start.js (Cursor `subagentStart` hook,
 * spawned with a JSON payload on stdin, exactly as Cursor's hook bus invokes
 * it). This file covers the NEW isolation-enforcement behavior added
 * alongside the pre-existing #2587 workspace-reminder behavior (that
 * reminder is covered separately by tests/fix-2587-cursor-hook-workspace-roots.test.cjs
 * and is asserted here only where it interacts with the new guard).
 *
 * Cursor's `subagentStart` payload has NO per-call isolation flag (unlike
 * Claude's `Agent(isolation=...)` kwarg) — `--worktree` is a SESSION-level
 * CLI flag. This guard therefore verifies EFFECTIVE isolation state (is the
 * workspace root actually a linked git worktree / under Cursor's managed
 * worktree root) rather than checking for a flag on the call.
 *
 * Output contract differs from hooks/gsd-agent-isolation-guard.js's Claude
 * contract ({decision:'block'} + exit 2): this hook always exits 0 and
 * communicates via stdout JSON {permission, user_message} — asserted
 * precisely below because getting this wrong means the guard silently never
 * blocks.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { SENTINEL_RELATIVE_PATH, SENTINEL_STALE_MS } = require('../hooks/lib/isolation-sentinel.js');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow, toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-cursor-subagent-start.js');

/**
 * Write a #3045 dispatch-isolation sentinel under `dir` (mirrors what
 * `gsd-tools.cjs record-dispatch-isolation` writes). `writtenAt` defaults to
 * "now" (fresh); pass an explicit past timestamp to construct a stale one.
 */
function writeSentinel(dir, { isolation, harnessFlag = null, phase = null, plan = null, writtenAt = Date.now() }) {
  const p = path.join(dir, SENTINEL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ isolation, harness_flag: harnessFlag, phase, plan, written_at: writtenAt }));
}

function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_RUNTIME;
  delete env.CURSOR_CONFIG_DIR;
  Object.assign(env, extraEnv);
  // Production code resolves the home directory via `os.homedir()` (correct,
  // cross-platform), which on Windows reads `USERPROFILE`, not `HOME` —
  // `os.homedir()` never honors `HOME` there. Tests below override `HOME` to
  // redirect `os.homedir()` hermetically; mirror the override onto
  // `USERPROFILE` too so that redirection actually takes effect on Windows
  // instead of silently leaking the real CI runner's profile directory.
  if ('HOME' in extraEnv) env.USERPROFILE = extraEnv.HOME;
  return toLegacyResult(runNode([HOOK_PATH], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd: require('node:os').tmpdir(),
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
  }));
}

function subagentPayload(workspaceRoots, overrides = {}) {
  return {
    hook_event_name: 'subagentStart',
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    workspace_roots: workspaceRoots,
    subagent_id: 'sub-1',
    subagent_type: 'gsd-executor',
    task: 'do the thing',
    parent_conversation_id: 'conv-0',
    tool_call_id: 'call-1',
    subagent_model: 'auto',
    is_parallel_worker: false,
    ...overrides,
  };
}

function git(args, cwd) {
  return gitOrThrow(args, { cwd });
}

/** A real git repo with a committed .planning/config.json. */
function makeGitProject(prefix, configContent) {
  const dir = createTempDir(prefix);
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configContent);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  return dir;
}

describe('gsd-cursor-subagent-start.js: isolation guard applicability (#3045)', () => {
  let harnessProject; // real git repo, config resolves to harness-worktree (default 'cursor')
  let linkedWorktree; // real `git worktree add` of harnessProject, NOT under Cursor's managed
                       // worktree root — a hand-made worktree the user opened themselves.
                       // #3045 finding 3: this is no longer treated as isolation proof.
  let noneProject; // config.json { runtime: 'windsurf' } -> resolves to 'none'
  let orchestratorEnvProject; // exercised via GSD_RUNTIME=codex -> 'orchestrator-worktree'
  let noGsdDir; // no .planning at all
  let unreadableConfigProject; // config.json is a directory (EISDIR)

  before(() => {
    // #3045 MAJOR fix ("Cursor residual false-deny"): the fallback resolver
    // no longer defaults confidently to 'cursor' when config.json carries no
    // `runtime` key (see hooks/gsd-cursor-subagent-start.js's
    // resolveFallbackIsolation doc comment) — an explicit signal is now
    // required. This fixture intentionally declares one so the REST of this
    // describe block still exercises a properly-configured Cursor+GSD
    // project resolving harness-worktree, not the newly-inert unconfigured
    // case (covered separately below).
    harnessProject = makeGitProject('gsd-cs-harness-', JSON.stringify({ runtime: 'cursor' }));
    const linkedPath = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-cs-wt-parent-')), 'linked');
    git(['worktree', 'add', linkedPath, '-b', 'agent-gsd-cs-iso-test'], harnessProject);
    linkedWorktree = linkedPath;

    noneProject = makeGitProject('gsd-cs-none-', JSON.stringify({ runtime: 'windsurf' }));
    orchestratorEnvProject = makeGitProject('gsd-cs-orch-', JSON.stringify({}));

    noGsdDir = createTempDir('gsd-cs-nogsd-');

    unreadableConfigProject = createTempDir('gsd-cs-unreadable-');
    fs.mkdirSync(path.join(unreadableConfigProject, '.planning', 'config.json'), { recursive: true });
  });

  after(() => {
    cleanup(harnessProject);
    cleanup(path.dirname(linkedWorktree));
    cleanup(noneProject);
    cleanup(orchestratorEnvProject);
    cleanup(noGsdDir);
    cleanup(unreadableConfigProject);
  });

  test('hand-made linked git worktree (real `git worktree add`, own .planning/, NOT under managed root) + executor -> DENY (#3045 finding 3)', () => {
    // A linked git worktree is not, by itself, proof of harness isolation —
    // the user can open Cursor directly in one and edit it by hand, same as
    // any other checkout. Only Cursor's OWN managed worktree root
    // (<CURSOR_CONFIG_DIR>/worktrees) counts; this repo's own
    // .claude/worktrees/ is the exact real-world shape of this row. This is
    // a deliberate tightening from the pre-review C1 row, which incorrectly
    // treated any linked worktree as isolated — see #3045 security review
    // finding 3.
    const r = runHook(subagentPayload([linkedWorktree]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /not an isolated Cursor worktree/);
  });

  test('not isolated (main checkout, harness-worktree) + executor -> DENY', () => {
    const r = runHook(subagentPayload([harnessProject]));
    assert.equal(r.status, 0, 'this hook always exits 0 — denial is communicated via stdout JSON');
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /harness-worktree/);
    assert.match(out.user_message, /not an isolated Cursor worktree/);
    assert.match(out.user_message, /--worktree/);
  });

  test('non-executor subagent_type (Cursor built-in) -> allow, even in main checkout', () => {
    const r = runHook(subagentPayload([harnessProject], { subagent_type: 'generalPurpose' }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('resolved mode orchestrator-worktree (GSD_RUNTIME=codex) -> allow (different path)', () => {
    const r = runHook(subagentPayload([orchestratorEnvProject]), { GSD_RUNTIME: 'codex' });
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('resolved mode none (config.json runtime=windsurf) -> allow', () => {
    const r = runHook(subagentPayload([noneProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('no GSD project (.planning/config.json absent) -> allow, inert', () => {
    const r = runHook(subagentPayload([noGsdDir]));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('config unreadable (EISDIR) + confirmed executor + harness-worktree -> DENY, distinct reason', () => {
    // Config resolution (which reads .planning/config.json to look for a
    // `runtime` override) fails before isolation evidence is ever consulted,
    // so no CURSOR_CONFIG_DIR override is needed here.
    const r = runHook(subagentPayload([unreadableConfigProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /could not read or resolve/i);
    assert.match(out.user_message, /#3050/);
  });

  test('config unreadable + non-executor subagent_type -> allow (never denies a dispatch it would not enforce against)', () => {
    const r = runHook(subagentPayload([unreadableConfigProject], { subagent_type: 'shell' }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('subagent_type entirely absent, harness-worktree GSD project -> DENY (cannot determine)', () => {
    const payload = subagentPayload([harnessProject]);
    delete payload.subagent_type;
    const r = runHook(payload);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /carries no usable/i);
    assert.match(out.user_message, /#3050/);
  });

  test('subagent_type absent, not a harness-worktree project -> allow (missing field is only fatal when harness-worktree applies)', () => {
    const payload = subagentPayload([noneProject]);
    delete payload.subagent_type;
    const r = runHook(payload);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('malformed subagent_type (non-string) in a harness-worktree project -> DENY (cannot determine)', () => {
    const r = runHook(subagentPayload([harnessProject], { subagent_type: ['gsd-executor'] }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
  });

  test('workspace_roots entirely absent -> allow, must not throw', () => {
    const payload = subagentPayload([harnessProject]);
    delete payload.workspace_roots;
    const r = runHook(payload);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '', 'must not crash or log a stack trace');
  });

  test('payload is not JSON at all -> allow, must not throw', () => {
    const r = runHook('not json {{{');
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('payload is JSON null -> allow, must not throw', () => {
    const r = runHook('null');
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('workspace_roots contains only non-string junk -> allow, must not throw', () => {
    const r = runHook(subagentPayload([null, 42, {}]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });
});

describe('gsd-cursor-subagent-start.js: managed-worktree-root OR-signal (#3045)', () => {
  let cursorConfigDir;
  let managedWorktree;

  before(() => {
    cursorConfigDir = createTempDir('gsd-cs-cursorhome-');
    // Not a git repo at all — a plain directory under
    // <CURSOR_CONFIG_DIR>/worktrees, with its own harness-worktree GSD
    // project. resolveWorktreeLinkage alone would report 'not_git_repo'
    // (a confident negative); the managed-root signal must still ALLOW.
    managedWorktree = path.join(cursorConfigDir, 'worktrees', 'agent-1');
    fs.mkdirSync(path.join(managedWorktree, '.planning'), { recursive: true });
    // #3045 MAJOR fix: explicit runtime signal required for the fallback to
    // resolve harness-worktree at all — otherwise this test would trivially
    // allow for the wrong reason (no runtime signal) instead of exercising
    // the managed-root evidence path it's actually testing.
    fs.writeFileSync(path.join(managedWorktree, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
  });

  after(() => {
    cleanup(cursorConfigDir);
  });

  test('non-git directory under CURSOR_CONFIG_DIR/worktrees -> allow (isolated via managed-root signal alone, realpath-verified)', () => {
    const r = runHook(subagentPayload([managedWorktree]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });
});

describe('gsd-cursor-subagent-start.js: multi-root workspace scan (#3045 finding 1)', () => {
  let unisolatedProject; // real git repo, harness-worktree, main checkout (not isolated)
  let benignRoot; // a plain directory with no .planning/ at all
  let cursorConfigDir;
  let managedWorktree; // a real isolated root under CURSOR_CONFIG_DIR/worktrees

  before(() => {
    // #3045 MAJOR fix: explicit runtime signal required — see the note on
    // the first `harnessProject` fixture above.
    unisolatedProject = makeGitProject('gsd-cs-multiroot-primary-', JSON.stringify({ runtime: 'cursor' }));
    benignRoot = createTempDir('gsd-cs-multiroot-benign-');

    cursorConfigDir = createTempDir('gsd-cs-multiroot-cursorhome-');
    managedWorktree = path.join(cursorConfigDir, 'worktrees', 'agent-1');
    fs.mkdirSync(managedWorktree, { recursive: true });
  });

  after(() => {
    cleanup(unisolatedProject);
    cleanup(benignRoot);
    cleanup(cursorConfigDir);
  });

  test('root[0] is a benign non-GSD directory, root[1] is the unisolated primary checkout -> DENY', () => {
    // Prior to the fix, firstWorkspaceRoot() only ever looked at
    // workspace_roots[0] — a non-GSD root[0] made the guard evaluate nothing
    // and allow, even though root[1] is the exact project this guard exists
    // to protect.
    const r = runHook(subagentPayload([benignRoot, unisolatedProject]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /not an isolated Cursor worktree/);
  });

  test('root[0] is an isolated managed-root directory, root[1] is the unisolated primary checkout -> DENY', () => {
    // A multi-root workspace where the FIRST root happens to be genuinely
    // isolated must not let that root's "allow" verdict short-circuit the
    // scan — every root is independently reachable and writable by the
    // dispatched subagent.
    const r = runHook(subagentPayload([managedWorktree, unisolatedProject]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /not an isolated Cursor worktree/);
  });

  test('every root isolated or benign -> allow', () => {
    const r = runHook(subagentPayload([benignRoot, managedWorktree]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });
});

describe('gsd-cursor-subagent-start.js: realpath verification against symlink/bind-mount spoofing (#3045 finding 2)', () => {
  let cursorConfigDir;
  let primaryCheckout; // real git repo, harness-worktree, main checkout (not isolated)
  let spoofedManagedPath; // <CURSOR_CONFIG_DIR>/worktrees/<name>, a SYMLINK to primaryCheckout
  let symlinkError = null; // set when fs.symlinkSync('dir') fails (unprivileged Windows)

  before(() => {
    cursorConfigDir = createTempDir('gsd-cs-symlink-cursorhome-');
    // #3045 MAJOR fix: explicit runtime signal required — see the note on
    // the first `harnessProject` fixture above.
    primaryCheckout = makeGitProject('gsd-cs-symlink-primary-', JSON.stringify({ runtime: 'cursor' }));
    fs.mkdirSync(path.join(cursorConfigDir, 'worktrees'), { recursive: true });
    spoofedManagedPath = path.join(cursorConfigDir, 'worktrees', 'spoofed');
    // Creating a DIRECTORY symlink requires elevated privileges (or Developer
    // Mode) on Windows and throws EPERM/EACCES/ENOSYS/UNKNOWN in unprivileged
    // CI. This end-to-end test is the real-symlink pin for the #3045 finding
    // 2 security property (the in-process, no-symlink coverage of the same
    // logic lives in the "realpath seam" describe block below, via an
    // injected realpath); on a platform that cannot create the symlink, the
    // test below skips rather than silently passing or crashing the suite.
    try {
      fs.symlinkSync(primaryCheckout, spoofedManagedPath, 'dir');
    } catch (err) {
      symlinkError = err;
    }
  });

  after(() => {
    cleanup(primaryCheckout);
    cleanup(cursorConfigDir);
  });

  test('symlink under the managed root pointing OUTSIDE it (at the primary checkout) -> DENY, not isolated', (t) => {
    if (symlinkError) {
      t.skip('directory symlinks require elevated privileges on this platform');
      return;
    }
    // Lexical path.relative(managedRoot, root) would find `root` textually
    // "under" managedRoot and misclassify this as isolated. A process with
    // the user's permissions (including an agent already running in a
    // legitimately isolated worktree) can plant exactly this symlink.
    // realpath-verification must resolve the symlink to primaryCheckout,
    // see that it is OUTSIDE the realpath'd managed root, and deny.
    const r = runHook(subagentPayload([spoofedManagedPath]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /not an isolated Cursor worktree/);
  });
});

describe('gsd-cursor-subagent-start.js: realpath seam — in-process spoof coverage, no symlink required (#3045 finding 2, Windows-safe)', () => {
  // Same threat model as the symlink describe block above (a path planted at
  // <CURSOR_CONFIG_DIR>/worktrees/<name> pointing OUTSIDE the managed root,
  // at the user's primary checkout, must not be classified as isolated) but
  // exercised entirely in-process via the `realpath` dependency-injection
  // seam added to hooks/gsd-cursor-subagent-start.js's
  // resolveIsolationEvidence/evaluateRootIsolation. No fs.symlinkSync call —
  // runs identically, unprivileged, on Windows/macOS/Linux.
  //
  // `spoofedPath` is a REAL (non-symlink) directory of its own, initialized
  // as its own tiny git repo — this makes the real `git rev-parse` calls
  // resolveIsolationEvidence's diagnostic path performs succeed exactly as
  // they would against a symlink transparently resolved by the OS, so the
  // test exercises the full evidence-resolution logic, not a shortcut. The
  // injected `realpath` function is what then proves the resolver is NOT
  // fooled by this path's own on-disk identity (or by its literal string
  // being lexically nested under the managed root) and instead follows the
  // (simulated) symlink-resolved target, exactly as a real spoof would need
  // to be defeated.
  const cursorHookModule = require('../hooks/gsd-cursor-subagent-start.js');

  let cursorConfigDir;
  let managedRootPath;
  let spoofedPath;
  let savedCursorConfigDir;

  before(() => {
    cursorConfigDir = createTempDir('gsd-cs-seam-cursorhome-');
    managedRootPath = path.join(cursorConfigDir, 'worktrees');
    spoofedPath = path.join(managedRootPath, 'spoofed');
    fs.mkdirSync(spoofedPath, { recursive: true });
    git(['init'], spoofedPath);
    git(['config', 'user.email', 'test@test.com'], spoofedPath);
    git(['config', 'user.name', 'Test'], spoofedPath);
    fs.mkdirSync(path.join(spoofedPath, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(spoofedPath, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));

    // resolveIsolationEvidence/evaluateRootIsolation are called directly
    // (in-process, no spawned subprocess), so CURSOR_CONFIG_DIR must be set
    // on THIS process's env, mirroring what the e2e tests pass via spawnSync.
    savedCursorConfigDir = process.env.CURSOR_CONFIG_DIR;
    process.env.CURSOR_CONFIG_DIR = cursorConfigDir;
  });

  after(() => {
    if (savedCursorConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = savedCursorConfigDir;
    cleanup(cursorConfigDir);
  });

  function fakeRealpathTo(primaryCheckoutTarget) {
    return (p) => {
      if (p === spoofedPath) return primaryCheckoutTarget;
      if (p === managedRootPath) return managedRootPath;
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });
    };
  }

  test('resolveIsolationEvidence: injected realpath resolving the spoofed path OUTSIDE the managed root -> NOT isolated, not merely "cannot determine"', () => {
    const primaryCheckoutTarget = path.join(require('node:os').tmpdir(), 'gsd-cs-seam-primary-checkout-fake-1');
    const evidence = cursorHookModule.resolveIsolationEvidence(spoofedPath, { realpath: fakeRealpathTo(primaryCheckoutTarget) });
    assert.equal(evidence.isolated, false, 'realpath must be consulted, not the literal lexically-nested path');
    assert.equal(evidence.cannotDetermine, false, 'the spoofed path is a real (decoy) git repo — git can determine it fine');
    assert.equal(evidence.notApplicable, false);
  });

  test('evaluateRootIsolation: full pipeline denies through the injected realpath seam (no subprocess, no symlink)', () => {
    const primaryCheckoutTarget = path.join(require('node:os').tmpdir(), 'gsd-cs-seam-primary-checkout-fake-2');
    const verdict = cursorHookModule.evaluateRootIsolation(
      spoofedPath, 'gsd-executor', { realpath: fakeRealpathTo(primaryCheckoutTarget) },
    );
    assert.equal(verdict.action, 'deny');
    assert.match(verdict.reason, /not an isolated Cursor worktree/);
  });

  test('control: an honest (identity) realpath — no spoof — correctly ALLOWS, proving the deny above comes from the injected spoof mapping, not the fixture itself', () => {
    // `spoofedPath` is genuinely, physically nested under `managedRootPath`
    // on disk (it is not a symlink). With an honest identity realpath (i.e.
    // "no symlink here at all"), the resolver must correctly see it as
    // isolated and ALLOW — exactly the same as a legitimate worktree Cursor
    // itself created under its own managed root. This is the control that
    // proves the DENY in the two tests above is caused specifically by the
    // injected realpath mapping simulating a symlink pointing outside the
    // managed root, not by some incidental property of this fixture.
    const identityRealpath = (p) => p;
    const verdict = cursorHookModule.evaluateRootIsolation(spoofedPath, 'gsd-executor', { realpath: identityRealpath });
    assert.equal(verdict.action, 'allow');
  });
});

describe('gsd-cursor-subagent-start.js: nonexistent workspace root does not crash or bypass the scan (#3045)', () => {
  let unisolatedProject;
  let nonexistentRoot;

  before(() => {
    // #3045 MAJOR fix: explicit runtime signal required — see the note on
    // the first `harnessProject` fixture above.
    unisolatedProject = makeGitProject('gsd-cs-nonexistent-companion-', JSON.stringify({ runtime: 'cursor' }));
    nonexistentRoot = path.join(require('node:os').tmpdir(), 'gsd-cs-does-not-exist-', String(process.pid), 'nope');
  });

  after(() => {
    cleanup(unisolatedProject);
  });

  test('single nonexistent workspace root, executor, no other root -> allow (no GSD project confirmable there; the project-existence gate — not the realpath isolation check — is what makes this allow, and is intentionally NOT a fail-closed trigger, mirroring the existing "no workspace root at all" branch)', () => {
    const r = runHook(subagentPayload([nonexistentRoot]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '', 'must not crash or log a stack trace on an unresolvable root');
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('nonexistent root paired with a real unisolated harness-worktree project root -> DENY (the bogus root must not short-circuit the scan into allowing)', () => {
    const r = runHook(subagentPayload([nonexistentRoot, unisolatedProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '', 'must not crash or log a stack trace on an unresolvable root');
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.match(out.user_message, /not an isolated Cursor worktree/);
  });
});

describe('gsd-cursor-subagent-start.js: output contract precision (#3045)', () => {
  let harnessProject;

  before(() => {
    // See the #3045 MAJOR fix note in the first `harnessProject` fixture
    // above — an explicit runtime signal is required for the fallback to
    // resolve harness-worktree.
    harnessProject = makeGitProject('gsd-cs-contract-', JSON.stringify({ runtime: 'cursor' }));
  });

  after(() => {
    cleanup(harnessProject);
  });

  test('deny sets permission="deny" (not "ask" — Cursor treats "ask" as deny for this event, but this hook must emit the explicit value) and a non-empty user_message', () => {
    const r = runHook(subagentPayload([harnessProject]));
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.notEqual(out.permission, 'ask');
    assert.equal(typeof out.user_message, 'string');
    assert.ok(out.user_message.length > 0);
  });

  test('this hook always exits 0 — Cursor reads the decision from stdout JSON, not the exit code', () => {
    const r = runHook(subagentPayload([harnessProject]));
    assert.equal(r.status, 0);
  });
});

// ─── Generative Fix Divergence guard (CLAUDE.md) ─────────────────────────────
// EXECUTOR_SUBAGENT_TYPES is duplicated between hooks/gsd-agent-isolation-guard.js
// (Claude) and hooks/gsd-cursor-subagent-start.js (Cursor) — the same "which
// subagent_type strings identify GSD's executor" constant, defined
// independently in two parallel-surface hooks. Per CLAUDE.md's
// "Generative Fix Divergence" rule, a shared-concept constant like this needs
// a parity assertion that fails if the two definitions drift (e.g. a future
// sibling executor role added to one hook and not the other). This is a
// BEHAVIORAL parity check — it runs both real hooks and compares their
// block/deny decisions for the same subagent_type — deliberately not a
// source-text comparison (local/no-source-grep) and deliberately not a
// require()-based constant import (both hook files are top-level scripts
// with unconditional stdin listeners; requiring them as modules would run
// that side-effecting code).
describe('executor-identity parity: hooks/gsd-agent-isolation-guard.js (Claude) vs hooks/gsd-cursor-subagent-start.js (Cursor) (#3045)', () => {
  const CLAUDE_HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-agent-isolation-guard.js');
  let claudeProject; // harness-worktree GSD project, no isolation param on the call
  let cursorProject; // harness-worktree GSD project, not an isolated worktree

  before(() => {
    claudeProject = createTempDir('gsd-cs-parity-claude-');
    fs.mkdirSync(path.join(claudeProject, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(claudeProject, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));

    // Must be a REAL git repo (not a bare mkdir'd directory): the Cursor hook's
    // #3045 MAJOR 3 "not a git repo -> INERT" branch would otherwise short-circuit
    // every probe type to allow before EXECUTOR_SUBAGENT_TYPES membership is ever
    // consulted, masking exactly the drift this parity check exists to catch.
    // #3045 MAJOR fix: explicit runtime signal required for the fallback to
    // resolve harness-worktree — mirrors claudeProject's explicit
    // `runtime: 'claude'` above, so this parity check compares two ACTUALLY
    // enforcing configurations, not Claude-enforcing vs. Cursor-inert.
    cursorProject = makeGitProject('gsd-cs-parity-cursor-', JSON.stringify({ runtime: 'cursor' }));
  });

  after(() => {
    cleanup(claudeProject);
    cleanup(cursorProject);
  });

  const PROBE_TYPES = ['gsd-executor', 'gsd-code-reviewer', 'gsd-planner', 'generalPurpose', 'explore', 'shell', 'GSD-EXECUTOR'];

  for (const subagentType of PROBE_TYPES) {
    test(`subagent_type="${subagentType}": Claude block-decision and Cursor deny-decision agree`, () => {
      const claudeEnv = { ...process.env };
      delete claudeEnv.GSD_RUNTIME;
      const claudeResult = runNode([CLAUDE_HOOK_PATH], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: subagentType },
        }),
        cwd: claudeProject,
        env: claudeEnv,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const claudeBlocked = claudeResult.exitCode === 2;

      const cursorResult = runHook(subagentPayload([cursorProject], { subagent_type: subagentType }));
      const cursorOut = JSON.parse(cursorResult.stdout);
      const cursorBlocked = cursorOut.permission === 'deny';

      assert.equal(
        cursorBlocked, claudeBlocked,
        `Cursor and Claude isolation guards disagree on whether subagent_type="${subagentType}" is ` +
        `a GSD executor (Claude blocked=${claudeBlocked}, Cursor blocked=${cursorBlocked}). ` +
        `EXECUTOR_SUBAGENT_TYPES has drifted between hooks/gsd-agent-isolation-guard.js and ` +
        `hooks/gsd-cursor-subagent-start.js.`
      );
    });
  }
});

describe('gsd-cursor-subagent-start.js: #3045 MAJOR 3 — non-git GSD project is INERT, not a confident negative', () => {
  let nonGitProject; // .planning/config.json present, but NOT a git repo at all, NOT under managed root

  before(() => {
    nonGitProject = createTempDir('gsd-cs-notgitrepo-');
    fs.mkdirSync(path.join(nonGitProject, '.planning'), { recursive: true });
    // #3045 MAJOR fix: explicit runtime signal, so this test exercises the
    // not_git_repo -> INERT code path specifically, not the unrelated "no
    // runtime signal" trivial allow (both now happen to allow, but this
    // fixture's whole point is proving the FORMER).
    fs.writeFileSync(path.join(nonGitProject, '.planning', 'config.json'), JSON.stringify({ runtime: 'cursor' }));
  });

  after(() => {
    cleanup(nonGitProject);
  });

  test('resolveWorktreeLinkage reports not_git_repo -> allow (was DENY before the #3045 MAJOR 3 fix: unactionable "start --worktree" advice for a directory with no git repo to isolate)', () => {
    const r = runHook(subagentPayload([nonGitProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined, `expected allow (inert), got: ${r.stdout}`);
  });
});

describe('gsd-cursor-subagent-start.js: #3045 MINOR — relative workspace_roots entry does not fail open', () => {
  test('a relative-path workspace_roots entry is filtered out, not resolved against the hook cwd', () => {
    // Before the fix, a relative entry joined against process.cwd() (Cursor's
    // config dir, ~/.cursor for a real invocation) — almost certainly NOT a
    // GSD project — which read as "not a GSD project" and allowed. The fix
    // filters relative entries out of getWorkspaceRoots() instead, for the
    // honest reason (never a resolvable workspace root), but the OBSERVABLE
    // outcome for this single-relative-root case is still allow either way,
    // so this test's actual load-bearing assertion is that it does not
    // throw / does not crash on a relative entry, cross-checked against an
    // absolute sibling proving the scan itself still works.
    const r = runHook(subagentPayload(['relative/workspace/root']));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '', 'must not crash on a relative workspace root');
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('relative root paired with a real unisolated absolute harness-worktree root still DENIES (relative entry is dropped, not silently trusted)', () => {
    // #3045 MAJOR fix: explicit runtime signal required — see the note on
    // the first `harnessProject` fixture above.
    const unisolatedProject = makeGitProject('gsd-cs-relmix-', JSON.stringify({ runtime: 'cursor' }));
    try {
      const r = runHook(subagentPayload(['relative/workspace/root', unisolatedProject]));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, 'deny');
    } finally {
      cleanup(unisolatedProject);
    }
  });
});

describe('gsd-cursor-subagent-start.js: #3045 BLOCKER regression — sentinel is authoritative over registry capability', () => {
  // Mirrors tests/gsd-agent-isolation-guard.test.cjs's Claude-side pinning
  // for the same defect: the guard used to key enforcement on the REGISTRY's
  // dispatch.isolation (a host CAPABILITY), not the workflow's resolved
  // per-dispatch ISOLATION. `harnessProject` resolves to harness-worktree via
  // the registry (default 'cursor' runtime), so a FAIL here proves the
  // sentinel is actually consulted.
  let harnessProject;
  let useWorktreesFalseProject;

  before(() => {
    // See the #3045 MAJOR fix note in the first `harnessProject` fixture
    // above — an explicit runtime signal is required for the fallback to
    // resolve harness-worktree (both fixtures need it: `useWorktreesFalseProject`
    // must actually reach the `workflow.use_worktrees:false` branch, not
    // short-circuit to 'none' for the unrelated "no runtime signal" reason).
    harnessProject = makeGitProject('gsd-cs-sentinel-', JSON.stringify({ runtime: 'cursor' }));
    useWorktreesFalseProject = makeGitProject('gsd-cs-uwf-', JSON.stringify({ runtime: 'cursor', workflow: { use_worktrees: false } }));
  });

  after(() => {
    cleanup(harnessProject);
    cleanup(useWorktreesFalseProject);
  });

  test('sentinel says isolation=none -> ALLOW even in the (unisolated) primary checkout (the BLOCKER)', () => {
    writeSentinel(harnessProject, { isolation: 'none' });
    try {
      const r = runHook(subagentPayload([harnessProject]));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, undefined, `expected allow, got: ${r.stdout}`);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel says isolation=orchestrator-worktree -> ALLOW', () => {
    writeSentinel(harnessProject, { isolation: 'orchestrator-worktree' });
    try {
      const r = runHook(subagentPayload([harnessProject]));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, undefined);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('STALE sentinel (older than SENTINEL_STALE_MS) is ignored -> falls back to registry (DENY, harness-worktree still applies)', () => {
    writeSentinel(harnessProject, { isolation: 'none', writtenAt: Date.now() - (SENTINEL_STALE_MS + 60000) });
    try {
      const r = runHook(subagentPayload([harnessProject]));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, 'deny', `expected deny (stale sentinel ignored), got: ${r.stdout}`);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('MALFORMED sentinel (invalid JSON) is treated as stale, never fatal -> falls back to registry (DENY)', () => {
    const sentinelPath = path.join(harnessProject, SENTINEL_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, '{ not valid json');
    try {
      const r = runHook(subagentPayload([harnessProject]));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, 'deny');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('no sentinel + workflow.use_worktrees=false -> ALLOW (project-level opt-out, case (a) from the BLOCKER)', () => {
    const r = runHook(subagentPayload([useWorktreesFalseProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });

  test('no sentinel + workflow.use_worktrees absent + registry harness-worktree -> DENY (conservative fallback still enforces)', () => {
    const r = runHook(subagentPayload([harnessProject]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
  });
});

describe('gsd-cursor-subagent-start.js: #3045 MAJOR "Cursor residual false-deny" — align with Claude hook semantics', () => {
  let unconfiguredProject; // .planning/config.json = {}, no GSD_RUNTIME, no defaults.json signal

  before(() => {
    unconfiguredProject = makeGitProject('gsd-cs-unconfigured-', JSON.stringify({}));
  });

  after(() => {
    cleanup(unconfiguredProject);
  });

  test('no sentinel + no runtime signal anywhere -> ALLOW (was a confident "cursor" default -> DENY pre-fix)', () => {
    // Before this fix, this exact shape (a GSD project scaffolded from
    // gsd-core/templates/config.json, which ships with no `runtime` key, with
    // no fresh sentinel — outside execute-phase, after .gsd cleanup, or past
    // the sentinel's staleness window) always resolved 'cursor' purely
    // because this script only runs as Cursor's own hook, then hard-DENIED
    // because the main checkout is not (yet) an isolated Cursor worktree —
    // a false-deny of an otherwise legitimate dispatch. HOME is pinned to the
    // project dir itself (which has no .gsd/defaults.json) for hermeticity.
    const r = runHook(subagentPayload([unconfiguredProject]), { HOME: unconfiguredProject });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined, `expected allow (inert), got: ${r.stdout}`);
  });

  test('~/.gsd/defaults.json runtime (installer-persisted, #2395) makes a REAL Cursor+GSD install still enforce', () => {
    const home = createTempDir('gsd-cs-defaults-home-');
    try {
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: 'cursor' }));

      const r = runHook(subagentPayload([unconfiguredProject]), { HOME: home });
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.permission, 'deny', `defaults.json runtime must be enforced, got: ${r.stdout}`);
    } finally {
      cleanup(home);
    }
  });
});

describe('gsd-cursor-subagent-start.js: #3045 SECURITY F2 — sentinel bound to phase/plan, mismatch is "no applicable sentinel"', () => {
  let harnessProject;

  before(() => {
    harnessProject = makeGitProject('gsd-cs-f2-', JSON.stringify({ runtime: 'cursor' }));
  });

  after(() => {
    cleanup(harnessProject);
  });

  test('a fresh "none" sentinel for a DIFFERENT phase than this dispatch (task text) is not applied -> falls through and DENIES', () => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '1', plan: 'plan-a' });
    try {
      const r = runHook(subagentPayload([harnessProject], { task: 'Execute plan plan-b of phase 2' }));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).permission, 'deny', 'mismatched sentinel must not silently allow');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('a fresh sentinel for the SAME phase/plan as this dispatch (task text) is applied normally (positive control)', () => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '2', plan: 'plan-b' });
    try {
      const r = runHook(subagentPayload([harnessProject], { task: 'Execute plan plan-b of phase 2' }));
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).permission, undefined);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });
});

describe('gsd-cursor-subagent-start.js: #3045 MAJOR — clock seam boundary coverage (in-process, no subprocess wall-clock race)', () => {
  const cursorHookModule = require('../hooks/gsd-cursor-subagent-start.js');

  let harnessProject;
  let savedGsdRuntime;

  before(() => {
    harnessProject = makeGitProject('gsd-cs-clock-', JSON.stringify({ runtime: 'cursor' }));
    savedGsdRuntime = process.env.GSD_RUNTIME;
    delete process.env.GSD_RUNTIME;
  });

  after(() => {
    cleanup(harnessProject);
    if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = savedGsdRuntime;
  });

  function fixedClock(nowMs) {
    return { now: () => nowMs };
  }

  test('sentinel exactly at SENTINEL_STALE_MS - 1 is still FRESH (trusted)', () => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    try {
      const verdict = cursorHookModule.evaluateRootIsolation(
        harnessProject, 'gsd-executor', { clock: fixedClock(writtenAt + SENTINEL_STALE_MS - 1) },
      );
      assert.equal(verdict.action, 'allow', 'still within the trust window — must use the fresh "none" sentinel');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel exactly AT SENTINEL_STALE_MS is STALE (falls back to registry, which DENIES for this unisolated checkout)', () => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    try {
      const verdict = cursorHookModule.evaluateRootIsolation(
        harnessProject, 'gsd-executor', { clock: fixedClock(writtenAt + SENTINEL_STALE_MS) },
      );
      assert.equal(verdict.action, 'deny');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel at SENTINEL_STALE_MS + 1 is STALE', () => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    try {
      const verdict = cursorHookModule.evaluateRootIsolation(
        harnessProject, 'gsd-executor', { clock: fixedClock(writtenAt + SENTINEL_STALE_MS + 1) },
      );
      assert.equal(verdict.action, 'deny');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });
});

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
const { execFileSync, spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-cursor-subagent-start.js');

function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_RUNTIME;
  delete env.CURSOR_CONFIG_DIR;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: require('node:os').tmpdir(),
    env,
  });
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
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
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
  let linkedWorktree; // real `git worktree add` of harnessProject — the isolated case
  let noneProject; // config.json { runtime: 'windsurf' } -> resolves to 'none'
  let orchestratorEnvProject; // exercised via GSD_RUNTIME=codex -> 'orchestrator-worktree'
  let noGsdDir; // no .planning at all
  let unreadableConfigProject; // config.json is a directory (EISDIR)

  before(() => {
    harnessProject = makeGitProject('gsd-cs-harness-', JSON.stringify({}));
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

  test('isolated (real linked git worktree, still has its own .planning/) + executor -> allow', () => {
    const r = runHook(subagentPayload([linkedWorktree]));
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined, 'must not set permission on allow');
    assert.equal(out.additional_context !== undefined, true, 'reminder behavior must still fire on allow');
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
    fs.writeFileSync(path.join(managedWorktree, '.planning', 'config.json'), JSON.stringify({}));
  });

  after(() => {
    cleanup(cursorConfigDir);
  });

  test('non-git directory under CURSOR_CONFIG_DIR/worktrees -> allow (isolated via managed-root signal alone)', () => {
    const r = runHook(subagentPayload([managedWorktree]), { CURSOR_CONFIG_DIR: cursorConfigDir });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, undefined);
  });
});

describe('gsd-cursor-subagent-start.js: output contract precision (#3045)', () => {
  let harnessProject;

  before(() => {
    harnessProject = makeGitProject('gsd-cs-contract-', JSON.stringify({}));
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

    cursorProject = createTempDir('gsd-cs-parity-cursor-');
    fs.mkdirSync(path.join(cursorProject, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cursorProject, '.planning', 'config.json'), JSON.stringify({}));
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
      const claudeResult = spawnSync(process.execPath, [CLAUDE_HOOK_PATH], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: { subagent_type: subagentType },
        }),
        encoding: 'utf8',
        cwd: claudeProject,
        env: claudeEnv,
      });
      const claudeBlocked = claudeResult.status === 2;

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

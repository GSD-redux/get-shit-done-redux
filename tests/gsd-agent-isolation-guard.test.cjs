'use strict';

/**
 * gsd-agent-isolation-guard.js — Agent-dispatch isolation guard (#3045)
 *
 * Seam: hooks/gsd-agent-isolation-guard.js (PreToolUse hook, spawned with a
 * JSON payload on stdin, exactly as every runtime bus invokes it).
 *
 * Defect: `gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`
 * resolves dispatch isolation correctly, then relies on PROSE ("substitute
 * $HARNESS_FLAG's value... on Claude Code it is literally isolation=\"worktree\"")
 * to get it into the model-authored `Agent()` call. Nothing verified the
 * substitution happened, so an executor could silently dispatch into the
 * user's primary checkout. This hook enforces the invariant structurally.
 *
 * Matrix source: .gsd/bug/fix-3045-agent-dispatch-isolation-guard/50-test-matrix.md
 * Part 1, rows 1-12. Every row below is annotated with its row number.
 *
 * Two implementation notes that diverge from a literal reading of the design
 * (both intentional, both explained where they're tested):
 *
 *  - Rows 8 and 12 ("config unreadable" / "config read times out") collapse
 *    to the SAME code path in the real implementation: resolveIsolationState
 *    resolves entirely via synchronous, in-process fs reads and require()
 *    calls — no subprocess is spawned (the guard prefers reading config
 *    directly, per the design's own preference), so there is no literal
 *    wall-clock timeout to simulate. Both rows are exercised here via two
 *    DIFFERENT real, deterministic, cross-platform-safe failure conditions
 *    that both land in the guard's single "cannot verify" catch: row 8 uses
 *    `.planning/config.json` being a DIRECTORY (fs.readFileSync → EISDIR),
 *    row 12 uses a syntactically invalid config.json (JSON.parse throws).
 *    Neither is a chmod/permission trick (CLAUDE.md's cross-platform IO
 *    injection rule) — both are real, deterministic file-type/content
 *    conditions that behave identically on macOS/Linux/Windows.
 *
 *  - Runtime selection for rows 6/7 (orchestrator-worktree / none) uses the
 *    real capability-registry.cjs shipped alongside the hook, selected via
 *    GSD_RUNTIME (the same precedence resolveIsolationState implements):
 *    codex → orchestrator-worktree, windsurf → none. No fixture/mock
 *    registry is substituted — this is the real hook reading its real
 *    sibling data file, per the "drive the real hook entry point" mandate.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-agent-isolation-guard.js');

/**
 * Run the hook with a given payload against a given cwd.
 * GSD_RUNTIME is deleted by default so ambient environment can never leak a
 * runtime override into a test that expects the config.json `runtime` key
 * (or the 'claude' default) to be used instead.
 */
function runHook(payload, cwd, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_RUNTIME;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env,
  });
}

function agentPayload(overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'gsd-executor', ...(overrides.tool_input || {}) },
    ...overrides,
  };
}

function mkProject(prefix) {
  const dir = createTempDir(prefix);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function writeConfig(dir, content) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), content);
}

describe('gsd-agent-isolation-guard.js: applicability matrix (#3045)', () => {
  let harnessProject; // GSD project resolving to harness-worktree (claude)
  let orchestratorProject; // resolves to orchestrator-worktree (codex)
  let noneProject; // resolves to none (windsurf)
  let noGsdProject; // not a GSD project at all
  let unreadableConfigProject; // config.json is a directory (EISDIR)
  let corruptConfigProject; // config.json is invalid JSON

  before(() => {
    harnessProject = mkProject('gsd-aig-harness-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));

    orchestratorProject = mkProject('gsd-aig-orch-');
    writeConfig(orchestratorProject, JSON.stringify({}));

    noneProject = mkProject('gsd-aig-none-');
    writeConfig(noneProject, JSON.stringify({}));

    noGsdProject = createTempDir('gsd-aig-nogsd-');

    unreadableConfigProject = mkProject('gsd-aig-unreadable-');
    // #3050 lesson: force a genuine, cross-platform-safe read failure by
    // making the config path a DIRECTORY instead of a file — fs.readFileSync
    // throws EISDIR deterministically on macOS/Linux/Windows. NOT a
    // chmod/permission trick (CLAUDE.md's IO-failure-injection rule).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing a single fixture FILE (not a temp dir teardown) to replace it with a directory; helpers.cleanup() tears down whole temp dirs and isn't the right tool here
    fs.rmSync(path.join(unreadableConfigProject, '.planning', 'config.json'), { force: true });
    fs.mkdirSync(path.join(unreadableConfigProject, '.planning', 'config.json'));

    corruptConfigProject = mkProject('gsd-aig-corrupt-');
    writeConfig(corruptConfigProject, '{ this is not valid json');
  });

  after(() => {
    cleanup(harnessProject);
    cleanup(orchestratorProject);
    cleanup(noneProject);
    cleanup(noGsdProject);
    cleanup(unreadableConfigProject);
    cleanup(corruptConfigProject);
  });

  test('row 1: absent isolation param, harness-worktree, GSD project -> DENY', () => {
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /harness-worktree/);
    assert.match(out.reason, /isolation="worktree"/);
    assert.equal(r.stderr, out.reason, 'stderr must carry the same reason (Kimi reads stderr on exit 2)');
  });

  test('row 2: isolation="worktree" present -> allow', () => {
    const r = runHook(agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: 'worktree' } }), harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('row 3: isolation="" (empty) -> DENY', () => {
    const r = runHook(agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: '' } }), harnessProject);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('row 4: isolation="none" -> DENY', () => {
    const r = runHook(agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: 'none' } }), harnessProject);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('row 5: subagent_type=gsd-code-reviewer (not an executor) -> allow', () => {
    const r = runHook(agentPayload({ tool_input: { subagent_type: 'gsd-code-reviewer' } }), harnessProject);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('row 6: resolved mode orchestrator-worktree -> allow (different path)', () => {
    const r = runHook(agentPayload(), orchestratorProject, { GSD_RUNTIME: 'codex' });
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('row 7: resolved mode none -> allow', () => {
    const r = runHook(agentPayload(), noneProject, { GSD_RUNTIME: 'windsurf' });
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('row 8: config unreadable (EISDIR) + GSD project present -> DENY, distinct reason', () => {
    const r = runHook(agentPayload(), unreadableConfigProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /could not read or resolve/i);
    assert.match(out.reason, /#3050/);
  });

  test('row 9: no GSD project (.planning/config.json absent) -> allow, inert', () => {
    const r = runHook(agentPayload(), noGsdProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
  });

  test('row 10: wrong tool (Bash) -> allow', () => {
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }, harnessProject);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('row 11a: subagent_type absent -> allow, must not throw', () => {
    const r = runHook(agentPayload({ tool_input: {} }), harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '', 'must not crash or log a stack trace');
  });

  test('row 11b: subagent_type malformed (non-string, e.g. array) -> allow, must not throw', () => {
    const r = runHook(agentPayload({ tool_input: { subagent_type: ['gsd-executor'] } }), harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stderr, '');
  });

  test('row 11c: tool_input entirely absent -> allow, must not throw', () => {
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }, harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('row 11d: payload is not JSON at all -> allow, must not throw', () => {
    const r = runHook('not json {{{', harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('row 11e: payload is JSON null -> allow, must not throw', () => {
    const r = runHook('null', harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('row 12: config read fails via corrupt JSON (stands in for "times out" — see file header) -> DENY', () => {
    const r = runHook(agentPayload(), corruptConfigProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /could not read or resolve/i);
  });

  test('reason names the exact parameter to add (self-correction requirement)', () => {
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.match(out.reason, /Add isolation="worktree" to the Agent\(\) call/);
  });
});

describe('gsd-agent-isolation-guard.js: property — deny iff isolation param != "worktree" (harness-worktree project)', () => {
  let harnessProject;

  before(() => {
    harnessProject = mkProject('gsd-aig-prop-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));
  });

  after(() => {
    cleanup(harnessProject);
  });

  test('for any string value, dispatch is blocked unless the value is exactly "worktree"', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (isolationValue) => {
          const r = runHook(
            agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: isolationValue } }),
            harnessProject
          );
          const expectBlocked = isolationValue !== 'worktree';
          const actualBlocked = r.status === 2;
          assert.equal(
            actualBlocked, expectBlocked,
            `isolation=${JSON.stringify(isolationValue)} expected ${expectBlocked ? 'blocked' : 'allowed'}, got status ${r.status}, stdout: ${r.stdout}`
          );
        }
      ),
      { numRuns: 30 } // each sample spawns the hook process — bound the cost
    );
  });
});

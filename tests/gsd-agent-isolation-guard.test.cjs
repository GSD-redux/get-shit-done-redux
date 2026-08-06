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
const { SENTINEL_RELATIVE_PATH, SENTINEL_STALE_MS } = require('../hooks/lib/isolation-sentinel.js');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-agent-isolation-guard.js');

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
  // Production code resolves the home directory via `os.homedir()` (correct,
  // cross-platform), which on Windows reads `USERPROFILE`, not `HOME` —
  // `os.homedir()` never honors `HOME` there. Tests below override `HOME` to
  // redirect `os.homedir()` hermetically; mirror the override onto
  // `USERPROFILE` too so that redirection actually takes effect on Windows
  // instead of silently leaking the real CI runner's profile directory.
  if ('HOME' in extraEnv) env.USERPROFILE = extraEnv.HOME;
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

describe('gsd-agent-isolation-guard.js: #3045 BLOCKER regression — sentinel is authoritative over registry capability', () => {
  // These rows pin the exact defect the isolated code review flagged as a
  // BLOCKER: the guard used to key enforcement on the REGISTRY's
  // dispatch.isolation (a host CAPABILITY — "this host CAN isolate"), not
  // the workflow's resolved per-dispatch ISOLATION ("this dispatch SHOULD be
  // isolated"). Sequential ISOLATION=none legitimately happens even on a
  // harness-worktree-capable host. Every row below uses `harnessProject`
  // (registry resolves to harness-worktree for runtime 'claude') so a FAIL
  // here proves the sentinel is actually consulted, not merely coincidental
  // with what the registry alone would already allow.
  let harnessProject;
  let useWorktreesFalseProject;

  before(() => {
    harnessProject = mkProject('gsd-aig-sentinel-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));

    useWorktreesFalseProject = mkProject('gsd-aig-uwf-');
    writeConfig(useWorktreesFalseProject, JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: false } }));
  });

  after(() => {
    cleanup(harnessProject);
    cleanup(useWorktreesFalseProject);
  });

  test('sentinel says isolation=none -> ALLOW even though registry resolves harness-worktree (the BLOCKER)', () => {
    writeSentinel(harnessProject, { isolation: 'none' });
    try {
      const r = runHook(agentPayload(), harnessProject); // no isolation param on the dispatch
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(r.stdout, '');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel says isolation=orchestrator-worktree -> ALLOW', () => {
    writeSentinel(harnessProject, { isolation: 'orchestrator-worktree' });
    try {
      const r = runHook(agentPayload(), harnessProject);
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(r.stdout, '');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel says isolation=harness-worktree + dispatch missing the flag -> DENY', () => {
    writeSentinel(harnessProject, { isolation: 'harness-worktree', harnessFlag: 'isolation="worktree"' });
    try {
      const r = runHook(agentPayload(), harnessProject);
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel says isolation=harness-worktree + dispatch carries the flag -> ALLOW', () => {
    writeSentinel(harnessProject, { isolation: 'harness-worktree', harnessFlag: 'isolation="worktree"' });
    try {
      const r = runHook(
        agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: 'worktree' } }),
        harnessProject
      );
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('STALE sentinel (older than SENTINEL_STALE_MS) is ignored -> falls back to registry (DENY, harness-worktree still applies)', () => {
    // The stale sentinel LIES (says none) — proving the fallback re-derives
    // from the registry instead of trusting it is exactly the point.
    writeSentinel(harnessProject, { isolation: 'none', writtenAt: Date.now() - (SENTINEL_STALE_MS + 60000) });
    try {
      const r = runHook(agentPayload(), harnessProject);
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('MALFORMED sentinel (invalid JSON) is treated as stale, never fatal -> falls back to registry (DENY)', () => {
    const sentinelPath = path.join(harnessProject, SENTINEL_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, '{ this is not valid json');
    try {
      const r = runHook(agentPayload(), harnessProject);
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
      assert.equal(r.stderr.length > 0, true, 'must not crash — a clean block reason, not a stack trace');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('no sentinel + workflow.use_worktrees=false -> ALLOW (project-level opt-out, case (a) from the BLOCKER)', () => {
    const r = runHook(agentPayload(), useWorktreesFalseProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  test('no sentinel + workflow.use_worktrees absent + registry harness-worktree -> DENY (conservative fallback still enforces)', () => {
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('tool_name="Task" behaves identically to "Agent" (#3045 MAJOR 1)', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'gsd-executor' } },
      harnessProject
    );
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('tool_name="Task" with isolation="worktree" present -> allow, same as "Agent"', () => {
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'gsd-executor', isolation: 'worktree' } },
      harnessProject
    );
    assert.equal(r.status, 0, `stdout: ${r.stdout}`);
  });
});

describe('gsd-agent-isolation-guard.js: #3045 MAJOR 2 — undeterminable runtime does not demand the Claude kwarg', () => {
  let unconfiguredProject;

  before(() => {
    unconfiguredProject = mkProject('gsd-aig-unconfigured-');
    // No `runtime` key at all — mirrors gsd-core/templates/config.json,
    // which ships every new project's scaffold WITHOUT one. GSD_RUNTIME is
    // deleted by runHook(), so this project has NO explicit runtime signal.
    writeConfig(unconfiguredProject, JSON.stringify({}));
  });

  after(() => {
    cleanup(unconfiguredProject);
  });

  test('no GSD_RUNTIME override, no config.json runtime key, no ~/.gsd/defaults.json runtime -> ALLOW (cannot-determine degrades to inert, not a guessed "claude" demand)', () => {
    // #3045 BLOCKER 2 fix: resolveRuntimeIdentity now ALSO reads
    // ~/.gsd/defaults.json as a confidence signal. That makes this test's
    // outcome environment-dependent unless HOME is pinned to a directory with
    // no defaults.json (the project fixture dir itself has none) — otherwise
    // a developer machine that ever installed GSD for a non-Claude runtime
    // would have ~/.gsd/defaults.json's real `runtime` leak in here and
    // silently flip this test's expectation depending on who runs it.
    const r = runHook(agentPayload(), unconfiguredProject, { HOME: unconfiguredProject });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
  });
});

describe('gsd-agent-isolation-guard.js: #3045 BLOCKER 2 — default-install fail-open (isolated two-review finding)', () => {
  let harnessProject; // registry resolves harness-worktree (claude), no defaults.json runtime
  let unconfiguredHarnessProject; // same, but with NO explicit runtime signal at all

  before(() => {
    harnessProject = mkProject('gsd-aig-b2-harness-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));

    unconfiguredHarnessProject = mkProject('gsd-aig-b2-unconfigured-');
    // Mirrors gsd-core/templates/config.json exactly: no `runtime` key.
    writeConfig(unconfiguredHarnessProject, JSON.stringify({}));
  });

  after(() => {
    cleanup(harnessProject);
    cleanup(unconfiguredHarnessProject);
  });

  test('part A: fresh sentinel confirms harness-worktree but carries NO harness_flag, and the runtime is not confidently resolvable -> DENY (was ALLOW pre-fix)', () => {
    // This is the exact BLOCKER 2 regression: previously this branch fell
    // through to the "not confident -> none" degrade and ALLOWED the
    // dispatch to run unisolated, on the DEFAULT-INSTALL path (no `runtime`
    // key in config.json — gsd-core/templates/config.json's shipped shape —
    // and no ~/.gsd/defaults.json runtime either).
    writeSentinel(unconfiguredHarnessProject, { isolation: 'harness-worktree', harnessFlag: null });
    try {
      const r = runHook(agentPayload(), unconfiguredHarnessProject, { HOME: unconfiguredHarnessProject });
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — must DENY, not silently allow`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.match(out.reason, /cannot verify|harness_flag/i);
    } finally {
      cleanup(path.join(unconfiguredHarnessProject, '.gsd'));
    }
  });

  test('part B: ~/.gsd/defaults.json runtime (installer-persisted, #2395) is now a confident signal — makes the default install enforce', () => {
    // No sentinel at all here — pure conservative-fallback path. Before this
    // fix, an unconfigured project (no config.json runtime key, the COMMON
    // scaffold shape) always fell back to 'none'/allow regardless of what the
    // machine actually has installed. After the fix, a `runtime` persisted to
    // ~/.gsd/defaults.json (which bin/install.js's writeNonClaudeDefaults
    // already writes for every non-Claude install) is read as confidently as
    // GSD_RUNTIME or config.json's own key.
    const home = mkProject('gsd-aig-b2-home-');
    try {
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: 'claude' }));

      const r = runHook(agentPayload(), unconfiguredHarnessProject, { HOME: home });
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — defaults.json runtime must be enforced`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(home);
    }
  });

  test('part B (negative control): a project WITH its own config.json runtime key still wins over defaults.json', () => {
    const home = mkProject('gsd-aig-b2-home2-');
    try {
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      // defaults.json says a runtime with NO harness-worktree capability;
      // config.json's own `runtime: claude` must take precedence.
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: 'windsurf' }));

      const r = runHook(agentPayload(), harnessProject, { HOME: home });
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(home);
    }
  });
});

describe('gsd-agent-isolation-guard.js: #3045 SECURITY F2 — sentinel bound to phase/plan, mismatch is "no applicable sentinel"', () => {
  let harnessProject;

  before(() => {
    harnessProject = mkProject('gsd-aig-f2-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));
  });

  after(() => {
    cleanup(harnessProject);
  });

  test('a fresh "none" sentinel for a DIFFERENT phase than this dispatch is not applied — falls through to conservative fallback and DENIES', () => {
    // Sentinel legitimately recorded 'none' for phase 1 (e.g. a submodule
    // degrade). This dispatch's own description names phase 2 — the guard
    // must not reuse phase 1's stale-but-fresh "none" to authorize it.
    writeSentinel(harnessProject, { isolation: 'none', phase: '1', plan: 'plan-a' });
    try {
      const r = runHook(
        agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan plan-b of phase 2' } }),
        harnessProject,
      );
      assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — mismatched sentinel must not silently allow`);
      assert.equal(JSON.parse(r.stdout).decision, 'block');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('a fresh sentinel for the SAME phase/plan as this dispatch is applied normally (positive control)', () => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '2', plan: 'plan-b' });
    try {
      const r = runHook(
        agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan plan-b of phase 2' } }),
        harnessProject,
      );
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('a dispatch whose description does not match the expected shape does not itself trigger a mismatch (best-effort extraction)', () => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '2', plan: 'plan-b' });
    try {
      const r = runHook(
        agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'some other free-form text' } }),
        harnessProject,
      );
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });
});

describe('gsd-agent-isolation-guard.js: #3045 MAJOR — clock seam boundary coverage (in-process, no subprocess wall-clock race)', () => {
  const guardModule = require('../hooks/gsd-agent-isolation-guard.js');

  let harnessProject;
  let savedGsdRuntime;

  before(() => {
    harnessProject = mkProject('gsd-aig-clock-');
    writeConfig(harnessProject, JSON.stringify({ runtime: 'claude' }));
    // These tests call resolveIsolationState() directly, in-process (not via
    // runHook's subprocess, which already strips GSD_RUNTIME) — guard against
    // ambient env leakage from the CURRENT test process (repo hermeticity
    // rule: an ambient GSD_ env var must never redirect a test's outcome).
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
      const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS - 1) });
      assert.equal(state.isolation, 'none', 'still within the trust window — must use the sentinel, not the registry fallback');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel exactly AT SENTINEL_STALE_MS is STALE (age > threshold is the only fresh condition)', () => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    try {
      const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS) });
      // Registry fallback for this project resolves harness-worktree (claude,
      // no workflow.use_worktrees:false) — proves the sentinel's 'none' was
      // NOT trusted at exactly the boundary.
      assert.equal(state.isolation, 'harness-worktree');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });

  test('sentinel at SENTINEL_STALE_MS + 1 is STALE', () => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    try {
      const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS + 1) });
      assert.equal(state.isolation, 'harness-worktree');
    } finally {
      cleanup(path.join(harnessProject, '.gsd'));
    }
  });
});

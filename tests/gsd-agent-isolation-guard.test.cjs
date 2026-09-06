// docs-guard-exempt: docs/adr/1239-...md is cited only in a comment as rationale; never read.
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
const os = require('node:os');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { toLegacyResult, gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, createTempProject, createTempGitProject, runGsdTools, cleanup } = require('./helpers.cjs');
const { SENTINEL_RELATIVE_PATH, SENTINEL_STALE_MS, readSentinel } = require('../hooks/lib/isolation-sentinel.js');
const { REASON_CODE } = require('../hooks/lib/isolation-deny-reason.js');
const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

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
  const r = runHookSeam(HOOK_PATH, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return toLegacyResult(r);
}

/**
 * #3045 follow-up (folded from tests/fix-3045-dispatch-isolation-resolver.test.cjs,
 * #3333 wave 1): sentinel-file path/read helpers for the WRITE-side coverage
 * below, which drives the real `gsd-tools.cjs query dispatch-isolation` CLI
 * (routeDispatchIsolation) rather than the guard hook.
 */
function sentinelFile(dir) {
  return path.join(dir, SENTINEL_RELATIVE_PATH);
}

function readSentinelRaw(dir) {
  return JSON.parse(fs.readFileSync(sentinelFile(dir), 'utf-8'));
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

  test('sentinel says isolation=none -> ALLOW even though registry resolves harness-worktree (the BLOCKER)', (t) => {
    writeSentinel(harnessProject, { isolation: 'none' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(agentPayload(), harnessProject); // no isolation param on the dispatch
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  test('sentinel says isolation=orchestrator-worktree -> ALLOW', (t) => {
    writeSentinel(harnessProject, { isolation: 'orchestrator-worktree' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
  });

  test('sentinel says isolation=harness-worktree + dispatch missing the flag -> DENY', (t) => {
    writeSentinel(harnessProject, { isolation: 'harness-worktree', harnessFlag: 'isolation="worktree"' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('sentinel says isolation=harness-worktree + dispatch carries the flag -> ALLOW', (t) => {
    writeSentinel(harnessProject, { isolation: 'harness-worktree', harnessFlag: 'isolation="worktree"' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(
      agentPayload({ tool_input: { subagent_type: 'gsd-executor', isolation: 'worktree' } }),
      harnessProject
    );
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('STALE sentinel (older than SENTINEL_STALE_MS) is ignored -> falls back to registry (DENY, harness-worktree still applies)', (t) => {
    // The stale sentinel LIES (says none) — proving the fallback re-derives
    // from the registry instead of trusting it is exactly the point.
    writeSentinel(harnessProject, { isolation: 'none', writtenAt: Date.now() - (SENTINEL_STALE_MS + 60000) });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('MALFORMED sentinel (invalid JSON) is treated as stale, never fatal -> falls back to registry (DENY)', (t) => {
    const sentinelPath = path.join(harnessProject, SENTINEL_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, '{ this is not valid json');
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(agentPayload(), harnessProject);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
    assert.equal(r.stderr.length > 0, true, 'must not crash — a clean block reason, not a stack trace');
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

  test('part A: fresh sentinel confirms harness-worktree but carries NO harness_flag, and the runtime is not confidently resolvable -> DENY (was ALLOW pre-fix)', (t) => {
    // This is the exact BLOCKER 2 regression: previously this branch fell
    // through to the "not confident -> none" degrade and ALLOWED the
    // dispatch to run unisolated, on the DEFAULT-INSTALL path (no `runtime`
    // key in config.json — gsd-core/templates/config.json's shipped shape —
    // and no ~/.gsd/defaults.json runtime either).
    writeSentinel(unconfiguredHarnessProject, { isolation: 'harness-worktree', harnessFlag: null });
    t.after(() => cleanup(path.join(unconfiguredHarnessProject, '.gsd')));
    const r = runHook(agentPayload(), unconfiguredHarnessProject, { HOME: unconfiguredHarnessProject });
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — must DENY, not silently allow`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /cannot verify|harness_flag/i);
  });

  test('part B: ~/.gsd/defaults.json runtime (installer-persisted, #2395) is now a confident signal — makes the default install enforce', (t) => {
    // No sentinel at all here — pure conservative-fallback path. Before this
    // fix, an unconfigured project (no config.json runtime key, the COMMON
    // scaffold shape) always fell back to 'none'/allow regardless of what the
    // machine actually has installed. After the fix, a `runtime` persisted to
    // ~/.gsd/defaults.json (which bin/install.js's writeNonClaudeDefaults
    // already writes for every non-Claude install) is read as confidently as
    // GSD_RUNTIME or config.json's own key.
    const home = mkProject('gsd-aig-b2-home-');
    t.after(() => cleanup(home));
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: 'claude' }));

    const r = runHook(agentPayload(), unconfiguredHarnessProject, { HOME: home });
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — defaults.json runtime must be enforced`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('part B (negative control): a project WITH its own config.json runtime key still wins over defaults.json', (t) => {
    const home = mkProject('gsd-aig-b2-home2-');
    t.after(() => cleanup(home));
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    // defaults.json says a runtime with NO harness-worktree capability;
    // config.json's own `runtime: claude` must take precedence.
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: 'windsurf' }));

    const r = runHook(agentPayload(), harnessProject, { HOME: home });
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
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

  test('a fresh "none" sentinel for a DIFFERENT phase than this dispatch is not applied — falls through to conservative fallback and DENIES', (t) => {
    // Sentinel legitimately recorded 'none' for phase 1 (e.g. a submodule
    // degrade). This dispatch's own description names phase 2 — the guard
    // must not reuse phase 1's stale-but-fresh "none" to authorize it.
    writeSentinel(harnessProject, { isolation: 'none', phase: '1', plan: 'plan-a' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(
      agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan plan-b of phase 2' } }),
      harnessProject,
    );
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr} — mismatched sentinel must not silently allow`);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  });

  test('a fresh sentinel for the SAME phase/plan as this dispatch is applied normally (positive control)', (t) => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '2', plan: 'plan-b' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(
      agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan plan-b of phase 2' } }),
      harnessProject,
    );
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });

  test('a dispatch whose description does not match the expected shape does not itself trigger a mismatch (best-effort extraction)', (t) => {
    writeSentinel(harnessProject, { isolation: 'none', phase: '2', plan: 'plan-b' });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const r = runHook(
      agentPayload({ tool_input: { subagent_type: 'gsd-executor', description: 'some other free-form text' } }),
      harnessProject,
    );
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
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

  test('sentinel exactly at SENTINEL_STALE_MS - 1 is still FRESH (trusted)', (t) => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS - 1) });
    assert.equal(state.isolation, 'none', 'still within the trust window — must use the sentinel, not the registry fallback');
  });

  test('sentinel exactly AT SENTINEL_STALE_MS is STALE (age > threshold is the only fresh condition)', (t) => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS) });
    // Registry fallback for this project resolves harness-worktree (claude,
    // no workflow.use_worktrees:false) — proves the sentinel's 'none' was
    // NOT trusted at exactly the boundary.
    assert.equal(state.isolation, 'harness-worktree');
  });

  test('sentinel at SENTINEL_STALE_MS + 1 is STALE', (t) => {
    const writtenAt = 1_000_000;
    writeSentinel(harnessProject, { isolation: 'none', writtenAt });
    t.after(() => cleanup(path.join(harnessProject, '.gsd')));
    const state = guardModule.resolveIsolationState(harnessProject, { clock: fixedClock(writtenAt + SENTINEL_STALE_MS + 1) });
    assert.equal(state.isolation, 'harness-worktree');
  });
});

describe('gsd-agent-isolation-guard.js: #3566 — per-install .gsd-runtime marker rung (in-process)', () => {
  // Precedence under the fix: GSD_RUNTIME > config.json `runtime` > the per-install
  // marker at <install>/gsd-core/.gsd-runtime > ~/.gsd/defaults.json `runtime`.
  //
  // The marker is __dirname-relative in production (hooks/ sits beside gsd-core/ in
  // every install tree — the same sibling assumption the hook's own
  // require('../gsd-core/bin/lib/…') already makes), so a spawned hook in this dev
  // tree (which has no marker) can never exercise the rung. These tests require the
  // module in-process and drive the marker through the same
  // _setInstallRuntimeMarkerForTests seam src/model-resolver.cts established for
  // #2297 — null simulates a dev tree / pre-#2297 install with no marker file.
  const guardModule = require('../hooks/gsd-agent-isolation-guard.js');
  const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');

  // Distinct canonical runtimes so the precedence oracle is unambiguous.
  const IDENTITY_POOL = ['claude', 'codex', 'windsurf', 'opencode'];

  let savedHome;
  let savedUserProfile;
  let savedGsdRuntime;
  let markerProject; // scaffold-shaped config ({}), per #2840's no-runtime-key template

  // Per-test world: install marker (seam), HOME containing an optional defaults.json,
  // GSD_RUNTIME. resolveRuntimeIdentity resolves the defaults rung through
  // os.homedir() at call time, so redirecting HOME — mirrored onto USERPROFILE for
  // Windows, exactly as runHook documents above — pins it hermetically.
  function setWorld(t, { marker = null, defaultsRuntime = null, envRuntime = undefined }) {
    guardModule._setInstallRuntimeMarkerForTests(marker);
    const home = mkProject('gsd-aig-3566-home-');
    if (defaultsRuntime !== null) {
      fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ runtime: defaultsRuntime }));
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    if (envRuntime === undefined) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = envRuntime;
    t.after(() => {
      cleanup(home);
      guardModule._setInstallRuntimeMarkerForTests(null);
    });
  }

  function identity(proj = markerProject) {
    const configPath = path.join(proj, '.planning', 'config.json');
    return guardModule.resolveRuntimeIdentity(proj, configPath, resolveRuntimeNameFromCandidates);
  }

  before(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedGsdRuntime = process.env.GSD_RUNTIME;
    markerProject = mkProject('gsd-aig-3566-');
    // Mirrors gsd-core/templates/config.json exactly: no `runtime` key — the COMMON
    // scaffold shape since #2840 stopped copying runtime into project configs.
    writeConfig(markerProject, JSON.stringify({}));
  });

  after(() => {
    cleanup(markerProject);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedGsdRuntime === undefined) delete process.env.GSD_RUNTIME;
    else process.env.GSD_RUNTIME = savedGsdRuntime;
    guardModule._setInstallRuntimeMarkerForTests(null);
  });

  test('#3566: per-install marker outranks host-wide defaults — two-runtime machine enforces instead of going inert', (t) => {
    // The exact issue scenario: a Codex install ran last (defaults.json says codex),
    // the Claude install's own marker says claude, the project scaffolded without a
    // runtime key, GSD_RUNTIME unset. Pre-fix the guard resolved codex confidently
    // and silently went inert; post-fix it resolves claude and DEMANDS the flag.
    setWorld(t, { marker: 'claude', defaultsRuntime: 'codex' });
    const decision = guardModule.evaluateDispatch(
      { tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor' }, cwd: markerProject },
    );
    assert.equal(decision.action, 'block', 'must resolve claude → harness-worktree and demand the isolation param');
    // (The block REASON's "names the exact parameter to add" property is already
    // pinned by the pre-existing #3045 row 'reason names the exact parameter to
    // add' — no new raw-text matching here, per CONTRIBUTING's test-output rule.)
  });

  test('#3566: marker rung returns confident claude above codex defaults (identity contract)', (t) => {
    setWorld(t, { marker: 'claude', defaultsRuntime: 'codex' });
    assert.deepEqual(identity(), { runtimeId: 'claude', confident: true });
  });

  test('#3566: explicit config.json runtime still outranks the install marker', (t) => {
    const proj = mkProject('gsd-aig-3566-cfg-');
    writeConfig(proj, JSON.stringify({ runtime: 'codex' }));
    t.after(() => cleanup(proj));
    setWorld(t, { marker: 'claude' });
    assert.deepEqual(identity(proj), { runtimeId: 'codex', confident: true });
    const decision = guardModule.evaluateDispatch(
      { tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor' }, cwd: proj },
    );
    assert.equal(decision.action, 'allow', 'codex dispatch isolation is not harness-worktree — the explicit config override is respected');
  });

  test('#3566: GSD_RUNTIME env still outranks the install marker', (t) => {
    setWorld(t, { marker: 'claude', envRuntime: 'windsurf' });
    assert.deepEqual(identity(), { runtimeId: 'windsurf', confident: true });
  });

  test('#3566: empty marker is no signal — falls through to the defaults rung', (t) => {
    setWorld(t, { marker: '', defaultsRuntime: 'claude' });
    assert.deepEqual(identity(), { runtimeId: 'claude', confident: true });
  });

  test('#3566: whitespace-only marker is no signal', (t) => {
    setWorld(t, { marker: '   ', defaultsRuntime: 'claude' });
    assert.deepEqual(identity(), { runtimeId: 'claude', confident: true });
  });

  test('#3566: marker value canonicalized through runtime-name-policy', (t) => {
    setWorld(t, { marker: 'claude-code' });
    assert.deepEqual(identity(), { runtimeId: 'claude', confident: true });
  });

  test('#3566: unknown marker value degrades to inert via registry miss, mirroring every other rung', (t) => {
    setWorld(t, { marker: 'not-a-runtime' });
    assert.deepEqual(identity(), { runtimeId: 'not-a-runtime', confident: true }, 'future-runtime tolerance passthrough');
    const configPath = path.join(markerProject, '.planning', 'config.json');
    assert.deepEqual(
      guardModule.resolveRegistryIsolation(markerProject, configPath),
      { isolation: 'none', harnessFlag: null },
      'the SPECIFIC degraded verdict — not merely survival',
    );
    const decision = guardModule.evaluateDispatch(
      { tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor' }, cwd: markerProject },
    );
    assert.equal(decision.action, 'allow');
  });

  test('#3566: absent marker preserves the #3045 defaults.json confidence rung', (t) => {
    setWorld(t, { marker: null, defaultsRuntime: 'claude' });
    assert.deepEqual(identity(), { runtimeId: 'claude', confident: true });
    const decision = guardModule.evaluateDispatch(
      { tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor' }, cwd: markerProject },
    );
    assert.equal(decision.action, 'block', 'single-runtime default install still enforces (#3045 BLOCKER 2 part B)');
  });

  test('#3566: no-signal case still degrades to inert, never a guessed runtime', (t) => {
    setWorld(t, { marker: null });
    assert.deepEqual(identity(), { runtimeId: null, confident: false });
    const decision = guardModule.evaluateDispatch(
      { tool_name: 'Agent', tool_input: { subagent_type: 'gsd-executor' }, cwd: markerProject },
    );
    assert.equal(decision.action, 'allow');
  });

  test('#3566 property: precedence chain is a total order over arbitrary signal subsets', (t) => {
    const proj = mkProject('gsd-aig-3566-prop-');
    const home = mkProject('gsd-aig-3566-prophome-');
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    const defaultsPath = path.join(home, '.gsd', 'defaults.json');
    const configPath = path.join(proj, '.planning', 'config.json');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    t.after(() => {
      cleanup(proj);
      cleanup(home);
      guardModule._setInstallRuntimeMarkerForTests(null);
    });

    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom(...IDENTITY_POOL), { minLength: 4, maxLength: 4 }),
      fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
      (perm, actives) => {
        // perm (a uniqueArray over the exact 4-runtime pool) assigns DISTINCT
        // canonical runtimes to the four rungs; actives[i] selects whether rung i
        // carries a value at all. Distinctness makes the oracle unambiguous: the
        // winner is the first ACTIVE rung in precedence order env > config >
        // marker > defaults.
        const [envV, cfgV, mkV, defV] = perm;
        const [envOn, cfgOn, mkOn, defOn] = actives;
        if (envOn) process.env.GSD_RUNTIME = envV;
        else delete process.env.GSD_RUNTIME;
        writeConfig(proj, cfgOn ? JSON.stringify({ runtime: cfgV }) : JSON.stringify({}));
        guardModule._setInstallRuntimeMarkerForTests(mkOn ? mkV : null);
        if (defOn) fs.writeFileSync(defaultsPath, JSON.stringify({ runtime: defV }));
        else fs.writeFileSync(defaultsPath, JSON.stringify({})); // no `runtime` key = no signal from the rung

        const expected = envOn ? envV : cfgOn ? cfgV : mkOn ? mkV : defOn ? defV : null;
        const id = guardModule.resolveRuntimeIdentity(proj, configPath, resolveRuntimeNameFromCandidates);
        if (expected === null) {
          assert.equal(id.runtimeId, null);
          assert.equal(id.confident, false);
        } else {
          assert.deepEqual(id, { runtimeId: expected, confident: true });
        }
      },
    ));
  });
});

// Folded from tests/fix-3045-dispatch-isolation-resolver.test.cjs (#3333 wave
// 1, test-only consolidation — no behavior change). These describe blocks
// cover the sentinel WRITE side: `gsd-tools.cjs query dispatch-isolation`
// (routeDispatchIsolation) persists the resolved isolation decision as an
// unconditional side effect of resolving it, and `record-dispatch-isolation`
// (routeRecordDispatchIsolation) is the explicit fallback/testable primitive
// sharing the same atomic-write implementation. Every test here drives the
// REAL gsd-tools.cjs CLI (via runGsdTools) and asserts on the sentinel file
// it actually wrote, parsed as JSON.
describe('#3045 CORE REDESIGN — dispatch-isolation records as an unconditional side effect', () => {
  test('a plain --raw query with no explicit isolation-record verb still writes the sentinel', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    assert.equal(fs.existsSync(sentinelFile(dir)), false, 'precondition: no sentinel yet');
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '7'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree');

    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'harness-worktree');
    assert.equal(sentinel.harness_flag, 'isolation="worktree"');
    assert.equal(sentinel.phase, '7');
    assert.equal(sentinel.plan, null);
    assert.equal(typeof sentinel.written_at, 'number');
  });

  test('--json output and the recorded sentinel agree on isolation + harnessFlag', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--json', '--phase', '3', '--plan', 'plan-b'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, parsed.isolation);
    assert.equal(sentinel.harness_flag, parsed.harnessFlag);
    assert.equal(sentinel.phase, '3');
    assert.equal(sentinel.plan, 'plan-b');
  });

  test('--force-isolation none overrides a naturally-resolved harness-worktree host and clears harnessFlag', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '4', '--force-isolation', 'none'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    // routeDispatchIsolation's own stdout still reflects the FORCED value.
    assert.equal(result.output.trim(), 'none');

    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none');
    assert.equal(sentinel.harness_flag, null);
  });

  test('an invalid --force-isolation value is ignored, not applied', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--force-isolation', 'bogus-mode'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree');
    assert.equal(readSentinelRaw(dir).isolation, 'harness-worktree');
  });

  test('#3045 BLOCKER 1 — a later, plan-scoped call overwrites an earlier phase-only sentinel atomically', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    // Phase-level resolve (as the "Resolve ISOLATION" step performs it).
    runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '9'], dir, { GSD_RUNTIME: 'claude', HOME: dir });
    assert.equal(readSentinelRaw(dir).plan, null);

    // Per-plan gate degrades THIS plan to sequential (submodule intersection).
    const r = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '9', '--plan', 'plan-sub', '--force-isolation', 'none'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(r.success, true, r.error);

    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none', 'the plan-scoped degrade must win over the stale phase-level record');
    assert.equal(sentinel.plan, 'plan-sub');
    assert.equal(sentinel.phase, '9');
  });

  test('the sentinel round-trips through the real reader (hooks/lib/isolation-sentinel.js)', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '2', '--plan', 'p1'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    const read = readSentinel(dir);
    assert.equal(read.present, true);
    assert.equal(read.stale, false);
    assert.equal(read.malformed, false);
    assert.equal(read.isolation, 'harness-worktree');
    assert.equal(read.harnessFlag, 'isolation="worktree"');
    assert.equal(read.phase, '2');
    assert.equal(read.plan, 'p1');
  });

  // #3737 — the project-level opt-out (workflow.use_worktrees === false) is
  // decided by the workflow shell AFTER the resolve, so pre-fix any plain
  // re-query re-persisted the naturally-resolved host capability over the
  // mandated `--force-isolation none` record, and the guard then denied the
  // sequential dispatch the config explicitly asked for.
  function writeUseWorktrees(dir, value) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: value } }),
    );
  }

  test('#3737: use_worktrees=false — a plain re-query records none and does not clobber the forced record', (t) => {
    const dir = createTempProject('gsd-3737-optout-');
    t.after(() => cleanup(dir));
    writeUseWorktrees(dir, false);

    const forced = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--force-isolation', 'none'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(forced.success, true, forced.error);
    assert.equal(forced.output.trim(), 'none');

    // The workflow's own re-record step, then the plain re-query that pre-fix
    // flipped the sentinel back to harness-worktree (#3737 reproduction).
    const requery = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(requery.success, true, requery.error);
    assert.equal(requery.output.trim(), 'none', '#3737: the opt-out must win on every host');
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none', '#3737: a plain re-query must not re-persist the host capability over the opt-out');
    assert.equal(sentinel.harness_flag, null);
  });

  test('#3737: use_worktrees=false resolves and records none on the first plain query (--json agrees)', (t) => {
    const dir = createTempProject('gsd-3737-optout-');
    t.after(() => cleanup(dir));
    writeUseWorktrees(dir, false);

    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--json'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.isolation, 'none');
    assert.equal(parsed.harnessFlag, null);
    assert.equal(parsed.exec, null);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none');
    assert.equal(sentinel.harness_flag, null);
  });

  test('#3737: use_worktrees=true keeps the natural harness-worktree record', (t) => {
    const dir = createTempProject('gsd-3737-optout-');
    t.after(() => cleanup(dir));
    writeUseWorktrees(dir, true);

    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree');
    assert.equal(readSentinelRaw(dir).isolation, 'harness-worktree');
  });

  test('#3737: a non-boolean "false" string is not an opt-out (strict === false)', (t) => {
    const dir = createTempProject('gsd-3737-optout-');
    t.after(() => cleanup(dir));
    writeUseWorktrees(dir, 'false');

    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree', 'a string "false" must degrade to the default (worktrees on), never coerce');
    assert.equal(readSentinelRaw(dir).isolation, 'harness-worktree');
  });

  // #3963 — the opt-out read must see the value config-get sees. Under
  // GSD_WORKSTREAM, config-get merges the ROOT config into the workstream
  // config (#2714 inheritance); the resolver's raw single-file read saw only
  // the workstream file, so a root-level use_worktrees=false was invisible
  // and the #3737 clobber resurfaced on every workstream-scoped run.
  test('#3963: root use_worktrees=false is inherited under GSD_WORKSTREAM', (t) => {
    const dir = createTempProject('gsd-3963-ws-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: false } }),
    );
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
    );

    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir, GSD_WORKSTREAM: 'alpha' },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'none',
      '#3963: the root opt-out must be inherited under a workstream, matching config-get');
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none');
    assert.equal(sentinel.harness_flag, null);
  });

  test('#3963: the workstream\'s own key wins over the root\'s', (t) => {
    const dir = createTempProject('gsd-3963-ws2-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: false } }),
    );
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'),
      JSON.stringify({ workflow: { use_worktrees: true } }),
    );

    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir, GSD_WORKSTREAM: 'alpha' },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree',
      '#3963: inheritance, not root-override — the workstream\'s own true must win');
  });

  test('#3963 parity: dispatch-isolation agrees with config-get on the same fixtures', () => {
    // Generative-fix-divergence guard (#3963 review): the resolver's raw read
    // and config-get's merged read must answer identically on shared shapes.
    const cases = [
      { root: { workflow: { use_worktrees: false } }, ws: { model_profile: 'balanced' } },
      { root: { workflow: { use_worktrees: false } }, ws: { workflow: { use_worktrees: true } } },
      { root: { runtime: 'claude' }, ws: { workflow: { use_worktrees: false } } },
      { root: { runtime: 'claude' }, ws: { runtime: 'claude' } },
    ];
    for (const { root, ws } of cases) {
      const dir = createTempProject('gsd-3963-parity-');
      try {
        fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(root));
        fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'), JSON.stringify(ws));
        const env = { GSD_RUNTIME: 'claude', HOME: dir, GSD_WORKSTREAM: 'alpha' };
        // --default true mirrors the schema default so the key-absent shape
        // answers "true" (not opted out) instead of erroring — the same
        // effective value the resolver's degrade-to-false produces.
        const cfg = runGsdTools(['query', 'config-get', 'workflow.use_worktrees', '--raw', '--default', 'true'], dir, env);
        const iso = runGsdTools(['query', 'dispatch-isolation', '--raw'], dir, env);
        assert.equal(cfg.success, true, cfg.error);
        assert.equal(iso.success, true, iso.error);
        const optedOut = cfg.output.trim() === 'false';
        assert.equal(iso.output.trim(), optedOut ? 'none' : 'harness-worktree',
          `#3963 parity: config-get says use_worktrees=${cfg.output.trim()} but dispatch-isolation says ${iso.output.trim()}`);
      } finally {
        cleanup(dir);
      }
    }
  });

  test('#3963: no root inheritance under GSD_PROJECT alone (documented contract)', (t) => {
    const dir = createTempProject('gsd-3963-proj-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'second-product'), { recursive: true });
    // Root opted out; the scoped project config omits the key. Under
    // GSD_PROJECT alone, config-get does NOT inherit root — and neither may
    // this resolver (the ws-env gate is the boundary).
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { use_worktrees: false } }));
    fs.writeFileSync(path.join(dir, '.planning', 'second-product', 'config.json'), JSON.stringify({ runtime: 'claude' }));

    const cfg = runGsdTools(['query', 'config-get', 'workflow.use_worktrees', '--raw', '--default', 'true'], dir,
      { GSD_RUNTIME: 'claude', HOME: dir, GSD_PROJECT: 'second-product' });
    const iso = runGsdTools(['query', 'dispatch-isolation', '--raw'], dir,
      { GSD_RUNTIME: 'claude', HOME: dir, GSD_PROJECT: 'second-product' });
    assert.equal(cfg.output.trim() === 'false', false,
      'fixture self-check: config-get must NOT see the root opt-out under GSD_PROJECT alone');
    assert.equal(iso.output.trim(), 'harness-worktree',
      '#3963: no root inheritance without the workstream env — parity with config-get');
  });

  test('#3963: malformed workstream config falls back to the root under the gate', (t) => {
    const dir = createTempProject('gsd-3963-malformed-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { use_worktrees: false } }));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'), '{ not valid json');

    const iso = runGsdTools(['query', 'dispatch-isolation', '--raw'], dir,
      { GSD_RUNTIME: 'claude', HOME: dir, GSD_WORKSTREAM: 'alpha' });
    assert.equal(iso.success, true, iso.error);
    assert.equal(iso.output.trim(), 'none',
      '#3963: an unreadable workstream config must degrade to the root view, matching loadConfigResolved branch B');
  });

  test('#3737: end-to-end — an opted-out project records none and the guard ALLOWS the sequential dispatch', (t) => {
    const dir = createTempProject('gsd-3737-optout-');
    t.after(() => cleanup(dir));
    writeUseWorktrees(dir, false);

    // The workflow's resolve step: a plain query (no force) records the
    // opt-out decision — the record the issue says must survive re-queries.
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'none');

    // The guard fires on the sequential inline Agent() dispatch (no
    // isolation kwarg) and must NOT deny it (#3737's user-visible symptom).
    const r = runHook(agentPayload(), dir);
    assert.equal(r.status, 0, `guard denied a sequential dispatch under the opt-out sentinel: stdout=${r.stdout} stderr=${r.stderr}`);
  });
});

describe('#4222 — the #683 base-check degrade is re-derived by the resolver, so a plain re-query cannot clobber it', () => {
  // #4222 — the #683 worktree base-check auto-degrade (HEAD diverged from the
  // fork base the harness forks worktrees from, origin/HEAD) was decided ONLY
  // in workflow shell, after the resolve, and recorded via
  // `--force-isolation none`. Unlike the #3737 opt-out, the resolver did not
  // re-derive it, so any plain re-query — the orchestrator's own `--json`
  // harnessFlag read, a subagent's gsd_run traffic — re-persisted
  // `harness-worktree` over the record and the guard then denied the
  // sequential dispatch the degrade had mandated.
  //
  // Real git, real `origin`: a bare repo stands in for the remote so
  // origin/HEAD resolves the same way the harness's fork base does. No
  // network, no mocked execGit — the resolver must reach the same evaluation
  // the `worktree base-check` subcommand runs.
  function git(args, cwd) {
    return gitOrThrow(args, { cwd });
  }

  function writeClaudeConfig(dir) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'claude', workflow: { use_worktrees: true } }),
    );
  }

  /** A git project whose HEAD is pushed to a local bare `origin`, with origin/HEAD set. */
  function projectWithOrigin(t, prefix) {
    const dir = createTempGitProject(prefix);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}origin-`));
    t.after(() => {
      cleanup(dir);
      cleanup(bare);
    });
    git(['init', '--bare'], bare);
    git(['remote', 'add', 'origin', bare], dir);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
    git(['push', '-u', 'origin', branch], dir);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`], dir);
    writeClaudeConfig(dir);
    return { dir, branch };
  }

  /** Advance local HEAD one commit past origin/HEAD — the #683 divergence. */
  function diverge(dir) {
    fs.appendFileSync(path.join(dir, 'README.md'), 'local divergence\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'local commit not on origin'], dir);
    assert.notEqual(
      git(['rev-parse', 'HEAD'], dir).trim(),
      git(['rev-parse', 'origin/HEAD'], dir).trim(),
      'precondition: HEAD must differ from origin/HEAD',
    );
  }

  const env = (dir) => ({ GSD_RUNTIME: 'claude', HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') });

  test('#4222: HEAD == origin/HEAD — a fresh run records the natural harness-worktree capability (nothing is sticky)', (t) => {
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');

    const result = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree');
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'harness-worktree', 'a non-diverged repo must keep the natural capability');
    assert.equal(sentinel.harness_flag, 'isolation="worktree"');
    assert.equal(sentinel.phase, '1');
  });

  test('#4222: HEAD diverged — a plain re-query records none and does not clobber the forced record', (t) => {
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);

    // The workflow's own re-record step after its shell base-check.
    const forced = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '1', '--force-isolation', 'none'],
      dir,
      env(dir),
    );
    assert.equal(forced.success, true, forced.error);
    assert.equal(forced.output.trim(), 'none');
    assert.equal(readSentinelRaw(dir).isolation, 'none');

    // The plain re-query that pre-fix flipped the sentinel back to
    // harness-worktree (#4222 reproduction — the `--json` harnessFlag read).
    const requery = runGsdTools(['query', 'dispatch-isolation', '--json', '--phase', '1'], dir, env(dir));
    assert.equal(requery.success, true, requery.error);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none', '#4222: a plain re-query must not re-persist the host capability over the base-check degrade');
    assert.equal(sentinel.harness_flag, null);
    assert.equal(sentinel.phase, '1');
  });

  test('#4222: HEAD diverged — stdout still reports the host capability (the shell fail-closed guard depends on it)', (t) => {
    // The degrade is applied to the RECORDED decision only. Every dispatch
    // site treats an unguarded `none` on stdout as "this runtime declares no
    // executor-isolation primitive" and exits 1, so the resolver's stdout
    // contract must not change — the shell still runs its own base-check
    // and prints the divergence message from it.
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);

    const raw = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
    assert.equal(raw.success, true, raw.error);
    assert.equal(raw.output.trim(), 'harness-worktree', 'stdout is the capability, not the recorded decision');

    const json = runGsdTools(['query', 'dispatch-isolation', '--json', '--phase', '1'], dir, env(dir));
    assert.equal(json.success, true, json.error);
    const parsed = JSON.parse(json.output);
    assert.equal(parsed.isolation, 'harness-worktree');
    assert.equal(parsed.harnessFlag, 'isolation="worktree"');

    // ...while the sentinel — the guard's input — carries the degrade from
    // the very first plain query, with no prior `--force-isolation` record.
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none');
    assert.equal(sentinel.harness_flag, null);
  });

  test('#4222: HEAD diverged — the degrade wins over --force-isolation harness-worktree (mirrors #3737)', (t) => {
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);

    const forced = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '1', '--force-isolation', 'harness-worktree'],
      dir,
      env(dir),
    );
    assert.equal(forced.success, true, forced.error);
    assert.equal(forced.output.trim(), 'harness-worktree', 'stdout honours the force');
    assert.equal(readSentinelRaw(dir).isolation, 'none', 'the harness would still fork from the diverged base — the record must say none');
  });

  test('#4222: not sticky — once origin/HEAD catches up to HEAD, a plain re-query records harness-worktree again', (t) => {
    const { dir, branch } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);

    const first = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
    assert.equal(first.success, true, first.error);
    assert.equal(readSentinelRaw(dir).isolation, 'none', 'precondition: the diverged run recorded none');

    // Push local HEAD to origin so origin/HEAD == HEAD again.
    git(['push', 'origin', branch], dir);
    assert.equal(git(['rev-parse', 'HEAD'], dir).trim(), git(['rev-parse', 'origin/HEAD'], dir).trim());

    const second = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
    assert.equal(second.success, true, second.error);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'harness-worktree', 'the evaluation reads live git state — a prior none must not persist');
    assert.equal(sentinel.harness_flag, 'isolation="worktree"');
  });

  test('#4222: the resolved mode is threaded into the evaluation — orchestrator-worktree honours worktree.baseRef:"head" (#3659)', (t) => {
    // In orchestrator-worktree mode GSD itself creates the worktree from the
    // orchestrator HEAD, so baseRef "head" legitimately suppresses the
    // divergence check; in harness-worktree mode it never did (#48). The
    // resolver must pass the mode it resolved, not default to harness.
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ worktree: { baseRef: 'head' } }),
    );

    const codex = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '1'],
      dir,
      { ...env(dir), GSD_RUNTIME: 'codex' },
    );
    assert.equal(codex.success, true, codex.error);
    assert.equal(codex.output.trim(), 'orchestrator-worktree', 'precondition: codex resolves to orchestrator-worktree');
    assert.equal(readSentinelRaw(dir).isolation, 'orchestrator-worktree', 'baseRef "head" suppresses the check where GSD creates the worktree');

    const claude = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
    assert.equal(claude.success, true, claude.error);
    assert.equal(readSentinelRaw(dir).isolation, 'none', 'the harness ignores baseRef "head", so the same repo degrades under harness-worktree');
  });

  test('#4222: end-to-end — after a plain re-query on a diverged repo the guard ALLOWS the sequential dispatch', (t) => {
    const { dir } = projectWithOrigin(t, 'gsd-4222-basecheck-');
    diverge(dir);

    // The workflow's resolve → shell base-check → `--force-isolation none`
    // re-record, then the plain `--json` read that clobbered the record
    // pre-fix (the originating session's first denial).
    const forced = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--phase', '1', '--force-isolation', 'none'],
      dir,
      env(dir),
    );
    assert.equal(forced.success, true, forced.error);
    const requery = runGsdTools(['query', 'dispatch-isolation', '--json', '--phase', '1'], dir, env(dir));
    assert.equal(requery.success, true, requery.error);

    // The guard fires on the sequential inline Agent() dispatch (no
    // isolation kwarg) and must NOT deny it (#4222's user-visible symptom).
    const r = runHook(agentPayload(), dir, { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') });
    assert.equal(r.status, 0, `guard denied a sequential dispatch after a plain re-query on a diverged repo: stdout=${r.stdout} stderr=${r.stderr}`);
  });

  // #4232 review, Nit 1 — `baseCheckDegrades`'s catch/unbuilt-lib fallback.
  //
  // The nit was that the seven tests above exercise the integration path only,
  // leaving the helper's own catch argued from code reading. Conceded: that
  // catch is NOT unreachable-from-production. It is the documented fallback for
  // an unbuilt runtime lib or a thrown evaluation, and on it the resolver
  // records the naturally-resolved capability instead of the degrade — i.e. it
  // silently reverts to pre-#4222 behaviour for that call.
  //
  // What makes this a REGRESSION test and not a restatement is the pair. Each
  // case asserts the control (evaluation available -> `none`) and the fault arm
  // (evaluation unavailable -> the natural capability) against the SAME diverged
  // repo. Pre-fix both arms recorded `harness-worktree`, so the pair fails on a
  // pre-fix tree; a fault-arm-only assertion would pass there and prove nothing.
  //
  // Both fault arms land in the same `catch`; they are driven separately because
  // they reach it by different seams (module resolution vs. a throwing export),
  // and only the first models the unbuilt-lib case the nit named.
  const BASEREF_FAULT_PRELOAD = path.join(__dirname, 'helpers', 'worktree-base-ref-fault-preload.cjs');

  for (const fault of ['unresolvable', 'throws']) {
    test(`#4232: base-check evaluation ${fault} — the resolver falls back to the natural capability and never throws`, (t) => {
      const { dir } = projectWithOrigin(t, 'gsd-4232-basecheck-fault-');
      diverge(dir);

      // Control, same repo state: with the evaluation available the degrade is
      // re-derived and the sentinel records `none` — #4222's whole point.
      const control = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, env(dir));
      assert.equal(control.success, true, control.error);
      assert.equal(
        readSentinelRaw(dir).isolation,
        'none',
        'control: with the evaluation available a diverged repo must record none',
      );

      // Fault arm: the identical call with the evaluation unavailable.
      const faulted = runGsdTools(['query', 'dispatch-isolation', '--raw', '--phase', '1'], dir, {
        ...env(dir),
        NODE_OPTIONS: `--require ${BASEREF_FAULT_PRELOAD}`,
        GSD_TEST_BASEREF_FAULT: fault,
      });

      // "Never throws" is half the helper's contract: the query still succeeds
      // and stdout still carries the host capability that the workflow's own
      // fail-closed guard branches on.
      assert.equal(
        faulted.success,
        true,
        `the resolver must not fail when the base-check evaluation is unavailable: ${faulted.error}`,
      );
      assert.equal(faulted.output.trim(), 'harness-worktree');

      // The other half: no degrade is re-derived, so the natural capability is
      // what gets recorded. This pins a LIMITATION, not an endorsement — the
      // workflow's own shell base-check plus `--force-isolation none` remains
      // the backstop, and it is why this fallback is safe rather than silent.
      const sentinel = readSentinelRaw(dir);
      assert.equal(
        sentinel.isolation,
        'harness-worktree',
        'fault arm: with no evaluation available the resolver records the natural capability',
      );
      assert.equal(sentinel.harness_flag, 'isolation="worktree"');
    });
  }
});

describe('#3045 MAJOR — --harness-flag can now accept a bare CLI-flag value (Cursor real registry value + generalized parsing)', () => {
  test('record-dispatch-isolation --harness-flag=--worktree persists the REAL cursor registry value verbatim', (t) => {
    const cursorFlag = runtimes.cursor.runtime.harnessIsolationFlag;
    assert.equal(cursorFlag, '--worktree', 'precondition: registry shape assumed by this test');

    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', `--harness-flag=${cursorFlag}`, '--phase', '1'],
      dir,
      { HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.harness_flag, cursorFlag);
  });

  test('record-dispatch-isolation --harness-flag=<bare-flag> persists ANY bare-CLI-flag-shaped value verbatim (parser is not Cursor-specific)', (t) => {
    // A prior draft of this test asserted `runtimes.windsurf.runtime.harnessIsolationFlag
    // === '--worktree'`, assuming Windsurf's registry entry mirrors Cursor's.
    // It does not: Windsurf's `hostIntegration.dispatch.isolation` is 'none'
    // and it declares NO `harnessIsolationFlag` at all — per ADR-1239
    // (docs/adr/1239-gsd-embeddable-orchestration-engine.md:247,250),
    // `pi`/`zcode`/`windsurf` "genuinely cannot benefit and correctly stay
    // none" because they lack named/concurrent subagent dispatch, so there is
    // no per-dispatch isolation flag for Windsurf to record. That was a wrong
    // test expectation (a fabricated registry precondition), not a production
    // defect — corrected here to prove the `--harness-flag=<value>` parser
    // generalizes to any bare-CLI-flag-shaped value, not merely Cursor's
    // specific '--worktree' string (which the sub-test above already pins).
    assert.equal(
      runtimes.windsurf.runtime.harnessIsolationFlag,
      undefined,
      'precondition: windsurf declares no harnessIsolationFlag (isolation: "none", ADR-1239)',
    );

    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag=--isolated', '--phase', '1'],
      dir,
      { HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(readSentinelRaw(dir).harness_flag, '--isolated');
  });

  test('the legacy space-separated form still rejects a value that looks like another flag (unchanged, regression pin)', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag', '--worktree', '--phase', '1'],
      dir,
      { HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(readSentinelRaw(dir).harness_flag, null, 'space form must not swallow a value shaped like a flag');
  });

  test('record-dispatch-isolation still errors with usage text when --isolation is missing', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(['query', 'record-dispatch-isolation'], dir, { HOME: dir });
    assert.equal(result.success, false);
    assert.match(result.error, /Usage: record-dispatch-isolation/);
  });

  test('record-dispatch-isolation accepts --plan and records it', (t) => {
    const dir = createTempProject('gsd-3045-resolver-');
    t.after(() => cleanup(dir));
    const result = runGsdTools(
      ['query', 'record-dispatch-isolation', '--isolation', 'none', '--phase', '5', '--plan', 'plan-x'],
      dir,
      { HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    const sentinel = readSentinelRaw(dir);
    assert.equal(sentinel.isolation, 'none');
    assert.equal(sentinel.phase, '5');
    assert.equal(sentinel.plan, 'plan-x');
  });
});

describe('#3045 MINOR — writer/reader sentinel path derivation now agrees for a linked worktree without its own .planning/', () => {
  function git(args, cwd) {
    gitOrThrow(args, { cwd });
  }

  test('a sentinel written from a linked worktree (via --cwd) is found by readSentinel() called with that SAME worktree path', (t) => {
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3045-minor-main-'));
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3045-minor-wtparent-'));
    t.after(() => {
      cleanup(mainRepo);
      cleanup(wtParent);
    });
    git(['init'], mainRepo);
    git(['config', 'user.email', 'test@test.com'], mainRepo);
    git(['config', 'user.name', 'Test'], mainRepo);
    git(['config', 'commit.gpgsign', 'false'], mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), 'placeholder\n');
    git(['add', '-A'], mainRepo);
    git(['commit', '-m', 'initial commit'], mainRepo);
    // #4222: the resolver now re-derives the #683 base-check for the decision
    // it records, and a repo with no fork base at all (`fork-ref-unknown`)
    // legitimately degrades to `none` — the verdict the workflow shell already
    // reached on this shape. This test is about path derivation, not the
    // degrade, so give the fixture an origin whose HEAD matches its own and
    // the natural capability is what gets recorded.
    git(['remote', 'add', 'origin', mainRepo], mainRepo);
    git(['fetch', '--quiet', 'origin'], mainRepo);
    const mainBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mainRepo }).trim();
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${mainBranch}`], mainRepo);

    // .planning/ is created AFTER the commit — uncommitted/untracked, the
    // documented shape where a linked worktree does NOT get its own copy
    // (git worktree only checks out tracked files).
    fs.mkdirSync(path.join(mainRepo, '.planning'));
    fs.writeFileSync(path.join(mainRepo, '.planning', 'config.json'), JSON.stringify({}));

    const linked = path.join(wtParent, 'linked');
    git(['worktree', 'add', linked, '-b', 'gsd-3045-minor-branch'], mainRepo);
    assert.equal(fs.existsSync(path.join(linked, '.planning')), false, 'precondition: linked worktree has no own .planning/');

    // Write FROM the linked worktree path — mirrors an orchestrator
    // running in a linked worktree calling `dispatch-isolation`.
    const result = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--cwd', linked, '--phase', '1'],
      mainRepo,
      { GSD_RUNTIME: 'claude', HOME: mainRepo },
    );
    assert.equal(result.success, true, result.error);

    // The writer resolved up to the MAIN worktree (findProjectRoot(resolveMainWorktreeCwd(...))) —
    // the sentinel must NOT exist at the linked worktree's own (nonexistent) .gsd/.
    assert.equal(fs.existsSync(sentinelFile(linked)), false, 'writer must not have written under the linked worktree itself');
    assert.equal(fs.existsSync(sentinelFile(mainRepo)), true, 'writer must have resolved up to the main worktree');

    // The READER, given the raw linked-worktree cwd (exactly what a guard
    // hook receives as data.cwd / workspace_roots[i]), must derive the SAME
    // root the writer did and find the sentinel — this is the MINOR fix.
    const read = readSentinel(linked);
    assert.equal(read.present, true, 'reader must resolve the linked worktree up to the main worktree, same as the writer');
    assert.equal(read.stale, false);
    assert.equal(read.isolation, 'harness-worktree');
  });
});

describe('#2486 regression: inspect-dispatch-isolation is the sentinel-free read', () => {
  // /gsd:health (W025) and /gsd:settings (Worktrees branching) must be able to
  // learn the negotiated isolation WITHOUT recording it: the #3045 recording
  // verb stamps a phase:null/plan:null sentinel the guard hooks then enforce
  // against real executor dispatches — letting a read-only diagnostic
  // hard-block execution for the sentinel's lifetime, across sessions.

  test('inspect-dispatch-isolation resolves the declared capability and writes NO sentinel', (t) => {
    const dir = createTempProject('gsd-2486-inspect-');
    t.after(() => cleanup(dir));
    assert.equal(fs.existsSync(sentinelFile(dir)), false, 'precondition: no sentinel yet');
    const result = runGsdTools(
      ['query', 'inspect-dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.output.trim(), 'harness-worktree');
    assert.equal(
      fs.existsSync(sentinelFile(dir)),
      false,
      'inspection must not create .gsd/dispatch-isolation-sentinel.json',
    );
    assert.equal(fs.existsSync(path.join(dir, '.gsd')), false, 'inspection must not even create the .gsd dir');
  });


  test('parity: inspect resolves byte-identically to the recording verb for every registry runtime', (t) => {
    // Same negotiation implementation by construction (shared helper) — this
    // pins the contract so a future edit cannot fork the two verbs apart.
    for (const runtimeId of Object.keys(runtimes)) {
      const dir = createTempProject('gsd-2486-parity-');
      t.after(() => cleanup(dir));
      const inspected = runGsdTools(
        ['query', 'inspect-dispatch-isolation', '--raw'],
        dir,
        { GSD_RUNTIME: runtimeId, HOME: dir },
      );
      assert.equal(inspected.success, true, inspected.error);
      assert.equal(
        fs.existsSync(sentinelFile(dir)),
        false,
        `${runtimeId}: inspect must not write the sentinel`,
      );

      const dispatched = runGsdTools(
        ['query', 'dispatch-isolation', '--raw'],
        dir,
        { GSD_RUNTIME: runtimeId, HOME: dir },
      );
      assert.equal(dispatched.success, true, dispatched.error);
      assert.equal(
        inspected.output.trim(),
        dispatched.output.trim(),
        `${runtimeId}: the two verbs must resolve the same isolation`,
      );
    }
  });

  // #2486 review, Major 4: silently IGNORING these was the defect. The
  // recording verb applies --force-isolation after the shared helper returns,
  // so accepting-and-ignoring it here means the same argv yields 'none' from
  // dispatch and the declared capability from inspect — a caller gets a
  // different answer with no signal. Rejecting turns that into a loud usage
  // error. This test fails if the verb ever goes back to accepting them.
  for (const [flag, value] of [['--force-isolation', 'none'], ['--phase', '9'], ['--plan', 'p1']]) {
    test(`inspect REJECTS the recording-only argument ${flag}`, (t) => {
      const dir = createTempProject('gsd-2486-inspect-args-');
      t.after(() => cleanup(dir));
      // --json-errors so the assertion is on the TYPED reason, not on human
      // prose: swapping ERROR_REASON.USAGE for UNKNOWN would keep a message
      // regex green while breaking every machine consumer (#2486 review,
      // round-9 Minor 4).
      const result = runGsdTools(
        ['query', 'inspect-dispatch-isolation', '--raw', flag, value, '--json-errors'],
        dir,
        { GSD_RUNTIME: 'claude', HOME: dir },
      );
      assert.equal(result.success, false, `${flag} must be a usage error, not a silently ignored argument`);
      const envelope = JSON.parse(result.error.trim().split('\n').filter(Boolean).pop());
      assert.equal(
        envelope.reason,
        'usage',
        `${flag}: must be typed as a usage error — got ${JSON.stringify(envelope.reason)}`,
      );
      assert.match(
        envelope.message || '',
        /recording-only/,
        `${flag}: the message must say why the argument has no read-path meaning`,
      );
      assert.equal(fs.existsSync(sentinelFile(dir)), false, 'a rejected inspection still records nothing');
    });
  }

  test('the divergence that rejection prevents: dispatch DOES honour --force-isolation', (t) => {
    // Pins the asymmetry that makes rejection necessary rather than pedantic.
    // If a future edit moved the override into the shared helper, inspect could
    // safely accept the flag — and this test would still pass, correctly, while
    // the rejection tests above would then be the ones to revisit.
    const dir = createTempProject('gsd-2486-force-divergence-');
    t.after(() => cleanup(dir));
    const dispatched = runGsdTools(
      ['query', 'dispatch-isolation', '--raw', '--force-isolation', 'none'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(dispatched.success, true, dispatched.error);
    assert.equal(dispatched.output.trim(), 'none', 'force is honoured on the recording verb');

    const inspected = runGsdTools(
      ['query', 'inspect-dispatch-isolation', '--raw'],
      dir,
      { GSD_RUNTIME: 'claude', HOME: dir },
    );
    assert.equal(inspected.success, true, inspected.error);
    assert.equal(
      inspected.output.trim(),
      'harness-worktree',
      'inspection reports the DECLARED capability, which is what the two would disagree on',
    );
  });

  // #2486 review, Minor 5: asserting inspection against a HANDWRITTEN key list
  // does not test parity at all — changing the recording verb's JSON
  // independently would leave it green. Compare against the real thing.
  test('--json shape matches the recording verb, compared against its actual output', (t) => {
    const inspectDir = createTempProject('gsd-2486-inspect-json-');
    const dispatchDir = createTempProject('gsd-2486-dispatch-json-');
    t.after(() => cleanup(inspectDir));
    t.after(() => cleanup(dispatchDir));

    const inspected = runGsdTools(
      ['query', 'inspect-dispatch-isolation', '--json'],
      inspectDir,
      { GSD_RUNTIME: 'cursor', HOME: inspectDir },
    );
    assert.equal(inspected.success, true, inspected.error);
    const inspectedJson = JSON.parse(inspected.output);

    // Separate project dir: the recording verb writes a sentinel, and the
    // inspection assertion below must not be able to see it.
    const dispatched = runGsdTools(
      ['query', 'dispatch-isolation', '--json'],
      dispatchDir,
      { GSD_RUNTIME: 'cursor', HOME: dispatchDir },
    );
    assert.equal(dispatched.success, true, dispatched.error);
    const dispatchedJson = JSON.parse(dispatched.output);

    assert.deepEqual(
      Object.keys(inspectedJson).sort(),
      Object.keys(dispatchedJson).sort(),
      'consumers written against the recording verb JSON must be able to switch verbatim',
    );
    assert.deepEqual(
      inspectedJson,
      dispatchedJson,
      'same runtime, same declared capability — every field must agree, not just the key set',
    );
    assert.equal(inspectedJson.runtime, 'cursor');
    assert.equal(inspectedJson.isolation, 'harness-worktree');
    assert.equal(fs.existsSync(sentinelFile(inspectDir)), false, 'no sentinel from a --json inspection either');
    assert.equal(fs.existsSync(sentinelFile(dispatchDir)), true, 'control: the recording verb DID write one');
  });

  // #2486 review, Minor 5 (second half): the registry parity test compares raw
  // isolation only, so it never exercises the orchestrator `exec` branch that
  // --cwd-target populates. Compare the full JSON there too.
  test('parity holds on the orchestrator exec branch (--cwd-target), not just raw isolation', (t) => {
    const inspectDir = createTempProject('gsd-2486-inspect-cwd-');
    const dispatchDir = createTempProject('gsd-2486-dispatch-cwd-');
    t.after(() => cleanup(inspectDir));
    t.after(() => cleanup(dispatchDir));

    const inspected = runGsdTools(
      ['query', 'inspect-dispatch-isolation', '--json', '--cwd-target', 'wt'],
      inspectDir,
      { GSD_RUNTIME: 'codex', HOME: inspectDir },
    );
    assert.equal(inspected.success, true, inspected.error);
    const dispatched = runGsdTools(
      ['query', 'dispatch-isolation', '--json', '--cwd-target', 'wt'],
      dispatchDir,
      { GSD_RUNTIME: 'codex', HOME: dispatchDir },
    );
    assert.equal(dispatched.success, true, dispatched.error);

    const inspectedJson = JSON.parse(inspected.output);
    assert.deepEqual(
      inspectedJson,
      JSON.parse(dispatched.output),
      'the exec branch must resolve identically on both verbs',
    );
    assert.equal(inspectedJson.isolation, 'orchestrator-worktree', 'precondition: codex is the orchestrator-worktree case');
    assert.ok(inspectedJson.exec, 'precondition: this branch actually populates exec, so the comparison means something');
  });
});

// ─── #3582: cold tree (no gsd-core/bin/lib/*.cjs) — self-heal surfacing ────
//
// gsd-core/bin/lib/*.cjs are tsc build artifacts (ADR-457), gitignored and
// absent on a raw plugin-marketplace / git-clone install that never ran
// `npm run build:lib`. Before #3582, resolveRegistryIsolation's
// require('../gsd-core/bin/lib/runtime-name-policy.cjs') threw a bare
// "Cannot find module", which resolveIsolationState's catch folded into the
// SAME generic "could not read or resolve ... configuration" reason as an
// unreadable config.json (row 8/12 above) — a misreport of a completely
// different failure (#3050 lesson). The fix: resolveRegistryIsolation now
// calls ensureRuntimeBuild() first; a RuntimeBuildError surfaces its own
// actionable message instead. Simulated hermetically via a fixture install
// tree that copies hooks/ + the seam module but never gsd-core/bin/lib/ or
// tsconfig.build.json (tests/helpers/cold-runtime-lib-fixture.cjs) — the
// REAL gsd-core/bin/lib/ is never touched.
describe('gsd-agent-isolation-guard.js: #3582 cold tree — RuntimeBuildError surfaces distinctly', () => {
  const { buildColdInstallTree } = require('./helpers/cold-runtime-lib-fixture.cjs');

  test('missing compiled runtime library -> DENY (fail-closed) with the seam\'s own actionable message, not the generic config-unreadable text', (t) => {
    const cold = buildColdInstallTree();
    t.after(cold.cleanup);
    const project = mkProject('gsd-aig-cold-');
    t.after(() => cleanup(project));
    writeConfig(project, JSON.stringify({ runtime: 'claude' }));

    const env = { ...process.env };
    delete env.GSD_RUNTIME;
    const r = runHookSeam(path.join(cold.hooksDir, 'gsd-agent-isolation-guard.js'), [], {
      input: JSON.stringify(agentPayload()),
      cwd: project,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const result = toLegacyResult(r);
    assert.equal(result.status, 2, `expected fail-closed DENY; stdout: ${result.stdout} stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.decision, 'block');
    // Typed reason code (CONTRIBUTING.md "Prohibited: Raw Text Matching on
    // Test Outputs" — assert the stable code, not the free-form `reason`
    // prose). RUNTIME_BUILD_FAILED and CONFIG_UNREADABLE are distinct codes,
    // so this equality check itself proves the build failure is NOT
    // misreported as the generic unreadable-config case (rows 8/12 above).
    assert.equal(out.reason_code, REASON_CODE.RUNTIME_BUILD_FAILED);
    // `reason` remains free-form operator-facing text — not asserted here.
    assert.equal(typeof out.reason, 'string');
    assert.ok(out.reason.length > 0);
  });
});

// ─── #3972: the guard's sentinel-absent fallback shares the opt-out ladder ───
// The guard's own config read was flat-root, so a workstream-LOCAL
// use_worktrees=false was invisible to it: with no sentinel present (fresh
// checkout) the fallback denied the sequential dispatch the config
// explicitly allowed. The ladder now lives in planning-workspace and both
// the resolver and the guard consume it.
describe('guard fallback — worktreesOptedOut ladder (#3972)', () => {
  function wsFixture(rootCfg, wsCfg) {
    const dir = createTempDir('gsd-3972-guard-');
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(rootCfg));
    fs.writeFileSync(path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json'), JSON.stringify(wsCfg));
    return dir;
  }

  test('#3972: a workstream-local use_worktrees=false opts the fallback out', (t) => {
    const dir = wsFixture({ runtime: 'claude' }, { runtime: 'claude', workflow: { use_worktrees: false } });
    t.after(() => cleanup(dir));
    assert.equal(fs.existsSync(sentinelFile(dir)), false, 'fixture: sentinel absent — the fallback is under test');
    const r = runHook(agentPayload(), dir, { GSD_WORKSTREAM: 'alpha' });
    assert.equal(r.status, 0,
      `#3972: the workstream opted out — the sentinel-absent fallback must allow; got stdout=${r.stdout}`);
  });

  test('#3972: a root-only opt-out under a workstream also allows (the #3963 shape, guard side)', (t) => {
    const dir = wsFixture({ runtime: 'claude', workflow: { use_worktrees: false } }, { runtime: 'claude' });
    t.after(() => cleanup(dir));
    const r = runHook(agentPayload(), dir, { GSD_WORKSTREAM: 'alpha' });
    assert.equal(r.status, 0, 'the inherited root opt-out must reach the fallback too');
  });

  test('#3972: no opt-out anywhere still denies (unchanged)', (t) => {
    const dir = wsFixture({ runtime: 'claude' }, { runtime: 'claude' });
    t.after(() => cleanup(dir));
    const r = runHook(agentPayload(), dir, { GSD_WORKSTREAM: 'alpha' });
    assert.equal(r.status, 2, 'the guard must keep demanding the harness flag when nothing opted out');
  });
});

describe('worktreesOptedOut — ladder unit semantics (#3972)', () => {
  const { worktreesOptedOut } = require('../gsd-core/bin/lib/planning-workspace.cjs');

  test('scoped own-key wins; root inherited only under the ws gate; strict === false', (t) => {
    const dir = createTempDir('gsd-3972-unit-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    const root = path.join(dir, '.planning', 'config.json');
    const ws = path.join(dir, '.planning', 'workstreams', 'alpha', 'config.json');
    const prev = process.env['GSD_WORKSTREAM'];
    t.after(() => { if (prev === undefined) delete process.env['GSD_WORKSTREAM']; else process.env['GSD_WORKSTREAM'] = prev; });

    fs.writeFileSync(ws, JSON.stringify({ workflow: { use_worktrees: false } }));
    process.env['GSD_WORKSTREAM'] = 'alpha';
    assert.equal(worktreesOptedOut(dir), true, 'scoped own false');

    fs.writeFileSync(ws, JSON.stringify({ workflow: { use_worktrees: true } }));
    assert.equal(worktreesOptedOut(dir), false, 'scoped own true wins over any root');

    fs.writeFileSync(ws, JSON.stringify({ runtime: 'claude' }));
    fs.writeFileSync(root, JSON.stringify({ workflow: { use_worktrees: false } }));
    assert.equal(worktreesOptedOut(dir), true, 'root false inherited under the ws gate');

    delete process.env['GSD_WORKSTREAM'];
    // Without a workstream, planningDir IS the flat root — the root's own key
    // is the scoped read (the plain-project opt-out), so this answers true.
    // The no-cross-inheritance contract (a GSD_PROJECT-scoped dir ignoring the
    // flat root) is pinned by the resolver-level #3963 boundary test.
    assert.equal(worktreesOptedOut(dir), true, 'no ws: the root config IS the effective config');

    fs.writeFileSync(ws, JSON.stringify({ workflow: { use_worktrees: 'false' } }));
    process.env['GSD_WORKSTREAM'] = 'alpha';
    assert.equal(worktreesOptedOut(dir), false, 'string "false" never coerces');

    fs.writeFileSync(ws, '{ malformed');
    assert.equal(worktreesOptedOut(dir), true, 'unreadable scoped config falls to the root view under the gate');
  });
});

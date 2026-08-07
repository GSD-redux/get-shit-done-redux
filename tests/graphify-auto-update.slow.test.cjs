'use strict';

// Tests for graphify.cjs — auto-update describe block.
// Split from the consolidated 2336-LOC file. Refs #3761.
//
// Regression for #3347: opt-in auto-update of the knowledge graph after
// main HEAD advances. Two sub-concerns: config-key surface (config.test)
// and hook behavior (hook.test). Both merged here.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { createTempProject, cleanup, runGsdTools, delay } = require('./helpers.cjs');
const { runGit, runHook: seamRunHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  graphifyStatus,
} = require('../gsd-core/bin/lib/graphify.cjs');

const {
  VALID_CONFIG_KEYS,
  isValidConfigKey,
} = require('../gsd-core/bin/lib/config-schema.cjs');

const {
  CONFIG_DEFAULTS: CANONICAL_CONFIG_DEFAULTS,
} = require('../gsd-core/bin/lib/configuration.cjs');

const {
  makeStatusProject,
} = require('./helpers/graphify.cjs');

// ─── auto-update describe ─────────────────────────────────────────────────────

describe('auto-update', () => {
  describe('config-key surface', () => {
    // Regression for #3347

    test('VALID_CONFIG_KEYS contains graphify.auto_update', () => {
      assert.ok(
        VALID_CONFIG_KEYS.has('graphify.auto_update'),
        'graphify.auto_update must be in VALID_CONFIG_KEYS so config-set accepts it',
      );
    });

    test('isValidConfigKey accepts graphify.auto_update', () => {
      assert.ok(
        isValidConfigKey('graphify.auto_update'),
        'isValidConfigKey must return true for graphify.auto_update',
      );
    });

    test('isValidConfigKey still accepts the pre-existing graphify.enabled key', () => {
      assert.ok(
        isValidConfigKey('graphify.enabled'),
        'regression guard: graphify.enabled must remain a valid key',
      );
    });

    test('CANONICAL_CONFIG_DEFAULTS.graphify.auto_update is false', () => {
      assert.ok(
        CANONICAL_CONFIG_DEFAULTS.graphify !== undefined,
        'CANONICAL_CONFIG_DEFAULTS must expose a graphify section',
      );
      assert.strictEqual(
        CANONICAL_CONFIG_DEFAULTS.graphify.auto_update,
        false,
        'graphify.auto_update default must be false (opt-in per issue #3347 AC)',
      );
    });

    test('config-set graphify.auto_update true succeeds', (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      const result = runGsdTools(
        ['config-set', 'graphify.auto_update', 'true'],
        tmpDir,
      );
      assert.ok(
        result.success,
        [
          'config-set graphify.auto_update true should succeed,',
          'got:',
          'stdout: ' + result.output,
          'stderr: ' + result.error,
        ].join('\n'),
      );
    });

    test('config-set graphify.auto_update true writes to config.json', (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      runGsdTools(['config-set', 'graphify.auto_update', 'true'], tmpDir);

      const configPath = path.join(tmpDir, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(
        config.graphify?.auto_update,
        true,
        'config.json must have graphify.auto_update: true after config-set',
      );
    });

    test('config-set graphify.auto_update false persists too', (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      runGsdTools(['config-set', 'graphify.auto_update', 'true'], tmpDir);
      runGsdTools(['config-set', 'graphify.auto_update', 'false'], tmpDir);

      const configPath = path.join(tmpDir, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(
        config.graphify?.auto_update,
        false,
        'config-set must round-trip true → false',
      );
    });

    test('graphifyStatus folds auto-update status=failed into stale=true', (t) => {
      const tmpDir = makeStatusProject({
        ts: '2026-05-15T12:00:00Z',
        status: 'failed',
        exit_code: 1,
        duration_ms: 1234,
        head_at_build: 'abcdef0',
        graphify_version: null,
      });
      t.after(() => cleanup(tmpDir));
      const s = graphifyStatus(tmpDir);
      assert.strictEqual(s.stale, true, 'auto-build failure must set stale=true');
      assert.ok(s.last_build_auto_update, 'last_build_auto_update must be exposed');
      assert.strictEqual(s.last_build_auto_update.status, 'failed');
      assert.strictEqual(s.last_build_auto_update.exit_code, 1);
    });

    test('graphifyStatus folds auto-update status=running into stale=true', (t) => {
      const tmpDir = makeStatusProject({
        ts: '2026-05-15T12:00:00Z',
        status: 'running',
        exit_code: null,
        duration_ms: null,
        head_at_build: 'abcdef0',
        graphify_version: null,
      });
      t.after(() => cleanup(tmpDir));
      const s = graphifyStatus(tmpDir);
      assert.strictEqual(s.stale, true, 'auto-build in-flight must set stale=true');
      assert.strictEqual(s.last_build_auto_update.status, 'running');
    });

    test('graphifyStatus leaves stale alone when auto-update status=ok and graph is fresh', (t) => {
      const tmpDir = makeStatusProject({
        ts: '2026-05-15T12:00:00Z',
        status: 'ok',
        exit_code: 0,
        duration_ms: 1234,
        head_at_build: 'abcdef0',
        graphify_version: null,
      });
      t.after(() => cleanup(tmpDir));
      const s = graphifyStatus(tmpDir);
      assert.strictEqual(s.stale, false, 'fresh graph + ok auto-build => not stale');
      assert.strictEqual(s.last_build_auto_update.status, 'ok');
    });

    test('graphifyStatus exposes last_build_auto_update: null when status file absent', (t) => {
      const tmpDir = makeStatusProject(null);
      t.after(() => cleanup(tmpDir));
      const s = graphifyStatus(tmpDir);
      assert.strictEqual(s.last_build_auto_update, null);
      assert.strictEqual(s.stale, false, 'no status file => stale follows mtime only');
    });

    test('config-set graphify.auto_update does not perturb sibling graphify.enabled', (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));

      runGsdTools(['config-set', 'graphify.enabled', 'true'], tmpDir);
      runGsdTools(['config-set', 'graphify.auto_update', 'true'], tmpDir);

      const configPath = path.join(tmpDir, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(
        config.graphify?.enabled,
        true,
        'graphify.enabled must be preserved when setting graphify.auto_update',
      );
      assert.strictEqual(
        config.graphify?.auto_update,
        true,
        'graphify.auto_update must coexist with graphify.enabled',
      );
    });
  });

  // ─── hook tests ─────────────────────────────────────────────────────────────

  const isWindows = process.platform === 'win32';
  const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-graphify-update.sh');

  function createTempGitRepo(opts = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3347-'));
    // Original discarded the result unchecked (stdio: 'ignore', never a
    // throw-native execFileSync) — bare runGit preserves that never-throws,
    // ignored-result shape.
    runGit(['init', '-b', opts.defaultBranch || 'main'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    gitOrThrow(['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
    gitOrThrow(['add', 'README.md'], { cwd: tmpDir });
    gitOrThrow(['commit', '-m', 'init'], { cwd: tmpDir });

    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    if (opts.config !== undefined) {
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify(opts.config, null, 2),
      );
    }
    return tmpDir;
  }

  function makeMockGraphifyBin(tmpDir, { exitCode = 0, sleepMs = 0 } = {}) {
    const binDir = path.join(tmpDir, '.mock-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const script = path.join(binDir, 'graphify');
    const body = [
      '#!/usr/bin/env bash',
      'set -u',
      sleepMs ? `sleep ${(sleepMs / 1000).toFixed(3)}` : '',
      'mkdir -p graphify-out',
      'echo \'{"nodes":[],"edges":[]}\' > graphify-out/graph.json',
      'echo "mock report" > graphify-out/GRAPH_REPORT.md',
      'echo "<html></html>" > graphify-out/graph.html',
      `exit ${exitCode}`,
    ]
      .filter(Boolean)
      .join('\n');
    fs.writeFileSync(script, body + '\n', { mode: 0o755 });
    return binDir;
  }

  function runHook(tmpDir, toolPayload, { env = {}, pathPrepend = '' } = {}) {
    const PATH = pathPrepend
      ? `${pathPrepend}${path.delimiter}${process.env.PATH || ''}`
      : process.env.PATH || '';
    // 30000ms: already bounded pre-migration (unchanged) — this is the `slow`
    // suite and the hook itself dispatches a detached graphify rebuild that
    // some tests wait on separately; the hook's own synchronous return (gate
    // checks + status-file write) is fast, so 30s stays generous headroom.
    // Original invoked the hook with stdio: 'ignore' — the seam always
    // captures stdout/stderr instead, but every call site of this wrapper
    // below reads only `.status`; the captured output is simply unread.
    const r = seamRunHook(HOOK, [], {
      interpreter: 'bash',
      cwd: tmpDir,
      input: JSON.stringify(toolPayload),
      env: {
        ...process.env,
        PATH,
        CI: '',
        ...env,
      },
      timeoutMs: 30000,
    });
    return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  // Wait until the detached rebuild writes a terminal status, with a generous
  // deadline. The detached subprocess can be slow under contended Docker; all
  // assertions here are outcome-based, so we wait for the real terminal state
  // rather than guessing a tight wall-clock budget (#382).
  async function waitForBuildStatus(statusPath, terminal /* e.g. new Set(['ok']) */, { deadlineMs = 30000, stepMs = 25 } = {}) {
    const deadline = Date.now() + deadlineMs;
    let status;
    while (Date.now() < deadline) {
      if (fs.existsSync(statusPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          status = parsed;
          if (parsed && terminal.has(parsed.status)) return parsed;
        } catch { /* detached writer can briefly expose a partial JSON write */ }
      }
      await delay(stepMs);
    }
    return status; // last seen (may be undefined / non-terminal) — assertions below will report
  }

  async function cleanupHookRepo(tmpDir) {
    // The hook detaches a graphify-rebuild subprocess that may still be writing
    // into tmpDir when the test body returns. Wait for the rebuild PID to exit
    // (lock file disappears on subprocess EXIT trap), then retry rmSync to
    // absorb any remaining transient ENOTEMPTY race.
    //
    // Uses delay() instead of Atomics.wait so we yield the event loop
    // without blocking the thread.  Budget: 15 s — bumped from 4 s to give
    // the detached child more time to exit under contended Docker (#382).
    const lockPath = path.join(tmpDir, '.planning/graphs/.rebuild.lock');
    const lockDeadline = Date.now() + 15000;
    while (Date.now() < lockDeadline) {
      if (!fs.existsSync(lockPath)) break;
      try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (!Number.isFinite(pid) || pid <= 0) break;
        // `kill -0` on a live PID exits 0; on a dead PID (or missing `kill`)
        // it exits non-zero — this loop only cares about that distinction,
        // so it reads exitCode as data instead of preserving a throw.
        // Original ran with stdio: 'ignore' — the seam always captures
        // stdout/stderr instead, but only `probe.exitCode` is read below;
        // the captured output is simply unread.
        const probe = seamRunHook('-0', [String(pid)], { interpreter: 'kill', timeoutMs: PROBE_TIMEOUT_MS });
        if (probe.exitCode !== 0) break; // PID dead → safe to clean up
      } catch {
        break; // PID dead → safe to clean up
      }
      await delay(50); // yield 50 ms, then re-check
    }
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- best-effort teardown: error is swallowed so cleanup() (which propagates) cannot be used here; a residual temp dir after a detached-subprocess race is harmless (#382)
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch { /* best-effort teardown: a residual temp dir is harmless; never fail the test (#382) */ }
  }

  describe('hook — bail paths (no side effects)',
    { skip: isWindows ? 'POSIX-only: harness spawns bash + kill -0 + sleep; the hook itself is a bash script under test' : false },
    () => {
    test('non-Bash tool call exits 0 with no status file', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const r = runHook(tmpDir, { tool_name: 'Edit', tool_input: { file_path: 'x' } });
      assert.strictEqual(r.status, 0, 'hook must exit 0 on non-Bash tool');
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'no status file should be created when bailing',
      );
    });

    test('Bash but non-HEAD-advancing command exits 0 with no status file', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const r = runHook(tmpDir, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
      assert.strictEqual(r.status, 0);
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')));
    });

    test('git commit but graphify.enabled=false → no dispatch', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: false, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const r = runHook(tmpDir, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
      assert.strictEqual(r.status, 0);
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')));
    });

    test('git commit but graphify.auto_update=false → no dispatch (opt-in)', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: false } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const r = runHook(tmpDir, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
      assert.strictEqual(r.status, 0);
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'opt-in default-off: auto_update=false must suppress dispatch',
      );
    });

    test('CI=true → no dispatch even with both gates true', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { env: { CI: 'true' }, pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')));
    });

    test('on non-default branch → no dispatch', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      gitOrThrow(['checkout', '-b', 'worktree-agent-abc'], { cwd: tmpDir });
      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'branch check must filter worktree-agent-* (non-default-branch) commits',
      );
    });

    test('graphify binary not on PATH → silent exit 0', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      // Note: do NOT prepend mock bin; rely on real PATH not having graphify
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { env: { PATH: '/usr/bin:/bin' } },
      );
      assert.strictEqual(r.status, 0, 'must not break commits when graphify missing');
    });
  });

  describe('hook — dispatch path (all gates pass)',
    { skip: isWindows ? 'POSIX-only: harness spawns bash + kill -0 + sleep; the hook itself is a bash script under test' : false },
    () => {
    test('writes status file with status=running synchronously before returning', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      // Sleep 2s in mock so we can observe the running state before completion
      const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 2000 });

      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0, 'hook must return 0');

      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      assert.ok(fs.existsSync(statusPath), 'status file must be written synchronously');
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      assert.strictEqual(status.status, 'running', 'initial status must be "running"');
      assert.ok(/^[0-9a-f]{7,40}$/.test(status.head_at_build), 'head_at_build must be a commit sha');
      // Await the detached rebuild's terminal status so the subprocess has exited
      // before the test returns. A dangling detached rebuild can outlive the chunk
      // under `node --test --test-force-exit` and surface as a non-zero chunk exit.
      const done = await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
      assert.ok(done && (done.status === 'ok' || done.status === 'failed'),
        'detached rebuild must reach a terminal status before the test returns');
    });

    test('completes to status=ok after detached graphify run succeeds', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir, { exitCode: 0, sleepMs: 200 });

      runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );

      // Wait for the detached rebuild process to write the final status file.
      // Uses waitForBuildStatus with a generous 30 s deadline so contended
      // Docker is never racing a tight budget (#382). All assertions are
      // outcome-based; the deadline is deterministic, not a timing assertion.
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      const status = await waitForBuildStatus(statusPath, new Set(['ok']));
      assert.ok(status, 'status file must exist after dispatch');
      assert.strictEqual(status.status, 'ok', 'mock graphify exit=0 → status ok');
      assert.strictEqual(status.exit_code, 0);
      assert.ok(typeof status.duration_ms === 'number' && status.duration_ms >= 0);
    });

    test('completes to status=failed when graphify exits non-zero', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir, { exitCode: 1, sleepMs: 100 });

      runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );

      // Wait for the detached rebuild process to write the final status file.
      // Uses waitForBuildStatus with a generous 30 s deadline so contended
      // Docker is never racing a tight budget (#382). All assertions are
      // outcome-based; the deadline is deterministic, not a timing assertion.
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      const status = await waitForBuildStatus(statusPath, new Set(['failed']));
      assert.ok(status, 'status file must exist after dispatch');
      assert.strictEqual(status.status, 'failed', 'mock graphify exit=1 → status failed');
      assert.strictEqual(status.exit_code, 1);
    });

    test('lock file with a live PID prevents concurrent dispatch', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      fs.mkdirSync(path.join(tmpDir, '.planning/graphs'), { recursive: true });
      // Seed a live-PID lock pointing at our own process — kill -0 will succeed
      fs.writeFileSync(path.join(tmpDir, '.planning/graphs/.rebuild.lock'), String(process.pid));

      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      // Status file should NOT be written because a rebuild is in flight
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'live PID lock must suppress dispatch',
      );
    });

    test('stale lock file (dead PID) is treated as absent', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      fs.mkdirSync(path.join(tmpDir, '.planning/graphs'), { recursive: true });
      // PID 1 is init; kill -0 1 succeeds for root but fails for non-root.
      // Use a very large PID number unlikely to exist (max pid = 4194304 on linux).
      fs.writeFileSync(path.join(tmpDir, '.planning/graphs/.rebuild.lock'), '4194303');

      const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 500 });
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      assert.ok(fs.existsSync(statusPath), 'stale lock must not block dispatch');
      // Await terminal status so the detached rebuild is gone before returning (see above).
      const done = await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
      assert.ok(done && (done.status === 'ok' || done.status === 'failed'),
        'detached rebuild must reach a terminal status before the test returns');
    });

    test('respects git.base_branch config override (default branch != main)', async (t) => {
      const tmpDir = createTempGitRepo({
        defaultBranch: 'trunk',
        config: {
          graphify: { enabled: true, auto_update: true },
          git: { base_branch: 'trunk' },
        },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 100 });
      const r = runHook(
        tmpDir,
        { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      assert.ok(
        fs.existsSync(statusPath),
        'hook must honor git.base_branch when default branch is not main',
      );
      // Await terminal status so the detached rebuild is gone before returning (see above).
      const done = await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
      assert.ok(done && (done.status === 'ok' || done.status === 'failed'),
        'detached rebuild must reach a terminal status before the test returns');
    });
  });

  // #2304 — Kimi tool vocabulary engages the hook: Kimi CLI registers this
  // hook with matcher 'Shell' and forwards tool_name 'Shell' (possibly
  // module-qualified). kimi-cli's Shell.Params names its field `command`
  // (src/kimi_cli/tools/shell/__init__.py), same as Claude's Bash, so only
  // the tool name needs normalization. Pre-fix, the Gate 1 `== "Bash"` check
  // never matched on Kimi and the auto-rebuild was silently dormant.
  describe('hook — Kimi tool vocabulary (#2304)',
    { skip: isWindows ? 'POSIX-only: harness spawns bash to invoke the .sh hook under test' : false },
    () => {
    test('dispatches on Kimi tool_name Shell (all gates pass)', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        { tool_name: 'Shell', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0, 'hook must return 0');
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      assert.ok(
        fs.existsSync(statusPath),
        'Kimi Shell must pass Gate 1 and dispatch — pre-fix the hook was silently dormant on Kimi (#2304)',
      );
      const done = await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
      assert.ok(done && (done.status === 'ok' || done.status === 'failed'),
        'detached rebuild must reach a terminal status before the test returns');
    });

    test('dispatches on module-qualified kimi_cli.tools.shell:Shell', async (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        { tool_name: 'kimi_cli.tools.shell:Shell', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
      assert.ok(fs.existsSync(statusPath),
        'module-qualified Kimi tool name must be recognized after prefix strip');
      const done = await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
      assert.ok(done && (done.status === 'ok' || done.status === 'failed'),
        'detached rebuild must reach a terminal status before the test returns');
    });

    test('negative control: Kimi WriteFile does NOT dispatch', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir);
      const r = runHook(
        tmpDir,
        // A command-shaped payload under a non-Shell Kimi tool: the name
        // normalization must not widen Gate 1 beyond Shell→Bash.
        { tool_name: 'kimi_cli.tools.file:WriteFile', tool_input: { command: 'git commit -m x' } },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'non-Shell Kimi tools must still bail at Gate 1',
      );
    });
  });

  describe('hook — HEAD-advancing command matchers',
    { skip: isWindows ? 'POSIX-only: harness spawns bash to invoke the .sh hook under test' : false },
    () => {
    for (const cmd of [
      'git commit -m fix',
      'git merge feature',
      'git pull --ff-only',
      'git rebase --continue',
      'git cherry-pick abc123',
      // #3653 — `gsd-tools query commit` invokes git via spawnSync('git', [...]),
      // so the substring "git commit" never appears in tool_input.command.
      // The hook must match the user-facing SDK invocation directly.
      'gsd-tools query commit "docs: probe" --files .planning/STATE.md',
      'npx gsd-tools query commit "docs: probe" --files .planning/STATE.md',
    ]) {
      test(`dispatches on: ${cmd}`, async (t) => {
        const tmpDir = createTempGitRepo({
          config: { graphify: { enabled: true, auto_update: true } },
        });
        t.after(() => cleanupHookRepo(tmpDir));
        const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 100 });
        runHook(
          tmpDir,
          { tool_name: 'Bash', tool_input: { command: cmd } },
          { pathPrepend: mockBin },
        );
        const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
        // Wait for any terminal status; we only assert the file exists,
        // not which terminal value it holds (#382: generous deadline).
        await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
        assert.ok(
          fs.existsSync(statusPath),
          `must dispatch for HEAD-advancing op: ${cmd}`,
        );
      });
    }

    test('does NOT dispatch on SDK commit-to-subrepo prefix collision', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 100 });
      const r = runHook(
        tmpDir,
        {
          tool_name: 'Bash',
          tool_input: {
            command: 'gsd-tools query commit-to-subrepo "msg" --files packages/foo',
          },
        },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'must NOT dispatch for commit-to-subrepo, which does not advance the outer repo HEAD',
      );
    });

    // #1772 — agent runtimes (Claude Code's Bash tool among them) routinely
    // emit HEAD-advancing commits as multi-line scripts (`cd /path` then
    // `git add` then `git commit …`). The hook joins tool_name + "\n" +
    // tool_input.command and must match the command across ALL its lines
    // (line 2 through EOF), not just line 2 — otherwise a `git commit` that
    // is not on the first command line silently no-ops the rebuild.
    for (const cmd of [
      "cd /tmp/repo\ngit add .\ngit commit -m 'multi-line commit'",
      "cd /tmp/repo\ngit merge feature-branch",
      "git fetch origin\ngit pull --ff-only",
    ]) {
      test(`dispatches on multi-line command (#1772): ${cmd.split('\n').slice(0, 2).join(' ⏎ ')}…`, async (t) => {
        const tmpDir = createTempGitRepo({
          config: { graphify: { enabled: true, auto_update: true } },
        });
        t.after(() => cleanupHookRepo(tmpDir));
        const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 100 });
        runHook(
          tmpDir,
          { tool_name: 'Bash', tool_input: { command: cmd } },
          { pathPrepend: mockBin },
        );
        const statusPath = path.join(tmpDir, '.planning/graphs/.last-build-status.json');
        await waitForBuildStatus(statusPath, new Set(['ok', 'failed']));
        assert.ok(
          fs.existsSync(statusPath),
          `must dispatch for multi-line command where the HEAD-advancing op is not on line 1 (#1772): ${cmd}`,
        );
      });
    }

    test('multi-line command with NO HEAD-advancing op still no-ops (#1772 no-regression)', (t) => {
      const tmpDir = createTempGitRepo({
        config: { graphify: { enabled: true, auto_update: true } },
      });
      t.after(() => cleanupHookRepo(tmpDir));
      const mockBin = makeMockGraphifyBin(tmpDir, { sleepMs: 100 });
      const r = runHook(
        tmpDir,
        {
          tool_name: 'Bash',
          tool_input: {
            // Multi-line, but only non-HEAD-advancing ops. Widening line
            // extraction to 2..EOF must not cause a spurious dispatch.
            command: 'cd /tmp/repo\nls -la\necho done',
          },
        },
        { pathPrepend: mockBin },
      );
      assert.strictEqual(r.status, 0);
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
        'multi-line command without a HEAD-advancing git op must still no-op (#1772)',
      );
    });

    // #3653 — only the SDK `commit` verb invokes git internally. Other
    // `gsd-tools query` verbs (phase.complete, roadmap.update-plan-progress,
    // state.begin-phase) mutate .md files but do NOT advance HEAD; matching
    // them would cause a spurious rebuild per state mutation.
    for (const cmd of [
      'gsd-tools query phase.complete 109',
      'gsd-tools query roadmap.update-plan-progress 109 W001',
      'gsd-tools query state.begin-phase 110',
    ]) {
      test(`does NOT dispatch on non-HEAD-advancing SDK verb: ${cmd}`, (t) => {
        const tmpDir = createTempGitRepo({
          config: { graphify: { enabled: true, auto_update: true } },
        });
        t.after(() => cleanupHookRepo(tmpDir));
        const r = runHook(tmpDir, { tool_name: 'Bash', tool_input: { command: cmd } });
        assert.strictEqual(r.status, 0);
        assert.ok(
          !fs.existsSync(path.join(tmpDir, '.planning/graphs/.last-build-status.json')),
          `must NOT dispatch for non-HEAD-advancing SDK verb: ${cmd}`,
        );
      });
    }
  });
});

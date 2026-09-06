/**
 * Behavior-lock tests for perf #317 — context-monitor hook fs I/O collapse
 *
 * The fix collapses each `if (existsSync(p)) { readFileSync(p) }` pattern
 * into a single `readFileSync` guarded by try/catch treating ENOENT as the
 * "file absent" branch. These tests lock the observable behavior so that
 * the optimized code is proved equivalent across all three files:
 *   1. metrics file (early-exit path when absent)
 *   2. config.json (defaults when absent)
 *   3. warn sentinel (first-warn vs debounce)
 *
 * This file has since become the home for context-monitor behaviour generally,
 * folded in rather than split into per-bug files, per the repo convention:
 *   - #2289 — output-envelope allowlist; side effects still run on silent events
 *   - #1974 — one-time critical-session breadcrumb
 *   - #3709 — PreCompact clears the warn sentinel AND the metrics bridge
 *   - #4285 — WARNING/CRITICAL fire-points resolve from .planning/config.json
 * Extend this list when folding in the next one.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const MONITOR_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
const tmpDir = os.tmpdir();

/**
 * Spawn the context-monitor hook with the given options.
 *
 * @param {object} opts
 * @param {string}  opts.sessionId     - session ID embedded in stdin payload
 * @param {string}  [opts.cwd]         - cwd in payload (defaults to tmpDir)
 * @param {boolean} [opts.writeMetrics] - if true, write a bridge file before spawn
 * @param {number}  [opts.remaining]   - remaining_percentage for bridge file
 * @param {number}  [opts.usedPct]     - used_pct for bridge file
 * @param {boolean} [opts.writeWarn]   - if true, write a warn sentinel before spawn
 * @param {object}  [opts.warnData]    - content for warn sentinel (defaults to first-warn-like data)
 * @param {object}  [opts.planningConfig] - when given, run in a throwaway project dir
 *   holding this object as .planning/config.json (#4285). Mutually exclusive with
 *   `cwd`, which the caller no longer chooses; the dir is removed on the way out.
 * @returns {{ exitCode: number, stdout: string }}
 */
function runMonitorRaw(opts) {
  const {
    sessionId,
    writeMetrics = false,
    remaining = 20,
    usedPct = 80,
    writeWarn = false,
    warnData = null,
    planningConfig = null,
  } = opts;

  // A staged config needs a project dir of its own; without one the caller's
  // cwd (tmpDir by default) is used exactly as before.
  const stagedCwd = planningConfig === null
    ? null
    : fs.mkdtempSync(path.join(tmpDir, 'gsd-4285-cfg-'));
  if (stagedCwd !== null) {
    fs.mkdirSync(path.join(stagedCwd, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(stagedCwd, '.planning', 'config.json'),
      JSON.stringify(planningConfig)
    );
  }
  const cwd = stagedCwd ?? opts.cwd ?? tmpDir;

  const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
  const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);

  if (writeMetrics) {
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: sessionId,
      remaining_percentage: remaining,
      used_pct: usedPct,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }

  if (writeWarn) {
    const wd = warnData ?? { callsSinceWarn: 0, lastLevel: null };
    fs.writeFileSync(warnPath, JSON.stringify(wd));
  }

  // #2289: explicit hook_event_name is required — the hook now emits its
  // envelope ONLY for the PostToolUse/AfterTool allowlist; a missing name
  // (non-Gemini) is silent. These callers model PostToolUse invocations.
  const input = JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'PostToolUse' });
  let stdout = '';
  let exitCode = 0;

  try {
    stdout = execFileSync(process.execPath, [MONITOR_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    stdout = e.stdout || '';
  } finally {
    try { fs.unlinkSync(metricsPath); } catch { /* already absent */ }
    try { fs.unlinkSync(warnPath); } catch { /* already absent */ }
    if (stagedCwd !== null) cleanup(stagedCwd);
  }

  return { exitCode, stdout };
}

// ─── 1. Metrics file absent → early exit 0, no stdout ────────────────────────

describe('perf #317: metrics file absent (exercises ENOENT early-exit path)', () => {
  test('exits 0 with empty stdout when metrics file does not exist', () => {
    // This is the "subagent / fresh session" path. The original code did:
    //   if (!existsSync(metricsPath)) process.exit(0)
    // The fix collapses to try/catch ENOENT → process.exit(0).
    // Both branches must produce: exit code 0, zero bytes on stdout.
    const sessionId = `test-317-no-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({ sessionId, writeMetrics: false });

    // Non-vacuous: assert the exact signature of the early-exit branch
    assert.strictEqual(exitCode, 0,
      'hook must exit 0 when metrics file is absent (subagent/fresh-session path)');
    assert.strictEqual(stdout, '',
      'hook must produce NO stdout when metrics file is absent — empty stdout is the ' +
      'unique signature of the early-exit branch; any output would mean the hook ' +
      'continued past the metrics-absent guard, proving the ENOENT branch is not taken');
  });

  test('a distinct session with a present metrics file DOES produce output (proves the absent-file test is not vacuous)', () => {
    // If the absent-file test passed vacuously (e.g. the hook never emits output
    // for ANY session), this companion test would fail — locking non-vacuousness.
    const sessionId = `test-317-has-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 20,  // below CRITICAL_THRESHOLD=25 → will emit
      usedPct: 80,
    });
    assert.ok(stdout.length > 0,
      'hook must emit JSON output when metrics ARE present and remaining <= CRITICAL_THRESHOLD; ' +
      'this proves the absent-file test above is non-vacuous');
    const parsed = JSON.parse(stdout);
    assert.ok(
      parsed?.hookSpecificOutput?.additionalContext,
      'output must contain hookSpecificOutput.additionalContext'
    );
  });
});

// ─── 2. config.json absent → uses defaults, still emits warning ──────────────

describe('perf #317: config.json absent (exercises config-missing → defaults path)', () => {
  test('emits warning using defaults when .planning/config.json is absent', () => {
    // Original code: existsSync(planningDir) guards the config read.
    // Fix collapses to: try { config = JSON.parse(readFileSync(configPath)) } catch { defaults }
    // When config.json is missing, the hook should proceed with defaults
    // (context_warnings not disabled) and emit the same warning.
    //
    // We point cwd at a temp dir that has NO .planning/config.json.
    const sessionId = `test-317-no-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testCwd = fs.mkdtempSync(path.join(tmpDir, 'gsd-317-no-config-'));

    try {
      // Metrics present, below warning threshold → should warn
      const { exitCode, stdout } = runMonitorRaw({
        sessionId,
        cwd: testCwd,
        writeMetrics: true,
        remaining: 20,
        usedPct: 80,
      });

      assert.strictEqual(exitCode, 0, 'hook should exit 0 (not crash) when config.json absent');
      assert.ok(stdout.length > 0,
        'hook should still emit a warning when config.json is absent (defaults apply)');
      const parsed = JSON.parse(stdout);
      assert.ok(
        parsed?.hookSpecificOutput?.additionalContext,
        'warning output must contain additionalContext'
      );
    } finally {
      cleanup(testCwd);
    }
  });

  test('respects context_warnings=false when config.json IS present', () => {
    // Proves the config read actually works (not just always-defaults).
    const sessionId = `test-317-config-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testCwd = fs.mkdtempSync(path.join(tmpDir, 'gsd-317-config-disabled-'));
    const planningDir = path.join(testCwd, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ hooks: { context_warnings: false } })
    );

    // Write metrics so the hook would warn if config_warnings wasn't false
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: sessionId,
      remaining_percentage: 20,
      used_pct: 80,
      timestamp: Math.floor(Date.now() / 1000),
    }));

    let exitCode = 0;
    let stdout = '';
    try {
      // #2289: send hook_event_name: 'PostToolUse' so the silence asserted below
      // is attributable ONLY to context_warnings=false, not to the hook's
      // non-injection-event silence path.
      stdout = execFileSync(process.execPath, [MONITOR_PATH], {
        input: JSON.stringify({ session_id: sessionId, cwd: testCwd, hook_event_name: 'PostToolUse' }),
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch (e) {
      exitCode = e.status ?? 1;
      stdout = e.stdout || '';
    } finally {
      try { fs.unlinkSync(metricsPath); } catch { /* noop */ }
      cleanup(testCwd);
    }

    assert.strictEqual(exitCode, 0, 'hook should exit 0 when context_warnings=false');
    assert.strictEqual(stdout, '',
      'hook should produce NO output when context_warnings=false in config.json');
  });
});

// ─── 3. Warn sentinel absent vs present (debounce behavior) ──────────────────

describe('perf #317: warn sentinel absent/present (exercises sentinel ENOENT path)', () => {
  test('emits warning on first call when warn sentinel is absent', () => {
    // Original: !existsSync(warnPath) → firstWarn=true → emit immediately.
    // Fix: try { warnData = JSON.parse(readFileSync(warnPath)) } catch { /* keep defaults */ }
    // When sentinel absent, warnData stays at default { callsSinceWarn:0, lastLevel:null }
    // and firstWarn=true → hook emits immediately.
    const sessionId = `test-317-first-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      writeWarn: false,  // sentinel absent
    });

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0,
      'hook should emit warning on first call (sentinel absent = firstWarn path)');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed?.hookSpecificOutput?.additionalContext,
      'first-warn output must contain additionalContext');
  });

  test('debounces when warn sentinel is present and callsSinceWarn is below threshold', () => {
    // Original: existsSync(warnPath) → readFileSync → warnData loaded → debounce check.
    // Fix: try { warnData = JSON.parse(readFileSync(warnPath)) } catch { defaults }
    // When sentinel present with recent warn, hook exits 0 with no output.
    const sessionId = `test-317-debounced-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      writeWarn: true,
      warnData: {
        // callsSinceWarn=1 (below DEBOUNCE_CALLS=5), same level → debounce fires
        callsSinceWarn: 1,
        lastLevel: 'warning',
      },
    });

    assert.strictEqual(exitCode, 0,
      'hook must exit 0 during debounce window');
    assert.strictEqual(stdout, '',
      'hook must emit NO output during debounce window (sentinel present, callsSinceWarn < 5)');
  });

  test('severity escalation (WARNING → CRITICAL) bypasses debounce even with sentinel present', () => {
    // Even if callsSinceWarn is low, escalating from warning to critical must fire immediately.
    // This tests the `severityEscalated` bypass path.
    const sessionId = `test-317-escalated-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { exitCode, stdout } = runMonitorRaw({
      sessionId,
      writeMetrics: true,
      remaining: 20,   // CRITICAL (below 25)
      usedPct: 80,
      writeWarn: true,
      warnData: {
        callsSinceWarn: 1,      // below DEBOUNCE_CALLS → would normally debounce
        lastLevel: 'warning',   // previous level was warning → escalation to critical
      },
    });

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.length > 0,
      'severity escalation (warning→critical) must bypass debounce and emit warning');
    const parsed = JSON.parse(stdout);
    const msg = parsed?.hookSpecificOutput?.additionalContext;
    assert.ok(msg, 'escalation output must contain additionalContext');
    assert.match(msg, /CONTEXT CRITICAL/,
      'escalated message must say CONTEXT CRITICAL');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1974-context-exhaustion-record.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1974-context-exhaustion-record (consolidation epic #1969 B6 #1975)", () => {
/**
 * Integration tests for gsd-context-monitor.js auto-record on CRITICAL (#1974).
 *
 * Verifies:
 * 1. On CRITICAL + active GSD project, the hook sets criticalRecorded in the
 *    warn sentinel AND the state record-session command writes the "Stopped At"
 *    field to STATE.md.
 * 2. Subsequent CRITICAL firings within the same session do NOT re-fire
 *    the subprocess (sentinel guard prevents repeated overwrites).
 * 3. When no .planning/STATE.md exists, the subprocess is not spawned.
 * 4. Path resolution uses __dirname, not hardcoded ~/.claude/.
 * 5. A WARNING-only fire does NOT set criticalRecorded (selectivity counter-test).
 *
 * Design note (#3726, #3775): the original test used a short wall-clock poll
 * against a fire-and-forget spawn().unref() subprocess and flaked under load.
 * We keep one deterministic assertion (criticalRecorded sentinel is written
 * before hook exit), and use a bounded poll window for the detached writer's
 * STATE.md update. A separate test verifies direct record-session invocation.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { cleanup, delay } = require('./helpers.cjs');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
const GSD_TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// Windows can hold a transient handle on the temp dir after a spawnSync child
// exits (AV scanner / handle-release lag), so cleanup()'s internal rmSync retry
// (~5s) occasionally still throws EBUSY/EPERM/ENOTEMPTY under CI load. Restore a
// bounded outer retry with async backoff via the shared delay() helper.
// Re-adds the guard removed in #482. Refs #490.
async function cleanupWithRetry(dir, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try { cleanup(dir); return; }
    catch (err) {
      const transient = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY');
      if (!transient || i === attempts - 1) throw err;
      await delay(100 * (i + 1));
    }
  }
}

/**
 * Run the hook with a given session id and context percentage.
 * Writes a bridge metrics file first, then pipes the hook input via stdin.
 * Returns after the hook exits.
 */
function runHook(sessionId, remainingPct, cwd) {
  // Write the bridge metrics file the hook reads
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    session_id: sessionId,
    remaining_percentage: remainingPct,
    used_pct: 100 - remainingPct,
    timestamp: Math.floor(Date.now() / 1000),
  }));

  // #2289: explicit hook_event_name: 'PostToolUse' so the hook takes the
  // emitting/allowlisted path — the tests in this block assert on stdout
  // content and record-session side effects, not event-name plumbing.
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'PostToolUse',
  });

  const result = runHookSeam(HOOK_PATH, [], {
    input,
    timeoutMs: 10000,
    env: { ...process.env, HOME: process.env.HOME },
  });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run gsd-tools state record-session synchronously.
 * Returns { exitCode, stdout, stderr }.
 * Used to verify the persistence seam deterministically without relying on
 * the fire-and-forget subprocess timing that caused flake (#3726).
 */
function runRecordSession(cwd, stoppedAt) {
  const result = spawnSync(
    process.execPath,
    [GSD_TOOLS, 'state', 'record-session', '--stopped-at', stoppedAt, '--cwd', cwd],
    { encoding: 'utf-8', timeout: 30000 }
  );
  return {
    exitCode: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Read and parse the warn sentinel file for a session.
 * Returns the parsed object, or null if the file does not exist.
 */
function readWarnData(sessionId) {
  const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
  try {
    return JSON.parse(fs.readFileSync(warnPath, 'utf-8'));
  } catch {
    return null;
  }
}

describe('#1974 context exhaustion auto-record', () => {
  let tmpDir;
  let statePath;
  let sessionId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1974-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    // Minimal STATE.md with Stopped At field
    statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, [
      '# Session State',
      '',
      '**Current Phase:** 1',
      '**Status:** executing',
      '**Last session:** unset',
      '**Last Date:** unset',
      '**Stopped At:** None',
      '**Resume File:** None',
      '',
    ].join('\n'));

    // Minimal config.json required by gsd-tools
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ project_code: 'TEST' }));

    sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    // cleanupWithRetry wraps cleanup() with a bounded outer retry (async setTimeout
    // backoff, no Atomics.wait) to handle cases where windows-2022 CI load keeps
    // the temp dir EBUSY beyond rmSync's internal ~5s retry window. Refs #490.
    await cleanupWithRetry(tmpDir);
    // Clean up bridge files
    try {
      const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
      if (fs.existsSync(warnPath)) fs.unlinkSync(warnPath);
      const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
      if (fs.existsSync(bridgePath)) fs.unlinkSync(bridgePath);
    } catch { /* noop */ }
  });

  test('sets criticalRecorded sentinel on CRITICAL (synchronous assertion only)', () => {
    // Trigger CRITICAL — remaining <= 25
    // The detached record-session subprocess timing assertion (waitForStateMatch,
    // 45s poll) was removed per #453 (clock-seam): flaky under load. The
    // deterministic coverage for STATE.md persistence lives in the
    // 'state record-session command persists Stopped At when invoked directly'
    // test below, which uses spawnSync instead of a fire-and-forget subprocess.
    const result = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result.exitCode, 0, `hook should exit 0: ${result.stderr}`);

    // Deterministic: hook writes criticalRecorded:true to warnPath SYNCHRONOUSLY
    // before the hook process exits, before the fire-and-forget subprocess runs.
    // Since runHook() uses spawnSync, this is guaranteed readable now.
    const warnData = readWarnData(sessionId);
    assert.ok(warnData, 'warn sentinel file must exist after CRITICAL fire');
    assert.strictEqual(
      warnData.criticalRecorded,
      true,
      'hook must set criticalRecorded:true in warn sentinel on CRITICAL'
    );
  });

  test('does NOT spawn subprocess when .planning/STATE.md is absent', () => {
    // Delete STATE.md to simulate non-GSD project
    fs.unlinkSync(statePath);

    const result = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result.exitCode, 0);

    // The hook checks isGsdActive via fs.existsSync(STATE.md) before setting
    // criticalRecorded.  If STATE.md is absent, criticalRecorded must NOT be set.
    const warnData = readWarnData(sessionId);
    // warnData may exist (hook still debounces) but criticalRecorded must be absent/falsy.
    const criticalRecorded = warnData && warnData.criticalRecorded;
    assert.ok(!criticalRecorded, 'criticalRecorded must not be set when STATE.md is absent');
    assert.ok(!fs.existsSync(statePath), 'STATE.md should not be recreated when absent');
  });

  test('sentinel prevents repeated firing within same session', () => {
    // First CRITICAL fire — should set criticalRecorded synchronously.
    const result1 = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result1.exitCode, 0, `first hook fire should exit 0: ${result1.stderr}`);

    const warnData1 = readWarnData(sessionId);
    assert.ok(warnData1, 'warn sentinel must exist after first CRITICAL fire');
    assert.strictEqual(warnData1.criticalRecorded, true, 'first fire must set criticalRecorded:true');

    // Second CRITICAL fire — same session, criticalRecorded already true in
    // warnPath.  Advance callsSinceWarn past DEBOUNCE_CALLS (5, see hook
    // line 29) so the hook processes the warning message path and exercises
    // the sentinel guard.  Using 10 (2× DEBOUNCE_CALLS) ensures we clear the
    // debounce threshold regardless of any future DEBOUNCE_CALLS adjustment.
    const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
    const warnDataPatched = { ...warnData1, callsSinceWarn: 10 };
    fs.writeFileSync(warnPath, JSON.stringify(warnDataPatched));

    const result2 = runHook(sessionId, 18, tmpDir);
    assert.strictEqual(result2.exitCode, 0, `second hook fire should exit 0: ${result2.stderr}`);

    // The warnData must still carry criticalRecorded:true — the guard was
    // active and the hook did not reset or clear it.
    const warnData2 = readWarnData(sessionId);
    assert.strictEqual(warnData2 && warnData2.criticalRecorded, true, 'sentinel must remain true after second fire');

    // The hook's stdout must still emit a CRITICAL warning message (so the
    // agent sees context warnings) even though record-session was NOT re-fired.
    const output2 = result2.stdout ? (() => { try { return JSON.parse(result2.stdout); } catch { return null; } })() : null;
    assert.ok(
      output2 && output2.hookSpecificOutput && /CONTEXT CRITICAL/.test(output2.hookSpecificOutput.additionalContext),
      'second CRITICAL fire must still emit CONTEXT CRITICAL warning to the agent'
    );
  });

  test('state record-session command persists Stopped At when invoked directly', () => {
    const recordResult = runRecordSession(tmpDir, 'context exhaustion at 80% (2026-01-01)');
    assert.strictEqual(
      recordResult.exitCode,
      0,
      `record-session should exit 0 (signal=${recordResult.signal || 'none'} error=${recordResult.error ? recordResult.error.message : 'none'}): ${recordResult.stderr}`
    );
    const content = fs.readFileSync(statePath, 'utf-8');
    assert.match(content, /context exhaustion at 80% \(2026-01-01\)/, 'STATE.md must contain direct record-session value');
  });

  test('WARNING-only fire does NOT set criticalRecorded (selectivity counter-test)', () => {
    // Trigger WARNING (remaining 30% — below WARNING_THRESHOLD=35, above CRITICAL_THRESHOLD=25)
    const result = runHook(sessionId, 30, tmpDir);
    assert.strictEqual(result.exitCode, 0, `hook should exit 0: ${result.stderr}`);

    // criticalRecorded must NOT be set on a WARNING-only fire
    const warnData = readWarnData(sessionId);
    const criticalRecorded = warnData && warnData.criticalRecorded;
    assert.ok(!criticalRecorded, 'WARNING-only fire must not set criticalRecorded');
  });

  // 'hook uses __dirname-based path (runtime-agnostic)' deleted per #453 (clock-seam):
  // source-grep of HOOK_PATH for path.join(__dirname is brittle. The behavioral equivalent
  // (hook successfully resolves gsd-tools.cjs from any working directory) is already covered
  // by the runHook() helper throughout this test file — it calls the hook from an arbitrary
  // tmpDir and all tests pass, proving __dirname-relative resolution works.
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2451-context-monitor-over-report.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2451-context-monitor-over-report (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #2451
 *
 * The GSD context monitor hook over-reports usage by ~13 percentage points
 * compared to Claude Code's native /context command. The root cause:
 *
 * gsd-statusline.js writes two values to the bridge file:
 *   - remaining_percentage: raw remaining from CC (e.g. 35%)
 *   - used_pct: normalized "usable" percentage (e.g. 78%) — accounts for
 *     the 16.5% autocompact buffer by scaling: (100 - remaining - buffer) /
 *     (100 - buffer) * 100
 *
 * gsd-context-monitor.js displays used_pct (78%) in warning messages.
 * But CC's native /context shows raw used = 100 - remaining = 65%.
 * The 13-point gap is exactly the buffer normalization overhead.
 *
 * Fix: the bridge must write used_pct as the raw value (Math.round(100 -
 * remaining)), not the buffer-normalized value. The statusline progress bar
 * continues to use the normalized value for its own display; only the bridge
 * value that feeds the context monitor needs to be raw/CC-consistent.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');
const MONITOR_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

/**
 * Run the statusline hook with a synthetic payload and return the full
 * bridge JSON object written to /tmp/claude-ctx-{sessionId}.json.
 */
function runStatuslineHook(remainingPct, totalTokens = 1_000_000, acwEnv = null) {
  const sessionId = `test-2451-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({
    model: { display_name: 'Claude' },
    workspace: { current_dir: os.tmpdir() },
    session_id: sessionId,
    context_window: {
      remaining_percentage: remainingPct,
      total_tokens: totalTokens,
    },
  });

  const env = { ...process.env };
  if (acwEnv != null) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(acwEnv);
  } else {
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }

  try {
    execFileSync(process.execPath, [HOOK_PATH], {
      input: payload,
      env,
      timeout: 4000,
    });
  } catch { /* non-zero exit is fine; we only need the bridge file */ }

  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
  fs.unlinkSync(bridgePath);
  return bridge;
}

/**
 * Run the context monitor hook with a pre-written bridge file and return
 * the parsed additionalContext string from its stdout.
 */
function runMonitorHook(remainingPct, usedPct) {
  const sessionId = `test-2451-mon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    session_id: sessionId,
    remaining_percentage: remainingPct,
    used_pct: usedPct,
    timestamp: Math.floor(Date.now() / 1000),
  }));

  // #2289: explicit hook_event_name: 'PostToolUse' — this helper's callers
  // assert on emitted message content (used_pct wording), which requires
  // the allowlisted emitting path.
  const input = JSON.stringify({ session_id: sessionId, cwd: os.tmpdir(), hook_event_name: 'PostToolUse' });
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [MONITOR_PATH], {
      input,
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch (e) {
    stdout = e.stdout || '';
  } finally {
    try { fs.unlinkSync(bridgePath); } catch { /* noop */ }
    try { fs.unlinkSync(path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`)); } catch { /* noop */ }
  }

  if (!stdout) return null;
  const out = JSON.parse(stdout);
  return out?.hookSpecificOutput?.additionalContext || null;
}

// ─── Bridge file used_pct accuracy ──────────────────────────────────────────

describe('bug #2451: bridge used_pct matches CC native reporting', () => {
  test('used_pct is raw (100 - remaining), not buffer-normalized', () => {
    // CC reports remaining_percentage=35 → CC native "used" = 100-35 = 65%
    // Buffer-normalized would give: (100 - (35-16.5)/(100-16.5)*100) ≈ 78%
    // The bridge used_pct must be 65 (raw), not 78 (normalized).
    const bridge = runStatuslineHook(35);
    assert.strictEqual(
      bridge.used_pct,
      65,
      `used_pct should be 65 (raw: 100 - 35) but got ${bridge.used_pct}. ` +
      'Buffer normalization must NOT be applied to the bridge used_pct, ' +
      'otherwise context monitor messages over-report usage by ~13 points ' +
      'compared to CC native /context (root cause of #2451).'
    );
  });

  test('used_pct is raw for high remaining (low usage scenario)', () => {
    // remaining=80 → raw used = 20
    const bridge = runStatuslineHook(80);
    assert.strictEqual(bridge.used_pct, 20,
      `used_pct should be 20 (raw: 100-80) but got ${bridge.used_pct}`);
  });

  test('used_pct is raw for near-critical remaining', () => {
    // remaining=20 → raw used = 80
    const bridge = runStatuslineHook(20);
    assert.strictEqual(bridge.used_pct, 80,
      `used_pct should be 80 (raw: 100-20) but got ${bridge.used_pct}`);
  });

  test('remaining_percentage in bridge matches raw CC value', () => {
    // The bridge remaining_percentage should be the exact raw value from CC
    const bridge = runStatuslineHook(42);
    assert.strictEqual(bridge.remaining_percentage, 42,
      'bridge remaining_percentage must be the raw CC value (no normalization)');
  });
});

// ─── Context monitor message accuracy ───────────────────────────────────────

describe('bug #2451: context monitor warning messages show CC-consistent percentages', () => {
  test('WARNING message shows raw used_pct consistent with CC reporting', () => {
    // remaining=30 → raw used=70; bridge stores used_pct=70
    // Monitor message must say "Usage at 70%", not a buffer-inflated value
    const msg = runMonitorHook(30, 70);
    assert.ok(msg, 'hook should emit a warning when remaining=30 (below WARNING_THRESHOLD=35)');
    assert.match(
      msg,
      /Usage at 70%/,
      `Warning message should say "Usage at 70%" (raw), got: ${msg}`
    );
  });

  test('CRITICAL message shows raw used_pct consistent with CC reporting', () => {
    // remaining=20 → raw used=80
    const msg = runMonitorHook(20, 80);
    assert.ok(msg, 'hook should emit a critical warning when remaining=20 (below CRITICAL_THRESHOLD=25)');
    assert.match(
      msg,
      /Usage at 80%/,
      `Critical message should say "Usage at 80%" (raw), got: ${msg}`
    );
  });

  test('gap between hook used_pct and raw CC value is at most 1 (rounding)', () => {
    // With the fix, the only acceptable deviation is ±1 due to Math.round
    const rawRemaining = 35;
    const bridge = runStatuslineHook(rawRemaining);
    const ccNativeUsed = 100 - rawRemaining; // 65
    const gap = Math.abs(bridge.used_pct - ccNativeUsed);
    assert.ok(
      gap <= 1,
      `Gap between hook used_pct (${bridge.used_pct}) and CC native used (${ccNativeUsed}) ` +
      `is ${gap} points — must be ≤1 (rounding). Larger gaps indicate buffer normalization ` +
      'is still being applied to bridge used_pct (root cause of #2451).'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-925-context-monitor-hook-event-name.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-925-context-monitor-hook-event-name (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression test for bug #925
 *
 * hooks/gsd-context-monitor.js hardcodes `hookEventName: "PostToolUse"` (or
 * "AfterTool" for Gemini) regardless of which hook event invoked it. Since
 * PR #821 the same script is also registered under Stop, SubagentStop, and
 * PreCompact in hooks/hooks.json. Claude Code rejects output whose
 * hookSpecificOutput.hookEventName doesn't echo the triggering event:
 *
 *   "expected Stop but got PostToolUse"
 *
 * Fix: derive hookEventName from the parsed stdin payload's `hook_event_name`
 * field (already available in the data object), falling back to the
 * Gemini / non-Gemini heuristic for runtimes that don't send it.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MONITOR_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

/**
 * Write a bridge metrics file and invoke the context monitor with the given
 * payload fields. Returns the parsed stdout object (or null if the hook
 * produced no output).
 *
 * remainingPct must be <= 35 to cross the WARNING threshold so the hook
 * actually emits output.
 */
function runMonitor({ hookEventName, sessionId, remainingPct = 30, usedPct = 70, env = {} }) {
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    session_id: sessionId,
    remaining_percentage: remainingPct,
    used_pct: usedPct,
    timestamp: Math.floor(Date.now() / 1000),
  }));

  const payload = { session_id: sessionId, cwd: os.tmpdir() };
  if (hookEventName !== undefined) {
    payload.hook_event_name = hookEventName;
  }

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [MONITOR_PATH], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    stdout = e.stdout || '';
  } finally {
    try { fs.unlinkSync(bridgePath); } catch { /* noop */ }
    try {
      fs.unlinkSync(path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`));
    } catch { /* noop */ }
  }

  if (!stdout) return null;
  return JSON.parse(stdout);
}

function makeSessionId(suffix) {
  return `test-925-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── hookEventName echoing ────────────────────────────────────────────────────

describe('bug #925: context monitor echoes the invoking hook event name (superseded for non-injection events by #2289)', () => {
  test('Stop is a non-injection event → silent (#2289)', () => {
    // #2289: Codex's Stop schema rejects the hookSpecificOutput envelope
    // entirely ("invalid stop hook JSON output"), so the hook must emit
    // NOTHING for Stop rather than echo it. This supersedes bug #925's
    // "echo the triggering event name" behavior for Stop specifically.
    const out = runMonitor({ hookEventName: 'Stop', sessionId: makeSessionId('stop') });
    assert.strictEqual(out, null, 'Stop is a non-injection event → silent (#2289)');
  });

  test('SubagentStop is a non-injection event → silent (#2289)', () => {
    // #2289: same rationale as Stop above — non-injection events get no envelope.
    const out = runMonitor({ hookEventName: 'SubagentStop', sessionId: makeSessionId('subagent-stop') });
    assert.strictEqual(out, null, 'SubagentStop is a non-injection event → silent (#2289)');
  });

  test('PreCompact is a non-injection event → silent (#2289)', () => {
    // #2289: same rationale as Stop above — non-injection events get no envelope.
    const out = runMonitor({ hookEventName: 'PreCompact', sessionId: makeSessionId('precompact') });
    assert.strictEqual(out, null, 'PreCompact is a non-injection event → silent (#2289)');
  });

  test('hookEventName is "PostToolUse" when payload contains hook_event_name: "PostToolUse"', () => {
    const out = runMonitor({ hookEventName: 'PostToolUse', sessionId: makeSessionId('posttools') });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'PostToolUse',
      `Expected hookEventName "PostToolUse" but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });
});

// ─── Fallback behaviour (no hook_event_name in payload) ──────────────────────

describe('bug #925: context monitor falls back to heuristic when hook_event_name absent (non-Gemini fallback now silent per #2289)', () => {
  test('absent hook_event_name (non-Gemini) is now silent (#2289)', () => {
    // #2289: a missing hook_event_name without GEMINI_API_KEY set used to fall
    // back to "PostToolUse" and emit. It is now a non-injection case → silent,
    // since we cannot positively confirm this is a context-injection-capable
    // invocation without either an allowlisted event name or the Gemini signal.
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    const out = runMonitor({
      hookEventName: undefined,
      sessionId: makeSessionId('fallback-non-gemini'),
      env: { GEMINI_API_KEY: '' }, // ensure unset
    });
    assert.strictEqual(out, null, 'absent hook_event_name (non-Gemini) is now silent (#2289)');
  });

  test('falls back to "AfterTool" when hook_event_name is absent and GEMINI_API_KEY is set', () => {
    // Unchanged by #2289: this is the Gemini fallback, which remains an
    // explicit allowlisted emitting path.
    const out = runMonitor({
      hookEventName: undefined,
      sessionId: makeSessionId('fallback-gemini'),
      env: { GEMINI_API_KEY: 'fake-key-for-test' },
    });
    assert.ok(out, 'hook must emit output when context is below WARNING threshold');
    assert.strictEqual(
      out.hookSpecificOutput?.hookEventName,
      'AfterTool',
      `Expected fallback "AfterTool" for Gemini but got "${out.hookSpecificOutput?.hookEventName}".`
    );
  });

  test('empty-string hook_event_name (non-Gemini) is now silent (#2289)', () => {
    // #2289: an empty hook_event_name without GEMINI_API_KEY is treated the
    // same as absent — non-injection case → silent.
    const out = runMonitor({
      hookEventName: '',
      sessionId: makeSessionId('fallback-empty'),
      env: { GEMINI_API_KEY: '' },
    });
    assert.strictEqual(out, null, 'empty-string hook_event_name (non-Gemini) is now silent (#2289)');
  });

  test('whitespace-only hook_event_name (non-Gemini) is now silent (#2289)', () => {
    // trim() makes "   " → "" which is falsy; #2289: this now takes the
    // non-injection silent path rather than falling back to "PostToolUse".
    const out = runMonitor({
      hookEventName: '   ',
      sessionId: makeSessionId('fallback-whitespace'),
      env: { GEMINI_API_KEY: '' },
    });
    assert.strictEqual(out, null, 'whitespace-only hook_event_name (non-Gemini) is now silent (#2289)');
  });
});

// ─── Critical threshold also echoes the event name ───────────────────────────

describe('bug #925: critical threshold warning also uses correct hookEventName', () => {
  test('CRITICAL under Stop is silent (Codex rejects the Stop envelope) (#2289)', () => {
    // #2289: even at CRITICAL severity, Stop is a non-injection event whose
    // schema (Codex) rejects the hookSpecificOutput envelope outright. The
    // hook must emit nothing rather than echo "Stop", superseding bug #925's
    // "echoes Stop" expectation for this event specifically.
    const out = runMonitor({
      hookEventName: 'Stop',
      sessionId: makeSessionId('critical-stop'),
      remainingPct: 20,
      usedPct: 80,
    });
    assert.strictEqual(out, null, 'CRITICAL under Stop must be silent — no envelope for a non-injection event (#2289)');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-2289-context-monitor-event-allowlist.test.cjs — H3 test-hygiene (#3315/#3334)
//
// Dropped as exact duplicates already covered by the "folded:bug-925-context-
// monitor-hook-event-name" section above:
//   - "missing hook_event_name (no Gemini) at 30% → empty stdout" (dupe of
//     "absent hook_event_name (non-Gemini) is now silent (#2289)")
//   - "empty-string hook_event_name (no Gemini) at 30% → empty stdout" (this
//     test actually used a whitespace-only event name '   '; dupe of
//     "whitespace-only hook_event_name (non-Gemini) is now silent (#2289)")
//   - "missing event name WITH Gemini env at 30% → AfterTool envelope
//     (fallback preserved)" (dupe of "falls back to \"AfterTool\" when
//     hook_event_name is absent and GEMINI_API_KEY is set")
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-2289-context-monitor-event-allowlist (#3315/#3334)", () => {
/**
 * #2289 — gsd-context-monitor lifecycle-event output allowlist.
 *
 * The context monitor emits a `hookSpecificOutput.additionalContext` envelope
 * to inject context warnings. That shape is only valid for the context-injection
 * events (PostToolUse, and AfterTool for the Gemini dialect). Codex also wires
 * this hook to Stop / SubagentStart / SubagentStop / PreCompact (#772), and
 * Codex's Stop schema REJECTS the envelope ("hook returned invalid stop hook
 * JSON output"). The fix uses a positive allowlist: emit only for
 * injection-capable events; every other event — and a missing/unknown name —
 * exits 0 with NO stdout, while side effects (debounce, critical-session
 * recording) still run.
 *
 * These tests drive the real hook script end-to-end (spawn + stdin + a fresh
 * metrics bridge file), asserting behavior, not source text.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');

// Run the monitor with a synthetic, fresh metrics bridge file.
// Returns { stdout, warnData } and cleans up the bridge + sentinel files.
// opts: { event, remaining, used = 80, gemini = false, gsdActive = false }
function runMonitor(opts) {
  const {
    event,
    remaining,
    used = 80,
    gemini = false,
    gsdActive = false,
  } = opts;

  const sessionId = `fix-2289-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpDir = os.tmpdir();
  const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
  const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);

  // Fresh (non-stale) metrics: timestamp is "now" in seconds.
  fs.writeFileSync(metricsPath, JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    remaining_percentage: remaining,
    used_pct: used,
  }));

  // Optional GSD-active project dir (STATE.md present) so the critical-session
  // recording side effect is reachable.
  let cwd = tmpDir;
  let projDir = null;
  if (gsdActive) {
    projDir = fs.mkdtempSync(path.join(tmpDir, 'fix-2289-proj-'));
    fs.mkdirSync(path.join(projDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.planning', 'STATE.md'), '# State\n');
    cwd = projDir;
  }

  const payload = { session_id: sessionId, cwd };
  if (event !== undefined) payload.hook_event_name = event;

  const env = { ...process.env };
  if (gemini) env.GEMINI_API_KEY = 'test-key';
  else delete env.GEMINI_API_KEY;

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload),
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
  } catch (e) {
    stdout = e.stdout || '';
  }

  let warnData = null;
  try {
    warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
  } catch { /* sentinel may not exist */ }

  // Cleanup
  for (const p of [metricsPath, warnPath]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  if (projDir) {
    // Retry-tolerant teardown: the critical path fires a detached, unref()'d
    // `state record-session` grandchild against projDir, and execFileSync does
    // not wait for it. maxRetries/retryDelay absorbs the transient
    // EBUSY/ENOTEMPTY window while that process exits, so cleanup can neither
    // flake nor leak the temp dir (mirrors tests/helpers.cjs cleanup(); see the
    // #2289 review and the prior fix in perf-317-context-monitor-fs.test.cjs).
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- test fixture teardown of a unique mkdtemp dir
    try { fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  }

  return { stdout, warnData };
}

describe('#2289 context-monitor: non-injection events exit silently', () => {
  // Boundary coverage around WARNING (35) and CRITICAL (25) — Stop must stay
  // silent at limit-1 / limit / limit+1 for BOTH thresholds.
  for (const remaining of [40, 36, 35, 34, 26, 25, 24, 20]) {
    test(`Stop event at remaining=${remaining}% → exit 0, empty stdout`, () => {
      const { stdout } = runMonitor({ event: 'Stop', remaining });
      assert.strictEqual(stdout, '', `Stop must emit nothing at remaining=${remaining}% (Codex rejects the envelope)`);
    });
  }

  for (const event of ['SubagentStart', 'SubagentStop', 'PreCompact', 'SessionStart', 'BeforeTool']) {
    test(`unknown/non-injection event "${event}" at 30% → empty stdout`, () => {
      const { stdout } = runMonitor({ event, remaining: 30 });
      assert.strictEqual(stdout, '', `${event} is not injection-capable and must emit nothing`);
    });
  }
});

describe('#2289 context-monitor: injection events still warn (unchanged)', () => {
  test('PostToolUse at 30% → WARNING envelope with hookEventName PostToolUse', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 30, used: 70 });
    assert.notStrictEqual(stdout, '', 'PostToolUse must still emit a warning envelope');
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.strictEqual(parsed.hookSpecificOutput.severity, 'warning');
  });

  test('PostToolUse at 20% → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 20, used: 80 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.strictEqual(parsed.hookSpecificOutput.severity, 'critical');
  });

  test('AfterTool at 30% → WARNING envelope with hookEventName AfterTool', () => {
    const { stdout } = runMonitor({ event: 'AfterTool', remaining: 30 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'AfterTool');
    assert.strictEqual(parsed.hookSpecificOutput.severity, 'warning');
  });

  test('explicit PostToolUse WITH Gemini env → explicit name wins over the AfterTool fallback', () => {
    // Precedence guard: the Gemini fallback only applies to a MISSING name; an
    // explicit PostToolUse must still report as PostToolUse even under GEMINI_API_KEY.
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 30, gemini: true });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.strictEqual(parsed.hookSpecificOutput.severity, 'warning');
  });

  // Threshold boundaries on the emit path: 36 = no warn, 35 = warn, 25 = critical, 26 = warn.
  test('PostToolUse at 36% (above WARNING) → empty stdout', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 36 });
    assert.strictEqual(stdout, '', 'no warning above the 35% threshold');
  });

  test('PostToolUse at 35% (WARNING boundary) → WARNING envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 35 });
    assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.severity, 'warning');
  });

  test('PostToolUse at 25% (CRITICAL boundary) → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 25 });
    assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.severity, 'critical');
  });

  // Review of #3709 (Major 3): complete the limit-1/limit/limit+1 trios on the
  // EMIT path for both thresholds. 36/35 (WARNING) and 25 (CRITICAL) are pinned
  // above; these close the trios. 26 is the row that separates the two
  // comparisons — a `< CRITICAL_THRESHOLD` regression keeps 25 CRITICAL-looking
  // tests green while silently reclassifying nothing, but 24-as-CRITICAL plus
  // 26-as-WARNING-not-CRITICAL pins the `<=` on both sides.
  test('PostToolUse at 34% (WARNING limit-1) → still WARNING envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 34 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('PostToolUse at 26% (CRITICAL limit+1) → WARNING, not CRITICAL', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 26 });
    const msg = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(msg, /CONTEXT WARNING/, '26% is inside WARNING territory');
    assert.doesNotMatch(msg, /CONTEXT CRITICAL/,
      '26% must NOT be CRITICAL — the threshold is `remaining <= 25`, and one-off-the-limit is '
      + 'exactly where an off-by-one in the comparison hides');
  });

  test('PostToolUse at 24% (CRITICAL limit-1) → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 24 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
  });
});

describe('#2289 context-monitor: side effects still fire on silent events (no output ≠ no side effect)', () => {
  test('Stop at 30% still writes the debounce sentinel (bookkeeping runs)', () => {
    const { stdout, warnData } = runMonitor({ event: 'Stop', remaining: 30 });
    assert.strictEqual(stdout, '', 'Stop emits nothing');
    assert.ok(warnData, 'the debounce sentinel must still be written on a silenced Stop event');
    assert.strictEqual(warnData.lastLevel, 'warning', 'debounce level bookkeeping runs regardless of output');
  });

  test('Stop at 20% in a GSD project still records the critical-session sentinel', () => {
    const { stdout, warnData } = runMonitor({ event: 'Stop', remaining: 20, used: 80, gsdActive: true });
    assert.strictEqual(stdout, '', 'Stop emits nothing even at critical context');
    assert.ok(warnData, 'sentinel must be written');
    assert.strictEqual(warnData.criticalRecorded, true, 'critical-session recording side effect fires on the silent Stop event');
  });
});
  });
}

/**
 * #3709 — the warn sentinel must not survive a compaction.
 *
 * The hook was already wired to PreCompact (#772), but read the event only at
 * the END, to pick an output envelope. So `lastLevel` stayed pinned at
 * 'critical' for the rest of the session and two DOCUMENTED behaviours died:
 * "First warning always fires immediately" and "Severity escalation
 * (WARNING -> CRITICAL) bypasses debounce" (the context-monitor reference,
 * "Debounce" section) — the latter computed as `lastLevel === 'warning'`, which can never be true again.
 *
 * These rows drive a SEQUENCE against one session id, because the defect is
 * about state carried ACROSS calls. The helpers above deliberately delete the
 * sentinel after every invocation, so this block needs its own driver.
 */
describe('#3709 context-monitor: PreCompact resets the warn sentinel', () => {
  const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
  const UNLINK_EPERM_PRELOAD = path.join(__dirname, 'helpers', 'context-monitor-unlink-eperm-preload.cjs');
  // Same clock-pinning seam the threshold trios below use, available here so a
  // row whose CLAIM is about timing can drive the real sequence with exact
  // arithmetic rather than a future-stamped bridge (round 4, Major 1).
  const NOW_PRELOAD = path.join(__dirname, 'helpers', 'context-monitor-fixed-now-preload.cjs');
  // A fixed instant for the rows that drive the compaction sequence by exact
  // arithmetic. Any stable value works; this one is far from any real clock so
  // an unpinned child cannot accidentally satisfy the assertions.
  const SEQ_NOW_MS = 1_800_000_000_000;
  const SEQ_NOW_S = Math.floor(SEQ_NOW_MS / 1000);

  function makeSession(t, { gsdActive = false, contextWarnings = null } = {}) {
    const dir = os.tmpdir();
    const id = `fix-3709-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metricsPath = path.join(dir, `claude-ctx-${id}.json`);
    const warnPath = path.join(dir, `claude-ctx-${id}-warned.json`);
    const watermarkPath = path.join(dir, `claude-ctx-${id}-compacted.json`);
    let cwd = dir;
    let projDir = null;
    if (gsdActive) {
      projDir = fs.mkdtempSync(path.join(dir, 'fix-3709-proj-'));
      fs.mkdirSync(path.join(projDir, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(projDir, '.planning', 'STATE.md'), '# State\n');
      if (contextWarnings !== null) {
        fs.writeFileSync(path.join(projDir, '.planning', 'config.json'),
          JSON.stringify({ hooks: { context_warnings: contextWarnings } }));
      }
      cwd = projDir;
    }
    t.after(() => {
      for (const p of [metricsPath, warnPath, watermarkPath]) { try { fs.unlinkSync(p); } catch { /* absent */ } }
      if (projDir) { try { cleanup(projDir); } catch { /* best effort */ } }
    });

    return {
      warnPath,
      watermarkPath,
      metricsPath,
      // Drive one hook invocation at a given remaining%, WITHOUT touching the
      // sentinel — that is the state under test. `metrics` selects how the
      // statusline bridge is presented:
      //   true    — write a fresh reading (the default)
      //   false   — no bridge at all, how a real PreCompact arrives
      //   'keep'  — leave whatever is already there, STALE. This is the shape the
      //             Major 1 rows need: after a compaction the bridge still holds
      //             the pre-compaction reading until the statusline next renders.
      //             Using `false` there would delete the very thing under test and
      //             the row would pass for the wrong reason.
      //
      // Returns the EXIT CODE as well as stdout. An earlier version swallowed the
      // exit status, which made `assert.doesNotThrow` vacuous: a hook that exited
      // 1 on an ENOENT unlink would still have passed, because the assertion only
      // saw the helper's own catch.
      // `failUnlinkMatching` injects an EPERM into the CHILD's fs.unlinkSync for
      // every path containing the given substring, via --require preload — the
      // review-of-#3709 (Blocker 2) seam for the unlink-failure fallback. Method
      // monkeypatching, never chmod 0o000: root bypasses mode bits under
      // Docker/CI, so a chmod row passes with zero coverage.
      // `lstatClaimsFileMatching` additionally makes the child's lstat report a
      // REGULAR FILE for matching paths — the lstat→open substitution-race
      // shape, so the O_NOFOLLOW backstop is the guard actually exercised
      // (review of #3808, round 3, Minor 3).
      // `nowMs` pins the CHILD's Date.now via the same --require seam the
      // STALE trio uses, and `bridgeTimestamp` stamps the bridge explicitly.
      // Together they let a row drive the real production sequence with exact
      // arithmetic instead of a future-stamped reading (review of #3808,
      // round 4, Major 1).
      //
      // `env` overrides the child's environment. Without it the child
      // inherited process.env wholesale, so two rows silently depended on
      // ambient GEMINI_API_KEY and failed outright on any machine or CI lane
      // that set it (review of #3808, round 4, Major 2). The sibling
      // `runMonitor` helper in this file has taken an explicit env for exactly
      // this reason all along. A key set to `undefined` is UNSET in the child,
      // which is what pinning an ambient variable requires.
      call(event, remaining, {
        metrics = true,
        failUnlinkMatching = null,
        lstatClaimsFileMatching = null,
        shrinkAfterLstatMatching = null,
        shortWriteMarker = null,
        nowMs = null,
        bridgeTimestamp = null,
        env: envOverrides = null,
      } = {}) {
        if (metrics === 'keep') {
          // leave the bridge exactly as the previous call left it
        } else if (metrics) {
          fs.writeFileSync(metricsPath, JSON.stringify({
            session_id: id,
            remaining_percentage: remaining,
            used_pct: 100 - remaining,
            // Default +62s: deliberately beyond the compaction grace window
            // (COMPACT_GRACE_SECONDS=60, +2 for the same-second start). These
            // tests run PreCompact and the next PostToolUse inside one second,
            // while a real post-compaction WARNING arrives minutes later when
            // the context re-climbs — inside the grace window every alarming
            // reading is dropped BY DESIGN (a mid-compaction render is
            // indistinguishable from it). Future-stamping models "a reading
            // from after the window" without touching the staleness math (a
            // negative age is never > 60).
            //
            // It is a MODELLING SHORTCUT, not a shape the real writer emits:
            // hooks/gsd-statusline.js always stamps Math.floor(Date.now()/1000)
            // on the same clock. Rows whose CLAIM is about the timing itself
            // must not rest on it — they pass `nowMs` + `bridgeTimestamp` and
            // drive the real sequence instead (round 4, Major 1).
            timestamp: bridgeTimestamp == null
              ? Math.floor(Date.now() / 1000) + 62
              : bridgeTimestamp,
          }));
        } else {
          try { fs.unlinkSync(metricsPath); } catch { /* already absent */ }
        }
        let stdout = '';
        let exitCode = 0;
        const usePreload = failUnlinkMatching || lstatClaimsFileMatching || shrinkAfterLstatMatching || shortWriteMarker;
        const preloads = [];
        if (usePreload) preloads.push('--require', UNLINK_EPERM_PRELOAD);
        if (nowMs != null) preloads.push('--require', NOW_PRELOAD);
        const argv = [...preloads, HOOK];
        const env = {
          ...process.env,
          ...(failUnlinkMatching ? { GSD_TEST_UNLINK_EPERM_MATCH: failUnlinkMatching } : {}),
          ...(lstatClaimsFileMatching ? { GSD_TEST_LSTAT_CLAIMS_FILE_MATCH: lstatClaimsFileMatching } : {}),
          ...(shrinkAfterLstatMatching ? { GSD_TEST_SHRINK_AFTER_LSTAT_MATCH: shrinkAfterLstatMatching } : {}),
          ...(shortWriteMarker ? { GSD_TEST_SHORT_WRITE_MATCH: shortWriteMarker } : {}),
          ...(nowMs != null ? { GSD_TEST_NOW_MS: String(nowMs) } : {}),
          ...(envOverrides || {}),
        };
        for (const k of Object.keys(env)) { if (env[k] === undefined) delete env[k]; }
        try {
          stdout = execFileSync(process.execPath, argv, {
            input: JSON.stringify({ session_id: id, cwd, hook_event_name: event }),
            encoding: 'utf8',
            timeout: 8000,
            env,
          });
        } catch (e) { stdout = e.stdout || ''; exitCode = e.status ?? 1; }
        return { stdout: String(stdout), exitCode };
      },
      warn() {
        try { return JSON.parse(fs.readFileSync(warnPath, 'utf8')); } catch { return null; }
      },
      // Raw file contents (or null when absent) — the truncation rows assert on
      // the exact byte content, because `warn()` cannot distinguish "absent"
      // from "present but unparseable", and that distinction IS the fallback.
      warnRaw() {
        try { return fs.readFileSync(warnPath, 'utf8'); } catch { return null; }
      },
      metricsRaw() {
        try { return fs.readFileSync(metricsPath, 'utf8'); } catch { return null; }
      },
      // The bridge filename (claude-ctx-<id>.json) ends with this, the sentinel
      // (claude-ctx-<id>-warned.json) and watermark (claude-ctx-<id>-compacted
      // .json) do not — a match string that fails ONLY the bridge unlink.
      bridgeMatch: `${id}.json`,
      metrics() {
        try { return JSON.parse(fs.readFileSync(metricsPath, 'utf8')); } catch { return null; }
      },
      watermark() {
        try { return JSON.parse(fs.readFileSync(watermarkPath, 'utf8')); } catch { return null; }
      },
      // Write the bridge EXACTLY as given (plus session_id) — the statusline-
      // race rows need full control of the timestamp, which call()'s fresh
      // stamp deliberately does not offer.
      writeBridge(fields) {
        fs.writeFileSync(metricsPath, JSON.stringify({ session_id: id, ...fields }));
      },
      seed(data) { fs.writeFileSync(warnPath, JSON.stringify(data)); },
    };
  }

  test('AC1: a PreCompact event clears a sentinel pinned at critical', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    s.call('PreCompact', 20);
    assert.strictEqual(s.warnRaw(), null,
      'the sentinel must be GONE after a compaction — a compact restarts the context lifecycle, '
      + 'so carrying lastLevel:critical across it disables escalation for the rest of the session');
  });

  test('AC1: PreCompact is tolerant of the sentinel already being absent', (t) => {
    const s = makeSession(t);
    assert.strictEqual(s.warnRaw(), null, 'precondition: no sentinel');
    // Asserted on the EXIT CODE, not on "did not throw". The driver catches every
    // child failure, so doesNotThrow would hold even for a hook that exited 1 on
    // the ENOENT unlink — the row would have proved nothing.
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0,
      'the common case is no warning having fired this cycle; an absent sentinel is success, and a '
      + 'compaction must never be failed by this hook');
    assert.strictEqual(s.warnRaw(), null, 'and it stays absent');
  });

  // Review of #3709: every other row writes a fresh metrics file, so the reset could
  // be moved BELOW the metrics read, the stale check or the healthy-threshold exit
  // and all of them would stay green — while a real PreCompact, which carries no
  // fresh metrics and follows a recovery to healthy usage, silently kept its
  // sentinel. These two rows pin the placement itself.
  test('placement: the reset fires with NO metrics file at all', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    const r = s.call('PreCompact', 20, { metrics: false });
    assert.strictEqual(r.exitCode, 0, 'a PreCompact without metrics must still exit cleanly');
    assert.strictEqual(s.warnRaw(), null,
      'a real PreCompact carries no bridge metrics — if the reset sat below the metrics read, the '
      + 'ENOENT branch would exit first and the sentinel would survive every genuine compaction');
  });

  test('placement: the reset fires when usage has recovered to healthy', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    // 80% remaining is above the WARNING threshold — the shape right after a
    // compaction, and an early `process.exit(0)` for every path below the reset.
    assert.strictEqual(s.call('PreCompact', 80).exitCode, 0);
    assert.strictEqual(s.warnRaw(), null,
      'post-compaction usage is healthy again, so a reset placed below the above-threshold exit '
      + 'would never run — which is exactly the state the issue reported in a live session');
  });

  // Review of #3709: the config gate is an early exit that sits ABOVE the reset's
  // original position, so a session that disabled warnings, compacted, and then
  // re-enabled them resurrected the stale sentinel and the bug with it. Config is
  // re-read per invocation, so that sequence is supported, not hypothetical.
  test('placement: the reset fires even when context warnings are disabled', (t) => {
    const s = makeSession(t, { gsdActive: true, contextWarnings: false });
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0);
    assert.strictEqual(s.warnRaw(), null,
      'clearing the sentinel is CLEANUP, not a warning — state that must not outlive a compaction '
      + 'should not outlive it merely because warnings are switched off for now');
  });

  // AC2 and AC3 drive the REAL post-compaction sequence, on a pinned clock,
  // with the bridge stamped the way hooks/gsd-statusline.js stamps it
  // (Math.floor(Date.now()/1000), never ahead of the reader).
  //
  // An earlier cut drove them through call()'s default bridge, stamped 62
  // seconds in the FUTURE — a shape the real writer cannot produce on the same
  // machine and clock. That proved only "the sentinel was cleared" while the
  // assertion messages claimed the documented immediate-warning behaviour,
  // which in production is gated behind the grace window and went unexercised;
  // a future hardening that rejected future-stamped readings would have redded
  // both rows with no real regression behind it (review of #3808, round 4,
  // Major 1). The clock-pinning seam already existed for the STALE trio and is
  // simply reused here, so the timing these rows CLAIM is the timing they RUN.
  test('AC2: after a compaction the first WARNING fires immediately, not debounced', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    // A real PreCompact carries no fresh bridge reading.
    assert.strictEqual(s.call('PreCompact', 20, { metrics: false, nowMs: SEQ_NOW_MS }).exitCode, 0);
    assert.strictEqual(s.watermark().at, SEQ_NOW_S,
      'the watermark is stamped on the pinned clock — the arithmetic below is exact, not a race');
    // The statusline's first render after the compaction completes and the
    // context has re-climbed: current reading, current stamp, one second past
    // the grace window.
    s.writeBridge({ remaining_percentage: 30, used_pct: 70, timestamp: SEQ_NOW_S + 61 });
    const { stdout } = s.call('PostToolUse', 30, { metrics: 'keep', nowMs: SEQ_NOW_MS + 61_000 });
    assert.match(stdout, /CONTEXT WARNING/,
      'The context-monitor reference states "First warning always fires immediately". Before the fix '
      + 'this was silently debounced: the surviving sentinel made it look like a repeat warning');
  });

  test('AC3: after a compaction a WARNING -> CRITICAL escalation bypasses debounce', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20, { metrics: false, nowMs: SEQ_NOW_MS }).exitCode, 0);
    s.writeBridge({ remaining_percentage: 30, used_pct: 70, timestamp: SEQ_NOW_S + 61 });
    s.call('PostToolUse', 30, { metrics: 'keep', nowMs: SEQ_NOW_MS + 61_000 });
    assert.strictEqual(s.warn().lastLevel, 'warning', 'the fresh cycle recorded a WARNING');
    s.writeBridge({ remaining_percentage: 20, used_pct: 80, timestamp: SEQ_NOW_S + 62 });
    const { stdout } = s.call('PostToolUse', 20, { metrics: 'keep', nowMs: SEQ_NOW_MS + 62_000 });
    assert.match(stdout, /CONTEXT CRITICAL/,
      'The context-monitor reference states "Severity escalation (WARNING -> CRITICAL) bypasses '
      + 'debounce". That bypass is `lastLevel === "warning"`, unreachable while a stale sentinel lives');
  });

  test('AC4: after a compaction the critical-session breadcrumb can be recorded again', (t) => {
    const s = makeSession(t, { gsdActive: true });
    // A distinguishing marker, because asserting `criticalRecorded === true` alone
    // is VACUOUS here — the stale sentinel already carries true, so the row would
    // pass with or without the fix. The marker can only survive by the sentinel
    // surviving, so its absence is what proves the state was REBUILT rather than
    // carried across the compaction.
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true, staleProbe: 'pre-compact' });
    s.call('PreCompact', 20);
    s.call('PostToolUse', 20);
    const after = s.warn();
    assert.strictEqual(after.staleProbe, undefined,
      'the post-compaction sentinel must be a NEW file — any field carried over means the pre-compact '
      + 'state survived, and with it the sticky criticalRecorded guard');
    assert.strictEqual(after.criticalRecorded, true,
      'criticalRecorded is equally sticky: without the reset the #1974 /gsd:resume-work breadcrumb '
      + 'keeps describing the earlier near-miss instead of the exhaustion that ended the session');
  });

  // Review of #3709, Major 1. Every row above writes a FRESH metrics file before
  // each call, which is precisely the shape real life does not guarantee. The
  // statusline owns the bridge and rewrites it on render; between the compaction
  // and that next render the bridge still holds the PRE-compaction reading, and
  // STALE_SECONDS is 60, so it still reads fresh and still says "exhausted".
  //
  // Clearing only the sentinel turned that window into a spurious CRITICAL fired
  // immediately after the compaction that freed the context — and a FALSE
  // exhaustion breadcrumb, the same inaccuracy #3709 exists to fix, from the
  // other side. So the compaction clears the reading as well as the state.
  test('Major 1: a PreCompact leaves no stale reading for the next tool use', (t) => {
    const s = makeSession(t, { gsdActive: true });
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    s.call('PreCompact', 20);
    // 'keep', NOT false: the defect is a bridge that is still THERE and still
    // reads fresh. Deleting it would make the row pass on the ENOENT early-exit
    // instead of on the fix — vacuous, and it was, until a mutation showed it.
    //
    // HONEST SCOPE (Codex review of #3808, round 4): this row asserts the
    // COMPOSED post-compaction behaviour, not bridge deletion in isolation. Its
    // sensitivity to a bridge-deletion regression rests on call()'s future
    // stamp; with a production stamp the watermark would suppress the same
    // reading and the row would stay green either way. The two guards genuinely
    // overlap inside the window, so no end-to-end row can separate them. The
    // DIRECT pin for bridge deletion is the next row, which asserts
    // s.metrics() === null and cannot be satisfied by the watermark.
    const { stdout } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(stdout, '',
      'the next tool use after a compaction must not warn off a pre-compaction reading — the '
      + 'context was just FREED, so telling the agent to stop is exactly backwards');
    assert.strictEqual(s.warnRaw(), null,
      'and criticalRecorded must not be re-armed off that stale reading, or the session records a '
      + 'context-exhaustion breadcrumb for an exhaustion that did not happen');
  });

  test('Major 1: the compaction clears the metrics bridge itself', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    s.call('PreCompact', 20);
    assert.strictEqual(s.metrics(), null,
      'the bridge holds the reading that produced the warning state; a compaction invalidates '
      + 'both, and the statusline rewrites it on the next render');
  });

  test('AC5 (non-vacuity): a NON-compaction lifecycle event does NOT clear the sentinel', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    const { stdout } = s.call('Stop', 20);
    assert.strictEqual(stdout, '', 'Stop stays silent (#2289)');
    assert.ok(s.warn(), 'Stop must NOT clear the sentinel — if this fails the reset is firing for '
      + 'every event, not just PreCompact, and the debounce is gone entirely');
  });

  test('PreCompact does not consume a debounce slot', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'warning' });
    s.call('PreCompact', 20);
    // Asserted at the OBSERVABLE consequence rather than on the sentinel being
    // absent, which AC1 already covers: the whole side-effect pipeline used to
    // run for PreCompact, advancing callsSinceWarn 0 -> 1 and eating a slot from
    // the very cycle the compaction was supposed to restart. If a slot were
    // still consumed, this first post-compaction warning would be debounced.
    const { stdout } = s.call('PostToolUse', 30);
    assert.match(stdout, /CONTEXT WARNING/,
      'the cycle after a compaction starts fresh, so its first warning fires immediately');
  });

  // Review of #3709, Blockers 1+2. The unlink-failure fallback is the branch a
  // held Windows handle takes, and it used to write well-formed NEUTRAL values —
  // which are not equivalent to deletion on either path. These rows execute the
  // branch for real (EPERM injected into the child's fs.unlinkSync via preload)
  // and pin each half at its observable consequence. The '' assertions are also
  // the proof the injection fired: a preload that failed to match would let the
  // unlink succeed and leave `null`, not ''.
  //
  // WINDOWS: the truncating write-open itself fails DETERMINISTICALLY on the CI
  // runners (observed on both windows-latest lanes: files freshly written by
  // the parent are held with a share mode that allows DELETE — every
  // real-unlink row passes — but refuses a write-open, so the give-up arm
  // engages). The fallback is best-effort BY DESIGN, so the rows tolerate the
  // give-up there, but still pin the Blocker-1 class on every platform: the
  // only legal states are TRUNCATED or UNTOUCHED — a parseable neutral value
  // ('{}' / '{"timestamp":0}') is never legal anywhere. The behavioural
  // follow-ons are asserted only where the truncation actually landed.
  test('Blocker: sentinel unlink EPERM → truncated to empty, and AC2 still holds on this path', (t) => {
    const s = makeSession(t);
    const seeded = { callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true };
    s.seed(seeded);
    const r = s.call('PreCompact', 20, { failUnlinkMatching: '-warned.json' });
    assert.strictEqual(r.exitCode, 0, 'a failed unlink must never fail the compaction');
    const raw = s.warnRaw();
    if (process.platform === 'win32') {
      assert.ok(raw === '' || raw === JSON.stringify(seeded),
        `sentinel must be truncated or untouched, never a neutral value; got ${JSON.stringify(raw)} — `
        + 'the old {} parsed fine, so firstWarn was false and the first post-compaction warning '
        + 'was debounced: AC2 of #3709 undone on exactly the path the fallback exists for');
      if (raw !== '') {
        // A VISIBLE skip, never a silent if: a platform that stops reaching
        // the behavioural half must show in the run output rather than count
        // as a pass (review of #3808, round 3, Minor 5).
        t.skip('truncation did not land (Windows share-mode hold on fresh files) — the '
          + 'neutral-value class is pinned above; the behavioural follow-on is provable only '
          + 'where truncation lands, and the POSIX lanes prove it');
        return;
      }
    } else {
      assert.strictEqual(raw, '',
        'the sentinel must be TRUNCATED TO EMPTY, which JSON.parse rejects — the old neutral {} '
        + 'parsed fine, so firstWarn was false and the first post-compaction warning was debounced: '
        + 'AC2 of #3709 still unfixed on exactly the path the fallback exists for');
    }
    const { stdout } = s.call('PostToolUse', 30);
    assert.match(stdout, /CONTEXT WARNING/,
      'an unparseable sentinel IS the reset: the first warning of the new cycle fires immediately');
  });

  test('Blocker: bridge unlink EPERM → truncated to empty, silent — never "Usage at undefined%"', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    const r = s.call('PreCompact', 20, { failUnlinkMatching: s.bridgeMatch });
    assert.strictEqual(r.exitCode, 0, 'a failed unlink must never fail the compaction');
    const raw = s.metricsRaw();
    if (process.platform === 'win32') {
      assert.ok(raw === '' || (raw !== null && (JSON.parse(raw).timestamp || 0) > 0),
        `bridge must be truncated or untouched, never a neutral value; got ${JSON.stringify(raw)} — `
        + 'the old {"timestamp":0} was NEVER stale (the staleness guard is falsy at 0), so the '
        + 'flow reached emit with remaining === undefined');
      if (raw !== '') {
        t.skip('truncation did not land (Windows share-mode hold on fresh files) — the '
          + 'neutral-value class is pinned above; the behavioural follow-on is provable only '
          + 'where truncation lands, and the POSIX lanes prove it');
        return;
      }
    } else {
      assert.strictEqual(raw, '',
        'the bridge must be TRUNCATED TO EMPTY, which JSON.parse rejects — the old neutral '
        + '{"timestamp":0} was NEVER stale (the staleness guard is `metrics.timestamp && ...` and 0 '
        + 'is falsy), so the flow reached emit with remaining === undefined');
    }
    const { stdout } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(stdout, '',
      'the next tool use must be SILENT: an unreadable bridge falls to the outer catch and exits 0 '
      + '— re-entering the prior round\'s Major as a literal "CONTEXT WARNING: Usage at undefined%" '
      + 'injection is the failure mode this row pins shut');
    assert.strictEqual(s.warnRaw(), null,
      'and no sentinel may be rebuilt off the truncated bridge — criticalRecorded stays un-re-armed');
  });

  test('the truncation fallback refuses to follow a planted symlink', (t) => {
    // Codex review of #3808. The per-session paths live in a shared sticky
    // tmpdir, where "unlink fails with EPERM" is exactly what a file PLANTED by
    // another user produces — so the fallback's write must not follow links: a
    // plain truncating write would empty out the symlink's TARGET, weaponising
    // the hook against any file its own user can write. This row pins the
    // LSTAT guard — lstat sees the link and the open is never reached; the
    // O_NOFOLLOW backstop is exercised by the substitution-race row below
    // (review of #3808, round 3, Minor 3).
    if (process.platform === 'win32') {
      t.skip('symlink planting is a POSIX shared-sticky-tmpdir scenario; Windows temp is per-user');
      return;
    }
    const s = makeSession(t);
    const victim = path.join(os.tmpdir(), `fix-3709-victim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(victim, 'precious victim bytes');
    t.after(() => { try { fs.unlinkSync(victim); } catch { /* absent */ } });
    fs.symlinkSync(victim, s.warnPath);

    const r = s.call('PreCompact', 20, { failUnlinkMatching: '-warned.json' });
    assert.strictEqual(r.exitCode, 0, 'refusing the symlink is a give-up, never a hook failure');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious victim bytes',
      'the symlink TARGET must be untouched — a truncating write that follows links empties it');
    // Non-vacuity (Codex round 2): if the EPERM injection ever stops matching,
    // the ordinary unlink simply REMOVES the symlink and the two assertions
    // above still pass without the fallback ever running. The link surviving is
    // the proof this row actually drove the refuse-to-follow branch.
    assert.ok(fs.lstatSync(s.warnPath).isSymbolicLink(),
      'the planted symlink must still be there — its absence means the unlink succeeded and the '
      + 'fallback under test never executed');
  });

  test('O_NOFOLLOW backstops the lstat→open substitution race', (t) => {
    // Review of #3808, round 3, Minor 3. The lstat guard and O_NOFOLLOW defend
    // DIFFERENT things: lstat covers "the path is not a regular file",
    // O_NOFOLLOW covers a symlink swapped in BETWEEN the lstat and the open.
    // The preload makes the child's lstat claim a regular file for the planted
    // symlink — exactly the race's shape — so the open itself is the only
    // guard left, and dropping `| O_NOFOLLOW` from the flags ships red here
    // instead of green.
    if (process.platform === 'win32') {
      t.skip('O_NOFOLLOW is a no-op on Windows (libuv defines it 0); the race backstop is POSIX-only');
      return;
    }
    const s = makeSession(t);
    const victim = path.join(os.tmpdir(), `fix-3709-victim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(victim, 'precious victim bytes');
    t.after(() => { try { fs.unlinkSync(victim); } catch { /* absent */ } });
    fs.symlinkSync(victim, s.warnPath);

    const marker = `${s.warnPath}.gsd-test-lstat-claimed`;
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* absent */ } });
    const r = s.call('PreCompact', 20, {
      failUnlinkMatching: '-warned.json',
      lstatClaimsFileMatching: '-warned.json',
    });
    assert.strictEqual(r.exitCode, 0, 'ELOOP is a give-up, never a hook failure');
    assert.ok(fs.existsSync(marker),
      'the lstat-claim arm must PROVE it engaged — without the marker, a match string that '
      + 'silently stops matching lets the real lstat refuse the symlink and every other '
      + 'assertion here passes without O_NOFOLLOW ever being the guard under test');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious victim bytes',
      'with lstat blinded, only O_NOFOLLOW stands between the open and the victim — the target '
      + 'must be untouched');
    assert.ok(fs.lstatSync(s.warnPath).isSymbolicLink(),
      'the planted symlink must survive — its absence means the injection never engaged');
  });

  test('round 11: the statusline bridge is read through the same hardening as the sentinels', (t) => {
    // Review of #3808, round 11. `metricsPath` is built one line from `warnPath` and
    // `watermarkPath` — same tmpdir, same predictable `claude-ctx-{sessionId}` shape, same
    // threat model this PR documents at length — and it is the only one of the three read on
    // EVERY invocation. It was also the only one still reached by a bare readFileSync, so the
    // symlink-to-FIFO stall the other two were hardened against stayed reachable on the file's
    // highest-traffic path. This row plants a symlink at the bridge and asserts the hook neither
    // follows it nor fails.
    if (process.platform === 'win32') {
      t.skip('symlink creation needs privilege on Windows; the lstat half of the guard still '
        + 'refuses a non-regular bridge there, and the directory row below covers it');
      return;
    }
    const s = makeSession(t);
    const planted = path.join(os.tmpdir(),
      `fix-3709-planted-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    // A bridge that WOULD warn if it were followed: remaining=20 is CRITICAL territory, and the
    // timestamp is current so it passes the staleness gate. Following the link emits; refusing
    // it is silent. That asymmetry is what makes this row non-vacuous.
    fs.writeFileSync(planted, JSON.stringify({
      session_id: 'planted', remaining_percentage: 20, used_pct: 80,
      timestamp: Math.floor(Date.now() / 1000),
    }));
    t.after(() => { try { fs.unlinkSync(planted); } catch { /* absent */ } });
    fs.symlinkSync(planted, s.metricsPath);

    const { stdout, exitCode } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(exitCode, 0, 'a refused bridge must never fail the hook');
    assert.strictEqual(stdout, '',
      'an attacker-chosen reading reached through a link must not drive a warning — following it '
      + 'is a false-CRITICAL primitive, and a link to a FIFO stalls this synchronous read on the '
      + 'one path that runs for every tool call');
    assert.ok(fs.lstatSync(s.metricsPath).isSymbolicLink(),
      'the planted link must survive — its absence means the hook rewrote the path and this row '
      + 'passed without the guard ever being reached');
  });

  test('round 11: a non-regular bridge is refused without failing the hook', (t) => {
    // The arm every platform runs. WHAT IT PINS, stated precisely because the obvious reading is
    // wrong (Codex review of round 11): this row asserts the OUTCOME — a directory at the bridge
    // path produces no warning and no failure — not that `lstat`'s isFile() check is what
    // produced it. Measured: deleting `!st.isFile() ||` leaves this row green, because the read
    // of a directory fails on its own one line later. The isFile() half is pinned by the symlink
    // row above, where a bare read would have succeeded and emitted.
    const s = makeSession(t);
    fs.mkdirSync(s.metricsPath);
    t.after(() => { try { fs.rmdirSync(s.metricsPath); } catch { /* absent */ } });

    const { stdout, exitCode } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(exitCode, 0, 'refusing the bridge is a give-up, never a hook failure');
    assert.strictEqual(stdout, '', 'and nothing is emitted off an object that is not a bridge');
    assert.ok(fs.lstatSync(s.metricsPath).isDirectory(), 'the planted directory must survive');
  });

  test('round 11: an oversized bridge is refused rather than slurped', (t) => {
    // The size bound is what stops a planted multi-megabyte file from being read into memory on
    // every tool call. A legitimate bridge is four fixed fields (~140 bytes with a UUID session
    // id, gsd-statusline.js), so nothing real approaches 4096.
    const s = makeSession(t);
    fs.writeFileSync(s.metricsPath, JSON.stringify({
      session_id: 'x', remaining_percentage: 20, used_pct: 80,
      timestamp: Math.floor(Date.now() / 1000), pad: 'x'.repeat(5000),
    }));
    const { stdout, exitCode } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'a bridge past the size bound is refused, not parsed');
  });

  test('round 11: readSentinel refuses a file that shrinks under the read', (t) => {
    // Round 11, Minor. `fs.readSync`'s RETURN value was discarded and the buffer assumed full.
    // A file truncated between the lstat and the read — an ordinary concurrent writer, not the
    // planted-object case the rest of the function guards — leaves the tail zero-filled. The
    // preload shrinks the file after lstat has measured it, the only way to produce a short read
    // deterministically.
    //
    // WHAT THIS ROW PINS, stated because it is narrower than it looks: the END-TO-END outcome of
    // a shrink, not the `bytesRead` guard itself. Measured by mutation — deleting the guard
    // leaves this row GREEN, because the zero-filled tail makes JSON.parse throw one line later
    // and both paths land in the same catch and degrade to "no sentinel". The guard has no
    // observable behavioural delta; it is a consistency fix in a function whose whole purpose is
    // refusing to trust what it read, and it is worth having for the same reason the lstat and
    // O_NOFOLLOW checks are. No row here claims otherwise.
    if (process.platform === 'win32') {
      t.skip('the preload shrinks the file between lstat and read; Windows holds a share lock '
        + 'that makes the truncation unreliable, and the guard itself is platform-independent');
      return;
    }
    const s = makeSession(t);
    // A sentinel whose ACCEPTANCE would suppress: critical→critical is not an escalation and
    // callsSinceWarn=1 is under DEBOUNCE_CALLS, so a hook that trusted it stays silent. A hook
    // that REFUSES it falls back to the default warnData, and the first warning of a fresh cycle
    // is emitted immediately. That asymmetry is the whole row — with a sentinel that emitted
    // either way, this would pass without the guard existing.
    fs.writeFileSync(s.warnPath, JSON.stringify({
      callsSinceWarn: 1, lastLevel: 'critical', criticalRecorded: true, pad: 'x'.repeat(400),
    }));
    const marker = `${s.warnPath}.gsd-test-shrunk`;
    t.after(() => { try { fs.unlinkSync(marker); } catch { /* absent */ } });
    const { stdout, exitCode } = s.call('PostToolUse', 20, {
      shrinkAfterLstatMatching: '-warned.json',
    });
    assert.strictEqual(exitCode, 0, 'a short read is a refusal, never a hook failure');
    // Non-vacuity, and NOT a size check on the sentinel: the hook rewrites that file later in
    // the same invocation, so its size afterwards says nothing about whether the truncation
    // landed (this row was written that way first and passed for the wrong reason).
    assert.ok(fs.existsSync(marker),
      'the shrink injection must PROVE it engaged — without the marker, a match string that '
      + 'silently stops matching lets an ordinary full read satisfy every assertion here');
    assert.match(stdout, /CONTEXT/,
      'a refused sentinel degrades to "no sentinel", which is the same fresh-cycle behaviour '
      + 'every other refusal in this function produces');
  });

  test('round 11: a short write is retried, not left as a truncated sentinel', (t) => {
    // Codex review of round 11. `fs.writeSync` may write fewer bytes than it is given, and the
    // return value was discarded — so a short write left a truncated sentinel on disk that every
    // later read rejects, silently defeating the debounce accounting this write exists to record.
    // The injection makes the first write of the payload return 1 byte, once; the loop under test
    // must finish the rest. Without the loop the sentinel is `{` and the next invocation warns
    // again instead of debouncing.
    const s = makeSession(t);
    const marker = path.join(os.tmpdir(), `fix-3709-shortwrite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    t.after(() => { try { fs.unlinkSync(`${marker}.gsd-test-short-write`); } catch { /* absent */ } });

    const first = s.call('PostToolUse', 20, { shortWriteMarker: marker });
    assert.strictEqual(first.exitCode, 0);
    assert.ok(fs.existsSync(`${marker}.gsd-test-short-write`),
      'the short-write injection must PROVE it engaged — without the marker this row exercises '
      + 'an ordinary full write and proves nothing');
    const raw = s.warnRaw();
    assert.ok(raw && raw.length > 1,
      `the sentinel must be complete after a short write, got ${JSON.stringify(raw)}`);
    assert.doesNotThrow(() => JSON.parse(raw),
      'a truncated sentinel is unparseable, which is how a short write silently lost the state');
  });

  test('round 11: a healthy bridge still drives a warning — the hardening is not a mute', (t) => {
    // The direction that matters most: every row above asserts SILENCE, and silence is also what
    // a hook that refused every bridge would produce. This is the same read path with an ordinary
    // regular file, and it must still emit.
    const s = makeSession(t);
    const { stdout, exitCode } = s.call('PostToolUse', 20);
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /CONTEXT/,
      'routing the bridge through readSentinel must not change what a normal reading does');
  });

  test('round 10: the watermark write refuses to follow a planted symlink', (t) => {
    // Review of #3808, round 10. The PreCompact watermark write was the block
    // writeSentinel was lifted from in round 7 and it kept its own inline copy
    // until round 10 routed it through the helper. Nothing pinned that site:
    // no other watermark row supplies a pre-existing object at the path before
    // PreCompact writes — the sequence rows let PreCompact create it, the
    // hardened-read rows below plant one afterwards and test the READ — so the
    // write regressing to a bare writeFileSync, which follows a link and writes
    // through to its target, shipped green (Codex, round 10, by mutation). This
    // row plants the object BEFORE the write: the target must be untouched,
    // and the path must end up a fresh regular file, which only
    // unlink-then-O_EXCL produces.
    if (process.platform === 'win32') {
      t.skip('symlink creation needs privilege on Windows. A directory at the path does not tell '
        + 'the two writes apart (both give up inside the branch-level catch with an identical '
        + 'exit 0 — checked by mutation); a hard link would, but is unverified on Windows here '
        + 'and not taken');
      return;
    }
    const s = makeSession(t);
    const victim = path.join(os.tmpdir(), `fix-3709-victim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(victim, 'precious victim bytes');
    t.after(() => { try { fs.unlinkSync(victim); } catch { /* absent */ } });
    fs.symlinkSync(victim, s.watermarkPath);

    const r = s.call('PreCompact', 20);
    assert.strictEqual(r.exitCode, 0, 'a planted watermark path must never fail the hook');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious victim bytes',
      'the symlink TARGET must be untouched — a write that follows links lands the watermark JSON in it');
    assert.ok(fs.lstatSync(s.watermarkPath).isFile() && !fs.lstatSync(s.watermarkPath).isSymbolicLink(),
      'the path must now hold a plain regular file this process made — the unlink half removed the link');
    const wm = s.watermark();
    assert.ok(wm && typeof wm.at === 'number', 'and it must be a real watermark, not the link left in place');
  });

  test('round 3, Major 1: a statusline rewrite DURING the compaction cannot re-fire off the old reading', (t) => {
    // PreCompact deletes the bridge, but the statusline is an uncoordinated
    // process that re-writes it on every render — a render landing between the
    // clear and the compaction's completion re-creates the PRE-compaction
    // remaining with a CURRENT timestamp, sailing past STALE_SECONDS. The
    // compaction watermark makes that reading identifiable: anything inside
    // the grace window past the watermark is dropped.
    const s = makeSession(t, { gsdActive: true });
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0);
    const wm = s.watermark();
    assert.ok(wm && typeof wm.at === 'number', 'PreCompact must leave a watermark');
    // the racing render: pre-compaction remaining, stamped in the same second
    s.writeBridge({ remaining_percentage: 20, used_pct: 80, timestamp: wm.at });
    const { stdout } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(stdout, '',
      'a reading the compaction watermark covers must be dropped — warning off it tells the agent '
      + 'to stop right after the compaction that freed the context');
    assert.strictEqual(s.warnRaw(), null,
      'and no false context-exhaustion breadcrumb may be re-armed off it');
  });

  test('round 3, Major 1: a DELAYED mid-compaction render is dropped too — the watermark marks the start, not the end', (t) => {
    // Codex on the first watermark cut: PreCompact stamps the compaction's
    // START, but the compaction keeps running — a statusline render one second
    // later still carries the PRE-compaction reading, and "strictly newer than
    // the watermark" admitted it. The grace window covers the compaction's own
    // duration, so a reading barely past the watermark is still suspect.
    const s = makeSession(t, { gsdActive: true });
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0);
    const wm = s.watermark();
    assert.ok(wm && typeof wm.at === 'number', 'PreCompact must leave a watermark');
    s.writeBridge({ remaining_percentage: 20, used_pct: 80, timestamp: wm.at + 1 });
    const { stdout } = s.call('PostToolUse', 20, { metrics: 'keep' });
    assert.strictEqual(stdout, '',
      'one second past the watermark is still mid-compaction territory — the old reading under a '
      + 'newer stamp must not re-fire the CRITICAL');
    assert.strictEqual(s.warnRaw(), null, 'and no false breadcrumb may be re-armed off it');
  });

  test('round 3, Major 1: a reading from past the grace window still warns', (t) => {
    // The non-vacuity half: the watermark must drop the compaction-window
    // readings, not all readings — one clearly past the window passes and the
    // fresh cycle behaves like a fresh session.
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0);
    const wm = s.watermark();
    assert.ok(wm && typeof wm.at === 'number', 'PreCompact must leave a watermark');
    // COMPACT_GRACE_SECONDS is 60; +61 is the first second the window no longer covers
    s.writeBridge({ remaining_percentage: 30, used_pct: 70, timestamp: wm.at + 61 });
    const { stdout } = s.call('PostToolUse', 30, { metrics: 'keep' });
    assert.match(stdout, /CONTEXT WARNING/,
      'a reading past the grace window is the new cycle — it must warn immediately');
  });

  test('round 3: an insane FUTURE watermark is ignored, never a permanent mute', (t) => {
    // Codex on the first watermark cut: a watermark stamped in the future — a
    // clock step backwards, a stray or planted file — would otherwise drop
    // every reading until wall-clock catches up: monitoring silently
    // self-disabled. A watermark ahead of the reader's own clock is treated
    // as garbage and the plain staleness rules apply.
    const s = makeSession(t);
    fs.writeFileSync(path.join(os.tmpdir(), `claude-ctx-${s.bridgeMatch.replace('.json', '')}-compacted.json`),
      JSON.stringify({ at: Math.floor(Date.now() / 1000) + 3600 }));
    const { stdout } = s.call('PostToolUse', 30);
    assert.match(stdout, /CONTEXT WARNING/,
      'a future-stamped watermark must not be honored — dropping fresh readings against it mutes '
      + 'the monitor indefinitely');
  });

  test('round 3, Minor 6: malformed hook_event_name values are silent, with side effects intact', (t) => {
    // readEventName is TOTAL and STRICT about type: the old expression threw
    // on a truthy non-string AFTER the side effects; hoisting would have moved
    // the throw ahead of them; and a String() coercion renders ['PreCompact']
    // as 'PreCompact' — running the RESET off a malformed payload — while a
    // hostile toString still throws. typeof does neither: every non-string is
    // "no event".
    //
    // GEMINI_API_KEY is pinned UNSET (round 4, Major 2). The preserved Gemini
    // fallback is `eventName === "" && !!process.env.GEMINI_API_KEY`, and
    // readEventName returned "" for every malformed name AT THE TIME THIS ROW
    // WAS WRITTEN — so with the key set in the ambient environment this row's
    // `stdout === ''` assertion failed outright: injection becomes supported
    // and a 30%-remaining reading emits a CONTEXT WARNING. Reproduced by
    // running this row under `GEMINI_API_KEY=x`. Round 7 then SUPERSEDED that
    // behaviour: a present-but-non-string name returns null and only an ABSENT
    // one returns "", so a malformed payload can no longer reach the fallback
    // at all. The pin stays regardless — this row is about readEventName's
    // typing, not about the fallback, and an ambient key would still change
    // what it measures — so the dialect variable is fixed, not inherited.
    // A FRESH SESSION PER SUBCASE (Codex review of #3808, round 4). Both
    // subcases shared one session, and the sentinel is the thing being
    // asserted: the `42` iteration left one behind, so the hostile-object
    // iteration's `assert.ok(s.warn())` passed off the PREVIOUS iteration's
    // side effect. A regression where a hostile object throws BEFORE the
    // bookkeeping would have kept the row green — vacuous for exactly the
    // subcase the row exists for.
    const noGemini = { GEMINI_API_KEY: undefined };
    for (const [label, badEvent] of [
      ['number', 42],
      ['object', { toString: 'not-callable' }],
    ]) {
      const s = makeSession(t);
      assert.strictEqual(s.warnRaw(), null, `${label}: precondition — no sentinel from a prior subcase`);
      const { stdout, exitCode } = s.call(badEvent, 30, { env: noGemini });
      assert.strictEqual(exitCode, 0, `${label}: a malformed event name must never fail the hook`);
      assert.strictEqual(stdout, '', `${label}: unknown events emit nothing (#2289 allowlist)`);
      assert.ok(s.warn(), `${label}: the debounce side effect must still have run (#2289 contract)`);
    }
  });

  test('round 7: a malformed event name does not inherit the Gemini fallback', (t) => {
    // The row above pins malformed names with GEMINI_API_KEY UNSET, and its own
    // comment records why: with the key SET, `stdout === ''` failed outright,
    // because readEventName collapsed ABSENT and MALFORMED onto the same '' and
    // the fallback `eventName === "" && !!GEMINI_API_KEY` then fired. That was
    // pinned around rather than fixed, and it is an ACCEPT-DIRECTION regression
    // against the merge-base: base evaluated `data.hook_event_name.trim()`,
    // which THREW on a truthy non-string after the side effects, so no envelope
    // was ever emitted. Measured base-vs-head at 996196fe0 before fixing:
    //
    //   hook_event_name: 42             base silent -> head EMITS AfterTool
    //   hook_event_name: ['PreCompact'] base silent -> head EMITS AfterTool
    //   hook_event_name: {}             base silent -> head EMITS AfterTool
    //   hook_event_name ABSENT          base EMITS  -> head EMITS   (unchanged)
    //
    // readEventName now returns '' only for an ABSENT name and null for a
    // present-but-non-string one, so the documented fallback keeps working for
    // the case it was written for and stops covering malformed payloads.
    //
    // This row is the one that must run with the key SET — that is the whole
    // condition under test, and pinning it unset here would reproduce the
    // blind spot the row exists to close.
    const withGemini = { GEMINI_API_KEY: 'fixture-key-not-a-real-credential' };
    for (const [label, badEvent] of [
      ['number', 42],
      ['array', ['PreCompact']],
      ['object', { toString: 'not-callable' }],
    ]) {
      const s = makeSession(t);
      const { stdout, exitCode } = s.call(badEvent, 30, { env: withGemini });
      assert.strictEqual(exitCode, 0, `${label}: a malformed event name must never fail the hook`);
      assert.strictEqual(stdout, '', `${label}: a malformed name must not be treated as the ABSENT `
        + 'name and emit the Gemini AfterTool envelope — base emitted nothing for this payload');
      assert.ok(s.warn(), `${label}: the #2289 side-effect contract still holds — the payload is `
        + 'malformed, not a reason to skip the bookkeeping');
    }

    // Non-vacuity: the ABSENT name must STILL take the documented fallback with
    // the same key set. Without this, the rows above would also pass if the
    // fallback had simply been deleted.
    const s = makeSession(t);
    const { stdout } = s.call(undefined, 30, { env: withGemini });
    assert.match(stdout, /CONTEXT WARNING/,
      'a MISSING event name under a Gemini-dialect runtime must still mean AfterTool — that '
      + 'fallback is the pre-#2289 behaviour this hook deliberately preserves');
  });

  test('round 3, Minor 6: an ARRAY-wrapped PreCompact does not run the reset', (t) => {
    // ['PreCompact'] under String() coercion reads as 'PreCompact' — a
    // malformed payload triggering a state-clearing branch. Strict typeof
    // treats it as no event: the sentinel survives.
    // GEMINI_API_KEY pinned unset for the same reason as the row above: this
    // row's `stdout === ''` also rests on injection being unsupported. It
    // happens to survive an ambient key today only because remaining=20 with
    // callsSinceWarn=0 is debounced — an incidental rescue, not independence,
    // so the variable is pinned here too (round 4, Major 2).
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    const { stdout, exitCode } = s.call(['PreCompact'], 20, { env: { GEMINI_API_KEY: undefined } });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, '', 'a malformed event emits nothing');
    assert.ok(s.warn(), 'the reset must NOT run off a non-string event name — the sentinel survives '
      + '(the side-effect pipeline ran instead, which is the unknown-event contract)');
  });

  // ─── round 7: the routine sentinel writes/read refuse a planted object ───
  //
  // Round 7 ruled that the three routine debounce-accounting writes must be
  // brought in line with the PreCompact clear and the compaction watermark,
  // which already refuse to follow or overwrite a planted object. The read
  // beside them is folded in as the same class in the same file — the
  // watermark's read was hardened in round 4 for exactly this reason, so
  // leaving this one bare recreated the asymmetry round 7 asks be removed.
  //
  // Every row below drives the REAL hook; none extracts logic into a
  // standalone harness. The control row runs first on purpose: without it a
  // refusal row passes for the wrong reason if the sentinel mechanism is
  // broken outright.

  test('round 7 control: an ordinary warning run writes a usable regular-file sentinel', (t) => {
    const s = makeSession(t);
    const { stdout, exitCode } = s.call('PostToolUse', 30);
    assert.strictEqual(exitCode, 0, 'the ordinary warning path must exit 0');
    assert.match(stdout, /CONTEXT WARNING/,
      'precondition: remaining=30 is under WARNING_THRESHOLD and must warn');
    const wd = s.warn();
    assert.ok(wd && wd.lastLevel === 'warning',
      'the sentinel must be written AND parseable through the hardened write — if it is not, the '
      + 'refusal rows below prove nothing, because a hook that writes no sentinel at all also '
      + 'never writes through a symlink');
    assert.ok(fs.lstatSync(s.warnPath).isFile(),
      'and it must land as a plain regular file, not a link');
  });

  test('round 7: a planted symlink is never written through to its target', (t) => {
    // The write-through primitive. A bare writeFileSync on a path in the
    // shared, sticky os.tmpdir() follows a planted link and writes the
    // sentinel INTO the attacker's chosen file — an arbitrary-file-write with
    // JSON the hook itself composes. Verified fail-first against the
    // pre-hardening file: the victim came back holding the sentinel JSON.
    if (process.platform === 'win32') {
      t.skip('symlink planting is a POSIX shared-sticky-tmpdir scenario; Windows temp is per-user, '
        + 'and libuv defines O_NOFOLLOW as 0 there — the unlink-then-O_EXCL half still applies');
      return;
    }
    const s = makeSession(t);
    const victim = path.join(os.tmpdir(),
      `fix-3709-victim-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const ORIGINAL = JSON.stringify({ untouched: true });
    fs.writeFileSync(victim, ORIGINAL);
    t.after(() => { try { fs.unlinkSync(victim); } catch { /* absent */ } });

    fs.symlinkSync(victim, s.warnPath);
    const { exitCode } = s.call('PostToolUse', 30);

    assert.strictEqual(exitCode, 0,
      'refusing a planted object is a give-up, never a hook failure');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), ORIGINAL,
      'the symlink TARGET must be byte-identical — writing through it is the arbitrary-file-write '
      + 'primitive this hardening exists to remove');
    assert.ok(fs.lstatSync(s.warnPath).isFile(),
      'the planted link must be REPLACED by a fresh regular file: unlink removes the link, then '
      + 'O_EXCL refuses to create through one, so the write can only land on this process own file');
  });

  test('round 7: a SYMLINKED sentinel cannot mute the monitor through the read', (t) => {
    // The mute primitive, and the reason the read is hardened alongside the
    // writes. The read runs BEFORE the first write of an invocation, so the
    // write-side unlink cannot protect it, and re-planting reopens it every
    // invocation. Fail-first against the pre-hardening file: this row emitted
    // NOTHING, because following the link set firstWarn=false and left
    // callsSinceWarn under DEBOUNCE_CALLS, taking the silent debounce arm.
    //
    // SCOPE OF THIS ROW, stated because the guard is narrower than "cannot be
    // muted" (Codex review of #3808, round 7): lstat + O_NOFOLLOW establishes
    // that the sentinel is a plain regular file, NOT that it is trustworthy. A
    // cross-owner REGULAR file planted at the predictable path in a shared
    // sticky tmpdir is still read, and the write cannot displace it either —
    // unlink returns EPERM in a sticky directory, so writeSentinel gives up and
    // the planted value persists. That residual is pre-existing (the bare
    // readFileSync had it too, plus the symlink case this row closes) and is
    // NOT fixed here: refusing it needs an ownership check, which is a
    // different policy than this PR's. Every object below is created by the
    // current user, so no row here exercises the cross-owner case.
    if (process.platform === 'win32') {
      t.skip('symlink creation needs privilege on Windows; the guard is lstat + O_NOFOLLOW, and '
        + 'the lstat half still refuses a non-regular sentinel there');
      return;
    }
    const s = makeSession(t);
    const planted = path.join(os.tmpdir(),
      `fix-3709-planted-warn-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    // callsSinceWarn=1 with lastLevel='warning' keeps the debounce arm taken at
    // remaining=30: the counter increments to 2, still under DEBOUNCE_CALLS=5,
    // and warning→warning is not a severity escalation, so nothing is emitted.
    fs.writeFileSync(planted, JSON.stringify({ callsSinceWarn: 1, lastLevel: 'warning' }));
    t.after(() => { try { fs.unlinkSync(planted); } catch { /* absent */ } });

    fs.symlinkSync(planted, s.warnPath);
    const { stdout, exitCode } = s.call('PostToolUse', 30);

    assert.strictEqual(exitCode, 0, 'a refused sentinel must never fail the hook');
    assert.match(stdout, /CONTEXT WARNING/,
      'an attacker-chosen sentinel reached through a link must not suppress the warning — in a '
      + 'shared sticky tmpdir that is a mute primitive, and a link to a FIFO stalls this '
      + 'synchronous read outright');
  });

  test('round 7: a non-regular sentinel is refused without failing the hook', (t) => {
    // Class coverage rather than one spelling, and the shape that proves the
    // refusal is not symlink-specific: the write's unlink throws something
    // other than ENOENT on a directory, which must still land in the give-up
    // arm rather than escaping as a hook crash.
    const s = makeSession(t);
    const oversized = JSON.stringify({ callsSinceWarn: 1, lastLevel: 'warning', pad: 'x'.repeat(8192) });
    for (const [label, plant, unplant] of [
      ['a directory', (wp) => fs.mkdirSync(wp), (wp) => { try { fs.rmdirSync(wp); } catch { /* gone */ } }],
      ['an oversized file', (wp) => fs.writeFileSync(wp, oversized), () => {}],
    ]) {
      plant(s.warnPath);
      const { stdout, exitCode } = s.call('PostToolUse', 30);
      unplant(s.warnPath);
      assert.strictEqual(exitCode, 0, `${label}: must never fail the hook`);
      assert.match(stdout, /CONTEXT WARNING/,
        `${label}: must be refused as a sentinel and fall back to first-warn defaults, not honored `
        + 'and not crashed on');
    }
  });

  // Round 8 (Minor): the 4096-byte bound on the round-7 sentinel READ
  // (gsd-context-monitor.js:335), at its fence. The row above proves an
  // OVERSIZED file is refused, but it pads to 8192 — a full 4096 bytes clear of
  // the boundary — so `>` vs `>=`, or an off-by-one in the limit itself, is
  // invisible to it.
  test('round 8: the sentinel size bound is exact at 4095/4096/4097', (t) => {
    const s = makeSession(t);
    // Sized by MEASUREMENT, not by arithmetic on an assumed prefix width: 'x'
    // is one UTF-8 byte and never JSON-escaped, and the assertion below pins
    // the result so a change to the skeleton cannot slide the fence.
    const sentinelOfExactBytes = (bytes) => {
      const skeleton = JSON.stringify({ callsSinceWarn: 1, lastLevel: 'warning', pad: '' });
      const pad = bytes - Buffer.byteLength(skeleton, 'utf8');
      assert.ok(pad >= 0, `${bytes} is smaller than the un-padded sentinel skeleton`);
      const out = JSON.stringify({ callsSinceWarn: 1, lastLevel: 'warning', pad: 'x'.repeat(pad) });
      assert.strictEqual(Buffer.byteLength(out, 'utf8'), bytes,
        'the padding arithmetic must land exactly on the size under test');
      return out;
    };

    // The discriminator is the DEBOUNCE ARM, not an error: an honored
    // `{callsSinceWarn:1, lastLevel:'warning'}` keeps the arm taken at
    // remaining=30 (the counter goes 1→2, still under DEBOUNCE_CALLS=5, and
    // warning→warning is not a severity escalation), so nothing is emitted —
    // while a REFUSED sentinel falls back to first-warn defaults and emits.
    // Both directions therefore assert on observable hook output, and the 4097
    // row is the non-vacuity control for the two accept rows.
    for (const [bytes, honored] of [[4095, true], [4096, true], [4097, false]]) {
      fs.writeFileSync(s.warnPath, sentinelOfExactBytes(bytes));
      assert.strictEqual(fs.lstatSync(s.warnPath).size, bytes,
        `${bytes}: the planted sentinel must be exactly the size under test`);
      const { stdout, exitCode } = s.call('PostToolUse', 30);
      assert.strictEqual(exitCode, 0, `${bytes}: a size verdict must never fail the hook`);
      if (honored) {
        assert.doesNotMatch(stdout, /CONTEXT WARNING/,
          `${bytes}: at or under the bound the sentinel must be HONORED — its taken debounce arm `
          + 'suppresses the warning; a warning here means the read refused a legal sentinel');
      } else {
        assert.match(stdout, /CONTEXT WARNING/,
          `${bytes}: one byte over the bound must be REFUSED and fall back to first-warn defaults`);
      }
    }
  });

});

// ─── #3709 round 3 (Major 2): the thresholds this fix turns on, at their limits ───
//
// DEBOUNCE_CALLS is the threshold the whole fix is ABOUT — the bug was a stale
// sentinel forcing every later CRITICAL through the full debounce — and
// STALE_SECONDS is load-bearing for the bridge-clearing argument. Neither had
// limit-1/limit/limit+1 coverage; the seeded values in the repo (0, 1, 10) sit
// far from the edges, so an off-by-one in either comparison shipped green.
describe('#3709 round 3: DEBOUNCE_CALLS and STALE_SECONDS at their limits', () => {
  const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
  const NOW_PRELOAD = path.join(__dirname, 'helpers', 'context-monitor-fixed-now-preload.cjs');
  // The STALE rows sit ON a wall-clock boundary, where one second of child
  // startup delay flips the verdict — so the child's Date.now is pinned via
  // preload and every age is exact arithmetic, not a race.
  const NOW_MS = 1_800_000_000_000;
  const NOW_S = Math.floor(NOW_MS / 1000);

  function drive({
    remaining = 30, warnData = null, timestamp = NOW_S, watermarkAt = null, nowMs = NOW_MS,
    plantWatermark = null,
  }) {
    const id = `fix-3709-trio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metricsPath = path.join(os.tmpdir(), `claude-ctx-${id}.json`);
    const warnPath = path.join(os.tmpdir(), `claude-ctx-${id}-warned.json`);
    const watermarkPath = path.join(os.tmpdir(), `claude-ctx-${id}-compacted.json`);
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: id, remaining_percentage: remaining, used_pct: 100 - remaining, timestamp,
    }));
    if (warnData) fs.writeFileSync(warnPath, JSON.stringify(warnData));
    if (plantWatermark) plantWatermark(watermarkPath);
    else if (watermarkAt !== null) fs.writeFileSync(watermarkPath, JSON.stringify({ at: watermarkAt }));
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, ['--require', NOW_PRELOAD, HOOK], {
        input: JSON.stringify({ session_id: id, cwd: os.tmpdir(), hook_event_name: 'PostToolUse' }),
        encoding: 'utf8',
        timeout: 8000,
        env: { ...process.env, GSD_TEST_NOW_MS: String(nowMs) },
      });
    } catch (e) { stdout = e.stdout || ''; exitCode = e.status ?? 1; }
    finally {
      for (const p of [metricsPath, warnPath, watermarkPath]) {
        try { fs.unlinkSync(p); } catch { /* absent, or the planted directory below */ }
      }
      // A row may plant a DIRECTORY at the watermark path, which unlinkSync
      // cannot remove. cleanup() rather than a raw rmSync: it carries the
      // repo's Windows-EBUSY retry budget (local/no-raw-rmsync-in-tests).
      try { if (fs.existsSync(watermarkPath)) cleanup(watermarkPath); } catch { /* best effort */ }
    }
    return { stdout, exitCode };
  }

  // The gate is `callsSinceWarn < DEBOUNCE_CALLS` evaluated AFTER the +1
  // increment: a seed of 3 becomes 4 (debounced), 4 becomes 5 (emits, the
  // limit itself), 5 becomes 6 (emits). `<=` for `<`, or moving the increment
  // below the comparison, reds exactly one of these three.
  for (const [seed, emits] of [[3, false], [4, true], [5, true]]) {
    test(`DEBOUNCE_CALLS trio: seed ${seed} (${seed + 1} after increment) → ${emits ? 'emits' : 'debounced'}`, () => {
      const { stdout, exitCode } = drive({
        remaining: 30,
        warnData: { callsSinceWarn: seed, lastLevel: 'warning' },
      });
      assert.strictEqual(exitCode, 0);
      if (emits) {
        assert.match(stdout, /CONTEXT WARNING/, `seed ${seed}: the debounce window is over — must emit`);
      } else {
        assert.strictEqual(stdout, '', `seed ${seed}: still inside the debounce window — must stay silent`);
      }
    });
  }

  // The gate is `(now - timestamp) > STALE_SECONDS`: an age of exactly 60 is
  // NOT stale, 61 is. `>=` for `>` reds the 60 row; widening reds the 61 row.
  for (const [age, emits] of [[59, true], [60, true], [61, false]]) {
    test(`STALE_SECONDS trio: reading aged ${age}s → ${emits ? 'warns' : 'dropped as stale'}`, () => {
      const { stdout, exitCode } = drive({ remaining: 30, timestamp: NOW_S - age });
      assert.strictEqual(exitCode, 0);
      if (emits) {
        assert.match(stdout, /CONTEXT WARNING/, `age ${age}s is inside the freshness window`);
      } else {
        assert.strictEqual(stdout, '', `age ${age}s is beyond STALE_SECONDS`);
      }
    });
  }

  test('timestamp 0 bypasses the stale gate — characterized directly', () => {
    // The falsy guard (`metrics.timestamp && ...`) means an UNSTAMPED reading
    // is never age-checked. Pinned here as the current contract in its own
    // row — not inside a platform disjunction — so a change to the guard's
    // polarity is a visible decision, not drift. After a compaction the
    // watermark closes this hole (`!(0 > at)` drops the reading), which the
    // round-3 Major-1 rows exercise.
    const { stdout, exitCode } = drive({ remaining: 30, timestamp: 0 });
    assert.strictEqual(exitCode, 0);
    assert.match(stdout, /CONTEXT WARNING/,
      'an unstamped reading skips the age check (falsy guard) — current, characterized behaviour');
  });

  // COMPACT_GRACE_SECONDS is the ONE constant this PR introduces, and it was
  // the only threshold here without a limit-1/limit/limit+1 trio while the PR
  // added full trios for four PRE-EXISTING ones (review of #3808, round 4,
  // Major 3). The seeded values were at+0, at+1 and at+61 — the boundary
  // itself (at+60, must be dropped) and limit-1 (at+59, must be dropped) went
  // untested, so mutating `>` to `>=`, or moving the constant by one, left the
  // suite green while the window shifted.
  //
  // The gate is `!(metrics.timestamp > watermark.at + COMPACT_GRACE_SECONDS)`:
  // a reading at at+60 is still covered, at+61 is the first one that is not.
  // The clock is pinned so every reading is also unambiguously FRESH
  // (now - timestamp is 0..60 here), which isolates the grace gate from the
  // staleness gate — a row that failed for the wrong gate would prove nothing.
  for (const [offset, emits] of [[59, false], [60, false], [61, true]]) {
    test(`COMPACT_GRACE_SECONDS trio: reading at watermark+${offset}s -> ${emits ? 'warns' : 'covered by the window'}`, () => {
      const { stdout, exitCode } = drive({
        remaining: 30,
        watermarkAt: NOW_S,
        // The reader's clock ADVANCES to the moment of the render; the reading
        // is stamped `now`, exactly as hooks/gsd-statusline.js stamps it. The
        // reading is therefore never ahead of the reader — the future-stamped
        // shortcut is what round 4 rejected — and its age is 0, so only the
        // grace gate can drop it.
        nowMs: NOW_MS + offset * 1000,
        timestamp: NOW_S + offset,
      });
      assert.strictEqual(exitCode, 0);
      if (emits) {
        assert.match(stdout, /CONTEXT WARNING/,
          `watermark+${offset}s is past the grace window — the new cycle must warn`);
      } else {
        assert.strictEqual(stdout, '',
          `watermark+${offset}s is still inside the grace window — a mid-compaction render is `
          + 'indistinguishable from a real reading and must be dropped');
      }
    });
  }

  // WATERMARK_SKEW_SECONDS is the OTHER threshold the watermark introduces, and
  // it had no boundary coverage either — the only sanity row used now+3600,
  // three orders of magnitude from the edge (Codex review of #3808, round 4).
  // The gate is `watermark.at <= now + WATERMARK_SKEW_SECONDS`: +5 is honored,
  // +6 is not. Mutating `<=` to `<`, or moving the constant, reds one row.
  //
  // This threshold is not cosmetic: an accepted +5 watermark pushes the grace
  // window's end from +61 to +66, which is why the docs no longer claim the
  // delay is bounded by COMPACT_GRACE_SECONDS alone.
  for (const [skew, honored] of [[4, true], [5, true], [6, false]]) {
    test(`WATERMARK_SKEW_SECONDS trio: a watermark ${skew}s ahead is ${honored ? 'honored' : 'ignored'}`, () => {
      const { stdout, exitCode } = drive({
        remaining: 30,
        watermarkAt: NOW_S + skew,
        timestamp: NOW_S,
        nowMs: NOW_MS,
      });
      assert.strictEqual(exitCode, 0);
      if (honored) {
        assert.strictEqual(stdout, '',
          `a watermark ${skew}s ahead is within the accepted skew, so the grace window applies `
          + 'and this current reading is dropped');
      } else {
        assert.match(stdout, /CONTEXT WARNING/,
          `a watermark ${skew}s ahead is beyond the accepted skew — it must be discarded as insane `
          + 'rather than muting the monitor, which is how a clock step would silently disable it');
      }
    });
  }

  test('round 4: a watermark that is not a plain regular file is never followed', (t) => {
    // The WRITE side already refused to follow or overwrite a planted object,
    // but the READ was a bare readFileSync — so anything the write side gave up
    // on was followed by every later invocation. Verified against the
    // pre-hardening file: a symlink to a planted watermark WAS honored and muted
    // the monitor; it is now refused (Codex review of #3808, round 4).
    if (process.platform === 'win32') {
      t.skip('symlink creation needs privilege on Windows; the guard is lstat+O_NOFOLLOW, '
        + 'and libuv defines O_NOFOLLOW as 0 there — the lstat half still applies');
      return;
    }
    const planted = path.join(os.tmpdir(), `fix-3709-planted-${Date.now()}.json`);
    t.after(() => { try { fs.unlinkSync(planted); } catch { /* absent */ } });
    fs.writeFileSync(planted, JSON.stringify({ at: NOW_S }));

    // Control FIRST: a legitimate regular-file watermark is still honored, so
    // the refusals below cannot pass by the hook simply ignoring watermarks.
    assert.strictEqual(drive({ remaining: 30, watermarkAt: NOW_S, timestamp: NOW_S, nowMs: NOW_MS }).stdout, '',
      'a plain watermark must still mute — otherwise the refusals prove nothing');

    for (const [label, plant] of [
      ['a symlink', (wp) => fs.symlinkSync(planted, wp)],
      ['a directory', (wp) => fs.mkdirSync(wp)],
      ['an oversized file', (wp) => fs.writeFileSync(wp, JSON.stringify({ at: NOW_S, pad: 'x'.repeat(8192) }))],
    ]) {
      const { stdout, exitCode } = drive({
        remaining: 30, timestamp: NOW_S, nowMs: NOW_MS, plantWatermark: plant,
      });
      assert.strictEqual(exitCode, 0, `${label}: a refused watermark must never fail the hook`);
      assert.match(stdout, /CONTEXT WARNING/,
        `${label}: must not be honored as a watermark — in a shared sticky tmpdir that is a mute `
        + 'primitive, and a symlink to a FIFO is a stall primitive on this synchronous read');
    }
  });

  // Round 8 (class sweep): the SAME 4096-byte bound guards the round-4
  // WATERMARK read at gsd-context-monitor.js:278, and its refusal row above
  // pads to 8192 exactly as the sentinel's did. Round 8's Minor was raised
  // against the round-7 sentinel bound only — this trio applies the identical
  // reasoning to its twin, so one constant is not held to this file's boundary
  // convention while the other, byte-for-byte the same check, is not. The bound
  // is pre-existing and this addition is test-only; say the word and it comes
  // out without touching the rest.
  test('round 8: the watermark size bound is exact at 4095/4096/4097', () => {
    // 'x' is one UTF-8 byte and never JSON-escaped, so the serialized length
    // moves one byte per padding character — but the payload is still sized by
    // MEASUREMENT below, not by arithmetic on an assumed prefix width, so a
    // change to the skeleton cannot silently move the fence off the boundary.
    const watermarkOfExactBytes = (bytes) => {
      const skeleton = JSON.stringify({ at: NOW_S, pad: '' });
      const pad = bytes - Buffer.byteLength(skeleton, 'utf8');
      assert.ok(pad >= 0, `${bytes} is smaller than the un-padded watermark skeleton`);
      const out = JSON.stringify({ at: NOW_S, pad: 'x'.repeat(pad) });
      assert.strictEqual(Buffer.byteLength(out, 'utf8'), bytes,
        'the padding arithmetic must land exactly on the size under test');
      return out;
    };

    // `st.size > 4096`: 4095 and 4096 are legal and must be HONORED (and so
    // mute the monitor), 4097 is one byte over and must be REFUSED. The 4097
    // row is the non-vacuity control for the two accept rows — without it,
    // a read that refused everything would still pass them.
    for (const [bytes, honored] of [[4095, true], [4096, true], [4097, false]]) {
      const { stdout, exitCode } = drive({
        remaining: 30, timestamp: NOW_S, nowMs: NOW_MS,
        plantWatermark: (wp) => fs.writeFileSync(wp, watermarkOfExactBytes(bytes)),
      });
      assert.strictEqual(exitCode, 0, `${bytes}: a size verdict must never fail the hook`);
      if (honored) {
        assert.strictEqual(stdout, '',
          `${bytes}: at or under the bound the watermark must be HONORED and mute the monitor; `
          + 'a warning here means the read refused a legal watermark');
      } else {
        assert.match(stdout, /CONTEXT WARNING/,
          `${bytes}: one byte over the bound must be REFUSED, leaving the monitor unmuted`);
      }
    }
  });

});

// ─── #4285: WARNING/CRITICAL fire-points resolve from .planning/config.json ───

describe('#4285 regression: context-monitor thresholds resolve from .planning/config.json', () => {
  // Why these are behavioural spawns rather than unit calls on resolveThresholds:
  // the value under test is not the resolver's return, it is WHICH fire-point the
  // running hook compares `remaining_percentage` against. A unit test on the
  // resolver would pass even if the resolved pair were never threaded to the two
  // comparison sites, which is the whole of the change.
  const sid = (tag) => `test-4285-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const severityOf = (stdout) => JSON.parse(stdout)?.hookSpecificOutput?.severity;

  test('a raised warning threshold fires where the default is silent', () => {
    // remaining 40 is ABOVE the default 35 → the hook is silent by default.
    // The control below proves that; without it this test would pass on a hook
    // that emits for every reading.
    const control = runMonitorRaw({ sessionId: sid('raise-control'), writeMetrics: true, remaining: 40, usedPct: 60 });
    assert.strictEqual(control.stdout, '',
      'control: remaining 40 must be silent under the default 35 threshold — ' +
      'if this emits, the test below proves nothing about the config key');

    const { exitCode, stdout } = runMonitorRaw({
      sessionId: sid('raise'),
      writeMetrics: true,
      remaining: 40,
      usedPct: 60,
      planningConfig: { hooks: { context_warning_threshold: 45 } },
    });

    assert.strictEqual(exitCode, 0, 'resolving a configured threshold must not fail the hook');
    assert.match(stdout, /CONTEXT WARNING/,
      'a configured warning threshold of 45 must fire at remaining 40; still silent means ' +
      'the hook is comparing against the hardcoded 35');
    assert.strictEqual(severityOf(stdout), 'warning', 'crossing only the warning point is not CRITICAL');
  });

  test('a raised critical threshold escalates a reading the default calls WARNING', () => {
    // remaining 32: default resolves warning (32 <= 35, 32 > 25). With critical
    // moved to 35 the same reading is CRITICAL — so this pins the critical key
    // specifically, not just "some threshold was read".
    const control = runMonitorRaw({ sessionId: sid('crit-control'), writeMetrics: true, remaining: 32, usedPct: 68 });
    assert.strictEqual(severityOf(control.stdout), 'warning',
      'control: remaining 32 is a WARNING under the defaults');

    const { stdout } = runMonitorRaw({
      sessionId: sid('crit'),
      writeMetrics: true,
      remaining: 32,
      usedPct: 68,
      planningConfig: { hooks: { context_warning_threshold: 45, context_critical_threshold: 35 } },
    });

    assert.strictEqual(severityOf(stdout), 'critical',
      'a configured critical threshold of 35 must escalate remaining 32 to CRITICAL');
  });

  test('a lowered warning threshold silences a reading the default warns on', () => {
    // The opposite direction — proves the key moves the fire-point rather than
    // only ever adding warnings.
    const control = runMonitorRaw({ sessionId: sid('lower-control'), writeMetrics: true, remaining: 30, usedPct: 70 });
    assert.match(control.stdout, /CONTEXT WARNING/,
      'control: remaining 30 warns under the defaults');

    const { exitCode, stdout } = runMonitorRaw({
      sessionId: sid('lower'),
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      planningConfig: { hooks: { context_warning_threshold: 20, context_critical_threshold: 10 } },
    });

    assert.strictEqual(exitCode, 0, 'hook exits 0 when the configured thresholds silence it');
    assert.strictEqual(stdout, '',
      'with the pair moved to 20/10, remaining 30 is above the warning point and must be silent');
  });

  test('an unusable value falls back to that key\'s default rather than throwing', () => {
    // One row per rejection reason, each run at remaining 40, where the default
    // is silent and the honoured value (45) is not. Silence here is NOT a unique
    // signature of rejection — Codex review of this PR showed that an accepted
    // out-of-domain value can reach the same silence through the pair check
    // instead (an accepted -5 pairs with the default critical 25, which is
    // >= -5, so both revert and 40 is silent again). So this table proves
    // "unusable input never fires early and never throws"; the two rows BELOW
    // are what separate per-key fallback from honouring the value.
    const rejected = [
      ['string', '45'],
      ['above domain', 150],
      ['negative', -5],
      ['null', null],
      ['boolean', true],
      ['array', [45]],
      ['object', {}],
    ];

    for (const [label, value] of rejected) {
      const { exitCode, stdout } = runMonitorRaw({
        sessionId: sid(`bad-${label.replace(/\W+/g, '-')}`),
        writeMetrics: true,
        remaining: 40,
        usedPct: 60,
        planningConfig: { hooks: { context_warning_threshold: value } },
      });

      assert.strictEqual(exitCode, 0, `${label}: an unusable threshold must never fail the hook`);
      assert.strictEqual(stdout, '',
        `${label}: an unusable threshold must fall back to the default 35, leaving remaining 40 silent`);
    }
  });

  test('100 is inside the domain, not rejected as out of range', () => {
    // The bound is inclusive on the top. 100 warns at every reading; if the
    // range check were `< 100` this would fall back to 35 and go silent at
    // remaining 40, which is exactly what the rejection table above asserts for
    // a genuinely out-of-domain 150.
    const { stdout } = runMonitorRaw({
      sessionId: sid('bound-100'),
      writeMetrics: true,
      remaining: 40,
      usedPct: 60,
      planningConfig: { hooks: { context_warning_threshold: 100 } },
    });

    assert.match(stdout, /CONTEXT WARNING/,
      'a warning threshold of 100 is in-domain and must fire at remaining 40');
  });

  test('an inconsistent pair falls back to BOTH defaults, not to the usable half', () => {
    // warning 20 / critical 25 is inconsistent (critical >= warning). Honouring
    // the warning half alone would leave remaining 30 SILENT; falling back to
    // both defaults warns. NOTE the limit of this row, raised by Codex review:
    // critical 25 IS the default here, so it cannot show that the CRITICAL side
    // reverts — an implementation that reset only `warning` would pass it. The
    // 45/50 block below is what pins both halves.
    const { exitCode, stdout } = runMonitorRaw({
      sessionId: sid('pair'),
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      planningConfig: { hooks: { context_warning_threshold: 20, context_critical_threshold: 25 } },
    });

    assert.strictEqual(exitCode, 0, 'an inconsistent pair must never fail the hook');
    assert.match(stdout, /CONTEXT WARNING/,
      'an inconsistent pair resolves to the defaults (35/25), which warn at remaining 30; ' +
      'silence here would mean the warning half was honoured on its own');
    assert.strictEqual(severityOf(stdout), 'warning',
      'the default critical (25) is below remaining 30, so the fallback pair yields WARNING');
  });

  test('a single override is checked against the OTHER key\'s default', () => {
    // Same rule as the row above, reached with one key set instead of two — the
    // case the docs call out, because it is the one an operator hits by accident.
    const { stdout } = runMonitorRaw({
      sessionId: sid('single'),
      writeMetrics: true,
      remaining: 30,
      usedPct: 70,
      planningConfig: { hooks: { context_warning_threshold: 20 } },
    });

    assert.match(stdout, /CONTEXT WARNING/,
      'warning 20 against the default critical 25 is inconsistent and resolves to 35/25, ' +
      'which warns at remaining 30');
  });

  test('an invalid key falls back alone — the sibling override survives', () => {
    // Codex review: nothing above separated per-key fallback from a
    // reset-BOTH implementation. Warning 45 is usable, critical is not.
    // Per key -> (45, 25): remaining 40 is <= 45 and > 25, so WARNING.
    // Reset both -> (35, 25): remaining 40 is above 35, so SILENCE.
    const { stdout } = runMonitorRaw({
      sessionId: sid('sibling'),
      writeMetrics: true,
      remaining: 40,
      usedPct: 60,
      planningConfig: { hooks: { context_warning_threshold: 45, context_critical_threshold: '30' } },
    });

    assert.match(stdout, /CONTEXT WARNING/,
      'an unusable critical must not drag the usable warning override down with it');
    // What this row pins is the WARNING side surviving. It does NOT by itself
    // prove critical became 25: coercing '30' to 30 would also yield WARNING at
    // remaining 40 (Codex review, round 2). The next row settles that.
    assert.strictEqual(severityOf(stdout), 'warning',
      'remaining 40 is above any resolved critical here, so the severity is the warning rung');
  });

  test('a numeric-looking STRING is rejected, not coerced', () => {
    // Same config as the row above, read at 28 — the reading that separates the
    // two candidate resolutions:
    //   rejected -> (45, 25): 28 > 25, so WARNING.
    //   coerced  -> (45, 30): 28 <= 30, so CRITICAL.
    const { stdout } = runMonitorRaw({
      sessionId: sid('string-critical'),
      writeMetrics: true,
      remaining: 28,
      usedPct: 72,
      planningConfig: { hooks: { context_warning_threshold: 45, context_critical_threshold: '30' } },
    });

    assert.strictEqual(severityOf(stdout), 'warning',
      "'critical' at remaining 28 means the string '30' was coerced into a fire-point; " +
      'Number.isFinite must reject it and leave critical at its default 25');
  });

  test('a below-domain critical is rejected rather than honoured', () => {
    // Codex review: the -5 row in the table above cannot tell rejection from
    // acceptance. Here it can. Warning 45 with critical -5:
    //   rejected -> (45, 25): remaining 20 is <= 25, so CRITICAL.
    //   honoured -> (45, -5): remaining 20 is above -5, so merely WARNING.
    const { stdout } = runMonitorRaw({
      sessionId: sid('neg-critical'),
      writeMetrics: true,
      remaining: 20,
      usedPct: 80,
      planningConfig: { hooks: { context_warning_threshold: 45, context_critical_threshold: -5 } },
    });

    assert.strictEqual(severityOf(stdout), 'critical',
      'a negative critical must fall back to 25 and escalate remaining 20; ' +
      "'warning' here means -5 was honoured as a fire-point");
  });

  describe('an inconsistent pair of TWO configured values reverts both', () => {
    // Codex review: the 20/25 row cannot prove the critical side resets, because
    // 25 IS the default — an implementation that reset only `warning` would pass
    // it. 45/50 is inconsistent with BOTH halves away from their defaults, so
    // each reading below fails a different partial implementation.
    const pair = { context_warning_threshold: 45, context_critical_threshold: 50 };

    test('the warning half reverts: remaining 40 is silent', () => {
      // Reverted -> warning 35, and 40 > 35 -> silence.
      // Warning 45 preserved -> 40 <= 45 -> a warning would fire.
      const { exitCode, stdout } = runMonitorRaw({
        sessionId: sid('pair45-40'), writeMetrics: true, remaining: 40, usedPct: 60,
        planningConfig: { hooks: { ...pair } },
      });
      // exitCode first: the helper turns a spawn failure, a non-zero exit or a
      // timeout into empty stdout too, so asserting silence alone would pass on
      // a crashed child (Codex review, round 2).
      assert.strictEqual(exitCode, 0, 'the silence below must come from the threshold, not from a dead child');
      assert.strictEqual(stdout, '',
        'output at remaining 40 means the configured warning 45 survived an inconsistent pair');
    });

    test('the critical half reverts: remaining 32 is WARNING, not CRITICAL', () => {
      // Reverted -> critical 25, and 32 > 25 -> severity 'warning'.
      // Critical 50 preserved -> 32 <= 50 -> severity 'critical'.
      const { stdout } = runMonitorRaw({
        sessionId: sid('pair45-32'), writeMetrics: true, remaining: 32, usedPct: 68,
        planningConfig: { hooks: { ...pair } },
      });
      assert.match(stdout, /CONTEXT WARNING/, 'the default warning 35 must fire at remaining 32');
      assert.strictEqual(severityOf(stdout), 'warning',
        "'critical' at remaining 32 means the configured critical 50 survived an inconsistent pair");
    });
  });

  test('an EQUAL pair is inconsistent too — critical must fire strictly deeper', () => {
    // The boundary of the pair rule: `critical < warning`, not `<=`. With 45/45
    // honoured, remaining 40 would be <= 45 on BOTH tests and every warning
    // would arrive pre-escalated to CRITICAL. Rejected, both revert to 35/25 and
    // remaining 40 is above the warning point.
    const { exitCode, stdout } = runMonitorRaw({
      sessionId: sid('equal-pair'),
      writeMetrics: true,
      remaining: 40,
      usedPct: 60,
      planningConfig: { hooks: { context_warning_threshold: 45, context_critical_threshold: 45 } },
    });

    assert.strictEqual(exitCode, 0, 'an equal pair must never fail the hook');
    assert.strictEqual(stdout, '',
      'an equal pair must revert to 35/25, leaving remaining 40 silent');
  });

  test('context_warnings:false still wins over configured thresholds', () => {
    // A project that tuned the thresholds and later switched warnings off stays
    // silent: the disable exit is unconditional, so no configured fire-point can
    // resurrect it. NOT an ordering guard — measured: moving the resolution
    // above the disable check leaves this row green, because allow() exits
    // either way. The ordering is a cost choice (don't resolve on a path that
    // exits), not an observable, so nothing here pins it.
    const { exitCode, stdout } = runMonitorRaw({
      sessionId: sid('disabled'),
      writeMetrics: true,
      remaining: 40,
      usedPct: 60,
      planningConfig: {
        hooks: {
          context_warnings: false,
          context_warning_threshold: 45,
          context_critical_threshold: 30,
        },
      },
    });

    assert.strictEqual(exitCode, 0, 'hook exits 0 when warnings are disabled');
    assert.strictEqual(stdout, '',
      'context_warnings:false must silence the hook even when a threshold would have fired');
  });
});

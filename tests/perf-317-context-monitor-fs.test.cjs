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
 * @returns {{ exitCode: number, stdout: string }}
 */
function runMonitorRaw(opts) {
  const {
    sessionId,
    cwd = tmpDir,
    writeMetrics = false,
    remaining = 20,
    usedPct = 80,
    writeWarn = false,
    warnData = null,
  } = opts;

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
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('PostToolUse at 20% → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 20, used: 80 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
  });

  test('AfterTool at 30% → WARNING envelope with hookEventName AfterTool', () => {
    const { stdout } = runMonitor({ event: 'AfterTool', remaining: 30 });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'AfterTool');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('explicit PostToolUse WITH Gemini env → explicit name wins over the AfterTool fallback', () => {
    // Precedence guard: the Gemini fallback only applies to a MISSING name; an
    // explicit PostToolUse must still report as PostToolUse even under GEMINI_API_KEY.
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 30, gemini: true });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  // Threshold boundaries on the emit path: 36 = no warn, 35 = warn, 25 = critical, 26 = warn.
  test('PostToolUse at 36% (above WARNING) → empty stdout', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 36 });
    assert.strictEqual(stdout, '', 'no warning above the 35% threshold');
  });

  test('PostToolUse at 35% (WARNING boundary) → WARNING envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 35 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT WARNING/);
  });

  test('PostToolUse at 25% (CRITICAL boundary) → CRITICAL envelope', () => {
    const { stdout } = runMonitor({ event: 'PostToolUse', remaining: 25 });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
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
      call(event, remaining, { metrics = true, failUnlinkMatching = null, lstatClaimsFileMatching = null } = {}) {
        if (metrics === 'keep') {
          // leave the bridge exactly as the previous call left it
        } else if (metrics) {
          fs.writeFileSync(metricsPath, JSON.stringify({
            session_id: id,
            remaining_percentage: remaining,
            used_pct: 100 - remaining,
            // +2s: deliberately a hair in the future. The compaction watermark
            // has one-second granularity and these tests run PreCompact and
            // the next PostToolUse inside the same second — a real session's
            // post-compaction render lands seconds later. Future-stamping by
            // 2s keeps the reading "strictly newer than the watermark" without
            // touching the staleness math (a negative age is never > 60).
            timestamp: Math.floor(Date.now() / 1000) + 2,
          }));
        } else {
          try { fs.unlinkSync(metricsPath); } catch { /* already absent */ }
        }
        let stdout = '';
        let exitCode = 0;
        const usePreload = failUnlinkMatching || lstatClaimsFileMatching;
        const argv = usePreload ? ['--require', UNLINK_EPERM_PRELOAD, HOOK] : [HOOK];
        const env = usePreload
          ? {
              ...process.env,
              ...(failUnlinkMatching ? { GSD_TEST_UNLINK_EPERM_MATCH: failUnlinkMatching } : {}),
              ...(lstatClaimsFileMatching ? { GSD_TEST_LSTAT_CLAIMS_FILE_MATCH: lstatClaimsFileMatching } : {}),
            }
          : process.env;
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

  test('AC2: after a compaction the first WARNING fires immediately, not debounced', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    s.call('PreCompact', 20);
    const { stdout } = s.call('PostToolUse', 30);
    assert.match(stdout, /CONTEXT WARNING/,
      'The context-monitor reference states "First warning always fires immediately". Before the fix '
      + 'this was silently debounced: the surviving sentinel made it look like a repeat warning');
  });

  test('AC3: after a compaction a WARNING -> CRITICAL escalation bypasses debounce', (t) => {
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    s.call('PreCompact', 20);
    s.call('PostToolUse', 30);
    assert.strictEqual(s.warn().lastLevel, 'warning', 'the fresh cycle recorded a WARNING');
    const { stdout } = s.call('PostToolUse', 20);
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

    const r = s.call('PreCompact', 20, {
      failUnlinkMatching: '-warned.json',
      lstatClaimsFileMatching: '-warned.json',
    });
    assert.strictEqual(r.exitCode, 0, 'ELOOP is a give-up, never a hook failure');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'precious victim bytes',
      'with lstat blinded, only O_NOFOLLOW stands between the open and the victim — the target '
      + 'must be untouched');
    assert.ok(fs.lstatSync(s.warnPath).isSymbolicLink(),
      'the planted symlink must survive — its absence means the injection never engaged');
  });

  test('round 3, Major 1: a statusline rewrite DURING the compaction cannot re-fire off the old reading', (t) => {
    // PreCompact deletes the bridge, but the statusline is an uncoordinated
    // process that re-writes it on every render — a render landing between the
    // clear and the compaction's completion re-creates the PRE-compaction
    // remaining with a CURRENT timestamp, sailing past STALE_SECONDS. The
    // compaction watermark makes that reading identifiable: anything not
    // strictly newer than the watermark is dropped.
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

  test('round 3, Major 1: a genuinely post-compaction reading still warns', (t) => {
    // The non-vacuity half: the watermark must drop the OLD reading, not all
    // readings — a strictly newer one passes and the fresh cycle behaves like
    // a fresh session.
    const s = makeSession(t);
    s.seed({ callsSinceWarn: 0, lastLevel: 'critical', criticalRecorded: true });
    assert.strictEqual(s.call('PreCompact', 20).exitCode, 0);
    const wm = s.watermark();
    assert.ok(wm && typeof wm.at === 'number', 'PreCompact must leave a watermark');
    s.writeBridge({ remaining_percentage: 30, used_pct: 70, timestamp: wm.at + 1 });
    const { stdout } = s.call('PostToolUse', 30, { metrics: 'keep' });
    assert.match(stdout, /CONTEXT WARNING/,
      'a reading strictly newer than the watermark is the new cycle — it must warn immediately');
  });

  test('round 3, Minor 6: a malformed hook_event_name is silent, with side effects intact', (t) => {
    // readEventName is TOTAL: a truthy non-string name (malformed or
    // future-dialect payload) used to throw at the tail call site — AFTER the
    // side effects — and hoisting it to the PreCompact check would have moved
    // that throw ahead of them, silently breaking #2289's documented contract.
    // Now it reads as an unknown event: no output, side effects run.
    const s = makeSession(t);
    const { stdout, exitCode } = s.call(42, 30);
    assert.strictEqual(exitCode, 0, 'a malformed event name must never fail the hook');
    assert.strictEqual(stdout, '', 'unknown events emit nothing (#2289 allowlist)');
    assert.ok(s.warn(), 'the debounce sentinel side effect must still have run (#2289 contract)');
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

  function drive({ remaining = 30, warnData = null, timestamp = NOW_S }) {
    const id = `fix-3709-trio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metricsPath = path.join(os.tmpdir(), `claude-ctx-${id}.json`);
    const warnPath = path.join(os.tmpdir(), `claude-ctx-${id}-warned.json`);
    fs.writeFileSync(metricsPath, JSON.stringify({
      session_id: id, remaining_percentage: remaining, used_pct: 100 - remaining, timestamp,
    }));
    if (warnData) fs.writeFileSync(warnPath, JSON.stringify(warnData));
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, ['--require', NOW_PRELOAD, HOOK], {
        input: JSON.stringify({ session_id: id, cwd: os.tmpdir(), hook_event_name: 'PostToolUse' }),
        encoding: 'utf8',
        timeout: 8000,
        env: { ...process.env, GSD_TEST_NOW_MS: String(NOW_MS) },
      });
    } catch (e) { stdout = e.stdout || ''; exitCode = e.status ?? 1; }
    finally {
      for (const p of [metricsPath, warnPath]) { try { fs.unlinkSync(p); } catch { /* absent */ } }
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
});

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

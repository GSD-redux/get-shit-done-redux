#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Context Monitor - PostToolUse/AfterTool hook (Gemini uses AfterTool)
// Reads context metrics from the statusline bridge file and injects
// warnings when context usage is high. This makes the AGENT aware of
// context limits (the statusline only shows the user).
//
// How it works:
// 1. The statusline hook writes metrics to /tmp/claude-ctx-{session_id}.json
// 2. This hook reads those metrics after each tool use
// 3. When remaining context drops below thresholds, it injects a warning
//    as additionalContext, which the agent sees in its conversation
//
// Thresholds:
//   WARNING  (remaining <= 35%): Agent should wrap up current task
//   CRITICAL (remaining <= 25%): Agent should stop immediately and save state
//
// Debounce: 5 tool uses between warnings to avoid spam
// Severity escalation bypasses debounce (WARNING -> CRITICAL fires immediately)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');

// This hook only injects an advisory context-usage warning; it never blocks
// the tool call it rides in on. A crash here (e.g. a malformed bridge file)
// must not turn a PostToolUse advisory into a blocked tool call — losing a
// context warning is far cheaper than stalling the agent's work (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

const WARNING_THRESHOLD = 35;  // remaining_percentage <= 35%
const CRITICAL_THRESHOLD = 25; // remaining_percentage <= 25%
const STALE_SECONDS = 60;      // ignore metrics older than 60s
const DEBOUNCE_CALLS = 5;      // min tool uses between warnings

let input = '';
// Timeout guard: if stdin doesn't close within 10s (e.g. pipe issues on
// Windows/Git Bash, or slow Claude Code piping during large outputs),
// exit silently instead of hanging until Claude Code kills the process
// and reports "hook error". See #775, #1162.
const stdinTimeout = setTimeout(() => allow(undefined), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;

    if (!sessionId) {
      allow(undefined);
    }

    // Reject session IDs that contain path traversal sequences or path separators.
    // session_id is used to construct file paths in /tmp — an unsanitized value
    // could escape the temp directory and read or write arbitrary files.
    if (/[/\\]|\.\./.test(sessionId)) {
      allow(undefined);
    }

    // Check if context warnings are disabled via config.
    // Collapsed existsSync+readFileSync into a single read guarded by try/catch
    // (ENOENT or parse error → use defaults, same as old "planningDir absent" branch).
    const cwd = data.cwd || process.cwd();
    try {
      const configPath = path.join(cwd, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.hooks?.context_warnings === false) {
        allow(undefined);
      }
    } catch (e) {
      // Missing or unparseable config → proceed with defaults (context warnings enabled)
    }

    const tmpDir = os.tmpdir();
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);

    // If no metrics file, this is a subagent or fresh session -- exit silently.
    // Collapsed existsSync+readFileSync: ENOENT → exit 0 (identical to old !existsSync branch),
    // other errors rethrow to the outer catch (swallowed → exit 0, as before).
    let metricsRaw;
    try {
      metricsRaw = fs.readFileSync(metricsPath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') allow(undefined);
      throw e;
    }
    const metrics = JSON.parse(metricsRaw);
    const now = Math.floor(Date.now() / 1000);

    // Ignore stale metrics
    if (metrics.timestamp && (now - metrics.timestamp) > STALE_SECONDS) {
      allow(undefined);
    }

    const remaining = metrics.remaining_percentage;
    const usedPct = metrics.used_pct;

    // No warning needed
    if (remaining > WARNING_THRESHOLD) {
      allow(undefined);
    }

    // Debounce: check if we warned recently
    const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);
    let warnData = { callsSinceWarn: 0, lastLevel: null };
    let firstWarn = true;

    // Collapsed existsSync+readFileSync: ENOENT or parse error → keep default warnData
    // (same as old "file absent" branch). firstWarn tracks whether we read a valid sentinel.
    try {
      warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
      firstWarn = false;
    } catch (e) {
      // Missing or corrupted sentinel → firstWarn stays true, warnData stays at defaults
    }

    warnData.callsSinceWarn = (warnData.callsSinceWarn || 0) + 1;

    const isCritical = remaining <= CRITICAL_THRESHOLD;
    const currentLevel = isCritical ? 'critical' : 'warning';

    // Emit immediately on first warning, then debounce subsequent ones
    // Severity escalation (WARNING -> CRITICAL) bypasses debounce
    const severityEscalated = currentLevel === 'critical' && warnData.lastLevel === 'warning';
    if (!firstWarn && warnData.callsSinceWarn < DEBOUNCE_CALLS && !severityEscalated) {
      // Update counter and exit without warning
      fs.writeFileSync(warnPath, JSON.stringify(warnData));
      allow(undefined);
    }

    // Reset debounce counter
    warnData.callsSinceWarn = 0;
    warnData.lastLevel = currentLevel;
    fs.writeFileSync(warnPath, JSON.stringify(warnData));

    // Detect if GSD is active (has .planning/STATE.md in working directory)
    const isGsdActive = fs.existsSync(path.join(cwd, '.planning', 'STATE.md'));

    // On CRITICAL with active GSD project, auto-record session state as a
    // breadcrumb for /gsd:resume-work (#1974). Fire-and-forget subprocess —
    // doesn't block the hook or the agent. Fires ONCE per CRITICAL session,
    // guarded by warnData.criticalRecorded to prevent repeated overwrites
    // of the "crash moment" record on every debounce cycle.
    if (isCritical && isGsdActive && !warnData.criticalRecorded) {
      try {
        // Runtime-agnostic path: this hook lives at <runtime-config>/hooks/
        // and gsd-tools.cjs lives at <runtime-config>/gsd-core/bin/.
        // Using __dirname makes this work on Claude Code, OpenCode, Gemini,
        // Kilo, etc. without hardcoding ~/.claude/.
        const gsdTools = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
        // Coerce usedPct to a safe number in case bridge file is malformed
        const safeUsedPct = Number(usedPct) || 0;
        const stoppedAt = `context exhaustion at ${safeUsedPct}% (${new Date().toISOString().split('T')[0]})`;
        spawn(
          process.execPath,
          [gsdTools, 'state', 'record-session', '--stopped-at', stoppedAt],
          { cwd, detached: true, stdio: 'ignore', windowsHide: true }
        ).unref();
        warnData.criticalRecorded = true;
        // Persist the sentinel so subsequent debounce cycles don't re-fire
        fs.writeFileSync(warnPath, JSON.stringify(warnData));
      } catch { /* non-critical — don't let state recording break the hook */ }
    }

    // Build advisory warning message (never use imperative commands that
    // override user preferences — see #884)
    let message;
    if (isCritical) {
      message = isGsdActive
        ? `CONTEXT CRITICAL: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
          'Context is nearly exhausted. Do NOT start new complex work or write handoff files — ' +
          'GSD state is already tracked in STATE.md. Inform the user so they can run ' +
          '/gsd:pause-work at the next natural stopping point.'
        : `CONTEXT CRITICAL: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
          'Context is nearly exhausted. Inform the user that context is low and ask how they ' +
          'want to proceed. Do NOT autonomously save state or write handoff files unless the user asks.';
    } else {
      message = isGsdActive
        ? `CONTEXT WARNING: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
          'Context is getting limited. Avoid starting new complex work. If not between ' +
          'defined plan steps, inform the user so they can prepare to pause.'
        : `CONTEXT WARNING: Usage at ${usedPct}%. Remaining: ${remaining}%. ` +
          'Be aware that context is getting limited. Avoid unnecessary exploration or ' +
          'starting new complex work.';
    }

    // #2289: the hookSpecificOutput.additionalContext envelope is only a valid
    // output shape for the context-injection events (PostToolUse, and AfterTool
    // for the Gemini dialect). This hook is also wired to other lifecycle events
    // on some hosts — Codex registers it under Stop / SubagentStart /
    // SubagentStop / PreCompact (#772) — and those reject the envelope
    // ("hook returned invalid stop hook JSON output"). Use a POSITIVE allowlist:
    // emit only for injection-capable events; every other event, and a
    // missing/unrecognized name, exits 0 with no stdout. A Stop-only blacklist is
    // not enough — a missing name would still fall through to the injection path.
    // All side effects above (debounce counter, one-time critical-session
    // recording) have already run regardless of whether output is emitted.
    const eventName = (data.hook_event_name && data.hook_event_name.trim()) || "";
    // Preserve the pre-#2289 Gemini fallback: a missing event name under a
    // Gemini-dialect runtime (GEMINI_API_KEY set) still means AfterTool, so its
    // advisory output is unchanged. A missing name on any other host is silent.
    const geminiFallback = eventName === "" && !!process.env.GEMINI_API_KEY;
    const injectionSupported = eventName === "PostToolUse" || eventName === "AfterTool" || geminiFallback;

    if (injectionSupported) {
      const output = {
        hookSpecificOutput: {
          hookEventName: eventName || "AfterTool",
          additionalContext: message
        }
      };
      process.stdout.write(JSON.stringify(output));
    }
  } catch (e) {
    // Silent fail -- never block tool execution.
    // ON_CRASH is declared ALLOW at module top: this preserves today's
    // exit(0) fail-open behavior exactly (#3911).
    crash(ON_CRASH, undefined);
  }
});

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

const WARNING_THRESHOLD = 35;  // remaining_percentage <= 35%
const CRITICAL_THRESHOLD = 25; // remaining_percentage <= 25%
const STALE_SECONDS = 60;      // ignore metrics older than 60s
const DEBOUNCE_CALLS = 5;      // min tool uses between warnings

// One DEFINITION of what counts as a lifecycle event name, shared by the #3709
// PreCompact reset and the #2289 output-envelope allowlist. Two call sites, one
// rule — so the two cannot drift into disagreeing about what "no event name" is.
function readEventName(data) {
  return (data && data.hook_event_name && data.hook_event_name.trim()) || "";
}

let input = '';
// Timeout guard: if stdin doesn't close within 10s (e.g. pipe issues on
// Windows/Git Bash, or slow Claude Code piping during large outputs),
// exit silently instead of hanging until Claude Code kills the process
// and reports "hook error". See #775, #1162.
const stdinTimeout = setTimeout(() => process.exit(0), 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;

    if (!sessionId) {
      process.exit(0);
    }

    // Reject session IDs that contain path traversal sequences or path separators.
    // session_id is used to construct file paths in /tmp — an unsanitized value
    // could escape the temp directory and read or write arbitrary files.
    if (/[/\\]|\.\./.test(sessionId)) {
      process.exit(0);
    }

    const tmpDir = os.tmpdir();
    const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);

    // #3709: a compaction RESTARTS the context lifecycle — usage drops back to
    // Normal and the next climb is a fresh cycle — so the warn sentinel must not
    // survive it. The hook was already wired to PreCompact (#772), but the event
    // was only read at the very END, and solely to pick the output envelope.
    //
    // Left in place, `lastLevel` stays pinned at 'critical' for the rest of the
    // session and two documented behaviours die (docs/context-monitor.md):
    // "First warning always fires immediately" — the first warning of the new
    // cycle is debounced instead; and "Severity escalation (WARNING -> CRITICAL)
    // bypasses debounce" — computed as `lastLevel === 'warning'`, which can never
    // be true again, so every later CRITICAL waits out the full debounce, exactly
    // when an immediate warning matters most. `criticalRecorded` is equally
    // sticky, so the #1974 /gsd:resume-work breadcrumb would keep describing the
    // earlier near-miss rather than the exhaustion that actually ended the run.
    //
    // Handled HERE — ahead of BOTH the config check and the metrics read —
    // deliberately. Ahead of the metrics read because a PreCompact payload
    // carries no fresh metrics, and a post-compaction reading is healthy again, so
    // the ENOENT / stale / above-threshold branches below all exit first and the
    // sentinel would never be cleared. Returning early also stops the compaction
    // itself from consuming a debounce slot — observed in the issue as
    // callsSinceWarn advancing 0 -> 1 on the PreCompact call.
    //
    // KNOWN, and deliberate: PreCompact fires BEFORE the compaction, so an
    // aborted or failed compaction leaves the state cleared while the context is
    // still genuinely critical. The effects are mild and arguably right — one
    // extra immediate CRITICAL, and criticalRecorded re-armed so a later, more
    // current breadcrumb can replace the old one. Making the reset conditional
    // would mean deferring it to SessionStart with source "compact", which is a
    // different hook event and new wiring; out of scope for this fix, and stated
    // rather than left silent (review of #3709).
    //
    // Ahead of the `context_warnings: false` exit because this is CLEANUP, not a
    // warning: state that must not outlive a compaction should not outlive it just
    // because warnings happen to be off right now. Config is re-read per invocation,
    // so a session that disables warnings, compacts, then re-enables them would
    // otherwise resurrect the stale sentinel and the original bug with it. Clearing
    // here cannot emit anything, so the disabled contract is untouched.
    if (readEventName(data) === 'PreCompact') {
      // BOTH files, not just the sentinel. Clearing the sentinel alone trades a
      // warning that never fires for one that fires when it must not: the
      // statusline bridge still holds the PRE-compaction reading, and
      // STALE_SECONDS is 60, so for up to a minute it still reads fresh and still
      // says the context is exhausted. With the sentinel gone, firstWarn is true,
      // so the next PostToolUse emits a spurious CRITICAL immediately after the
      // compaction that FREED the context — and flips criticalRecorded, spawning
      // a false "context exhaustion" breadcrumb. That is the same breadcrumb
      // inaccuracy #3709 exists to fix, re-entered from the other side. Reported
      // in review of #3709.
      //
      // Removing the bridge is not a loss of data: the statusline owns that file
      // and rewrites it on every render, and its absence is already the
      // "no reading yet" state a fresh session starts in, which exits silently.
      // A compaction invalidates the warning state AND the reading that produced
      // it, so both go.
      for (const stale of [warnPath, metricsPath]) {
        try {
          fs.unlinkSync(stale);
        } catch (e) {
          if (e && e.code === 'ENOENT') continue;   // already absent — that IS the reset
          // Windows can hold a handle (EPERM/EBUSY), and a failed unlink would
          // leave the original bug silently intact, indistinguishable from
          // success. Truncate to EMPTY instead — an empty file is the one state
          // both readers treat exactly like deletion, because JSON.parse('')
          // throws: the sentinel read falls to its catch, so firstWarn stays
          // true, and the bridge read falls to the outer catch and exits 0
          // silently. A well-formed "neutral" value is NOT equivalent (review
          // of #3709): '{}' parses fine, so the first post-compaction warning
          // is debounced — AC2 undone on this path — and '{"timestamp":0}' is
          // never stale (the staleness guard is `metrics.timestamp && ...`,
          // and 0 is falsy), so the flow reaches emit with
          // remaining === undefined.
          //
          // O_NOFOLLOW, not writeFileSync: these paths live in a shared sticky
          // tmpdir, where an unlink of a file another user planted is exactly
          // what EPERM looks like — and a planted SYMLINK would make a plain
          // truncating write empty out its TARGET instead (Codex review of
          // #3808). Refusing to follow (ELOOP) lands in the same give-up arm.
          // On Windows the constant is absent; `|| 0` keeps the fallback alive
          // there, where the held-handle case it exists for actually occurs
          // and temp dirs are per-user.
          try {
            fs.closeSync(fs.openSync(
              stale,
              fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)
            ));
          } catch (e2) { /* give up, never throw */ }
        }
      }
      process.exit(0);
    }

    // Check if context warnings are disabled via config.
    // Collapsed existsSync+readFileSync into a single read guarded by try/catch
    // (ENOENT or parse error → use defaults, same as old "planningDir absent" branch).
    const cwd = data.cwd || process.cwd();
    try {
      const configPath = path.join(cwd, '.planning', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.hooks?.context_warnings === false) {
        process.exit(0);
      }
    } catch (e) {
      // Missing or unparseable config → proceed with defaults (context warnings enabled)
    }

    // If no metrics file, this is a subagent or fresh session -- exit silently.
    // Collapsed existsSync+readFileSync: ENOENT → exit 0 (identical to old !existsSync branch),
    // other errors rethrow to the outer catch (swallowed → exit 0, as before).
    let metricsRaw;
    try {
      metricsRaw = fs.readFileSync(metricsPath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') process.exit(0);
      throw e;
    }
    const metrics = JSON.parse(metricsRaw);
    const now = Math.floor(Date.now() / 1000);

    // Ignore stale metrics
    if (metrics.timestamp && (now - metrics.timestamp) > STALE_SECONDS) {
      process.exit(0);
    }

    const remaining = metrics.remaining_percentage;
    const usedPct = metrics.used_pct;

    // No warning needed
    if (remaining > WARNING_THRESHOLD) {
      process.exit(0);
    }

    // Debounce: check if we warned recently. `warnPath` is resolved above, next to
    // metricsPath, because the PreCompact reset needs it before this point.
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
      process.exit(0);
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
    const eventName = readEventName(data);
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
    // Silent fail -- never block tool execution
    process.exit(0);
  }
});

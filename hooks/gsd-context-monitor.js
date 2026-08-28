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
// How long after a PreCompact readings stay suspect. The watermark records the
// compaction's START; the compaction keeps running after it, and a statusline
// render during it stamps the PRE-compaction reading with a CURRENT timestamp
// (Codex review of #3808, round 3) — so "newer than the watermark" alone still
// admits it. Everything inside this window is dropped instead. The cost is
// bounded and benign: a healthy reading dropped here behaves identically to an
// accepted one (it would exit above-threshold anyway), and a genuine
// exhaustion warning is delayed by at most this window after a compact.
const COMPACT_GRACE_SECONDS = 60;
// How far AHEAD of this process's clock a watermark may be and still be
// honored. PreCompact stamps it from the same clock as the reader, so the
// legitimate skew is 0; this tolerance only absorbs a clock step. It is a
// THRESHOLD, so it is named rather than inlined and carries its own boundary
// trio (Codex review of #3808, round 4). Note it also extends the mute: a
// watermark this far ahead pushes first recovery from +61 to +66 (measured).
const WATERMARK_SKEW_SECONDS = 5;

// One DEFINITION of what counts as a lifecycle event name, shared by the #3709
// PreCompact reset and the #2289 output-envelope allowlist. Two call sites, one
// rule — so the two cannot drift into disagreeing about what "no event name" is.
// TOTAL, and STRICT about type: only an actual string is an event name. The old
// inline expression threw on a truthy non-string, and hoisting it ahead of the
// pipeline would have moved that throw ahead of the side effects #2289
// documents as always running; a String() coercion is no better — it renders
// ['PreCompact'] as 'PreCompact' and would run the reset off a malformed
// payload, and a hostile toString still throws (Codex review of #3808,
// round 3). typeof does neither: any non-string reads as "no event" — silent,
// side effects intact — on both call sites.
function readEventName(data) {
  const name = data && data.hook_event_name;
  return typeof name === 'string' ? name.trim() : '';
}

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

    const tmpDir = os.tmpdir();
    const warnPath = path.join(tmpDir, `claude-ctx-${sessionId}-warned.json`);
    const metricsPath = path.join(tmpDir, `claude-ctx-${sessionId}.json`);
    const watermarkPath = path.join(tmpDir, `claude-ctx-${sessionId}-compacted.json`);

    // #3709: a compaction RESTARTS the context lifecycle, so neither the warn
    // sentinel nor the pre-compaction statusline reading may survive it. Full
    // rationale — what dies when the sentinel outlives a compaction, why the
    // reset sits ahead of the config gate and the metrics read, and why an
    // aborted compaction deliberately stays cleared — lives in ONE place:
    // docs/context-monitor.md, "PreCompact reset". Constraints the code itself
    // must keep are stated at their lines below.
    if (readEventName(data) === 'PreCompact') {
      // BOTH files: with the sentinel gone but the bridge still holding the
      // pre-compaction reading (fresh for STALE_SECONDS), the next PostToolUse
      // would fire a spurious CRITICAL off a context the compaction just freed
      // (review of #3709).
      for (const stale of [warnPath, metricsPath]) {
        try {
          fs.unlinkSync(stale);
        } catch (e) {
          if (e && e.code === 'ENOENT') continue;   // already absent — that IS the reset
          // Best-effort fallback for a held handle (Windows EPERM/EBUSY):
          // truncate to EMPTY — the one state both readers treat exactly like
          // deletion, because JSON.parse('') throws. A well-formed "neutral"
          // value is NOT equivalent: '{}' debounces the first post-compaction
          // warning, '{"timestamp":0}' is never stale (falsy guard) and emits
          // "undefined%" (review of #3808). Never through a LINK: lstat
          // rejects non-regular files on every platform (Windows has no
          // effective O_NOFOLLOW — libuv defines it as 0 — and TEMP/TMP means
          // its tmpdir is not guaranteed per-user); O_NOFOLLOW additionally
          // closes the lstat→open substitution race where honored. Every
          // refusal lands in this give-up arm — including a Windows runner
          // refusing the write-open of a freshly written file outright —
          // which is why the fallback is best-effort, never asserted-on.
          try {
            if (fs.lstatSync(stale).isFile()) {
              fs.closeSync(fs.openSync(
                stale,
                fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)
              ));
            }
          } catch (e2) { /* give up, never throw */ }
        }
      }

      // COMPACTION WATERMARK (review of #3808, round 3). Deleting the bridge
      // only NARROWS the stale-reading window: the statusline is an
      // uncoordinated process that re-writes the bridge on every render, so a
      // render landing between this clear and the compaction's completion
      // re-creates the PRE-compaction reading with a CURRENT timestamp — and
      // it would sail past STALE_SECONDS as freshly valid. The watermark makes
      // the pre-compaction reading identifiable rather than merely absent: the
      // metrics read drops any reading not strictly newer than it. Written
      // unlink-then-O_EXCL so an existing file — or a planted symlink — is
      // never followed or overwritten in place; failure to write degrades to
      // the old narrowing, never throws.
      try {
        try {
          fs.unlinkSync(watermarkPath);
        } catch (e) {
          if (!e || e.code !== 'ENOENT') throw e;
        }
        const wfd = fs.openSync(
          watermarkPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        );
        fs.writeSync(wfd, JSON.stringify({ at: Math.floor(Date.now() / 1000) }));
        fs.closeSync(wfd);
      } catch (e) { /* best effort — see above */ }
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
        allow(undefined);
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
      if (e && e.code === 'ENOENT') allow(undefined);
      throw e;
    }
    const metrics = JSON.parse(metricsRaw);
    const now = Math.floor(Date.now() / 1000);

    // #3709 (round 3): a reading not clearly PAST the compaction is suspect,
    // whatever its timestamp says — the statusline re-writes the bridge on
    // every render, and a render during the compaction stamps the OLD
    // remaining_percentage with a current time. The watermark records the
    // compaction's START, so "newer than the watermark" alone still admits a
    // mid-compaction render (Codex review of #3808, round 3): the grace
    // window covers the compaction's own duration. `!(>)` rather than `<=` so
    // a missing/zero/garbage timestamp is also dropped once a compaction has
    // happened — an unstamped reading cannot prove it is post-compaction.
    //
    // The watermark itself must be SANE to count: one stamped in the future
    // (a clock step backwards, a stray file) would otherwise drop every
    // reading indefinitely and silently self-disable monitoring — so it is
    // honored only when its own timestamp is not ahead of this process's
    // clock (small skew allowed). No watermark, an unreadable one, or an
    // insane one all degrade to the plain STALE_SECONDS behaviour below.
    //
    // READ HARDENING (Codex review of #3808, round 4). The WRITE side already
    // refuses to follow or overwrite a planted object (unlink-then-O_EXCL
    // above), but this read was a bare readFileSync — so on any write-side
    // give-up the planted object survived and every later invocation followed
    // it. In a shared sticky os.tmpdir() that is a mute primitive (a planted
    // recent watermark suppresses monitoring) and a stall primitive (a symlink
    // to a FIFO blocks this synchronous read indefinitely; measured: such a
    // read is still running after 300ms). The same lstat + O_NOFOLLOW pair the
    // sentinel path uses, plus a size bound, applied to the file this PR adds.
    // Every refusal degrades to "no watermark", never throws.
    try {
      const st = fs.lstatSync(watermarkPath);
      if (!st.isFile() || st.size > 4096) throw new Error('not a plain watermark');
      const wfd = fs.openSync(watermarkPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let raw;
      try {
        const buf = Buffer.alloc(st.size);
        fs.readSync(wfd, buf, 0, st.size, 0);
        raw = buf.toString('utf8');
      } finally { fs.closeSync(wfd); }
      const watermark = JSON.parse(raw);
      if (
        watermark && typeof watermark.at === 'number'
        && watermark.at <= now + WATERMARK_SKEW_SECONDS
        && !(metrics.timestamp > watermark.at + COMPACT_GRACE_SECONDS)
      ) {
        process.exit(0);
      }
    } catch (e) { /* no watermark — nothing to compare against */ }

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
    // Silent fail -- never block tool execution.
    // ON_CRASH is declared ALLOW at module top: this preserves today's
    // exit(0) fail-open behavior exactly (#3911).
    crash(ON_CRASH, undefined);
  }
});

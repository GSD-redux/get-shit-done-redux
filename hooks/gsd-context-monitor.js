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
// bounded: a healthy reading dropped here behaves identically to an accepted
// one (it would exit above-threshold anyway). A genuine exhaustion reading
// inside the window is SKIPPED, not queued — its warning and its #1974
// breadcrumb both fire on the next reading after the window, so they are
// delayed by at most this window plus the accepted skew below when a later
// reading comes, and lost when
// none does, i.e. when the session ends inside the window (review of #3808,
// round 9). That loss is accepted over the alternative, which is trusting a
// reading that may be the pre-compaction value under a fresh timestamp.
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
  if (typeof name === 'string') return name.trim();
  // ABSENT vs MALFORMED are not the same event (Codex review of #3808, round 7,
  // measured base-vs-head). A MISSING name is the documented pre-#2289 Gemini
  // fallback: under GEMINI_API_KEY it means AfterTool and still emits. A name
  // that is PRESENT but not a string is a malformed payload and must not
  // inherit that fallback — at the merge-base it threw on `.trim()` after the
  // side effects, so no envelope was ever produced, and collapsing both onto ''
  // silently turned `42`, `{}` and `['PreCompact']` into emitting AfterTool
  // events. Measured: base silent, head emitted, for both `42` and
  // `['PreCompact']`. null keeps them distinguishable while staying unequal to
  // every event name, so the PreCompact reset and the allowlist below are
  // byte-for-byte unchanged for every well-formed payload.
  return (name === undefined || name === null) ? '' : null;
}

// SENTINEL WRITE HARDENING (review of #3808, round 7). `warnPath` lives in
// os.tmpdir(), which may resolve to a shared sticky directory — not guaranteed
// per-user, and the file persists across invocations — so an object already
// sitting there may be a planted symlink. The three routine debounce-accounting writes were bare
// writeFileSync, which follows one and writes through to its target, while the
// PreCompact clear and the compaction watermark in this same file already
// refuse to. Unlink-then-O_EXCL is the watermark's own shape (the watermark
// write itself now calls this helper — review round 10): the unlink
// removes any existing object (regular file or link) and O_EXCL then refuses
// to create through one, so the write can only ever land on a fresh regular
// file this process made. Best effort by design — a lost sentinel write costs
// only debounce accounting, which is never worth breaking the hook over, so
// every failure is swallowed exactly as the watermark write's is.
// NOT an atomic read-modify-write, and not claimed to be (Codex review of
// #3808, round 7): two concurrent invocations can read the same state and race
// through unlink/create, so one invocation's accounting can be lost — the same
// lost-update race the bare writeFileSync already had, not a class this change
// introduces. What a lost write leaves behind is whatever the competing writer
// wrote, which may be a perfectly valid sentinel; it does not reliably mean
// "defaults on the next call". Advisory debounce bookkeeping is the right place
// to accept that.
// The read-side twin of writeSentinel (review of #3808, round 9). Both
// sentinel files this hook reads — the compaction watermark and the warn
// state — must be read the same way: lstat first so a planted link, FIFO or
// directory is refused before any open; O_NOFOLLOW so a link raced in between
// is refused by the kernel too (0 on Windows, where lstat already carries the
// check); a 4096-byte bound so a planted large file cannot stall a
// synchronous read. Rounds 4 and 7 each wrote that sequence inline at their
// own call site, which left two copies to keep in step by hand. One place
// now. Refusal THROWS; every caller already wraps the read in a try/catch and
// degrades to "no file", which is the same behaviour the inline copies had.
function readSentinel(target) {
  const st = fs.lstatSync(target);
  if (!st.isFile() || st.size > 4096) throw new Error('not a plain sentinel');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buf = Buffer.alloc(st.size);
    // The RETURN VALUE, not just the call (review of #3808, round 11). A file that shrinks
    // between the lstat above and this read — a concurrent legitimate writer truncating
    // mid-write, not the planted-object case the rest of this function guards — leaves the tail
    // of `buf` zero-filled, and those NULs reach JSON.parse as garbage. Every caller already
    // treats a throw here as "no file", so refusing a short read is both safer and the same
    // outcome the caller would reach one line later, stated on purpose rather than by accident.
    const bytesRead = fs.readSync(fd, buf, 0, st.size, 0);
    if (bytesRead !== st.size) throw new Error('sentinel shrank under the read');
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function writeSentinel(target, payload) {
  try {
    try {
      fs.unlinkSync(target);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    );
    try {
      // LOOP, and check progress (Codex review of round 11). A single `fs.writeSync` is
      // permitted to write fewer bytes than it was given, and the return value was discarded —
      // a short write left a truncated sentinel that JSON.parse rejects, silently defeating the
      // debounce accounting or the compaction watermark this write exists to record. Node's own
      // `writeFileSync` loops for exactly this reason; the explicit no-progress guard keeps a
      // pathological fd from spinning. Symmetric with the bytesRead check in readSentinel.
      const buf = Buffer.from(payload, 'utf8');
      let written = 0;
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (!(n > 0)) throw new Error('sentinel write made no progress');
        written += n;
      }
    } finally { fs.closeSync(fd); }
  } catch (e) { /* best effort — see above */ }
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
      // ORDERING ASSUMPTION, stated rather than enforced (review of #3808,
      // round 9): this reset and the debounce writeSentinel(warnPath) further
      // down are two writers to the same file, and nothing here serialises
      // them. A debounce invocation that read the pre-compaction state and
      // lands its write AFTER this unlink would resurrect exactly the stale
      // sentinel this block removes. The hook relies on the host dispatching a
      // session's hooks one at a time, which Claude Code does; the other
      // runtimes this hook is installed for are assumed to, and that is not
      // tested. A lock file would close it at the cost of a second file to
      // harden on every platform; not taken here.
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
      // through writeSentinel (review of #3808, round 10 — this block was the
      // shape writeSentinel was lifted from in round 7 and kept its own copy):
      // unlink-then-O_EXCL so an existing file — or a planted symlink — is
      // never followed or overwritten in place; failure to write degrades to
      // the old narrowing, never throws.
      writeSentinel(watermarkPath, JSON.stringify({ at: Math.floor(Date.now() / 1000) }));
      // allow(), not raw process.exit: #3911/ADR-3889 moved this hook onto the
      // declared-policy exit vocabulary while this PR was in review, and the
      // PreCompact branch is new here, so it needs the same conversion.
      // A compaction is never blocked by this hook — ALLOW is the policy the
      // rest of the file already declares.
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

    // If no metrics file, this is a subagent or fresh session -- exit silently.
    // Collapsed existsSync+readFileSync: ENOENT → exit 0 (identical to old !existsSync branch),
    // other errors rethrow to the outer catch (swallowed → exit 0, as before).
    //
    // Through readSentinel, like the other two (review of #3808, round 11). This read was the
    // asymmetry left in this file: `metricsPath` is built one line away from `warnPath` and
    // `watermarkPath` (same tmpdir, same predictable `claude-ctx-{sessionId}` shape), it is the
    // only one of the three read on EVERY invocation, and it was the only one still reached by a
    // bare readFileSync — so the symlink-to-FIFO stall the other two are hardened against was
    // still reachable here, on the highest-traffic path in the file. The 4096-byte bound is
    // ample: the statusline writes four fixed fields (`gsd-statusline.js`, ~140 bytes with a
    // UUID session id), so no legitimate bridge approaches it. A refusal throws and lands in the
    // rethrow below exactly as an unreadable or malformed bridge already did.
    let metricsRaw;
    try {
      metricsRaw = readSentinel(metricsPath);
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
      const watermark = JSON.parse(readSentinel(watermarkPath));
      if (
        watermark && typeof watermark.at === 'number'
        && watermark.at <= now + WATERMARK_SKEW_SECONDS
        && !(metrics.timestamp > watermark.at + COMPACT_GRACE_SECONDS)
      ) {
        // Same #3911/ADR-3889 conversion as the PreCompact branch above: this
        // gate is new in this PR, so it did not exist to be migrated.
        allow(undefined);
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
    //
    // READ HARDENING (self-found while addressing round 7; same class, same
    // file). Hardening the writes above leaves this read as a bare
    // readFileSync on warnPath, which is the exact asymmetry round 7 asks be
    // removed from the write side — and the watermark's read was hardened in
    // round 4 for this same reason, so leaving this one recreates it. It was
    // not the LAST bare read in the file: the statusline bridge kept its own
    // until round 11 found it. All three go through readSentinel now. The
    // exposure is real but bounded: the writes now unlink any planted object,
    // so only a read reaching this line BEFORE the first write of an
    // invocation can follow one, and re-planting reopens it every invocation.
    // Following it is a mute primitive — attacker-chosen callsSinceWarn keeps
    // the debounce arm below taken so no warning is ever emitted — and a
    // symlink to a FIFO stalls this synchronous read, the same two primitives
    // measured on the watermark. Same lstat + O_NOFOLLOW + size bound; every
    // refusal degrades to the default warnData this catch already produces,
    // so a normal regular file behaves exactly as before.
    try {
      warnData = JSON.parse(readSentinel(warnPath));
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
      writeSentinel(warnPath, JSON.stringify(warnData));
      allow(undefined);
    }

    // Reset debounce counter
    warnData.callsSinceWarn = 0;
    warnData.lastLevel = currentLevel;
    writeSentinel(warnPath, JSON.stringify(warnData));

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
        writeSentinel(warnPath, JSON.stringify(warnData));
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
          additionalContext: message,
          severity: currentLevel
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

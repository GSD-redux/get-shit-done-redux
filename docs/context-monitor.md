# Context Window Monitor

A post-tool hook (`PostToolUse` for Claude Code, `AfterTool` for Antigravity CLI) that warns the agent when context window usage is high.

## Problem

The statusline shows context usage to the **user**, but the **agent** has no awareness of context limits. When context runs low, the agent continues working until it hits the wall — potentially mid-task with no state saved.

## How It Works

1. The statusline hook writes context metrics to `/tmp/claude-ctx-{session_id}.json`
2. After each tool use, the context monitor reads these metrics
3. When remaining context drops below thresholds, it injects a warning as `additionalContext`
4. The agent receives the warning in its conversation and can act accordingly

The hook is also registered for other lifecycle events on some hosts — including
`PreCompact` (#772). Those events never emit a warning, because only the
injection-capable events accept the `additionalContext` envelope. `PreCompact` is
handled specially: it resets the per-session state described under
[Debounce](#debounce) and returns immediately, without running the debounce or
breadcrumb bookkeeping.

## Thresholds

| Level | Remaining | Agent Behavior |
|-------|-----------|----------------|
| Normal | > 35% | No warning |
| WARNING | <= 35% | Wrap up current task, avoid starting new complex work |
| CRITICAL | <= 25% | Stop immediately, save state (`/gsd-pause-work`) |

## Debounce

To avoid spamming the agent with repeated warnings:
- First warning always fires immediately
- Subsequent warnings require 5 tool uses between them
- Severity escalation (WARNING -> CRITICAL) bypasses debounce
- A context compaction (`PreCompact`) resets this state, so the cycle after a
  compact behaves like a fresh session: its first warning fires immediately and
  its WARNING -> CRITICAL escalation bypasses debounce again. Without the reset
  both rules above would be dead for the rest of the session once a CRITICAL had
  fired, since the escalation test is "the previous level was WARNING" (#3709).

### PreCompact reset

The compaction reset does four things together:

| what | why |
|---|---|
| clears the debounce counter and last-seen severity | a compact restarts the context lifecycle, so the next climb is a fresh cycle |
| clears the one-time critical-session guard | otherwise the resume breadcrumb keeps describing the earlier near-miss rather than the exhaustion that actually ended the run (#1974) |
| deletes the statusline metrics file | it holds the pre-compaction reading, and metrics stay "fresh" for 60s — a warning fired off it right after the compaction would be exactly backwards |
| writes a compaction **watermark** (`claude-ctx-{session_id}-compacted.json`) | deleting the bridge only narrows the stale-reading window: the statusline re-writes the bridge on every render, so a render landing mid-compaction re-creates the pre-compaction reading with a current timestamp. The watermark records the compaction's *start*, and the monitor drops every reading inside a grace window (60s) past it; an unstamped reading (no/zero timestamp) is dropped too. The window **narrows** the race rather than closing it: 60s is a heuristic bound, not a measured maximum, so a compaction running longer than the window can still be followed by a render that passes both the watermark and staleness gates. The cost is bounded but not by the window alone: a healthy reading dropped in the window behaves identically to an accepted one. A genuine exhaustion reading inside the window is *skipped, not queued*: its warning and its #1974 resume breadcrumb both fire on the next reading after the window, so they are delayed by up to the window plus the accepted clock skew when a later reading comes (measured: first recovery is watermark+61s with no skew, watermark+66s for a watermark at the +5s skew limit), and lost when none does — a session that ends inside the window records neither. That loss is accepted over trusting a reading that may be the pre-compaction value under a fresh timestamp. An aborted compaction is muted for the same period — nothing in the event distinguishes abort from success. A watermark more than 5s ahead of the reader's clock is discarded as insane (a stray or clock-stepped file must not mute the monitor); one within that skew is honored, which is why it can extend the delay. A watermark that is not a plain regular file — a symlink, a directory, an oversized file — is never followed, and neither is the statusline bridge or the warn sentinel: all three per-session files in that directory are read through the same hardened path (round 11). A plain regular file planted at the predictable path *is* honored for its window: the reader checks the object's shape and sanity, not who wrote it, so a same-user (or, in a shared sticky tmpdir, cross-owner) planted watermark mutes the monitor for at most the window plus the accepted skew (65s) per planting. That is the same residual the warn sentinel at the sibling path already carries, bounded here by the window; refusing it needs an ownership check, which is a different policy than this file's |

Properties of the reset worth knowing:

- It runs even when `hooks.context_warnings` is `false`. Clearing this state is
  cleanup, not a warning, and it emits nothing — but config is re-read on every
  invocation, so a session that disables warnings, compacts, then re-enables them
  would otherwise resurrect the stale state.
- `PreCompact` fires *before* the compaction. If a compaction is aborted, the
  state has already been reset. The effect is mild: one extra immediate warning,
  and the breadcrumb guard re-armed so a later, more current breadcrumb can
  replace the old one.
- The reset covers **compaction only**. No other context-shrinking path (a
  `/clear`, a session restart that reuses the id) fires `PreCompact`, so state
  keyed to a surviving `session_id` outlives those; wiring `SessionStart` is
  separate work.
- Everything here is best-effort: the reset, the fallback truncation, and the
  watermark write all degrade silently rather than ever failing a compaction.

## Architecture

```
Statusline Hook (gsd-statusline.js)
    | writes
    v
/tmp/claude-ctx-{session_id}.json
    ^ reads
    |
Context Monitor (gsd-context-monitor.js, PostToolUse/AfterTool)
    | injects
    v
additionalContext -> Agent sees warning
```

The bridge file is a simple JSON object:

```json
{
  "session_id": "abc123",
  "remaining_percentage": 28.5,
  "used_pct": 71,
  "timestamp": 1708200000
}
```

## Integration with GSD

GSD's `/gsd-pause-work` command saves execution state. The WARNING message suggests using it. The CRITICAL message instructs immediate state save.

## Setup

Both hooks are registered automatically during `npx @opengsd/gsd-core` installation — no manual steps are needed under normal circumstances. For hook configuration details, threshold overrides, and manual registration examples, see [Configuration](CONFIGURATION.md).

As a brief reference: the statusline hook registers as `statusLine` in `settings.json`; the context monitor (`gsd-context-monitor.js`) registers as a `PostToolUse` hook (or `AfterTool` for Antigravity CLI). Both entries use the absolute Node executable path that ran the installer. On Windows PowerShell, prefix quoted executable paths with `&`.

## Safety

- The hook wraps everything in try/catch and exits silently on error
- It never blocks tool execution — a broken monitor should not break the agent's workflow
- Stale metrics (older than 60s) are ignored
- Missing bridge files are handled gracefully (subagents, fresh sessions)
- A compaction is never blocked by this hook: if the per-session state cannot be
  removed (a held file handle on Windows, for instance) the hook *attempts* to
  truncate the file to empty in place — which later reads treat exactly like an
  absent file — and any remaining error is swallowed. The truncation is
  best-effort, not a guarantee: if that open is refused too (or the path is not a
  plain regular file, which is never followed) the original file survives and the
  stale state persists for that session. Exiting cleanly always wins over
  clearing state

---

## Related

- [Architecture](ARCHITECTURE.md)
- [Configuration](CONFIGURATION.md)
- [docs index](README.md)

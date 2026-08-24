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

The compaction reset clears three things together:

| what | why |
|---|---|
| the debounce counter and last-seen severity | a compact restarts the context lifecycle, so the next climb is a fresh cycle |
| the one-time critical-session guard | otherwise the resume breadcrumb keeps describing the earlier near-miss rather than the exhaustion that actually ended the run (#1974) |
| the statusline metrics file | it still holds the pre-compaction reading, and metrics stay "fresh" for 60s — leaving it would fire a warning off a reading the compaction just invalidated, immediately after the context was freed |

Two properties of the reset worth knowing:

- It runs even when `hooks.context_warnings` is `false`. Clearing this state is
  cleanup, not a warning, and it emits nothing — but config is re-read on every
  invocation, so a session that disables warnings, compacts, then re-enables them
  would otherwise resurrect the stale state.
- `PreCompact` fires *before* the compaction. If a compaction is aborted, the
  state has already been reset. The effect is mild: one extra immediate warning,
  and the breadcrumb guard re-armed so a later, more current breadcrumb can
  replace the old one.

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
  removed (a held file handle on Windows, for instance) it is neutralised in
  place instead, and any remaining error is swallowed

---

## Related

- [Architecture](ARCHITECTURE.md)
- [Configuration](CONFIGURATION.md)
- [docs index](README.md)

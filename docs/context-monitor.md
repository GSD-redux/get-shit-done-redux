# Context Window Monitor

A post-tool hook (`PostToolUse` for Claude Code, `AfterTool` for Antigravity CLI) that warns the agent when context window usage is high.

## Problem

The statusline shows context usage to the **user**, but the **agent** has no awareness of context limits. When context runs low, the agent continues working until it hits the wall — potentially mid-task with no state saved.

## How It Works

1. The statusline hook writes context metrics to `/tmp/claude-ctx-{session_id}.json`
2. After each tool use, the context monitor reads these metrics
3. When remaining context drops below thresholds, it injects a warning as `additionalContext`
4. The agent receives the warning in its conversation and can act accordingly

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

---

## Related

- [Architecture](ARCHITECTURE.md)
- [Configuration](CONFIGURATION.md)
- [docs index](README.md)

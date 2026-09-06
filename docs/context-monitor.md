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

### Tuning the fire-points

35 and 25 are defaults, not fixed points. How much runway "35% remaining" buys
depends on the window size and on what the phase is doing, so both are
overridable per project in `.planning/config.json` (#4285):

```jsonc
{
  "hooks": {
    "context_warnings": true,
    "context_warning_threshold": 45,
    "context_critical_threshold": 30
  }
}
```

Editing the constants in `gsd-context-monitor.js` instead does not survive: the
file is in the managed-hooks registry, so the next install re-stages the
vendored body and the edit is gone without a conflict or a warning. A config key
survives by construction.

Both keys are optional and both are percentages of context window **remaining**,
so a *larger* number fires *earlier*. Absent keys resolve to the defaults above,
which is what every existing project gets.

The hook never blocks a tool call, so it never throws on a bad value — it
degrades:

| config | resolved |
|---|---|
| key absent | the default (35 / 25) |
| not a number, or outside 0-100 | the default for that key |
| `critical >= warning` after resolution | **both** defaults — an inconsistent pair has no coherent reading, and honouring one side would silently discard the other |

Note the two rows are different rules and compose in this order: an unusable
value is replaced by ITS OWN default first, and only the resulting pair is
checked. So `context_warning_threshold: 150` with `context_critical_threshold:
30` resolves to 35 / 30 — not 35 / 25 — because 30 is usable and 30 < 35 holds.

The pair check compares resolved values, so overriding only one key is still
checked against the other's default: `context_warning_threshold: 20` on its own
is inconsistent with the default critical of 25 and resolves back to 35 / 25.
Move both when either crosses the other. `gsd-tools config-set` validates the
0-100 domain per key but deliberately does not enforce the pair, because it
writes one key per call and a two-step retune *can* be transiently inconsistent
on disk — 35 / 25 to 20 / 10 is valid throughout if critical goes first, and
inconsistent in between if warning does. A pair check in the setter would reject
that intermediate write and force one particular order.

### Scope: the root project config only

The monitor reads `<cwd>/.planning/config.json` and nothing else. It does not
consult a sub-project or workstream config, but `gsd-tools config-set` does
write to one when the environment selects it — so a scoped write succeeds and
the monitor keeps using the root value, or the default when the root has none:

| environment | `config-set` writes to |
|---|---|
| neither variable | `.planning/config.json` — the file the monitor reads |
| `GSD_PROJECT=p` | `.planning/p/config.json` |
| `GSD_WORKSTREAM=w` | `.planning/workstreams/w/config.json` |
| both | `.planning/p/workstreams/w/config.json` |

That is the same root-only scope `hooks.context_warnings` has always had; tune
these keys in the root `.planning/config.json`.

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

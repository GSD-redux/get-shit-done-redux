---
name: gsd:debug
description: Systematic debugging with persistent state across context resets
argument-hint: "[list | status <slug> | continue <slug>] [--diagnose] [--runtime-probes | --no-runtime-probes] [issue description]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Agent
  - AskUserQuestion
---

<objective>
Debug issues using scientific method with subagent isolation.

**Orchestrator role:** Gather symptoms, spawn gsd-debugger agent, handle checkpoints, spawn continuations.

**Flags:**
- `--diagnose` — Diagnose only. Returns a Root Cause Report without applying a fix.
- `--runtime-probes` — Select opt-in `adaptive` runtime evidence; all safety gates still apply.
- `--no-runtime-probes` — Select `off` explicitly. With no probe flag, policy also defaults to `off`.

**Subcommands:** `list` · `status <slug>` · `continue <slug>`
</objective>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-debug-session-manager — manages debug checkpoint/continuation loop in isolated context
- gsd-debugger — investigates bugs using scientific method
</available_agent_types>

<execution_context>
@~/.claude/gsd-core/workflows/debug.md
</execution_context>

<context>
User's input: $ARGUMENTS

Parse flags and subcommands from $ARGUMENTS BEFORE the active-session check:

1. Scan the complete argv for the exact whole-token flags `--diagnose`, `--runtime-probes`, and `--no-runtime-probes`. They are global and order-independent. Similar text such as `--runtime-probes=true`, prefixes, or substrings is user data, not a flag.
2. Both probe flags are conflicting and must be rejected; stop when they occur together. Strip every recognized flag token before interpreting a subcommand, slug, or description.
3. Parse the remaining tokens: leading `list` has no arguments; leading `status` or `continue` takes exactly one slug; otherwise use `debug` and join the remaining tokens as the issue description.
4. `list` and `status` accept no recognized flags. `continue` rejects `--diagnose`. A new diagnosis rejects `--diagnose --runtime-probes`, while redundant `--diagnose --no-runtime-probes` is valid.
5. Set `diagnose_only` from the stripped diagnose flag. Set the explicit runtime-evidence override to `adaptive` for `--runtime-probes`, `off` for `--no-runtime-probes`, or absent when neither appears. The no-flag effective default is `off`; a valid saved policy may still be retained by `continue`.

Check for active sessions (used for non-list/status/continue flows):
```bash
ls .planning/debug/*.md 2>/dev/null | grep -v resolved | head -5
```
</context>

<process>
Execute end-to-end.
</process>

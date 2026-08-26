---
id: 104
title: New Runtime Support (Cline, CodeBuddy, Qwen Code)
group: v1.35.0 Features
---

**Part of:** `npx @opengsd/gsd-core`

**Purpose:** Extend GSD installation to Cline, CodeBuddy, and Qwen Code runtimes.

**Requirements:**
- REQ-CLINE-02: Cline install MUST write `.clinerules` to `~/.cline/` (global) or `./.cline/` (local). No custom slash commands — rules-based integration only. Flag: `--cline`.
- REQ-CODEBUDDY-01: CodeBuddy install MUST deploy skills to `~/.codebuddy/skills/gsd-*/SKILL.md` (emitted `user-invocable: false`), `/gsd-*` slash commands to `~/.codebuddy/commands/gsd-*.md`, and subagents to `~/.codebuddy/agents/gsd-*.md`. The commands surface is the sole `/` menu entry point. No `mcp.json` is written (gsd ships no MCP server). Flag: `--codebuddy`.
- REQ-QWEN-01: Qwen Code install MUST deploy skills to `~/.qwen/skills/gsd-*/SKILL.md`, following the open standard used by Claude Code 2.1.88+. `QWEN_CONFIG_DIR` env var overrides the default path. Flag: `--qwen`.

**Runtime summary:**

| Runtime | Install Format | Config Path | Flag |
|---------|---------------|-------------|------|
| Cline | `.clinerules` | `~/.cline/` or `./.cline/` | `--cline` |
| CodeBuddy | Skills (`SKILL.md`) | `~/.codebuddy/skills/` | `--codebuddy` |
| Qwen Code | Skills (`SKILL.md`) | `~/.qwen/skills/` | `--qwen` |

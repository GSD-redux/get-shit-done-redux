---
id: 36
title: Multi-Runtime Support
group: Infrastructure Features
---

**Purpose:** Run GSD across multiple AI coding agent runtimes.

**Requirements:**
- REQ-RUNTIME-01: System MUST support Claude Code, OpenCode, Kilo, Codex, Copilot, Antigravity, Trae, Cline, Augment Code, CodeBuddy, Qwen Code
- REQ-RUNTIME-02: Installer MUST transform content per runtime (tool names, paths, frontmatter)
- REQ-RUNTIME-03: Installer MUST support interactive and non-interactive (`--claude --global`) modes
- REQ-RUNTIME-04: Installer MUST support both global and local installation
- REQ-RUNTIME-05: Uninstall MUST cleanly remove all GSD files without affecting other configurations
- REQ-RUNTIME-06: Installer MUST handle platform differences (Windows, macOS, Linux, WSL, Docker)
- REQ-RUNTIME-07: Runtimes with lifecycle hook support MUST register per-turn context-headroom tracking events at install time
- REQ-RUNTIME-08: Native packaging manifests MUST be version-stamped and enable runtime-native install/update/uninstall flows

**Runtime Transformations:**

| Aspect | Claude Code | OpenCode | Kilo | Codex | Copilot | Antigravity | Cursor | Trae | Cline | Augment | CodeBuddy | Qwen Code |
|--------|------------|----------|-------|-------|---------|-------------|--------|------|-------|---------|-----------|-----------|
| Commands | Slash commands | Slash commands | Slash commands | Skills (TOML) | Slash commands | Skills | Skills + Slash commands | Skills | Rules | Skills + Slash commands | Slash commands | Skills |
| Agent format | Claude native | `mode: subagent` | `mode: subagent` | Skills | Tool mapping | Skills | Skills | Skills | Rules | Skills | Skills | Skills |
| Skills emission | N/A | On-demand SKILL.md (1.4.0) | On-demand SKILL.md (1.4.0) | `/skills` picker (1.4.0) | N/A | N/A | SKILL.md | N/A | On-demand SKILL.md (1.4.0) | N/A | N/A | N/A |
| Hook events | `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`, `PreCompact`, `FileChanged` | N/A | N/A | `SessionStart`, `SubagentStart`, `Stop`, `PostToolUse` | `sessionStart` | N/A | `sessionStart`, `postToolUse` | N/A | `PreToolUse` | N/A | N/A | `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`, `PreCompact` |
| Config | `settings.json` | `opencode.json(c)` | `kilo.json(c)` | TOML | Instructions | Config | Config | Config | `.clinerules` | Config | Config | Config |

**Cursor artifact surfaces:** `gsd install --cursor` writes two artifact kinds:
- `~/.cursor/skills/gsd-<name>/SKILL.md` — rich skills with YAML frontmatter, Cursor tool-name mapping, and adapter context header (existing surface)
- `~/.cursor/commands/gsd-<name>.md` — plain markdown slash commands (no frontmatter) invocable via `/` in the Agent input (Cursor 1.6+)

**Native skills emission (1.4.0):** Three runtimes now emit GSD as on-demand native skills (`skills/<name>/SKILL.md`) at install time, in addition to their existing command and agent surfaces. Skills respect the active install profile and are removed on uninstall.
- **Cline** (global installs, Cline >= v3.48.0) — emits skills alongside the existing `.clinerules/` directory
- **Kilo** — emits skills alongside `command/` and `agents/`
- **OpenCode** — emits skills alongside its existing surfaces

**New slash-command surfaces (1.4.0):**
- **CodeBuddy** — `/gsd-*` slash commands written to `~/.codebuddy/commands/`
- **Augment** — `commands/gsd-<name>.md` written to `~/.augment/commands/`
- **Cursor** (Cursor >= 1.6) — `.cursor/commands/gsd-<name>.md` so GSD appears in the `/` command menu

**Cross-runtime lifecycle hooks (1.4.0):** Each supported runtime registers lifecycle hook events for per-turn context-headroom tracking and workflow state management. Notable registrations:
- **Claude Code:** `SubagentStop`, `Stop`, `PreCompact` (context-headroom warnings), `FileChanged` (hot-reloads `.planning/config.json` mid-session)
- **Qwen Code:** `SubagentStop`, `Stop`, `PreCompact`
- **Codex:** `SubagentStart`, `Stop`, `PostToolUse` (new in 1.4.0); on Windows the `SessionStart` hook entry gains a `commandWindows` field so the `.cmd` shim is used for native execution
- **Cline:** `PreToolUse`
- **Cursor:** `sessionStart` (injects workflow state), `postToolUse` (nudges `.planning` updates)
- **Copilot:** `sessionStart`

**Runtime-specific enrichments (1.4.0):**
- Codex emits `service_tier: flex` for light-tier agents; GSD skills appear in the Codex `/skills` picker via `SKILL.md` (no `agents/openai.yaml` sidecar is emitted — doing so caused duplicate autocomplete entries, #1326)

**Native packaging:**
- **Claude Code:** GSD Core ships a `.claude-plugin/plugin.json` manifest, enabling installation and lifecycle management via `claude plugin install|enable|disable|update gsd-core`. Commands load under the `/gsd-core:` namespace (e.g. `/gsd-core:plan-phase`), avoiding slash-command collisions with the classic npm installer which uses `/gsd:`. Always-on guard and update hooks are wired automatically via `hooks/hooks.json`. The plugin path is additive — the npm installer (`npx @opengsd/gsd-core`) remains fully supported.
